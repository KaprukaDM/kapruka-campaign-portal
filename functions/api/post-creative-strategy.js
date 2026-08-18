// functions/api/post-creative-strategy.js
// ============================================================================
//  POST CREATIVE STRATEGY — weekly Instagram post-performance investigator
//
//  Pulls Kapruka's own Instagram posts + per-post insights from the last N
//  days via the Graph API, then hands the real data to an LLM (OpenAI) that
//  investigates cross-post patterns and returns a concrete creative strategy
//  for next week — every recommendation citing the actual post(s)/numbers
//  behind it, not generic advice. This is deliberately NOT a one-shot "write
//  me a strategy" prompt: the model only ever reasons over real pulled data.
//
//  Runs server-side as a Cloudflare Pages Function so the Meta token and the
//  OpenAI key never touch the browser. Sits behind functions/_middleware.js's
//  Basic Auth like the rest of /api/*.
//
//  Env vars required:
//    META_PAGE_ACCESS_TOKEN — reused from the rest of this project (needs
//                              instagram_basic + page-scoped read access)
//    OPENAI_API_KEY         — NEW secret, not shared with any other feature
//  Optional:
//    META_PAGE_ID       — defaults to 154693882923 (Kapruka Page)
//    META_IG_ACCOUNT_ID — defaults to 17841401761474904; skips the page->IG
//                         resolution call if set
//    OPENAI_MODEL       — defaults to 'gpt-4o'. Reasoning quality matters
//                         more than raw scale for this task (it's "read
//                         carefully and form a defensible opinion", not
//                         "generate a lot of text") — don't downgrade to a
//                         mini/nano-class model to save cost here.
// ============================================================================

const GRAPH_VERSION = 'v19.0';
const DEFAULT_PAGE_ID = '154693882923';
const DEFAULT_IG_ACCOUNT_ID = '17841401761474904';
const DEFAULT_LOOKBACK_DAYS = 7;
const SAFE_FALLBACK_METRICS = 'reach,likes,comments,shares,saved,total_interactions';

const SYSTEM_PROMPT = `You are reviewing Kapruka's Instagram content like an investigator and an anthropologist, not a dashboard. A dashboard reports numbers; you explain *why* a post did or didn't work and what pattern to repeat or break next week. You are read-only/advisory — you analyze and recommend, you don't publish or edit anything.

**Your job:**
1. You'll be given the last N days of Instagram posts with per-post insights (format, caption, timestamp, reach, engagement_rate, and for Reels: hook_rate_pct, avg watch time, total watch time).
2. **Per-post investigation** (every post, not just top/bottom performers): note format (image/carousel/Reels/Story), subject matter, caption hook (the actual first line — what makes it a hook, not just "it has a hook"), hashtags, day-of-week/time posted, and business-line/occasion relevance. Pair against its metrics.
3. **Cross-post pattern analysis** — this is the actual point, not a list of stats. Look for what correlates with better/worse engagement_rate and (for Reels) hook_rate_pct across the week: format, subject/category, caption style, emotional angle, occasion timing, posting time, price point. State patterns as claims you could be wrong about — a week of data is a small sample.
4. If a post references something you don't have context on (an unfamiliar trend, audio, meme format), say so explicitly rather than guessing at internet-culture context you're not sure of.
5. Turn the pattern analysis into a **concrete creative strategy for next week**: specific formats to lean into or drop, specific hook patterns to reuse (quote the actual opening line that worked), specific subject/category mix, posting-time guidance — each recommendation citing the post(s)/numbers behind it.

**Statistical honesty (read this before writing anything):** organic reach per post here is small (commonly double-to-low-triple-digit reach, single-digit likes). At this volume: a 1-2 like/comment difference is noise, not signal — don't build a recommendation on it. Prefer relative metrics (engagement_rate, hook_rate_pct) over raw counts when comparing posts of different reach. Say explicitly when a "pattern" is based on only 1-2 posts and should be treated as a lead to test, not a proven rule. Do not fabricate confidence you don't have.

**Output:** a per-post table (post id/permalink, format, reach, engagement rate, hook rate % where applicable), "What worked" / "What didn't" with the *why*, "Next week's creative strategy" (the cited recommendations), the statistical-confidence caveat, and a one-line summary (posts reviewed, best/worst performer, single highest-confidence strategy change).`;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

async function graphGet(path, params, token) {
  const url = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  url.searchParams.set('access_token', token);
  const res = await fetch(url);
  const body = await res.json();
  if (body.error) throw new Error(body.error.message);
  return body;
}

async function resolveIgAccountId(env, token) {
  if (env.META_IG_ACCOUNT_ID) return env.META_IG_ACCOUNT_ID;
  const pageId = env.META_PAGE_ID || DEFAULT_PAGE_ID;
  try {
    const data = await graphGet(pageId, { fields: 'instagram_business_account' }, token);
    return data.instagram_business_account?.id || DEFAULT_IG_ACCOUNT_ID;
  } catch (e) {
    return DEFAULT_IG_ACCOUNT_ID;
  }
}

// Paginates /media newest-first, stopping as soon as a post falls outside
// the lookback window (posts are already ordered newest-first by the API,
// so this never has to over-fetch past the window).
async function fetchRecentMedia(igAccountId, token, since, maxPosts) {
  const posts = [];
  let nextUrl = `https://graph.facebook.com/${GRAPH_VERSION}/${igAccountId}/media?fields=${encodeURIComponent('id,caption,media_type,media_product_type,timestamp,permalink')}&limit=25&access_token=${encodeURIComponent(token)}`;

  while (nextUrl && posts.length < maxPosts) {
    const res = await fetch(nextUrl);
    const body = await res.json();
    if (body.error) throw new Error(`media list: ${body.error.message}`);

    let hitBoundary = false;
    for (const post of body.data || []) {
      if (new Date(post.timestamp) < since) { hitBoundary = true; break; }
      posts.push(post);
      if (posts.length >= maxPosts) { hitBoundary = true; break; }
    }
    nextUrl = hitBoundary ? null : (body.paging?.next || null);
  }
  return posts;
}

function metricsFor(mediaProductType) {
  if (mediaProductType === 'REELS') {
    return 'reach,likes,comments,shares,saved,total_interactions,views,ig_reels_avg_watch_time,ig_reels_video_view_total_time,reels_skip_rate';
  }
  if (mediaProductType === 'STORY') return 'reach,replies,navigation';
  return SAFE_FALLBACK_METRICS; // FEED (image/carousel) and anything else
}

function parseInsights(body) {
  const out = {};
  for (const m of body.data || []) {
    out[m.name] = m.values?.[0]?.value ?? null;
  }
  if (typeof out.reels_skip_rate === 'number') {
    out.hook_rate_pct = Math.round((100 - out.reels_skip_rate) * 100) / 100;
  }
  if (typeof out.total_interactions === 'number' && typeof out.reach === 'number' && out.reach > 0) {
    out.engagement_rate = Math.round((out.total_interactions / out.reach) * 10000) / 10000;
  }
  return out;
}

// Cloudflare Pages Functions cap outgoing fetches at 50 subrequests per
// invocation (default plan) — one insights call per post blew past that on
// anything beyond a handful of posts (confirmed live: "Too many subrequests"
// on a 14/30-day window). Facebook's Graph API batch endpoint bundles up to
// 50 individual calls into ONE outgoing HTTP request, so fetching insights
// for an entire window now costs ~2 subrequests total (one batch + one
// fallback-retry batch) instead of one per post.
const GRAPH_BATCH_LIMIT = 50;

async function graphBatch(token, calls) {
  // calls: [{ id, relativeUrl }]. Returns a Map from id -> parsed body (or
  // { error } if that specific sub-call failed).
  const results = new Map();
  for (let i = 0; i < calls.length; i += GRAPH_BATCH_LIMIT) {
    const chunk = calls.slice(i, i + GRAPH_BATCH_LIMIT);
    const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        access_token: token,
        batch: JSON.stringify(chunk.map(c => ({ method: 'GET', relative_url: c.relativeUrl }))),
      }),
    });
    const batchBody = await res.json();
    if (!Array.isArray(batchBody)) throw new Error(`Graph batch request failed: ${JSON.stringify(batchBody)}`);
    chunk.forEach((c, idx) => {
      const item = batchBody[idx];
      let parsed = null;
      try { parsed = item?.body ? JSON.parse(item.body) : null; } catch (e) { /* leave null */ }
      if (item && item.code === 200 && parsed && !parsed.error) {
        results.set(c.id, parsed);
      } else {
        results.set(c.id, { error: parsed?.error?.message || `HTTP ${item?.code ?? '?'}` });
      }
    });
  }
  return results;
}

async function fetchAllInsights(mediaList, token) {
  const primaryCalls = mediaList.map(m => ({
    id: m.id,
    relativeUrl: `${m.id}/insights?metric=${encodeURIComponent(metricsFor(m.media_product_type))}`,
  }));
  const primaryResults = await graphBatch(token, primaryCalls);

  // Same fallback rationale as before: the Graph API is inconsistent
  // post-by-post about which metrics are actually valid, not just by
  // declared media_product_type. Retry only the failures, still batched.
  const needsFallback = mediaList.filter(m => primaryResults.get(m.id)?.error);
  let fallbackResults = new Map();
  if (needsFallback.length) {
    const fallbackCalls = needsFallback.map(m => ({
      id: m.id,
      relativeUrl: `${m.id}/insights?metric=${encodeURIComponent(SAFE_FALLBACK_METRICS)}`,
    }));
    fallbackResults = await graphBatch(token, fallbackCalls);
  }

  const out = new Map();
  for (const m of mediaList) {
    const raw = fallbackResults.get(m.id) || primaryResults.get(m.id);
    out.set(m.id, raw?.error ? { error: raw.error } : parseInsights(raw));
  }
  return out;
}

async function callOpenAI(env, dataPayload) {
  const model = env.OPENAI_MODEL || 'gpt-4o';
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify(dataPayload) },
      ],
      temperature: 0.4,
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`OpenAI error: ${body.error?.message || JSON.stringify(body)}`);
  const content = body.choices?.[0]?.message?.content;
  if (!content) throw new Error('OpenAI returned no report content.');
  return content;
}

export async function onRequestPost(context) {
  const { env, request } = context;
  try {
    if (!env.META_PAGE_ACCESS_TOKEN) return json({ error: 'Server is missing the META_PAGE_ACCESS_TOKEN secret.' }, 500);
    if (!env.OPENAI_API_KEY) return json({ error: 'Server is missing the OPENAI_API_KEY secret — ask an admin to add it in Cloudflare Pages settings.' }, 500);

    let body = {};
    try { body = await request.json(); } catch (e) { /* no body sent — use defaults */ }
    const days = Number(body.days) > 0 ? Number(body.days) : DEFAULT_LOOKBACK_DAYS;
    const maxPosts = Number(body.maxPosts) > 0 ? Number(body.maxPosts) : 100;

    const token = env.META_PAGE_ACCESS_TOKEN;
    const igAccountId = await resolveIgAccountId(env, token);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const media = await fetchRecentMedia(igAccountId, token, since, maxPosts);
    if (!media.length) return json({ error: `No Instagram posts found in the last ${days} days.` }, 404);

    const insightsById = await fetchAllInsights(media, token);
    const posts = media.map((m) => ({
      id: m.id,
      caption: m.caption || '',
      media_type: m.media_type,
      media_product_type: m.media_product_type,
      timestamp: m.timestamp,
      permalink: m.permalink,
      insights: insightsById.get(m.id) || { error: 'no insights returned' },
    }));

    const dataPayload = {
      accountId: igAccountId,
      window: { since: since.toISOString().slice(0, 10), days },
      postCount: posts.length,
      posts,
    };

    const report = await callOpenAI(env, dataPayload);

    return json({ ok: true, report, raw: dataPayload });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}
