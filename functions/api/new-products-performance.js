// functions/api/new-products-performance.js
// ============================================================================
//  NEWLY ADDED PRODUCTS PERFORMANCE — GSC + GA4, fixed product list
//
//  SOURCE → Google Search Console Search Analytics API + GA4 Data API,
//           restricted to the exact ~2000 product URLs added between
//           Aug 1 and Sep 11, 2025 (data/newly-added-products.json).
//
//  Each product's live URL is https://www.kapruka.com/buyonline/-/kid/{code}
//  (same pattern as homepage-booking-portal.html's KAPRUKA_BASE and
//  ga4interest/index.js's classifyUrl regex).
//
//  Env vars required (Cloudflare Pages secrets / .dev.vars locally):
//    GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GSC_REFRESH_TOKEN — same
//      OAuth pattern as functions/api/seo-performance.js.
//    GA4_PROPERTY_ID    — numeric GA4 property id.
//    GA4_REFRESH_TOKEN  — optional; falls back to GSC_REFRESH_TOKEN if unset
//      (same fallback pattern as ga4interest/index.js).
//
//  API shape:
//    GET /api/new-products-performance?range=30|90|180
// ============================================================================

import PRODUCTS from '../../data/newly-added-products.json';

const GSC_API = 'https://www.googleapis.com/webmasters/v3/sites';
const GA4_API = 'https://analyticsdata.googleapis.com/v1beta/properties';
const KAPRUKA_BASE = 'https://www.kapruka.com/buyonline/-/kid/';
const VALID_RANGES = [30, 90, 180];
const GA4_BATCH_SIZE = 100;
const GSC_ROW_LIMIT = 25000; // GSC's own per-request max
const GSC_MAX_PAGES = 20; // safety cap on pagination (500k rows)

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

// GSC finalized data typically lags ~2-3 days behind "today".
function dateWindow(days) {
  const now = new Date();
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  end.setUTCDate(end.getUTCDate() - 3);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (days - 1));
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

// ── GSC: page-level breakdown, paginated, filtered locally to our URL set ──
// GSC's dimensionFilterGroups ANDs filters within a single group — there is
// no documented way to OR many "page equals X" filters together in one
// request, so exact per-URL batching isn't viable the way GA4's inListFilter
// is. Instead this pulls the full page-level breakdown for the whole
// property in the date range (same paginated pattern as
// functions/api/seo-performance.js's fetchPageBreakdown) and keeps only rows
// whose URL is in our fixed product list — one bounded set of requests
// regardless of how many of the ~2000 products actually have any GSC data.
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

async function fetchAllGsc(token, siteUrl, urls, range, warnings) {
  const wanted = new Set(urls);
  const rows = await fetchGscPageBreakdown(token, siteUrl, range, warnings);
  const byUrl = new Map();
  for (const row of rows) {
    const page = row.keys[0];
    if (!wanted.has(page)) continue;
    byUrl.set(page, {
      clicks: row.clicks || 0,
      impressions: row.impressions || 0,
      position: row.position || 0
    });
  }
  return byUrl;
}

// ── GA4: batch pagePath lookups via inListFilter ─────────────────────────
async function fetchGa4Batch(token, propertyId, paths, { startDate, endDate }) {
  const res = await fetch(`${GA4_API}/${propertyId}:runReport`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      dateRanges: [{ startDate, endDate }],
      dimensions: [{ name: 'pagePath' }],
      metrics: [{ name: 'screenPageViews' }, { name: 'totalUsers' }, { name: 'sessions' }],
      dimensionFilter: {
        filter: {
          fieldName: 'pagePath',
          inListFilter: { values: paths }
        }
      },
      limit: paths.length,
      keepEmptyRows: false
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`GA4 query failed (${res.status}): ${data.error?.message || JSON.stringify(data)}`);
  return data.rows || [];
}

async function fetchAllGa4(token, propertyId, paths, range, warnings) {
  const byPath = new Map();
  const batches = chunk(paths, GA4_BATCH_SIZE);
  for (const batch of batches) {
    try {
      const rows = await fetchGa4Batch(token, propertyId, batch, range);
      for (const row of rows) {
        const path = row.dimensionValues[0].value;
        byPath.set(path, {
          pageViews: parseInt(row.metricValues[0].value, 10) || 0,
          users: parseInt(row.metricValues[1].value, 10) || 0,
          sessions: parseInt(row.metricValues[2].value, 10) || 0
        });
      }
    } catch (e) {
      warnings.push(`GA4 batch (${batch.length} paths): ${e.message}`);
    }
  }
  return byPath;
}

// ── Handler ───────────────────────────────────────────────────────────────
export async function onRequestGet(context) {
  const { env, request } = context;
  try {
    const url = new URL(request.url);
    const requestedRange = parseInt(url.searchParams.get('range') || '30', 10);
    const range = VALID_RANGES.includes(requestedRange) ? requestedRange : 30;

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
      url: KAPRUKA_BASE + p.code,
      path: '/buyonline/-/kid/' + p.code
    }));

    const [gscToken, ga4Token] = await Promise.all([
      getGscAccessToken(env),
      getGa4AccessToken(env)
    ]);

    const [gscByUrl, ga4ByPath] = await Promise.all([
      fetchAllGsc(gscToken, siteUrl, items.map(i => i.url), { startDate, endDate }, warnings),
      fetchAllGa4(ga4Token, env.GA4_PROPERTY_ID, items.map(i => i.path), { startDate, endDate }, warnings)
    ]);

    const products = items.map(item => {
      const gsc = gscByUrl.get(item.url) || { clicks: 0, impressions: 0, position: 0 };
      const ga4 = ga4ByPath.get(item.path) || { pageViews: 0, users: 0, sessions: 0 };
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

    return json({
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
    });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}
