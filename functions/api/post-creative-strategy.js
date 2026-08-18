// functions/api/post-creative-strategy.js
// ============================================================================
//  POST CREATIVE STRATEGY — weekly Instagram post-performance investigator
//
//  Pulls Kapruka's own Instagram posts + per-post insights, audience
//  demographics, and a vision-model read of each post's actual image, then
//  hands ALL of that real data to an LLM (OpenAI) that investigates
//  cross-post patterns and returns a concrete creative strategy for next
//  week — every recommendation citing the actual post(s)/numbers behind it,
//  not generic advice. Two-stage LLM pipeline, deliberately in this order:
//    1. Vision analysis of each post's image/thumbnail (what's actually IN
//       the post, not just what the caption claims)
//    2. The strategist call, which reasons over insights + demographics +
//       stage 1's visual findings together — never a bare "write me a
//       strategy" prompt.
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
//    OPENAI_MODEL       — defaults to 'gpt-4o'. Used for BOTH the vision
//                         stage and the strategist stage — needs to be a
//                         vision-capable model. Reasoning quality matters
//                         more than raw scale for this task, don't downgrade
//                         to a mini/nano-class model to save cost.
//
//  KNOWN LIMITATIONS (be honest about these, don't paper over them):
//    - retention_rate_pct (Reels) is a BEST-EFFORT estimate. The Graph API
//      doesn't expose a clip's duration through any documented field —
//      extractDurationSeconds() below parses it out of an undocumented,
//      internal query param embedded in Instagram's CDN media_url. Meta can
//      change or drop that param at any time with zero notice; treat this
//      number as directional, not authoritative, and it may silently stop
//      populating if Meta changes the URL format.
//    - There is no true "longevity"/decay-curve metric here. The Graph API
//      only returns CURRENT lifetime-to-date totals, and this project
//      doesn't store historical snapshots of the same post over time — so
//      there's no way to see how a post's engagement accumulated day by
//      day from a single pull. reach_per_day/engagement_per_day below are
//      an age-normalized MOMENTUM proxy (so a 6-day-old and a 1-day-old
//      post are comparable), not a decay curve — the system prompt is
//      explicit with the model about this distinction, and this comment is
//      the same warning for the next person reading the code.
// ============================================================================

const GRAPH_VERSION = 'v21.0';
const DEFAULT_PAGE_ID = '154693882923';
const DEFAULT_IG_ACCOUNT_ID = '17841401761474904';
const DEFAULT_LOOKBACK_DAYS = 7;
const SAFE_FALLBACK_METRICS = 'reach,likes,comments,shares,saved,total_interactions';
const VISION_CHUNK_SIZE = 10;

const VISION_PROMPT = `You are analyzing Instagram post images for Kapruka (a Sri Lankan e-commerce/gifting company) as part of a weekly content-performance investigation. Each image below is preceded by a label giving its post ID.

For each image, identify:
- subject: what's actually shown (specific product, lifestyle scene, meme/text graphic, people, food, etc.) — be concrete, not generic
- composition: framing (close-up vs. wide), clutter vs. clean, focal point
- text_overlay: any text baked into the image itself, quoted verbatim if legible, or "none"
- product_visibility: is the actual product clearly and prominently shown, subtly present, or absent entirely
- aesthetic_notes: color palette, lighting, professional/studio vs. casual/UGC feel — anything that would affect scroll-stopping power
- notable_elements: anything else a human reviewer would flag (faces, branding, motion blur, screenshots vs. photos, etc.)

If an image fails to load or its content is unclear, say so plainly in "subject" (e.g. "image did not load") rather than guessing or inventing a description.

Respond with a single JSON object. Each key is exactly the post ID given in that image's label. Each value is an object with the six string fields above.`;

const SYSTEM_PROMPT = `You are reviewing Kapruka's Instagram content like an investigator and an anthropologist, not a dashboard. A dashboard reports numbers; you explain *why* a post did or didn't work and what pattern to repeat or break next week. You are read-only/advisory — you analyze and recommend, you don't publish or edit anything.

**What you're given:**
- The last N days of Instagram posts, each with: format, caption, timestamp, permalink, numeric insights (reach, engagement_rate, and for Reels: hook_rate_pct, avg/total watch time, and a best-effort retention_rate_pct), age-normalized reach_per_day/engagement_per_day, a \`visual_analysis\` object (a vision model's read of the actual image/thumbnail — subject, composition, text overlay, product visibility, aesthetic notes), and pre-computed \`is_outlier\`/\`is_key_post\` flags with reasons attached by real statistics, not guesswork.
- Account-level \`audience_demographics\`: top follower cities, top follower countries, and age/gender distribution.
- A \`highlights\` object naming the specific post IDs that are this batch's highest/lowest reach, highest/lowest engagement rate, and (Reels) highest/lowest hook rate.

**Your job:**
1. **Per-post investigation** (every post, not just top/bottom performers): format, subject matter (from the caption AND \`visual_analysis\` — the actual image content, not just what the caption claims), caption hook (the actual first line — what makes it a hook, not just "it has a hook"), hashtags, day-of-week/time posted, business-line/occasion relevance, and whether the visual reinforces or undercuts the caption's message. Pair against its metrics.
2. **Explicitly call out every post flagged \`is_outlier\` or \`is_key_post\`** — these were identified by real statistics (IQR-based outlier detection, batch highs/lows), not your judgment call. Explain what's notable about each and your best read on why.
3. **Cross-post pattern analysis** — this is the actual point, not a list of stats. Look for what correlates with better/worse engagement_rate and (for Reels) hook_rate_pct/retention_rate_pct across the week: format, subject/category (from caption AND visual_analysis), caption style, emotional angle, occasion timing, posting time, price point, visual composition (close-up vs. wide, product-forward vs. lifestyle, text-overlay presence). State patterns as claims you could be wrong about — a week of data is a small sample.
4. **Audience fit**: cross-reference content against \`audience_demographics\` — does the caption language, subject matter, or posting time make sense for the actual follower base (age/gender/geography)? Flag apparent mismatches as a lead worth testing, not a proven problem.
5. If a post references something you don't have context on (an unfamiliar trend, audio, meme format), say so explicitly rather than guessing at internet-culture context you're not sure of. Same if a post's \`visual_analysis\` has an \`error\`/unclear result — say the image couldn't be read rather than inventing a description.
6. Turn all of the above into a **concrete creative strategy for next week**: specific formats to lean into or drop, specific hook patterns to reuse (quote the actual opening line that worked), specific subject/category/visual-style mix, posting-time guidance, and any audience-fit adjustments — each recommendation citing the post(s)/numbers behind it.

**Statistical honesty (read this before writing anything):**
- Organic reach per post here is small (commonly double-to-low-triple-digit reach, single-digit likes). At this volume: a 1-2 like/comment difference is noise, not signal — don't build a recommendation on it.
- Prefer relative metrics (engagement_rate, hook_rate_pct) over raw counts when comparing posts of different reach.
- \`reach_per_day\`/\`engagement_per_day\` age-normalize each post's current lifetime-to-date totals so posts of different ages are comparable. They are NOT a decay curve or a measure of how a post's engagement changed over time — there is only a single snapshot per post, not repeated historical observations. Never describe them as "engagement over time" or "how fast the post decayed."
- \`retention_rate_pct\`, when present, is a best-effort estimate derived from an undocumented Meta field and can exceed 100% (rewatches). Treat it as directional, not authoritative, and say so if you cite it.
- Say explicitly when a "pattern" is based on only 1-2 posts and should be treated as a lead to test, not a proven rule. Do not fabricate confidence you don't have.

**Output:**
1. A per-post table: post ID/permalink, format, reach, engagement rate, hook rate % (Reels), and an "Outlier / Key post" column citing the relevant flag(s).
2. "What worked" / "What didn't" with the *why* — must explicitly cover every flagged key/outlier post.
3. "Audience fit" — a short section on how the content matches (or doesn't) the demographic data.
4. "Next week's creative strategy" (the cited recommendations).
5. The statistical-confidence caveats above, condensed to what actually applies to this specific report.
6. A one-line summary (posts reviewed, best/worst performer, single highest-confidence strategy change).`;

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
// so this never has to over-fetch past the window). media_url/thumbnail_url
// are needed for the vision-analysis stage below.
async function fetchRecentMedia(igAccountId, token, since, maxPosts) {
  const posts = [];
  const fields = 'id,caption,media_type,media_product_type,timestamp,permalink,media_url,thumbnail_url';
  let nextUrl = `https://graph.facebook.com/${GRAPH_VERSION}/${igAccountId}/media?fields=${encodeURIComponent(fields)}&limit=25&access_token=${encodeURIComponent(token)}`;

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
// 50 individual calls into ONE outgoing HTTP request.
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

// See the KNOWN LIMITATIONS block at the top of this file.
function extractDurationSeconds(mediaUrl) {
  try {
    const url = new URL(mediaUrl);
    const efg = url.searchParams.get('efg');
    if (!efg) return null;
    const b64 = efg.replace(/-/g, '+').replace(/_/g, '/');
    const decoded = JSON.parse(atob(b64));
    return typeof decoded.duration_s === 'number' ? decoded.duration_s : null;
  } catch (e) {
    return null;
  }
}

function enrichPostMetrics(post) {
  const ins = post.insights;
  if (ins && !ins.error) {
    const ageMs = Date.now() - new Date(post.timestamp).getTime();
    const ageDays = Math.max(ageMs / (1000 * 60 * 60 * 24), 0.5); // floor avoids a same-day-post spike from dividing by ~0
    if (typeof ins.reach === 'number') ins.reach_per_day = Math.round((ins.reach / ageDays) * 10) / 10;
    if (typeof ins.total_interactions === 'number') ins.engagement_per_day = Math.round((ins.total_interactions / ageDays) * 10) / 10;

    if (typeof ins.ig_reels_avg_watch_time === 'number' && post.media_url) {
      const durationS = extractDurationSeconds(post.media_url);
      if (durationS) {
        ins.retention_rate_pct = Math.round((ins.ig_reels_avg_watch_time / 1000 / durationS) * 1000) / 10;
        ins.retention_rate_is_estimated = true;
      }
    }
  }
  return post;
}

function quantile(sortedArr, q) {
  if (!sortedArr.length) return 0;
  const pos = (sortedArr.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  return sortedArr[base + 1] !== undefined ? sortedArr[base] + rest * (sortedArr[base + 1] - sortedArr[base]) : sortedArr[base];
}

// Flags outliers (IQR method — robust to the skew small marketing datasets
// usually have) and the batch's highest/lowest posts on each key metric, so
// the model is REQUIRED to discuss specific, statistically-real posts
// rather than picking its own "notable" examples.
function computeOutliersAndHighlights(posts) {
  const withEngagement = posts.filter(p => typeof p.insights.engagement_rate === 'number');
  const rates = withEngagement.map(p => p.insights.engagement_rate).sort((a, b) => a - b);
  const q1 = quantile(rates, 0.25), q3 = quantile(rates, 0.75);
  const iqr = q3 - q1;
  const lowerFence = q1 - 1.5 * iqr, upperFence = q3 + 1.5 * iqr;

  for (const p of posts) {
    const er = p.insights.engagement_rate;
    if (typeof er === 'number' && iqr > 0) {
      if (er > upperFence) { p.is_outlier = true; p.outlier_reason = `engagement_rate ${er} is above this batch's upper fence (${upperFence.toFixed(4)})`; }
      else if (er < lowerFence) { p.is_outlier = true; p.outlier_reason = `engagement_rate ${er} is below this batch's lower fence (${lowerFence.toFixed(4)})`; }
    }
  }

  const byReach = posts.filter(p => typeof p.insights.reach === 'number').sort((a, b) => b.insights.reach - a.insights.reach);
  const byEngagement = [...withEngagement].sort((a, b) => b.insights.engagement_rate - a.insights.engagement_rate);
  const byHook = posts.filter(p => typeof p.insights.hook_rate_pct === 'number').sort((a, b) => b.insights.hook_rate_pct - a.insights.hook_rate_pct);

  const highlights = {
    highest_reach: byReach[0]?.id || null,
    lowest_reach: byReach[byReach.length - 1]?.id || null,
    highest_engagement_rate: byEngagement[0]?.id || null,
    lowest_engagement_rate: byEngagement[byEngagement.length - 1]?.id || null,
    highest_hook_rate: byHook[0]?.id || null,
    lowest_hook_rate: byHook[byHook.length - 1]?.id || null,
  };

  const keyIds = new Set(Object.values(highlights).filter(Boolean));
  for (const p of posts) {
    if (keyIds.has(p.id)) {
      p.is_key_post = true;
      p.key_post_reasons = Object.entries(highlights).filter(([, id]) => id === p.id).map(([k]) => k.replace(/_/g, ' '));
    }
  }
  return highlights;
}

// follower_demographics (with a breakdown dimension) is the current,
// non-deprecated audience metric — the legacy audience_country/
// audience_gender_age metrics this file used to reach for are rejected on
// this Graph version. Batched into one request alongside the account's
// other calls where possible to stay well under the subrequest cap.
async function fetchAudienceDemographics(igAccountId, token) {
  const calls = [
    { id: 'city', relativeUrl: `${igAccountId}/insights?metric=follower_demographics&period=lifetime&metric_type=total_value&breakdown=city` },
    { id: 'country', relativeUrl: `${igAccountId}/insights?metric=follower_demographics&period=lifetime&metric_type=total_value&breakdown=country` },
    { id: 'age_gender', relativeUrl: `${igAccountId}/insights?metric=follower_demographics&period=lifetime&metric_type=total_value&breakdown=age,gender` },
  ];

  let results;
  try {
    results = await graphBatch(token, calls);
  } catch (e) {
    return { error: e.message };
  }

  const summarize = (key, topN) => {
    const raw = results.get(key);
    if (!raw || raw.error) return { error: raw?.error || 'unavailable' };
    const breakdown = raw.data?.[0]?.total_value?.breakdowns?.[0];
    if (!breakdown?.results) return { error: 'no breakdown data returned (account may be below Meta\'s minimum audience size for demographics)' };
    const rows = breakdown.results
      .map(r => ({ label: r.dimension_values.join(' / '), value: r.value }))
      .sort((a, b) => b.value - a.value);
    return { top: rows.slice(0, topN) };
  };

  return {
    top_cities: summarize('city', 10),
    top_countries: summarize('country', 10),
    age_gender: summarize('age_gender', 20),
  };
}

// Stage 1 of the LLM pipeline: analyze each post's actual image/thumbnail
// BEFORE any strategic reasoning happens. Chunked (not one call per post)
// to stay well under the subrequest cap even on a 30-day window. Passes the
// Instagram CDN URL straight to OpenAI as an image_url — OpenAI fetches it
// server-side, so this costs zero extra Cloudflare subrequests per image.
async function analyzeImagesForPosts(env, posts) {
  const model = env.OPENAI_MODEL || 'gpt-4o';
  const visualById = new Map();

  const withImages = posts
    .map(p => ({ id: p.id, url: p.media_type === 'VIDEO' ? p.thumbnail_url : (p.media_url || p.thumbnail_url) }))
    .filter(p => !!p.url);

  for (let i = 0; i < withImages.length; i += VISION_CHUNK_SIZE) {
    const chunk = withImages.slice(i, i + VISION_CHUNK_SIZE);
    const content = [{ type: 'text', text: VISION_PROMPT }];
    for (const item of chunk) {
      content.push({ type: 'text', text: `Post ID: ${item.id}` });
      content.push({ type: 'image_url', image_url: { url: item.url } });
    }

    try {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.OPENAI_API_KEY}` },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content }],
          response_format: { type: 'json_object' },
          temperature: 0.3,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error?.message || JSON.stringify(body));
      const raw = body.choices?.[0]?.message?.content;
      const parsed = raw ? JSON.parse(raw) : {};
      for (const item of chunk) {
        visualById.set(item.id, parsed[item.id] || { error: 'no visual analysis returned for this post' });
      }
    } catch (e) {
      for (const item of chunk) visualById.set(item.id, { error: `image analysis failed: ${e.message}` });
    }
  }

  return visualById;
}

// Stage 2: the strategist call, reasoning over insights + demographics +
// stage 1's visual findings together.
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
    const posts = media.map((m) => enrichPostMetrics({
      id: m.id,
      caption: m.caption || '',
      media_type: m.media_type,
      media_product_type: m.media_product_type,
      timestamp: m.timestamp,
      permalink: m.permalink,
      media_url: m.media_url,
      thumbnail_url: m.thumbnail_url,
      insights: insightsById.get(m.id) || { error: 'no insights returned' },
    }));

    const highlights = computeOutliersAndHighlights(posts);
    const [audienceDemographics, visualById] = await Promise.all([
      fetchAudienceDemographics(igAccountId, token),
      analyzeImagesForPosts(env, posts),
    ]);
    posts.forEach(p => { p.visual_analysis = visualById.get(p.id) || { error: 'not analyzed (no usable image URL)' }; });

    // Drop the CDN URLs before sending to the strategist call / back to the
    // client — they're large, time-limited, and no longer useful once
    // visual analysis is done; permalink is what's actually actionable.
    const postsForReport = posts.map(({ media_url, thumbnail_url, ...rest }) => rest);

    const dataPayload = {
      accountId: igAccountId,
      window: { since: since.toISOString().slice(0, 10), days },
      postCount: postsForReport.length,
      audience_demographics: audienceDemographics,
      highlights,
      posts: postsForReport,
    };

    const report = await callOpenAI(env, dataPayload);

    return json({ ok: true, report, raw: dataPayload });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}
