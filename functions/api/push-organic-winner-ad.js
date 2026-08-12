// functions/api/push-organic-winner-ad.js
// ============================================================================
//  PUSH ORGANIC WINNER → LIVE AD  (manual, one-click, from the admin dashboard)
//
//  Same job as scripts/weekly-organic-winners-to-ads.js (the Monday cron),
//  but for a single post on demand, triggered by the "🚀 Push Now" button in
//  the "Queued for Weekly Ad Push" card. Runs server-side as a Cloudflare
//  Pages Function — same infra as functions/api/posting-calendar.js — so the
//  Meta ads token never touches the browser. The whole site (including
//  /api/*) sits behind functions/_middleware.js's Basic Auth, so this
//  endpoint is not publicly reachable.
//
//  WHY A SEPARATE COPY OF THE WINNER/SHEET-MATCH LOGIC:
//  This mirrors admin-dashboard.html's grouping/winner criteria AND
//  scripts/weekly-organic-winners-to-ads.js's sheet-matching/creative-build
//  logic. There's no shared build step in this project (plain <script> tags,
//  plain function files, no bundler) to import a common module across a
//  browser page, a Node script, and a Workers isolate — so all three copies
//  must be kept in sync by hand if the winner criteria or matching logic
//  ever changes.
//
//  ADVANTAGE OVER THE NODE SCRIPT: this endpoint reads the creative sheet
//  and downloads Drive images using the SAME authenticated Google token
//  functions/api/posting-calendar.js already uses (GOOGLE_CLIENT_ID/SECRET/
//  REFRESH_TOKEN, scoped to spreadsheets + drive.readonly) — so, unlike the
//  Node script, it does NOT require the sheet or its Drive files to be
//  publicly link-shared.
//
//  Env vars required (Cloudflare Pages secrets — separate from the GitHub
//  Actions secrets used by the weekly cron; both must be set independently):
//    GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN
//                            — already configured for posting-calendar.js
//    CONTENT_SHEET_ID        — already configured; same creative sheet
//    META_ADS_ACCESS_TOKEN   — token with ads_management scope
//    META_AD_ACCOUNT_ID      — e.g. 'act_1234567890'
//    META_PAGE_ID            — Facebook Page ID
//  Optional:
//    META_IG_USER_ID         — Instagram Business Account ID (auto-discovered if unset)
//    TARGET_ADSET_ID         — defaults to 52816670204854
//    KAPRUKA_HOME_URL        — defaults to https://www.kapruka.com
//
//  Ads are created with status ACTIVE — clicking "Push Now" spends the ad
//  set's budget immediately, same as the Monday cron, per the team's
//  explicit choice.
// ============================================================================

const CREATIVE_SHEET_GID = '275837150';
const GRAPH_VERSION = 'v21.0';
const LOOKBACK_DAYS = 7;
const WINNER_MULTIPLIER = 1.5;

const SUPABASE_URL = 'https://ivllhheqqiseagmctfyp.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml2bGxoaGVxcWlzZWFnbWN0ZnlwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg1NzQzMzksImV4cCI6MjA4NDE1MDMzOX0.OnkYNACtdknKDY2KqLfiGN0ORXpKaW906fD0TtSJlIk';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

// ── Supabase ─────────────────────────────────────────────────────────────
async function supabaseQuery(endpoint, method = 'GET', body = null, prefer = 'return=representation') {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${endpoint}`, {
    method,
    headers: {
      apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY,
      'Content-Type': 'application/json', Prefer: prefer,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error('Supabase error: ' + text);
  return text ? JSON.parse(text) : [];
}

// ── Google OAuth (same pattern as posting-calendar.js) ──────────────────
async function getGoogleAccessToken(env) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: env.GOOGLE_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error('Google auth failed: ' + JSON.stringify(body));
  return body.access_token;
}

async function sheetsGetCsvRows(env, token) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${env.CONTENT_SHEET_ID}?fields=sheets.properties`;
  const metaRes = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  const meta = await metaRes.json();
  if (!metaRes.ok) throw new Error('Sheets metadata read failed: ' + JSON.stringify(meta));
  const sheet = (meta.sheets || []).find(s => String(s.properties.sheetId) === CREATIVE_SHEET_GID);
  if (!sheet) throw new Error(`Could not find sheet tab with gid ${CREATIVE_SHEET_GID}`);
  const title = sheet.properties.title;

  const valuesUrl = `https://sheets.googleapis.com/v4/spreadsheets/${env.CONTENT_SHEET_ID}/values/${encodeURIComponent(title)}?valueRenderOption=UNFORMATTED_VALUE`;
  const valuesRes = await fetch(valuesUrl, { headers: { Authorization: 'Bearer ' + token } });
  const valuesBody = await valuesRes.json();
  if (!valuesRes.ok) throw new Error('Sheets read failed: ' + JSON.stringify(valuesBody));

  const rows = valuesBody.values || [];
  const header = (rows[0] || []).map(h => String(h).trim());
  return rows.slice(1).map(row => {
    const obj = {};
    header.forEach((h, i) => { obj[h] = row[i] !== undefined ? String(row[i]) : ''; });
    return obj;
  });
}

async function downloadDriveFile(token, fileId) {
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: { Authorization: 'Bearer ' + token },
  });
  if (!res.ok) throw new Error(`Drive download failed for ${fileId}: ${res.status} ${await res.text()}`);
  return res.arrayBuffer();
}

// ── Grouping + winner scoring — MUST mirror admin-dashboard.html exactly ──
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
      if (p[k] !== null && p[k] !== undefined && !Number.isNaN(Number(p[k]))) g[k] = (g[k] || 0) + Number(p[k]);
    }
  }
  return Array.from(groups.values());
}

function combinedOf(p) { return (Number(p.impressions) || 0) + (Number(p.reach) || 0); }
function rateOf(n, d) { return d > 0 ? n / d : 0; }

function isWinner(group, groupedPosts) {
  const combinedRated = groupedPosts.filter(p => combinedOf(p) > 0);
  const avgCombinedRate = combinedRated.length ? combinedRated.reduce((t, p) => t + rateOf(Number(p.reactions_total) || 0, combinedOf(p)), 0) / combinedRated.length : 0;
  const avgCombinedVolume = combinedRated.length ? combinedRated.reduce((t, p) => t + combinedOf(p), 0) / combinedRated.length : 0;
  const reachRated = groupedPosts.filter(p => (Number(p.reach) || 0) > 0);
  const avgReachRate = reachRated.length ? reachRated.reduce((t, p) => t + rateOf(Number(p.reactions_total) || 0, Number(p.reach) || 0), 0) / reachRated.length : 0;

  const reactions = Number(group.reactions_total) || 0;
  const combined = combinedOf(group);
  const combinedRate = rateOf(reactions, combined);
  const reachRate = rateOf(reactions, Number(group.reach) || 0);
  return (avgCombinedRate > 0 && combinedRate >= avgCombinedRate * WINNER_MULTIPLIER)
    || (avgReachRate > 0 && reachRate >= avgReachRate * WINNER_MULTIPLIER)
    || (avgCombinedVolume > 0 && combined >= avgCombinedVolume * WINNER_MULTIPLIER);
}

// ── Sheet matching ────────────────────────────────────────────────────────
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
  return intersection / Math.min(wa.size, wb.size) >= 0.6;
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

// ── Meta Graph API helpers ───────────────────────────────────────────────
async function graphGet(env, path, params) {
  const url = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  url.searchParams.set('access_token', env.META_ADS_ACCESS_TOKEN);
  const res = await fetch(url);
  const body = await res.json();
  if (body.error) throw new Error(`GET ${path}: ${body.error.message}`);
  return body;
}

async function graphPost(env, path, payload) {
  const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, access_token: env.META_ADS_ACCESS_TOKEN }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`POST ${path}: ${body.error.message}`);
  return body;
}

async function findInstagramAccountId(env) {
  if (env.META_IG_USER_ID) return env.META_IG_USER_ID;
  const data = await graphGet(env, env.META_PAGE_ID, { fields: 'instagram_business_account' });
  return data.instagram_business_account?.id || null;
}

async function uploadAdImage(env, imageBytes, filename) {
  const form = new FormData();
  form.append('access_token', env.META_ADS_ACCESS_TOKEN);
  form.append(filename, new Blob([imageBytes]), filename);
  const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${env.META_AD_ACCOUNT_ID}/adimages`, { method: 'POST', body: form });
  const body = await res.json();
  if (body.error) throw new Error(`adimages upload: ${body.error.message}`);
  const entry = Object.values(body.images || {})[0];
  if (!entry?.hash) throw new Error('adimages upload: no hash returned');
  return entry.hash;
}

// ── Creative builders ─────────────────────────────────────────────────────
async function buildCreativeFromSheetRow(env, googleToken, row, igUserId) {
  const mediaType = (row['Image or Video'] || '').trim().toLowerCase();
  if (mediaType === 'video') return null; // video ad-creative upload not implemented

  const driveFileId = extractDriveFileId(row['URL']);
  if (!driveFileId) return null;

  const homeUrl = env.KAPRUKA_HOME_URL || 'https://www.kapruka.com';
  const ctaLink = extractCtaLink(row['Primary Text']) || homeUrl;
  const message = (row['Primary Text'] || '').trim();

  const imageBytes = await downloadDriveFile(googleToken, driveFileId);
  const hash = await uploadAdImage(env, imageBytes, `${driveFileId}.jpg`);

  const creative = await graphPost(env, `${env.META_AD_ACCOUNT_ID}/adcreatives`, {
    name: `Organic Winner (sheet) - ${row['Content ID'] || driveFileId}`,
    object_story_spec: {
      page_id: env.META_PAGE_ID,
      ...(igUserId ? { instagram_actor_id: igUserId } : {}),
      link_data: {
        message, link: ctaLink, image_hash: hash,
        call_to_action: { type: 'SHOP_NOW', value: { link: ctaLink } },
      },
    },
  });

  return { source: 'sheet_match', contentId: row['Content ID'] || null, ctaLink, message, creativeId: creative.id };
}

async function buildCreativeFromExistingPost(env, group, igUserId) {
  const ctaLink = env.KAPRUKA_HOME_URL || 'https://www.kapruka.com';

  if (group.fbPostId) {
    const creative = await graphPost(env, `${env.META_AD_ACCOUNT_ID}/adcreatives`, {
      name: `Organic Winner (reused FB post) - ${group.fbPostId}`,
      object_story_id: `${env.META_PAGE_ID}_${group.fbPostId}`,
      call_to_action: { type: 'SHOP_NOW', value: { link: ctaLink } },
    });
    return { source: 'reused_post', ctaLink, creativeId: creative.id };
  }

  if (group.igPostId && igUserId) {
    const creative = await graphPost(env, `${env.META_AD_ACCOUNT_ID}/adcreatives`, {
      name: `Organic Winner (reused IG post) - ${group.igPostId}`,
      object_id: env.META_PAGE_ID,
      instagram_actor_id: igUserId,
      source_instagram_media_id: group.igPostId,
      call_to_action: { type: 'SHOP_NOW', value: { link: ctaLink } },
    });
    return { source: 'reused_post', ctaLink, creativeId: creative.id };
  }

  throw new Error('Group has neither an FB post_id nor a usable IG post_id.');
}

// ── Main handler ────────────────────────────────────────────────────────
export async function onRequestPost(context) {
  const { env, request } = context;
  try {
    const { group_key } = await request.json();
    if (!group_key) return json({ error: 'group_key is required' }, 400);

    for (const required of ['META_ADS_ACCESS_TOKEN', 'META_AD_ACCOUNT_ID', 'META_PAGE_ID']) {
      if (!env[required]) return json({ error: `Server is missing the ${required} secret — ask an admin to configure it in Cloudflare Pages settings.` }, 500);
    }

    const alreadyPushed = await supabaseQuery(`organic_winner_ad_pushes?group_key=eq.${encodeURIComponent(group_key)}&select=ad_id`);
    if (alreadyPushed.length) return json({ error: 'This post has already been pushed to an ad.', adId: alreadyPushed[0].ad_id }, 409);

    const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const posts = await supabaseQuery(`facebook_post_performance?created_time=gte.${encodeURIComponent(since)}&order=created_time.desc&limit=500`);
    const grouped = groupPosts(posts);
    const group = grouped.find(g => g.key === group_key);
    if (!group) return json({ error: 'That post was not found in the last 7 days of synced performance data.' }, 404);
    if (!isWinner(group, grouped)) return json({ error: 'That post no longer qualifies as a Winner (performance data may have shifted since the page loaded — refresh and retry).' }, 409);

    const adsetId = env.TARGET_ADSET_ID || '52816670204854';
    const googleToken = await getGoogleAccessToken(env);
    const [sheetRows, igUserId] = await Promise.all([
      sheetsGetCsvRows(env, googleToken).catch(e => { console.warn('Sheet read failed, will fall back to reused-post:', e.message); return []; }),
      findInstagramAccountId(env),
    ]);

    const sheetMatch = sheetRows.find(row => row['Primary Text'] && fuzzyMatch(row['Primary Text'], group.message));
    let built = sheetMatch ? await buildCreativeFromSheetRow(env, googleToken, sheetMatch, igUserId) : null;
    if (!built) built = await buildCreativeFromExistingPost(env, group, igUserId);

    const ad = await graphPost(env, `${env.META_AD_ACCOUNT_ID}/ads`, {
      name: `Organic Winner - ${group.key.slice(0, 60)}`,
      adset_id: adsetId,
      creative: { creative_id: built.creativeId },
      status: 'ACTIVE',
    });

    await supabaseQuery('organic_winner_ad_pushes', 'POST', {
      group_key: group.key,
      platforms: group.platforms.join(','),
      message_excerpt: (group.message || '').slice(0, 200),
      creative_source: built.source,
      matched_content_id: built.contentId || null,
      cta_link: built.ctaLink,
      ad_id: ad.id,
      adset_id: adsetId,
    }, 'return=minimal');

    return json({ ok: true, adId: ad.id, source: built.source, ctaLink: built.ctaLink });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}
