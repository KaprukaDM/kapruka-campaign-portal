// functions/api/push-organic-winner-ad.js
// ============================================================================
//  PUSH ORGANIC WINNER → LIVE AD  (manual, one-click, from the admin dashboard)
//
//  Same job as scripts/weekly-organic-winners-to-ads.js (the Monday cron),
//  but for a single post on demand, triggered by either the "🚀 Push Now"
//  button in the "Queued for Weekly Ad Push" card (🏆 Winners only), or the
//  per-row "🚀 Push to Ads" button on the full Organic Social Performance
//  table (any synced post — no Winner requirement; a human explicitly
//  chose it). Runs server-side as a Cloudflare Pages Function — same infra
//  as functions/api/posting-calendar.js — so the Meta ads token never
//  touches the browser. The whole site (including /api/*) sits behind
//  functions/_middleware.js's Basic Auth, so this endpoint is not publicly
//  reachable.
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
//  and downloads Drive images/videos using the SAME authenticated Google
//  token functions/api/posting-calendar.js already uses (GOOGLE_CLIENT_ID/
//  SECRET/REFRESH_TOKEN, scoped to spreadsheets + drive.readonly) — so,
//  unlike the Node script, it does NOT require the sheet or its Drive files
//  to be publicly link-shared.
//
//  VIDEO/REEL HANDLING: video winners are uploaded as native video ads
//  (/advideos), but this is a synchronous HTTP request with a real timeout,
//  so the wait for Meta to finish processing the video is capped short (see
//  waitForVideoReady). If it doesn't finish in time, this endpoint falls
//  back to the next option rather than hanging the click — the weekly cron
//  (scripts/weekly-organic-winners-to-ads.js), which has no such timeout,
//  will still pick the same video up cleanly on its own run.
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
async function graphGet(env, path, params, token = env.META_ADS_ACCESS_TOKEN) {
  const url = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  url.searchParams.set('access_token', token);
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
  // Guard against the easy copy-paste mistake of setting META_IG_USER_ID to
  // the Facebook Page ID instead of the actual IG business account ID —
  // that produces exactly "Param instagram_actor_id must be a valid
  // Instagram account id" on every ad, since a Page ID isn't a valid IG ID.
  if (env.META_IG_USER_ID && env.META_IG_USER_ID !== env.META_PAGE_ID) return env.META_IG_USER_ID;
  // META_ADS_ACCESS_TOKEN (ads/User-type token) can't see page-scoped fields
  // like instagram_business_account — the call succeeds but the field is
  // silently absent, not an error. A real Page token is required.
  const pageScopedToken = env.META_PAGE_ACCESS_TOKEN || env.META_ADS_ACCESS_TOKEN;
  const data = await graphGet(env, env.META_PAGE_ID, { fields: 'instagram_business_account' }, pageScopedToken);
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

async function uploadAdVideo(env, videoBytes, filename) {
  const form = new FormData();
  form.append('access_token', env.META_ADS_ACCESS_TOKEN);
  form.append('source', new Blob([videoBytes]), filename);
  const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${env.META_AD_ACCOUNT_ID}/advideos`, { method: 'POST', body: form });
  const body = await res.json();
  if (body.error) throw new Error(`advideos upload: ${body.error.message}`);
  if (!body.id) throw new Error('advideos upload: no video id returned');
  return body.id;
}

// A Pages Function has a request lifetime, unlike the cron script — so this
// polls for a much shorter budget. If the video isn't done processing in
// time, the caller treats it the same as "couldn't build a video creative"
// and falls back to the next option (reused-post) rather than blocking the
// click. The upload itself already happened and keeps processing on Meta's
// side either way; it's just not used for this particular push.
async function waitForVideoReady(env, videoId, timeoutMs = 25000, intervalMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const data = await graphGet(env, videoId, { fields: 'status' });
    const status = data.status?.video_status;
    if (status === 'ready') return true;
    if (status === 'error') throw new Error(`Meta rejected the uploaded video: ${JSON.stringify(data.status)}`);
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return false;
}

async function buildVideoData(env, videoBytes, namePrefix, ctaLink, providedThumbnailUrl) {
  const videoId = await uploadAdVideo(env, videoBytes, `${namePrefix}.mp4`);
  const ready = await waitForVideoReady(env, videoId);
  if (!ready) throw new Error(`video ${videoId} is still processing — it'll be usable shortly, but not within this request`);

  let imageHash = null;
  if (providedThumbnailUrl) {
    try {
      const thumbRes = await fetch(providedThumbnailUrl);
      if (thumbRes.ok) imageHash = await uploadAdImage(env, await thumbRes.arrayBuffer(), `${namePrefix}_thumb.jpg`);
    } catch (e) { /* fall through to Meta-generated thumbnail below */ }
  }
  if (!imageHash) {
    const thumbs = await graphGet(env, `${videoId}/thumbnails`, {});
    const picked = thumbs.data?.find(t => t.is_preferred) || thumbs.data?.[0];
    if (picked?.uri) {
      const thumbRes = await fetch(picked.uri);
      if (thumbRes.ok) imageHash = await uploadAdImage(env, await thumbRes.arrayBuffer(), `${namePrefix}_autothumb.jpg`);
    }
  }
  if (!imageHash) throw new Error('could not obtain a thumbnail image for the video ad');

  return { video_id: videoId, image_hash: imageHash, call_to_action: { type: 'SHOP_NOW', value: { link: ctaLink } } };
}

// ── Creative builders ─────────────────────────────────────────────────────
async function buildCreativeFromSheetRow(env, googleToken, row, igUserId) {
  const mediaType = (row['Image or Video'] || '').trim().toLowerCase();
  const driveFileId = extractDriveFileId(row['URL']);
  if (!driveFileId) return null;

  const homeUrl = env.KAPRUKA_HOME_URL || 'https://www.kapruka.com';
  const ctaLink = extractCtaLink(row['Primary Text']) || homeUrl;
  const message = (row['Primary Text'] || '').trim();

  if (mediaType === 'video') {
    const videoBytes = await downloadDriveFile(googleToken, driveFileId);
    let videoData;
    try {
      videoData = await buildVideoData(env, videoBytes, driveFileId, ctaLink, null);
    } catch (e) {
      console.warn('Sheet video upload/processing did not finish in time, falling back:', e.message);
      return null;
    }
    let creative;
    try {
      creative = await graphPost(env, `${env.META_AD_ACCOUNT_ID}/adcreatives`, {
        name: `Organic Winner (sheet video) - ${row['Content ID'] || driveFileId}`,
        object_story_spec: { page_id: env.META_PAGE_ID, ...(igUserId ? { instagram_actor_id: igUserId } : {}), video_data: { ...videoData, link_description: message } },
      });
    } catch (e) {
      if (igUserId && /instagram_actor_id/i.test(e.message)) {
        creative = await graphPost(env, `${env.META_AD_ACCOUNT_ID}/adcreatives`, {
          name: `Organic Winner (sheet video, FB-only) - ${row['Content ID'] || driveFileId}`,
          object_story_spec: { page_id: env.META_PAGE_ID, video_data: { ...videoData, link_description: message } },
        });
      } else {
        throw e;
      }
    }
    return { source: 'sheet_match_video', contentId: row['Content ID'] || null, ctaLink, message, creativeId: creative.id };
  }

  const imageBytes = await downloadDriveFile(googleToken, driveFileId);
  const hash = await uploadAdImage(env, imageBytes, `${driveFileId}.jpg`);

  const linkData = {
    message, link: ctaLink, image_hash: hash,
    call_to_action: { type: 'SHOP_NOW', value: { link: ctaLink } },
  };

  let creative;
  try {
    creative = await graphPost(env, `${env.META_AD_ACCOUNT_ID}/adcreatives`, {
      name: `Organic Winner (sheet) - ${row['Content ID'] || driveFileId}`,
      object_story_spec: { page_id: env.META_PAGE_ID, ...(igUserId ? { instagram_actor_id: igUserId } : {}), link_data: linkData },
    });
  } catch (e) {
    // The ad account not being connected to the IG account in Business
    // Manager (a config issue, not something code can fix) shows up as this
    // exact error — fall back to Facebook-only rather than losing the whole ad.
    if (igUserId && /instagram_actor_id/i.test(e.message)) {
      creative = await graphPost(env, `${env.META_AD_ACCOUNT_ID}/adcreatives`, {
        name: `Organic Winner (sheet, FB-only) - ${row['Content ID'] || driveFileId}`,
        object_story_spec: { page_id: env.META_PAGE_ID, link_data: linkData },
      });
    } else {
      throw e;
    }
  }

  return { source: 'sheet_match', contentId: row['Content ID'] || null, ctaLink, message, creativeId: creative.id };
}

async function fetchPostMediaInfo(env, postId, isIg, pageScopedToken) {
  if (isIg) {
    const media = await graphGet(env, postId, { fields: 'media_url,thumbnail_url,media_type,media_product_type' }, pageScopedToken);
    const isVideo = media.media_type === 'VIDEO' || media.media_product_type === 'REELS';
    return {
      isVideo,
      imageUrl: media.media_url || media.thumbnail_url || null,
      videoUrl: isVideo ? (media.media_url || null) : null,
      thumbnailUrl: media.thumbnail_url || null,
    };
  }
  const post = await graphGet(env, postId, { fields: 'full_picture,attachments{media_type,target}' }, pageScopedToken);
  const attachment = post.attachments?.data?.[0];
  const isVideo = attachment?.media_type === 'video';
  let videoUrl = null, thumbnailUrl = post.full_picture || null;
  if (isVideo && attachment?.target?.id) {
    try {
      const video = await graphGet(env, attachment.target.id, { fields: 'source,picture' }, pageScopedToken);
      videoUrl = video.source || null;
      thumbnailUrl = video.picture || thumbnailUrl;
    } catch (e) { /* fall through with no videoUrl — caller bails to fallback */ }
  }
  return { isVideo, imageUrl: post.full_picture || null, videoUrl, thumbnailUrl };
}

// Rebuilds a fresh ad (image link_data, or native video_data for
// video/Reels) from the post's OWN media, instead of reusing the post as an
// object (object_story_id / source_instagram_media_id) — that reuse path
// requires the ad account to be formally assigned the Page as a Business
// Manager asset, which isn't set up on this account (confirmed live:
// /act_.../promote_pages returns empty, and object_story_id fails with
// "Post not owned by ad's Page"). Creating brand-new content that merely
// references the Page works under a much looser permission level — this
// reproduces that same working shape instead of failing.
//
// Video path has a short processing-wait budget (see waitForVideoReady) —
// if a video doesn't finish in time within this request, this bails to the
// next fallback rather than hanging the "Push Now" click. The weekly cron
// (scripts/weekly-organic-winners-to-ads.js) has no such constraint and will
// pick up the same video cleanly on its own run.
async function buildCreativeFromLivePost(env, group, igUserId) {
  const postId = group.fbPostId || group.igPostId;
  if (!postId) return null;
  const isIg = !group.fbPostId && !!group.igPostId;
  const ctaLink = extractCtaLink(group.message) || env.KAPRUKA_HOME_URL || 'https://www.kapruka.com';
  const message = (group.message || '').slice(0, 600);
  const safeName = postId.replace(/[^a-zA-Z0-9]/g, '_');
  const pageScopedToken = env.META_PAGE_ACCESS_TOKEN || env.META_ADS_ACCESS_TOKEN;

  let info;
  try {
    info = await fetchPostMediaInfo(env, postId, isIg, pageScopedToken);
  } catch (e) {
    return null;
  }

  if (info.isVideo) {
    if (!info.videoUrl) return null;
    const videoRes = await fetch(info.videoUrl);
    if (!videoRes.ok) return null;
    const videoBytes = await videoRes.arrayBuffer();

    let videoData;
    try {
      videoData = await buildVideoData(env, videoBytes, safeName, ctaLink, info.thumbnailUrl);
    } catch (e) {
      console.warn('Live video upload/processing did not finish in time, falling back:', e.message);
      return null;
    }

    let creative;
    try {
      creative = await graphPost(env, `${env.META_AD_ACCOUNT_ID}/adcreatives`, {
        name: `Organic Winner (live video) - ${postId}`,
        object_story_spec: { page_id: env.META_PAGE_ID, ...(igUserId ? { instagram_actor_id: igUserId } : {}), video_data: { ...videoData, link_description: message } },
      });
    } catch (e) {
      if (igUserId && /instagram_actor_id/i.test(e.message)) {
        creative = await graphPost(env, `${env.META_AD_ACCOUNT_ID}/adcreatives`, {
          name: `Organic Winner (live video, FB-only) - ${postId}`,
          object_story_spec: { page_id: env.META_PAGE_ID, video_data: { ...videoData, link_description: message } },
        });
      } else {
        throw e;
      }
    }

    return { source: 'live_video', ctaLink, message, creativeId: creative.id };
  }

  if (!info.imageUrl) return null;

  const imageRes = await fetch(info.imageUrl);
  if (!imageRes.ok) return null;
  const imageBytes = await imageRes.arrayBuffer();
  const hash = await uploadAdImage(env, imageBytes, `${safeName}.jpg`);

  const linkData = {
    message, link: ctaLink, image_hash: hash,
    call_to_action: { type: 'SHOP_NOW', value: { link: ctaLink } },
  };

  let creative;
  try {
    creative = await graphPost(env, `${env.META_AD_ACCOUNT_ID}/adcreatives`, {
      name: `Organic Winner (live image) - ${postId}`,
      object_story_spec: { page_id: env.META_PAGE_ID, ...(igUserId ? { instagram_actor_id: igUserId } : {}), link_data: linkData },
    });
  } catch (e) {
    if (igUserId && /instagram_actor_id/i.test(e.message)) {
      creative = await graphPost(env, `${env.META_AD_ACCOUNT_ID}/adcreatives`, {
        name: `Organic Winner (live image, FB-only) - ${postId}`,
        object_story_spec: { page_id: env.META_PAGE_ID, link_data: linkData },
      });
    } else {
      throw e;
    }
  }

  return { source: 'live_post_image', ctaLink, message, creativeId: creative.id };
}

// Last-resort fallback: reuse the post as an ad object directly. Requires
// the ad account to be formally assigned the Page/IG account as Business
// Manager assets — currently NOT set up (see note above), so this will keep
// failing until that's fixed on Meta's side. Kept as a fallback rather than
// removed so it starts working automatically once the Business Manager
// connection is actually in place, without a code change.
async function buildCreativeFromExistingPost(env, group, igUserId) {
  const ctaLink = env.KAPRUKA_HOME_URL || 'https://www.kapruka.com';

  if (group.fbPostId) {
    // group.fbPostId already comes from the Graph API in composite
    // "{page_id}_{post_id}" form — prepending META_PAGE_ID again here
    // produced a doubled, invalid ID and every reused-FB-post push failed
    // with "(#100) Invalid post_id parameter".
    const creative = await graphPost(env, `${env.META_AD_ACCOUNT_ID}/adcreatives`, {
      name: `Organic Winner (reused FB post) - ${group.fbPostId}`,
      object_story_id: group.fbPostId,
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

    // An existing row with no ad_id is a "skipped" marker (written by the
    // dashboard's Remove button), not a real push — that shouldn't block a
    // deliberate push, it should be overwritten (see the PATCH-vs-POST
    // choice below). Only an existing row that actually has an ad_id means
    // this post genuinely already has a live ad.
    const existingRows = await supabaseQuery(`organic_winner_ad_pushes?group_key=eq.${encodeURIComponent(group_key)}&select=id,ad_id`);
    const realPush = existingRows.find(r => r.ad_id);
    if (realPush) return json({ error: 'This post has already been pushed to an ad.', adId: realPush.ad_id }, 409);
    const skippedRowId = existingRows.find(r => !r.ad_id)?.id || null;

    // Matches the dashboard's Organic Social Performance / Queued-for-Ads
    // scope exactly — bounded by post count, not a date cutoff, so a post
    // the dashboard is showing (however old) never 404s here just because
    // it fell outside a fixed day window.
    const posts = await supabaseQuery('facebook_post_performance?order=created_time.desc&limit=100');
    const grouped = groupPosts(posts);
    const group = grouped.find(g => g.key === group_key);
    if (!group) return json({ error: 'That post was not found in the last 100 synced posts — it may have aged out. Refresh the dashboard and retry.' }, 404);
    // No isWinner() gate here on purpose: this endpoint also backs the
    // per-row "Push to Ads" button on the full Organic Social Performance
    // table, which is deliberately available for ANY synced post, not just
    // ones the 🏆 Winner heuristic flagged. The winner check still decides
    // what's auto-queued/auto-run by the Monday cron — it just isn't a
    // gate on a human's explicit one-off click here.

    const adsetId = env.TARGET_ADSET_ID || '52816670204854';
    const googleToken = await getGoogleAccessToken(env);
    const [sheetRows, igUserId] = await Promise.all([
      sheetsGetCsvRows(env, googleToken).catch(e => { console.warn('Sheet read failed, will fall back to reused-post:', e.message); return []; }),
      findInstagramAccountId(env),
    ]);

    const sheetMatch = sheetRows.find(row => row['Primary Text'] && fuzzyMatch(row['Primary Text'], group.message));
    let built = sheetMatch ? await buildCreativeFromSheetRow(env, googleToken, sheetMatch, igUserId) : null;
    if (!built && !sheetMatch) built = await buildCreativeFromLivePost(env, group, igUserId);
    if (!built) built = await buildCreativeFromExistingPost(env, group, igUserId);

    const ad = await graphPost(env, `${env.META_AD_ACCOUNT_ID}/ads`, {
      name: `Organic Winner - ${group.key.slice(0, 60)}`,
      adset_id: adsetId,
      creative: { creative_id: built.creativeId },
      status: 'ACTIVE',
    });

    const pushRecord = {
      group_key: group.key,
      platforms: group.platforms.join(','),
      message_excerpt: (group.message || '').slice(0, 200),
      creative_source: built.source,
      matched_content_id: built.contentId || null,
      cta_link: built.ctaLink,
      ad_id: ad.id,
      adset_id: adsetId,
      status: 'pushed',
    };
    if (skippedRowId) {
      await supabaseQuery(`organic_winner_ad_pushes?id=eq.${skippedRowId}`, 'PATCH', pushRecord, 'return=minimal');
    } else {
      await supabaseQuery('organic_winner_ad_pushes', 'POST', pushRecord, 'return=minimal');
    }

    return json({ ok: true, adId: ad.id, source: built.source, ctaLink: built.ctaLink });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}
