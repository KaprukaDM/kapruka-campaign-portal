#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// ROTATE ACTIVE ADS — enforce a 5-active-ad cap per managed ad set
//
// Runs every 3 hours (.github/workflows/rotate-active-ads.yml). Both
// pipelines that create ads in the two managed ad sets — the weekly organic
// winners cron (scripts/weekly-organic-winners-to-ads.js) and the dashboard's
// manual "Push Now" (functions/api/push-organic-winner-ad.js) — already cap
// themselves at push time: if an ad set already has MAX_ACTIVE_ADS_PER_ADSET
// ACTIVE ads, the new ad is created PAUSED instead of ACTIVE, so it queues in
// Meta rather than blowing past the cap. This job is what actually works
// that queue afterwards: a slot only frees up later (an ad gets paused,
// disapproved, archived, or deleted — nothing pushes new capacity), so
// something has to periodically notice that and promote the next PAUSED ad.
//
// For each of the two managed ad sets:
//   1. Count ads with effective_status ACTIVE right now.
//   2. If under the cap, list PAUSED ads THIS PIPELINE created in that ad
//      set (cross-checked against organic_winner_ad_pushes — see
//      "Only pipeline-created ads" below), oldest created_time first.
//   3. Activate (status -> ACTIVE) as many as it takes to reach the cap or
//      run out of queued ads, whichever comes first.
//
// Only pipeline-created ads are ever touched. An ad a human paused on
// purpose in Ads Manager (to kill a bad performer, pause a promo mid-flight,
// etc.) is never silently reactivated — it isn't ours to un-pause, and this
// job has no way to know why a human paused it. "Ours" means its ad_id
// appears in organic_winner_ad_pushes with a matching adset_id; anything
// else in these ad sets — including ads Meta itself marked
// DISAPPROVED/PENDING_REVIEW, which show up as PAUSED-adjacent statuses, not
// plain PAUSED — is left exactly as it is.
//
// Required env vars (GitHub Actions repo secrets — same ones the weekly cron
// uses):
//   META_ADS_ACCESS_TOKEN (or META_PAGE_ACCESS_TOKEN as a fallback)
//   META_AD_ACCOUNT_ID    — e.g. 'act_1234567890' (unused directly here, kept
//                           for parity/future use — every call below is
//                           scoped to the ad set, not the account).
//
// Optional:
//   ORGANIC_ADSET_ID  — defaults to 52763744155054 (the current organic
//                       winners destination — see TARGET_ADSET_ID in
//                       weekly-organic-winners-to-ads.js; keep both in sync
//                       if that ad set ever changes).
//   PROMO_ADSET_ID    — defaults to 52829715742254 (Promotion Time Sensitive
//                       — see PROMOTION_SENSITIVE_ADSET_ID in
//                       admin-dashboard.html).
//   MAX_ACTIVE_ADS    — defaults to 5. Keep in sync with
//                       MAX_ACTIVE_ADS_PER_ADSET in
//                       weekly-organic-winners-to-ads.js and
//                       push-organic-winner-ad.js if this ever changes.
//
// Pass --dry-run (or DRY_RUN=1/true/yes/on) to log every count and every ad
// that would be activated without calling Meta's write endpoint.

const DRY_RUN = process.argv.includes('--dry-run')
  || ['1', 'true', 'yes', 'on'].includes(String(process.env.DRY_RUN || '').trim().toLowerCase());

const SUPABASE_URL = 'https://ivllhheqqiseagmctfyp.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml2bGxoaGVxcWlzZWFnbWN0ZnlwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg1NzQzMzksImV4cCI6MjA4NDE1MDMzOX0.OnkYNACtdknKDY2KqLfiGN0ORXpKaW906fD0TtSJlIk';

const ADS_ACCESS_TOKEN = process.env.META_ADS_ACCESS_TOKEN || process.env.META_PAGE_ACCESS_TOKEN;
const GRAPH_VERSION = 'v21.0';

// Same defaults as weekly-organic-winners-to-ads.js's TARGET_ADSET_ID and
// admin-dashboard.html's PROMOTION_SENSITIVE_ADSET_ID.
const MANAGED_ADSETS = [
  { key: 'organic', id: process.env.ORGANIC_ADSET_ID || '52763744155054', label: 'Organic Winners' },
  { key: 'promo', id: process.env.PROMO_ADSET_ID || '52829715742254', label: 'Promotion Time Sensitive' },
];

const MAX_ACTIVE_ADS_PER_ADSET = Number(process.env.MAX_ACTIVE_ADS) || 5;

if (!DRY_RUN && !ADS_ACCESS_TOKEN) {
  console.error('Missing META_ADS_ACCESS_TOKEN (or META_PAGE_ACCESS_TOKEN) env var.');
  process.exit(1);
}

// ═══════════════════════════════════════════════════════════════
// META GRAPH API
// ═══════════════════════════════════════════════════════════════

function formatGraphError(method, path, error) {
  const parts = [`(#${error.code}${error.error_subcode ? '/' + error.error_subcode : ''}) ${error.message}`];
  if (error.error_user_msg) parts.push(`user_msg: ${error.error_user_msg}`);
  return `${method} ${path}: ${parts.join(' — ')}`;
}

async function graphGet(path, params) {
  const url = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  url.searchParams.set('access_token', ADS_ACCESS_TOKEN);
  const res = await fetch(url);
  const json = await res.json();
  if (json.error) throw new Error(formatGraphError('GET', path, json.error));
  return json;
}

async function graphPost(path, body) {
  if (DRY_RUN) { console.log(`  [dry-run] would POST ${path}`, body); return { success: true }; }
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${path}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, access_token: ADS_ACCESS_TOKEN }),
  });
  const json = await res.json();
  if (json.error) throw new Error(formatGraphError('POST', path, json.error));
  return json;
}

async function countActiveAds(adsetId) {
  const res = await graphGet(`${adsetId}/ads`, { fields: 'id', effective_status: '["ACTIVE"]', limit: 500 });
  return (res.data || []).length;
}

// Plain PAUSED only — deliberately excludes PENDING_REVIEW, DISAPPROVED,
// PREAPPROVED, CAMPAIGN_PAUSED (paused via the ad set/campaign, not this
// ad), and every other effective_status. An ad Meta disapproved or is still
// reviewing isn't ready to activate no matter how long it's waited, and an
// ad that's only paused because its ad set/campaign is paused would just
// get rejected by Meta anyway (or silently not deliver) if flipped to
// ACTIVE while the parent stays paused.
async function listPausedAds(adsetId) {
  const res = await graphGet(`${adsetId}/ads`, {
    fields: 'id,name,created_time,effective_status',
    effective_status: '["PAUSED"]',
    limit: 500,
  });
  return res.data || [];
}

// ═══════════════════════════════════════════════════════════════
// SUPABASE — which ads are ours to rotate
// ═══════════════════════════════════════════════════════════════

// Only ads this pipeline actually created are eligible for auto-activation —
// see the "Only pipeline-created ads" note at the top of the file. A human
// pausing an ad in Ads Manager for their own reason must never be silently
// undone by this job.
async function fetchPipelineAdIds(adsetId) {
  const url = `${SUPABASE_URL}/rest/v1/organic_winner_ad_pushes?adset_id=eq.${encodeURIComponent(adsetId)}&ad_id=not.is.null&select=ad_id`;
  const res = await fetch(url, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } });
  if (!res.ok) throw new Error(`Supabase fetch (pipeline ad ids for ${adsetId}) failed (${res.status}): ${await res.text()}`);
  const rows = await res.json();
  return new Set(rows.map(r => r.ad_id));
}

// ═══════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════

async function rotateAdset({ key, id: adsetId, label }) {
  console.log(`\n── ${label} (${adsetId}) ──`);

  const activeCount = await countActiveAds(adsetId);
  const freeSlots = MAX_ACTIVE_ADS_PER_ADSET - activeCount;
  console.log(`  ${activeCount}/${MAX_ACTIVE_ADS_PER_ADSET} active.`);

  if (freeSlots <= 0) {
    console.log('  No free slots — nothing to activate this run.');
    return { adsetId, label, activeCount, activated: [] };
  }

  const [pausedAds, pipelineAdIds] = await Promise.all([
    listPausedAds(adsetId),
    fetchPipelineAdIds(adsetId),
  ]);

  const queuedOurs = pausedAds
    .filter(ad => pipelineAdIds.has(ad.id))
    .sort((a, b) => new Date(a.created_time) - new Date(b.created_time)); // oldest first

  if (queuedOurs.length === 0) {
    console.log(`  ${freeSlots} free slot(s), but no pipeline-created PAUSED ad is waiting in queue.`);
    return { adsetId, label, activeCount, activated: [] };
  }

  const toActivate = queuedOurs.slice(0, freeSlots);
  console.log(`  ${freeSlots} free slot(s), ${queuedOurs.length} queued — activating ${toActivate.length}:`);

  const activated = [];
  for (const ad of toActivate) {
    console.log(`    - ${ad.id} "${ad.name}" (queued since ${ad.created_time})`);
    try {
      await graphPost(ad.id, { status: 'ACTIVE' });
      activated.push(ad);
    } catch (e) {
      console.error(`      Failed to activate ${ad.id}: ${e.message}`);
    }
  }

  return { adsetId, label, activeCount, activated };
}

async function main() {
  console.log(`========== ROTATE ACTIVE ADS ${DRY_RUN ? '[DRY RUN]' : ''} ==========`);
  console.log(`Cap: ${MAX_ACTIVE_ADS_PER_ADSET} active ads per managed ad set.`);

  const results = [];
  for (const adset of MANAGED_ADSETS) {
    try {
      results.push(await rotateAdset(adset));
    } catch (e) {
      console.error(`Failed to rotate ${adset.label} (${adset.id}): ${e.message}`);
      results.push({ adsetId: adset.id, label: adset.label, error: e.message, activated: [] });
    }
  }

  const totalActivated = results.reduce((sum, r) => sum + r.activated.length, 0);
  console.log(`\n========== DONE: ${totalActivated} ad(s) activated across ${results.length} ad set(s) ${DRY_RUN ? '[dry run]' : ''} ==========`);

  if (results.some(r => r.error)) process.exitCode = 1;
}

main().catch(err => {
  console.error('Rotate active ads job failed:', err.message);
  process.exit(1);
});
