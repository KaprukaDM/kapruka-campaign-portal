#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// WEEKLY ORGANIC WINNERS → PAID ADS
//
// Runs weekly (.github/workflows/weekly-organic-winners-ads.yml). For each
// organic FB/IG post from the last 7 days that qualifies as a "winner"
// (same reaction-rate-ratio logic as the admin dashboard's 🏆 badge):
//
//   1. Search the creative sheet's Primary Text column for a fuzzy match to
//      the winning post's caption.
//        - MATCH FOUND: build a fresh link ad from that row's Drive image +
//          Primary Text. If Primary Text has a trailing kapruka.com URL,
//          that's the destination link; otherwise falls back to the Kapruka
//          homepage. CTA button = Shop Now.
//        - NO MATCH (high performer, but not in the sheet): reuse the
//          organic post itself as the ad creative. CTA button = Shop Now,
//          linking to the Kapruka homepage (the organic post has no
//          per-product link to borrow).
//   2. Create the ad in the target ad set, status ACTIVE.
//   3. Record the push in Supabase (organic_winner_ad_pushes) so the same
//      post is never promoted twice, even if it's still a winner next week.
//
// Required env vars (GitHub Actions repo secrets):
//   META_ADS_ACCESS_TOKEN  — token with ads_management scope on the ad
//                            account below (falls back to
//                            META_PAGE_ACCESS_TOKEN if unset, but that token
//                            may not have ad-creation permission — check).
//   META_AD_ACCOUNT_ID     — e.g. 'act_1234567890' (NOT the Page ID).
//   META_PAGE_ID           — same Facebook Page ID used by the sync job.
// Optional:
//   META_IG_USER_ID        — Instagram Business Account ID (auto-discovered
//                            if unset).
//   TARGET_ADSET_ID        — defaults to 52816670204854 (given by the team).
//   CREATIVE_SHEET_ID      — defaults to the Kapruka content-calendar sheet.
//   CREATIVE_SHEET_GID     — defaults to the tab given by the team.
//   KAPRUKA_HOME_URL       — defaults to https://www.kapruka.com
//   WHATSAPP_PHONE_ID / WHATSAPP_ACCESS_TOKEN / WHATSAPP_TO — optional
//                            summary alert after each run; skipped silently
//                            if unset.
//
// IMPORTANT — READ BEFORE FIRST LIVE RUN:
//   - The creative sheet and the Drive files it links to must be shared as
//     "Anyone with the link" (Viewer), because this script reads them
//     unauthenticated via the public CSV-export/download endpoints. If they
//     are restricted to specific accounts, the sheet-match step will fail
//     closed (falls back to reusing the existing post) rather than crash —
//     but you won't get the sheet-matched creative you expect.
//   - Video rows in the sheet are NOT uploaded (video ad-creative upload is
//     a separate chunked API this script doesn't implement yet) — a winner
//     whose only sheet match is a video row falls back to reusing the
//     existing organic post instead.
//   - Ads are created with status ACTIVE — they start spending the ad set's
//     budget immediately, with no human approval step, per the team's
//     explicit choice. Strongly recommend a first dry run (see --dry-run
//     below) before trusting this unattended.
//   - Reused-IG-post creatives may not accept a Shop Now CTA override the
//     same way boosted Facebook posts do — Meta's API doesn't officially
//     document CTA overrides for source_instagram_media_id creatives. This
//     script requests it anyway; verify the resulting ad actually shows the
//     button before relying on it.
//
// Pass --dry-run (or DRY_RUN=1) to log everything this would do — sheet
// matches, extracted links, which posts would get ads — without calling any
// Meta write endpoints or touching Supabase. Strongly recommended for the
// first run.

const DRY_RUN = process.argv.includes('--dry-run') || process.env.DRY_RUN === '1';

const SUPABASE_URL = 'https://ivllhheqqiseagmctfyp.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml2bGxoaGVxcWlzZWFnbWN0ZnlwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg1NzQzMzksImV4cCI6MjA4NDE1MDMzOX0.OnkYNACtdknKDY2KqLfiGN0ORXpKaW906fD0TtSJlIk';

const ADS_ACCESS_TOKEN = process.env.META_ADS_ACCESS_TOKEN || process.env.META_PAGE_ACCESS_TOKEN;
// Ads/User-type tokens can't see page-scoped fields like
// instagram_business_account (confirmed live: the call succeeds but the
// field is silently absent, not an error) — Meta's "new Pages experience"
// requires an actual Page token for that. Prefer a real page token
// specifically for the IG-account lookup; fall back to the ads token if
// that's genuinely all that's configured.
const PAGE_SCOPED_TOKEN = process.env.META_PAGE_ACCESS_TOKEN || ADS_ACCESS_TOKEN;
const AD_ACCOUNT_ID = process.env.META_AD_ACCOUNT_ID; // 'act_XXXXXXXXXX'
const PAGE_ID = process.env.META_PAGE_ID;
const IG_USER_ID_OVERRIDE = process.env.META_IG_USER_ID || null;
const TARGET_ADSET_ID = process.env.TARGET_ADSET_ID || '52816670204854';
const CREATIVE_SHEET_ID = process.env.CREATIVE_SHEET_ID || '1CNSZqL5MCbTaj5fF4L_e95oJECVMpOZMUAz-b9r9Bpk';
const CREATIVE_SHEET_GID = process.env.CREATIVE_SHEET_GID || '275837150';
const KAPRUKA_HOME_URL = process.env.KAPRUKA_HOME_URL || 'https://www.kapruka.com';
const GRAPH_VERSION = 'v21.0';
const LOOKBACK_DAYS = 7;
const WINNER_MULTIPLIER = 1.5;

if (!DRY_RUN) {
  if (!ADS_ACCESS_TOKEN) { console.error('Missing META_ADS_ACCESS_TOKEN (or META_PAGE_ACCESS_TOKEN) env var.'); process.exit(1); }
  if (!AD_ACCOUNT_ID) { console.error('Missing META_AD_ACCOUNT_ID env var (e.g. act_1234567890).'); process.exit(1); }
  if (!PAGE_ID) { console.error('Missing META_PAGE_ID env var.'); process.exit(1); }
}

// ═══════════════════════════════════════════════════════════════
// SUPABASE — pull last-7-days performance, record pushes
// ═══════════════════════════════════════════════════════════════

async function fetchRecentPerformance() {
  const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const url = `${SUPABASE_URL}/rest/v1/facebook_post_performance?created_time=gte.${encodeURIComponent(since)}&order=created_time.desc&limit=500`;
  const res = await fetch(url, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } });
  if (!res.ok) throw new Error(`Supabase fetch failed (${res.status}): ${await res.text()}`);
  return res.json();
}

async function fetchAlreadyPushedKeys() {
  const url = `${SUPABASE_URL}/rest/v1/organic_winner_ad_pushes?select=group_key`;
  const res = await fetch(url, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } });
  if (!res.ok) throw new Error(`Supabase fetch (pushed keys) failed (${res.status}): ${await res.text()}`);
  const rows = await res.json();
  return new Set(rows.map(r => r.group_key));
}

async function recordPush(record) {
  if (DRY_RUN) { console.log(`[dry-run] would record push: ${JSON.stringify(record)}`); return; }
  const res = await fetch(`${SUPABASE_URL}/rest/v1/organic_winner_ad_pushes`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json', Prefer: 'return=minimal',
    },
    body: JSON.stringify(record),
  });
  if (!res.ok) console.error(`Failed to record push for ${record.group_key}: ${res.status} ${await res.text()}`);
}

// ═══════════════════════════════════════════════════════════════
// GROUPING + WINNER SCORING — mirrors admin-dashboard.html exactly, so
// "winner" here means the same thing it means on the 🏆 badge in the UI.
// ═══════════════════════════════════════════════════════════════

const SUM_KEYS = ['impressions', 'reach', 'engaged_users', 'reactions_total', 'comments_count', 'shares_count'];

function groupKeyOf(p) {
  const day = p.created_time ? new Date(p.created_time).toISOString().slice(0, 10) : 'unknown';
  return `${(p.message || '').trim()}|${day}`;
}

function groupPosts(posts) {
  const groups = new Map();
  for (const p of posts) {
    const key = groupKeyOf(p);
    if (!groups.has(key)) {
      groups.set(key, {
        key, platforms: [], fbPostId: null, igPostId: null,
        message: p.message, permalink_url: p.permalink_url, created_time: p.created_time,
        impressions: null, reach: null, engaged_users: null, reactions_total: null, comments_count: null, shares_count: null,
      });
    }
    const g = groups.get(key);
    g.platforms.push(p.platform);
    if (p.platform === 'facebook') g.fbPostId = p.post_id;
    if (p.platform === 'instagram') g.igPostId = p.post_id;
    if (p.created_time && (!g.created_time || p.created_time < g.created_time)) g.created_time = p.created_time;
    if (!g.permalink_url && p.permalink_url) g.permalink_url = p.permalink_url;
    for (const k of SUM_KEYS) {
      if (p[k] !== null && p[k] !== undefined && !Number.isNaN(Number(p[k]))) {
        g[k] = (g[k] || 0) + Number(p[k]);
      }
    }
  }
  return Array.from(groups.values());
}

function combinedOf(p) { return (Number(p.impressions) || 0) + (Number(p.reach) || 0); }
function rateOf(numerator, denominator) { return denominator > 0 ? numerator / denominator : 0; }

function findWinners(groupedPosts) {
  const combinedRated = groupedPosts.filter(p => combinedOf(p) > 0);
  const avgCombinedRate = combinedRated.length
    ? combinedRated.reduce((t, p) => t + rateOf(Number(p.reactions_total) || 0, combinedOf(p)), 0) / combinedRated.length
    : 0;
  const avgCombinedVolume = combinedRated.length
    ? combinedRated.reduce((t, p) => t + combinedOf(p), 0) / combinedRated.length
    : 0;

  const reachRated = groupedPosts.filter(p => (Number(p.reach) || 0) > 0);
  const avgReachRate = reachRated.length
    ? reachRated.reduce((t, p) => t + rateOf(Number(p.reactions_total) || 0, Number(p.reach) || 0), 0) / reachRated.length
    : 0;

  // Three signals, any one qualifies — matches admin-dashboard.html's 🏆
  // badge exactly: reaction-rate efficiency (combined and reach-only), plus
  // the "usual" way of picking a winner — raw Views+Reach volume.
  return groupedPosts.filter(p => {
    const reactions = Number(p.reactions_total) || 0;
    const combined = combinedOf(p);
    const combinedRate = rateOf(reactions, combined);
    const reachRate = rateOf(reactions, Number(p.reach) || 0);
    const isCombinedWinner = avgCombinedRate > 0 && combinedRate >= avgCombinedRate * WINNER_MULTIPLIER;
    const isReachWinner = avgReachRate > 0 && reachRate >= avgReachRate * WINNER_MULTIPLIER;
    const isVolumeWinner = avgCombinedVolume > 0 && combined >= avgCombinedVolume * WINNER_MULTIPLIER;
    return isCombinedWinner || isReachWinner || isVolumeWinner;
  });
}

// ═══════════════════════════════════════════════════════════════
// CREATIVE SHEET — public CSV export, no auth. Sheet must be shared
// "Anyone with the link" for this to work from a GitHub Actions runner.
// ═══════════════════════════════════════════════════════════════

function parseCsvLine(line) {
  // Minimal CSV parser handling quoted fields with embedded commas/quotes —
  // sufficient for Google Sheets' CSV export, not a general-purpose parser.
  const fields = [];
  let cur = '', inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') { inQuotes = false; }
      else { cur += c; }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { fields.push(cur); cur = ''; }
      else cur += c;
    }
  }
  fields.push(cur);
  return fields;
}

function parseCsv(text) {
  const lines = text.split(/\r\n|\n/).filter(l => l.length > 0);
  const rows = lines.map(parseCsvLine);
  const header = rows[0].map(h => h.trim());
  return rows.slice(1).map(row => {
    const obj = {};
    header.forEach((h, i) => { obj[h] = row[i] !== undefined ? row[i] : ''; });
    return obj;
  });
}

async function fetchCreativeSheetRows() {
  const url = `https://docs.google.com/spreadsheets/d/${CREATIVE_SHEET_ID}/gviz/tq?tqx=out:csv&gid=${CREATIVE_SHEET_GID}`;
  const res = await fetch(url);
  const text = await res.text();
  if (!res.ok || text.trim().startsWith('<')) {
    console.warn('Could not read the creative sheet as CSV (likely not shared "Anyone with the link"). Sheet-matching will be skipped for this run.');
    return [];
  }
  return parseCsv(text);
}

function normalizeText(text) {
  return (text || '')
    .replace(/https?:\/\/\S+/g, ' ')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function fuzzyMatch(a, b) {
  const na = normalizeText(a), nb = normalizeText(b);
  if (!na || !nb) return false;
  if (na.includes(nb) || nb.includes(na)) return true;
  const wa = new Set(na.split(' ')), wb = new Set(nb.split(' '));
  const intersection = [...wa].filter(w => wb.has(w)).length;
  const overlap = intersection / Math.min(wa.size, wb.size);
  return overlap >= 0.6;
}

function findSheetMatch(sheetRows, postMessage) {
  return sheetRows.find(row => row['Primary Text'] && fuzzyMatch(row['Primary Text'], postMessage)) || null;
}

function extractCtaLink(primaryText) {
  const matches = (primaryText || '').match(/https?:\/\/[^\s)]+/g);
  if (!matches || matches.length === 0) return null;
  return matches[matches.length - 1].replace(/[.,;]+$/, '');
}

function extractDriveFileId(driveUrl) {
  const m = (driveUrl || '').match(/\/file\/d\/([a-zA-Z0-9_-]+)/) || (driveUrl || '').match(/[?&]id=([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

// ═══════════════════════════════════════════════════════════════
// GRAPH API HELPERS
// ═══════════════════════════════════════════════════════════════

async function graphGet(path, params, token = ADS_ACCESS_TOKEN) {
  const url = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  url.searchParams.set('access_token', token);
  const res = await fetch(url);
  const json = await res.json();
  if (json.error) throw new Error(`GET ${path}: ${json.error.message}`);
  return json;
}

async function graphPost(path, body) {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${path}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, access_token: ADS_ACCESS_TOKEN }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`POST ${path}: ${json.error.message}`);
  return json;
}

async function findInstagramAccountId() {
  // Guard against the easy copy-paste mistake of setting META_IG_USER_ID to
  // the Facebook Page ID instead of the actual IG business account ID —
  // that produces exactly "Param instagram_actor_id must be a valid
  // Instagram account id" on every single ad, since a Page ID isn't a valid
  // IG account ID.
  if (IG_USER_ID_OVERRIDE && IG_USER_ID_OVERRIDE !== PAGE_ID) return IG_USER_ID_OVERRIDE;
  if (IG_USER_ID_OVERRIDE === PAGE_ID) {
    console.warn('META_IG_USER_ID is set to the same value as META_PAGE_ID — that\'s almost certainly a mistake (should be the IG business account ID, not the Page ID). Ignoring the override and auto-discovering instead.');
  }
  const data = await graphGet(PAGE_ID, { fields: 'instagram_business_account' }, PAGE_SCOPED_TOKEN);
  return data.instagram_business_account?.id || null;
}

async function uploadAdImage(imageBytes, filename) {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${AD_ACCOUNT_ID}/adimages`;
  const form = new FormData();
  form.append('access_token', ADS_ACCESS_TOKEN);
  form.append(filename, new Blob([imageBytes]), filename);
  const res = await fetch(url, { method: 'POST', body: form });
  const json = await res.json();
  if (json.error) throw new Error(`adimages upload: ${json.error.message}`);
  const entry = Object.values(json.images || {})[0];
  if (!entry?.hash) throw new Error('adimages upload: no hash returned');
  return entry.hash;
}

// ═══════════════════════════════════════════════════════════════
// CREATIVE BUILDERS
// ═══════════════════════════════════════════════════════════════

async function buildCreativeFromSheetRow(row, igUserId) {
  const mediaType = (row['Image or Video'] || '').trim().toLowerCase();
  if (mediaType === 'video') {
    console.log('  Sheet match is a video — video creative upload isn\'t implemented, falling back to reused-post.');
    return null;
  }

  const driveFileId = extractDriveFileId(row['URL']);
  if (!driveFileId) { console.log('  Sheet match has no usable Drive URL — falling back to reused-post.'); return null; }

  const ctaLink = extractCtaLink(row['Primary Text']) || KAPRUKA_HOME_URL;
  const message = (row['Primary Text'] || '').trim();

  console.log(`  Sheet match: Content ID ${row['Content ID'] || '?'}, CTA link -> ${ctaLink}`);

  if (DRY_RUN) {
    return { source: 'sheet_match', contentId: row['Content ID'] || null, ctaLink, message, dryRunNote: `would download Drive file ${driveFileId}, upload as ad image, build link_data creative` };
  }

  const downloadRes = await fetch(`https://drive.google.com/uc?export=download&id=${driveFileId}`);
  const contentType = downloadRes.headers.get('content-type') || '';
  if (!downloadRes.ok || contentType.includes('text/html')) {
    console.log('  Could not download the Drive file directly (not publicly shared?) — falling back to reused-post.');
    return null;
  }
  const imageBytes = Buffer.from(await downloadRes.arrayBuffer());
  const hash = await uploadAdImage(imageBytes, `${driveFileId}.jpg`);

  const linkData = {
    message, link: ctaLink, image_hash: hash,
    call_to_action: { type: 'SHOP_NOW', value: { link: ctaLink } },
  };

  let creative;
  try {
    creative = await graphPost(`${AD_ACCOUNT_ID}/adcreatives`, {
      name: `Organic Winner (sheet) - ${row['Content ID'] || driveFileId}`,
      object_story_spec: { page_id: PAGE_ID, ...(igUserId ? { instagram_actor_id: igUserId } : {}), link_data: linkData },
    });
  } catch (e) {
    // The ad account not being connected to the IG account in Business
    // Manager (a config issue, not something code can fix) shows up as this
    // exact error — fall back to Facebook-only rather than losing the whole
    // ad over it.
    if (igUserId && /instagram_actor_id/i.test(e.message)) {
      console.log('  IG placement rejected (ad account likely not connected to the IG account in Business Manager) — retrying Facebook-only.');
      creative = await graphPost(`${AD_ACCOUNT_ID}/adcreatives`, {
        name: `Organic Winner (sheet, FB-only) - ${row['Content ID'] || driveFileId}`,
        object_story_spec: { page_id: PAGE_ID, link_data: linkData },
      });
    } else {
      throw e;
    }
  }

  return { source: 'sheet_match', contentId: row['Content ID'] || null, ctaLink, message, creativeId: creative.id };
}

async function buildCreativeFromExistingPost(group, igUserId) {
  const ctaLink = KAPRUKA_HOME_URL;

  if (DRY_RUN) {
    return { source: 'reused_post', ctaLink, dryRunNote: `would reuse ${group.fbPostId ? 'FB post ' + group.fbPostId : 'IG media ' + group.igPostId} as creative` };
  }

  if (group.fbPostId) {
    // group.fbPostId already comes from the Graph API in composite
    // "{page_id}_{post_id}" form (confirmed against a live post) — prepending
    // PAGE_ID again here produced a doubled, invalid ID and every reused-FB-post
    // ad failed with "(#100) Invalid post_id parameter".
    const creative = await graphPost(`${AD_ACCOUNT_ID}/adcreatives`, {
      name: `Organic Winner (reused FB post) - ${group.fbPostId}`,
      object_story_id: group.fbPostId,
      call_to_action: { type: 'SHOP_NOW', value: { link: ctaLink } },
    });
    return { source: 'reused_post', ctaLink, creativeId: creative.id };
  }

  if (group.igPostId && igUserId) {
    // NOTE: CTA override isn't officially documented for source_instagram_media_id
    // creatives — verify the resulting ad actually shows "Shop Now" before relying
    // on this for IG-only winners.
    const creative = await graphPost(`${AD_ACCOUNT_ID}/adcreatives`, {
      name: `Organic Winner (reused IG post) - ${group.igPostId}`,
      object_id: PAGE_ID,
      instagram_actor_id: igUserId,
      source_instagram_media_id: group.igPostId,
      call_to_action: { type: 'SHOP_NOW', value: { link: ctaLink } },
    });
    return { source: 'reused_post', ctaLink, creativeId: creative.id };
  }

  throw new Error('Group has neither an FB post_id nor a usable IG post_id — cannot build a reused-post creative.');
}

async function createAd(creativeId, name) {
  if (DRY_RUN) { console.log(`  [dry-run] would create ad "${name}" in ad set ${TARGET_ADSET_ID} with creative ${creativeId}, status ACTIVE`); return { id: '[dry-run]' }; }
  return graphPost(`${AD_ACCOUNT_ID}/ads`, {
    name,
    adset_id: TARGET_ADSET_ID,
    creative: { creative_id: creativeId },
    status: 'ACTIVE',
  });
}

// ═══════════════════════════════════════════════════════════════
// WHATSAPP SUMMARY (optional, best-effort)
// ═══════════════════════════════════════════════════════════════

async function sendWhatsAppAlert(message) {
  const phoneId = process.env.WHATSAPP_PHONE_ID, token = process.env.WHATSAPP_ACCESS_TOKEN, to = process.env.WHATSAPP_TO;
  if (!phoneId || !token || !to) return;
  try {
    await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${phoneId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: message } }),
    });
  } catch (e) {
    console.warn('WhatsApp alert failed (non-fatal):', e.message);
  }
}

// ═══════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════

async function main() {
  console.log(`========== WEEKLY ORGANIC WINNERS → ADS ${DRY_RUN ? '[DRY RUN]' : ''} ==========`);

  const [posts, sheetRows, alreadyPushed, igUserId] = await Promise.all([
    fetchRecentPerformance(),
    fetchCreativeSheetRows(),
    DRY_RUN ? new Set() : fetchAlreadyPushedKeys(),
    DRY_RUN ? Promise.resolve(null) : findInstagramAccountId(),
  ]);

  console.log(`Fetched ${posts.length} posts from the last ${LOOKBACK_DAYS} days. Sheet rows: ${sheetRows.length}.`);

  const grouped = groupPosts(posts);
  const winners = findWinners(grouped).filter(w => !alreadyPushed.has(w.key));

  console.log(`${winners.length} new winner(s) to push (already-pushed winners skipped for idempotency).`);

  const results = { created: 0, failed: 0, skipped: 0 };

  for (const group of winners) {
    console.log(`\n→ ${group.message?.slice(0, 80) || '(no caption)'} [${group.platforms.join('+')}]`);
    try {
      const sheetMatch = findSheetMatch(sheetRows, group.message);
      let built = sheetMatch ? await buildCreativeFromSheetRow(sheetMatch, igUserId) : null;
      if (!built) {
        if (!sheetMatch) console.log('  No sheet match — reusing existing organic post.');
        built = await buildCreativeFromExistingPost(group, igUserId);
      }

      if (DRY_RUN) {
        console.log(`  [dry-run] ${built.dryRunNote}, CTA -> ${built.ctaLink}`);
        results.created++;
        continue;
      }

      const ad = await createAd(built.creativeId, `Organic Winner - ${group.key.slice(0, 60)}`);
      await recordPush({
        group_key: group.key,
        platforms: group.platforms.join(','),
        message_excerpt: (group.message || '').slice(0, 200),
        creative_source: built.source,
        matched_content_id: built.contentId || null,
        cta_link: built.ctaLink,
        ad_id: ad.id,
        adset_id: TARGET_ADSET_ID,
      });
      console.log(`  ✅ Created ad ${ad.id} (${built.source})`);
      results.created++;
    } catch (e) {
      console.error(`  ❌ Failed: ${e.message}`);
      results.failed++;
    }
  }

  const summary = `Organic Winners → Ads: ${results.created} created, ${results.failed} failed, ${winners.length - results.created - results.failed} skipped. (${DRY_RUN ? 'dry run' : 'live'})`;
  console.log(`\n${summary}`);
  if (!DRY_RUN) await sendWhatsAppAlert(summary);
}

main().catch((err) => {
  console.error('Weekly organic winners → ads job failed:', err.message);
  process.exit(1);
});
