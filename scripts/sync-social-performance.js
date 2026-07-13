#!/usr/bin/env node
// Pulls organic post performance for a Facebook Page AND its linked
// Instagram professional account via the Graph API, and upserts everything
// into Supabase's facebook_post_performance table — rows are tagged with a
// `platform` column so the admin dashboard can show one combined feed.
// Runs on a schedule via .github/workflows/facebook-sync.yml — the admin
// dashboard never talks to Facebook/Instagram directly, it only reads what
// this script writes.
//
// Required env vars (set as GitHub Actions repo secrets):
//   META_PAGE_ACCESS_TOKEN  — long-lived Page Access Token
//   META_PAGE_ID            — numeric Facebook Page ID
// Optional:
//   META_PAGE_NAME  — label stored alongside each row (default 'Kapruka FB')
//   META_IG_USER_ID — Instagram Business Account ID. If unset, it's
//                     auto-discovered from the Page's linked account; set
//                     this explicitly to skip that lookup or override it.
//                     If Instagram isn't linked or the token lacks
//                     instagram_basic/instagram_manage_insights, Instagram
//                     is skipped with a warning and Facebook sync still runs.

// Same Supabase project + anon key already public in js/supabase-api.js —
// every write in this app goes through the anon key, so this is consistent
// with the existing security model rather than introducing a new one.
const SUPABASE_URL = 'https://ivllhheqqiseagmctfyp.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml2bGxoaGVxcWlzZWFnbWN0ZnlwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg1NzQzMzksImV4cCI6MjA4NDE1MDMzOX0.OnkYNACtdknKDY2KqLfiGN0ORXpKaW906fD0TtSJlIk';

const PAGE_ACCESS_TOKEN = process.env.META_PAGE_ACCESS_TOKEN;
const PAGE_ID = process.env.META_PAGE_ID;
const PAGE_NAME = process.env.META_PAGE_NAME || 'Kapruka FB';
const IG_USER_ID_OVERRIDE = process.env.META_IG_USER_ID || null;
const GRAPH_VERSION = 'v21.0';
const POST_LIMIT = 25;

if (!PAGE_ACCESS_TOKEN || !PAGE_ID) {
  console.error('Missing META_PAGE_ACCESS_TOKEN or META_PAGE_ID env vars.');
  process.exit(1);
}

async function graphGet(path, params) {
  const url = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  url.searchParams.set('access_token', PAGE_ACCESS_TOKEN);
  const res = await fetch(url);
  const json = await res.json();
  if (json.error) throw new Error(`${path}: ${json.error.message}`);
  return json;
}

// ═══════════════════════════════════════════════════════════════
// FACEBOOK PAGE POSTS
// ═══════════════════════════════════════════════════════════════

// Ordered richest → safest. Meta periodically retires post-insight metrics,
// so if the full set 400s we retry with a smaller set instead of failing
// the whole sync over one bad metric name.
const FB_METRIC_FALLBACKS = [
  'post_impressions,post_impressions_unique,post_engaged_users,post_clicks,post_reactions_by_type_total',
  'post_impressions,post_impressions_unique,post_engaged_users',
  'post_impressions,post_impressions_unique',
];

async function fetchFacebookPosts() {
  const fields = [
    'id', 'message', 'created_time', 'permalink_url',
    'attachments{media_type,type}',
    'shares',
    'comments.summary(true).limit(0)',
    'likes.summary(true).limit(0)',
  ].join(',');
  const data = await graphGet(`${PAGE_ID}/posts`, { fields, limit: String(POST_LIMIT) });
  return data.data || [];
}

async function fetchFacebookInsights(postId) {
  for (const metrics of FB_METRIC_FALLBACKS) {
    try {
      const data = await graphGet(`${postId}/insights`, { metric: metrics });
      const values = {};
      for (const row of data.data || []) {
        values[row.name] = row.values?.[0]?.value;
      }
      return values;
    } catch (err) {
      console.warn(`FB insights fallback for ${postId} (${metrics}): ${err.message}`);
    }
  }
  return {};
}

function fbReactionsTotal(insightValue, post) {
  if (insightValue && typeof insightValue === 'object') {
    const sum = Object.values(insightValue).reduce((total, n) => total + (Number(n) || 0), 0);
    if (sum > 0 || Object.keys(insightValue).length > 0) return sum;
  }
  return post.likes?.summary?.total_count ?? null;
}

function fbPostType(post) {
  const first = post.attachments?.data?.[0];
  return first?.media_type || first?.type || 'status';
}

async function buildFacebookRows() {
  console.log(`Fetching Facebook posts for page ${PAGE_ID}...`);
  const posts = await fetchFacebookPosts();
  console.log(`Facebook: found ${posts.length} posts. Fetching insights for each...`);

  const rows = [];
  for (const post of posts) {
    const insights = await fetchFacebookInsights(post.id);
    rows.push({
      platform: 'facebook',
      page_name: PAGE_NAME,
      page_id: String(PAGE_ID),
      post_id: post.id,
      message: (post.message || '').slice(0, 1000),
      permalink_url: post.permalink_url || null,
      post_type: fbPostType(post),
      created_time: post.created_time || null,
      impressions: insights.post_impressions ?? null,
      reach: insights.post_impressions_unique ?? null,
      engaged_users: insights.post_engaged_users ?? null,
      clicks: insights.post_clicks ?? null,
      reactions_total: fbReactionsTotal(insights.post_reactions_by_type_total, post),
      comments_count: post.comments?.summary?.total_count ?? null,
      shares_count: post.shares?.count ?? null,
      synced_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  }
  return rows;
}

// ═══════════════════════════════════════════════════════════════
// INSTAGRAM MEDIA (linked professional account)
// ═══════════════════════════════════════════════════════════════

const IG_METRIC_FALLBACKS = [
  'reach,impressions,saved,shares',
  'reach,impressions',
  'reach',
];

async function findInstagramAccountId() {
  if (IG_USER_ID_OVERRIDE) return IG_USER_ID_OVERRIDE;
  try {
    const data = await graphGet(PAGE_ID, { fields: 'instagram_business_account' });
    return data.instagram_business_account?.id || null;
  } catch (err) {
    console.warn(`Could not look up linked Instagram account: ${err.message}`);
    return null;
  }
}

async function fetchInstagramMedia(igUserId) {
  const fields = 'id,caption,media_type,media_product_type,permalink,timestamp,like_count,comments_count';
  const data = await graphGet(`${igUserId}/media`, { fields, limit: String(POST_LIMIT) });
  return data.data || [];
}

async function fetchInstagramInsights(mediaId) {
  for (const metrics of IG_METRIC_FALLBACKS) {
    try {
      const data = await graphGet(`${mediaId}/insights`, { metric: metrics });
      const values = {};
      for (const row of data.data || []) {
        values[row.name] = row.values?.[0]?.value ?? row.total_value?.value;
      }
      return values;
    } catch (err) {
      console.warn(`IG insights fallback for ${mediaId} (${metrics}): ${err.message}`);
    }
  }
  return {};
}

async function buildInstagramRows() {
  const igUserId = await findInstagramAccountId();
  if (!igUserId) {
    console.log('No linked Instagram account found — skipping Instagram sync.');
    return [];
  }
  console.log(`Instagram: found account ${igUserId}. Fetching media...`);
  const media = await fetchInstagramMedia(igUserId);
  console.log(`Instagram: found ${media.length} media items. Fetching insights for each...`);

  const rows = [];
  for (const item of media) {
    const insights = await fetchInstagramInsights(item.id);
    rows.push({
      platform: 'instagram',
      page_name: PAGE_NAME,
      page_id: igUserId,
      post_id: item.id,
      message: (item.caption || '').slice(0, 1000),
      permalink_url: item.permalink || null,
      post_type: (item.media_product_type || item.media_type || 'status').toLowerCase(),
      created_time: item.timestamp || null,
      impressions: insights.impressions ?? null,
      reach: insights.reach ?? null,
      engaged_users: null, // no directly comparable unique-users metric at the media level
      clicks: null,
      reactions_total: item.like_count ?? null,
      comments_count: item.comments_count ?? null,
      shares_count: insights.shares ?? null,
      synced_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  }
  return rows;
}

// ═══════════════════════════════════════════════════════════════
// SUPABASE UPSERT
// ═══════════════════════════════════════════════════════════════

async function upsertRows(rows) {
  if (!rows.length) return;
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/facebook_post_performance?on_conflict=platform,page_id,post_id`,
    {
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(rows),
    }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase upsert failed (${res.status}): ${text}`);
  }
}

async function main() {
  const fbRows = await buildFacebookRows();
  const igRows = await buildInstagramRows();

  const allRows = [...fbRows, ...igRows];
  await upsertRows(allRows);
  console.log(`Synced ${allRows.length} total posts to Supabase (Facebook: ${fbRows.length}, Instagram: ${igRows.length}).`);
}

main().catch((err) => {
  console.error('Social sync failed:', err.message);
  process.exit(1);
});
