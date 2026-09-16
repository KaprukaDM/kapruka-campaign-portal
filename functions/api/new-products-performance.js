// functions/api/new-products-performance.js
// ============================================================================
//  NEWLY ADDED PRODUCTS PERFORMANCE — GSC + GA4, fixed product list
//
//  SOURCE → Google Search Console Search Analytics API + GA4 Data API,
//           restricted to the exact ~2000 products added between
//           Aug 1 and Sep 11, 2025 (data/newly-added-products.json),
//           matched by product code (the "/kid/{code}" URL segment).
//
//  KAPRUKA_BASE (".../buyonline/-/kid/{code}") is a redirect-only shorthand
//  used elsewhere in this repo to build clickable links — GSC and GA4 both
//  record the final resolved URL/path instead, which includes the real
//  product-name slug and (for GSC only) a "/lk/" locale prefix we don't have
//  per product. So neither API is queried with a per-product exact-match —
//  both are fetched broadly (page/path containing "/buyonline/") and matched
//  locally by pulling the code out of each result's "/kid/{code}" segment.
//
//  Env vars required (Cloudflare Pages secrets / .dev.vars locally):
//    GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GSC_REFRESH_TOKEN — same
//      OAuth pattern as functions/api/seo-performance.js.
//    GA4_PROPERTY_ID    — numeric GA4 property id.
//    GA4_REFRESH_TOKEN  — optional; falls back to GSC_REFRESH_TOKEN if unset
//      (same fallback pattern as ga4interest/index.js).
//
//  API shape:
//    GET /api/new-products-performance?range=launch|30|90|180
//      "launch" (default) = full lifetime-to-date since Aug 1, 2025.
// ============================================================================

import PRODUCTS from '../../data/newly-added-products.json';

const GSC_API = 'https://www.googleapis.com/webmasters/v3/sites';
const GA4_API = 'https://analyticsdata.googleapis.com/v1beta/properties';
const KAPRUKA_BASE = 'https://www.kapruka.com/buyonline/-/kid/';
const GSC_ROW_LIMIT = 25000; // GSC's own per-request max
const GSC_MAX_PAGES = 20; // safety cap on pagination (500k rows)
const GA4_PAGE_LIMIT = 100000; // GA4 Data API's own per-request max row count
const GA4_MAX_PAGES = 10; // safety cap on pagination (1M rows)
const LAUNCH_START = '2025-08-01'; // these products started going live on this date
const VALID_WINDOWS = ['launch', 30, 90, 180];
const CACHE_TTL_SECONDS = 6 * 60 * 60; // "since launch" pulls ~1.5min of GSC+GA4 data — cache it

function json(data, status = 200, cacheControl = 'no-store') {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': cacheControl }
  });
}

function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

// GSC finalized data typically lags ~2-3 days behind "today".
function today3DaysAgo() {
  const now = new Date();
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  end.setUTCDate(end.getUTCDate() - 3);
  return end;
}

// "launch" = full lifetime-to-date since these products started going live
// (Aug 1, 2025) through today. "30/90/180" = a recent trailing window, for
// looking at current activity rather than the whole lifetime.
function dateWindow(rangeParam) {
  const end = today3DaysAgo();
  if (rangeParam === 'launch') {
    return { startDate: LAUNCH_START, endDate: fmtDate(end) };
  }
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (rangeParam - 1));
  return { startDate: fmtDate(start), endDate: fmtDate(end) };
}

// ── Google OAuth ─────────────────────────────────────────────────────────
async function getGscAccessToken(env) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: env.GSC_REFRESH_TOKEN,
      grant_type: 'refresh_token'
    })
  });
  const body = await res.json();
  if (!res.ok) throw new Error('GSC auth failed: ' + JSON.stringify(body));
  return body.access_token;
}

async function getGa4AccessToken(env) {
  const clientId = env.GA4_CLIENT_ID || env.GOOGLE_CLIENT_ID;
  const clientSecret = env.GA4_CLIENT_SECRET || env.GOOGLE_CLIENT_SECRET;
  const refreshToken = env.GA4_REFRESH_TOKEN || env.GSC_REFRESH_TOKEN;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    })
  });
  const body = await res.json();
  if (!res.ok) throw new Error('GA4 auth failed: ' + JSON.stringify(body));
  return body.access_token;
}

function normalizeSiteUrl(raw) {
  let s = (raw || '').trim();
  if (!s) return null;
  if (s.startsWith('sc-domain:')) return s;
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  if (!s.endsWith('/')) s += '/';
  return s;
}

function getSiteUrl(env) {
  const raw = (env.GSC_SITE_URL || '').split(/[\s,]+/).map(normalizeSiteUrl).filter(Boolean);
  return raw[0] || null;
}

// Real Kapruka product page URLs are https://www.kapruka.com/lk/buyonline/
// {product-name-slug}/kid/{code} — the KAPRUKA_BASE "/buyonline/-/kid/{code}"
// shorthand is a redirect-only convenience link (used for generating
// clickable URLs elsewhere in this repo); Search Console and GA4 both record
// the final resolved URL/path, which includes the real slug and "/lk/"
// locale prefix we don't have per-product. So pages/paths are matched by
// pulling out the code after the last "/kid/" segment instead of comparing
// full URLs/paths.
function extractProductCode(pageOrPath) {
  const m = pageOrPath.match(/\/kid\/([^/?#]+)/);
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch { return m[1]; }
}

// ── GSC: page-level breakdown, paginated, filtered locally to our code set ──
// Pulls the full /buyonline/ page-level breakdown for the property in the
// date range (same paginated pattern as functions/api/seo-performance.js's
// fetchPageBreakdown) and keeps only rows whose product code (from the URL's
// /kid/{code} segment) is in our fixed product list.
async function fetchGscPageBreakdown(token, siteUrl, { startDate, endDate }, warnings) {
  const rows = [];
  try {
    let startRow = 0;
    for (let i = 0; i < GSC_MAX_PAGES; i++) {
      const res = await fetch(`${GSC_API}/${encodeURIComponent(siteUrl)}/searchAnalytics/query`, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          startDate, endDate,
          dimensions: ['page'],
          dimensionFilterGroups: [{ filters: [{ dimension: 'page', operator: 'includingRegex', expression: '/buyonline/' }] }],
          rowLimit: GSC_ROW_LIMIT, startRow
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(`GSC query failed (${res.status}): ${data.error?.message || JSON.stringify(data)}`);
      const got = data.rows || [];
      rows.push(...got);
      if (got.length < GSC_ROW_LIMIT) break;
      startRow += GSC_ROW_LIMIT;
    }
  } catch (e) {
    warnings.push(`GSC page breakdown: ${e.message}`);
  }
  return rows;
}

async function fetchAllGsc(token, siteUrl, codes, range, warnings) {
  const wanted = new Set(codes.map(c => c.toLowerCase()));
  const rows = await fetchGscPageBreakdown(token, siteUrl, range, warnings);
  const byCode = new Map();
  for (const row of rows) {
    const code = extractProductCode(row.keys[0]);
    if (!code || !wanted.has(code.toLowerCase())) continue;
    const key = code.toLowerCase();
    const existing = byCode.get(key) || { clicks: 0, impressions: 0, posW: 0 };
    existing.clicks += row.clicks || 0;
    existing.impressions += row.impressions || 0;
    existing.posW += (row.position || 0) * (row.impressions || 0);
    byCode.set(key, existing);
  }
  const result = new Map();
  for (const [code, v] of byCode) {
    result.set(code, {
      clicks: v.clicks,
      impressions: v.impressions,
      position: v.impressions ? v.posW / v.impressions : 0
    });
  }
  return result;
}

// GA4's pagePath for these products is "/buyonline/{product-name-slug}/kid/
// {code}" — no "/lk/" locale prefix (unlike GSC's full page URLs, which do
// have one) — and the {code} segment comes back lowercased regardless of the
// case in our product list. Same approach as GSC: pull every /buyonline/
// pagePath in the date range (paginated) and match locally by code.
async function fetchGa4PageBreakdown(token, propertyId, { startDate, endDate }, warnings) {
  const rows = [];
  try {
    let offset = 0;
    for (let i = 0; i < GA4_MAX_PAGES; i++) {
      const res = await fetch(`${GA4_API}/${propertyId}:runReport`, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dateRanges: [{ startDate, endDate }],
          dimensions: [{ name: 'pagePath' }],
          metrics: [{ name: 'screenPageViews' }, { name: 'totalUsers' }, { name: 'sessions' }],
          dimensionFilter: {
            filter: { fieldName: 'pagePath', stringFilter: { matchType: 'CONTAINS', value: '/buyonline/' } }
          },
          limit: GA4_PAGE_LIMIT, offset,
          keepEmptyRows: false
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(`GA4 query failed (${res.status}): ${data.error?.message || JSON.stringify(data)}`);
      const got = data.rows || [];
      rows.push(...got);
      if (got.length < GA4_PAGE_LIMIT) break;
      offset += GA4_PAGE_LIMIT;
    }
  } catch (e) {
    warnings.push(`GA4 page breakdown: ${e.message}`);
  }
  return rows;
}

async function fetchAllGa4(token, propertyId, codes, range, warnings) {
  const wanted = new Set(codes.map(c => c.toLowerCase()));
  const rows = await fetchGa4PageBreakdown(token, propertyId, range, warnings);
  const byCode = new Map();
  for (const row of rows) {
    const path = row.dimensionValues[0].value;
    const code = extractProductCode(path);
    if (!code || !wanted.has(code.toLowerCase())) continue;
    const existing = byCode.get(code.toLowerCase()) || { pageViews: 0, users: 0, sessions: 0 };
    existing.pageViews += parseInt(row.metricValues[0].value, 10) || 0;
    existing.users += parseInt(row.metricValues[1].value, 10) || 0;
    existing.sessions += parseInt(row.metricValues[2].value, 10) || 0;
    byCode.set(code.toLowerCase(), existing);
  }
  return byCode;
}

// ── Handler ───────────────────────────────────────────────────────────────
// Each request re-fetches a full site-wide GSC+GA4 breakdown and filters
// locally (there's no way to ask either API for just our ~2000 product
// codes), which takes well over a minute for the "launch" window — so
// successful responses are cached at the edge per range, and a page load
// doesn't force a live Google API round trip every time. Add ?refresh=1 to
// bypass the cache and force a fresh pull.
export async function onRequestGet(context) {
  const { env, request } = context;
  const cache = caches.default;
  const cacheUrl = new URL(request.url);
  const forceRefresh = cacheUrl.searchParams.get('refresh') === '1';
  cacheUrl.searchParams.delete('refresh');
  const cacheKey = new Request(cacheUrl.toString(), request);

  if (!forceRefresh) {
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
  }

  try {
    const url = new URL(request.url);
    const rawRange = url.searchParams.get('range') || 'launch';
    const requestedRange = rawRange === 'launch' ? 'launch' : parseInt(rawRange, 10);
    const range = VALID_WINDOWS.includes(requestedRange) ? requestedRange : 'launch';

    const siteUrl = getSiteUrl(env);
    if (!siteUrl) return json({ error: 'GSC_SITE_URL is not configured' }, 500);
    if (!env.GSC_REFRESH_TOKEN) return json({ error: 'GSC_REFRESH_TOKEN is not configured' }, 500);
    if (!env.GA4_PROPERTY_ID) return json({ error: 'GA4_PROPERTY_ID is not configured' }, 500);

    const { startDate, endDate } = dateWindow(range);
    const warnings = [];

    if (!Array.isArray(PRODUCTS) || !PRODUCTS.length) {
      return json({ error: 'data/newly-added-products.json is missing or empty' }, 500);
    }

    const items = PRODUCTS.map(p => ({
      code: p.code,
      name: p.name,
      status: p.status,
      url: KAPRUKA_BASE + p.code // redirect-only convenience link, for the table's "open page" link
    }));

    const [gscToken, ga4Token] = await Promise.all([
      getGscAccessToken(env),
      getGa4AccessToken(env)
    ]);

    const codes = items.map(i => i.code);
    const [gscByCode, ga4ByCode] = await Promise.all([
      fetchAllGsc(gscToken, siteUrl, codes, { startDate, endDate }, warnings),
      fetchAllGa4(ga4Token, env.GA4_PROPERTY_ID, codes, { startDate, endDate }, warnings)
    ]);

    const products = items.map(item => {
      const key = item.code.toLowerCase();
      const gsc = gscByCode.get(key) || { clicks: 0, impressions: 0, position: 0 };
      const ga4 = ga4ByCode.get(key) || { pageViews: 0, users: 0, sessions: 0 };
      return {
        code: item.code,
        name: item.name,
        status: item.status,
        url: item.url,
        clicks: gsc.clicks,
        impressions: gsc.impressions,
        ctr: gsc.impressions ? gsc.clicks / gsc.impressions : 0,
        position: gsc.position,
        pageViews: ga4.pageViews,
        users: ga4.users,
        sessions: ga4.sessions
      };
    });

    products.sort((a, b) => (b.pageViews + b.clicks) - (a.pageViews + a.clicks));

    const totals = products.reduce((acc, p) => {
      acc.clicks += p.clicks;
      acc.impressions += p.impressions;
      acc.posW += p.position * p.impressions;
      acc.pageViews += p.pageViews;
      acc.users += p.users;
      acc.sessions += p.sessions;
      return acc;
    }, { clicks: 0, impressions: 0, posW: 0, pageViews: 0, users: 0, sessions: 0 });

    const response = json({
      range, startDate, endDate,
      totals: {
        clicks: totals.clicks,
        impressions: totals.impressions,
        ctr: totals.impressions ? totals.clicks / totals.impressions : 0,
        position: totals.impressions ? totals.posW / totals.impressions : 0,
        pageViews: totals.pageViews,
        users: totals.users,
        sessions: totals.sessions
      },
      products,
      warnings
    }, 200, `public, max-age=${CACHE_TTL_SECONDS}`);

    context.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}
