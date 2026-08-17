// functions/api/seo-performance.js
// ============================================================================
//  SEO PERFORMANCE (Google Search Console) — Admin Dashboard "SEO Performance" tab
//
//  SOURCE → Google Search Console Search Analytics API, restricted to pages
//           whose path contains "/online/" (Kapruka's online-store category
//           and listing pages — individual product pages live under
//           /buyonline/ and are intentionally excluded).
//
//  Categorization is derived purely from the URL path, not a hardcoded taxonomy:
//    /online/{root}                                → root category only
//    /online/{root}/price/{sub}                     → root > sub
//    /online/{root}/price/{sub}/{extra}             → root > sub > sub-sub
//  ("price" and similar facet-wrapper segments, plus pure page-number
//  segments, are skipped when picking sub/sub-sub — see SKIP_SEGMENTS.)
//
//  Env vars required (Cloudflare Pages secrets / .dev.vars locally):
//    GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET  — same OAuth client already
//      used elsewhere in this project (posting-calendar.js etc.)
//    GSC_REFRESH_TOKEN   — refresh token for a user with access to the GSC
//      property below, scoped to https://www.googleapis.com/auth/webmasters.readonly
//    GSC_SITE_URL        — one or more Search Console property identifiers,
//      space or comma separated (e.g. "https://www.kapruka.com/ sc-domain:kapruka.com").
//      Each is queried independently and the results are merged.
//  Optional:
//    GSC_ROW_LIMIT       — page rows fetched per request when paginating the
//      page-level breakdown (default 2500, GSC's own per-request max is 25000).
//
//  API shape:
//    GET /api/seo-performance?range=30|90|180
//        → site-wide overview: totals, daily trend, root-category breakdown.
//    GET /api/seo-performance?range=30|90|180&category=<rootKey>
//        → drill-down for one root category: totals, daily trend scoped to
//          that category, sub/sub-sub category breakdown, top pages.
// ============================================================================

const GSC_API = 'https://www.googleapis.com/webmasters/v3/sites';
const ONLINE_SEGMENT = 'online';
// Facet/filter wrapper segments Kapruka's URL scheme inserts between real
// category names — not categories themselves, so they're skipped when
// picking sub/sub-sub labels. "p" = pagination facet (".../p/2"), "lanka" =
// a delivery-location filter applied near-universally across categories
// (confirmed against live GSC page data — both showed up as a near-duplicate
// child under almost every unrelated category with no distinct meaning of
// their own).
const SKIP_SEGMENTS = new Set(['price', 'brand', 'offer', 'offers', 'discount', 'sort', 'filter', 'sale', 'p', 'lanka']);
const VALID_RANGES = [30, 90, 180];
const MAX_PAGE_FETCH_PAGES = 12; // safety cap on pagination loops per site

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

// ── Google OAuth (same pattern as posting-calendar.js, separate refresh token) ──
async function getAccessToken(env) {
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
  if (!res.ok) throw new Error('Google auth failed: ' + JSON.stringify(body));
  return body.access_token;
}

function normalizeSiteUrl(raw) {
  let s = raw.trim();
  if (!s) return null;
  if (s.startsWith('sc-domain:')) return s;
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  if (!s.endsWith('/')) s += '/';
  return s;
}

// A URL-prefix property like "https://www.kapruka.com/" already contains every
// URL under a narrower property such as "https://www.kapruka.com/lk/" (prefix
// matching is a plain string-prefix match on the full URL) — querying both and
// summing would double-count every page under the narrower one. Drop any site
// whose scope is fully contained in an already-kept (shorter) site string.
function dedupeSiteUrls(urls) {
  const sorted = [...new Set(urls)].sort((a, b) => a.length - b.length);
  const kept = [];
  for (const u of sorted) {
    const isScDomain = u.startsWith('sc-domain:');
    const subsumed = kept.some(k => !isScDomain && !k.startsWith('sc-domain:') && u.startsWith(k));
    if (!subsumed) kept.push(u);
  }
  return kept;
}

function getSiteUrls(env) {
  const raw = (env.GSC_SITE_URL || '')
    .split(/[\s,]+/)
    .map(normalizeSiteUrl)
    .filter(Boolean);
  return dedupeSiteUrls(raw);
}

function rowLimitFromEnv(env) {
  const n = parseInt(env.GSC_ROW_LIMIT, 10);
  if (!n || Number.isNaN(n)) return 2500;
  return Math.min(Math.max(n, 100), 25000);
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

// ── Search Console query ─────────────────────────────────────────────────
async function gscQuery(token, siteUrl, body) {
  const res = await fetch(`${GSC_API}/${encodeURIComponent(siteUrl)}/searchAnalytics/query`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`GSC query failed (${res.status}): ${data.error?.message || JSON.stringify(data)}`);
  return data;
}

function pathFilter(pathRegex) {
  return [{ filters: [{ dimension: 'page', operator: 'includingRegex', expression: pathRegex }] }];
}

// One row per date, merged across all configured sites.
async function fetchDateSeries(token, siteUrls, { startDate, endDate, pathRegex }, warnings) {
  const merged = new Map(); // date -> { clicks, impressions, posW }
  for (const siteUrl of siteUrls) {
    try {
      const data = await gscQuery(token, siteUrl, {
        startDate, endDate,
        dimensions: ['date'],
        dimensionFilterGroups: pathFilter(pathRegex),
        rowLimit: 1000
      });
      for (const row of data.rows || []) {
        const date = row.keys[0];
        const entry = merged.get(date) || { clicks: 0, impressions: 0, posW: 0 };
        entry.clicks += row.clicks;
        entry.impressions += row.impressions;
        entry.posW += row.position * row.impressions;
        merged.set(date, entry);
      }
    } catch (e) {
      warnings.push(`${siteUrl} (date series): ${e.message}`);
    }
  }
  return [...merged.entries()]
    .map(([date, v]) => ({
      date,
      clicks: v.clicks,
      impressions: v.impressions,
      ctr: v.impressions ? v.clicks / v.impressions : 0,
      position: v.impressions ? v.posW / v.impressions : 0
    }))
    .sort((a, b) => a.date < b.date ? -1 : 1);
}

// One row per page, concatenated across all configured sites (paginated per site).
async function fetchPageBreakdown(token, siteUrls, { startDate, endDate, pathRegex, rowLimit }, warnings) {
  const rows = [];
  for (const siteUrl of siteUrls) {
    try {
      let startRow = 0;
      for (let i = 0; i < MAX_PAGE_FETCH_PAGES; i++) {
        const data = await gscQuery(token, siteUrl, {
          startDate, endDate,
          dimensions: ['page'],
          dimensionFilterGroups: pathFilter(pathRegex),
          rowLimit, startRow
        });
        const got = data.rows || [];
        for (const r of got) {
          rows.push({ page: r.keys[0], clicks: r.clicks, impressions: r.impressions, position: r.position });
        }
        if (got.length < rowLimit) break;
        startRow += rowLimit;
      }
    } catch (e) {
      warnings.push(`${siteUrl} (page breakdown): ${e.message}`);
    }
  }
  return rows;
}

// ── URL → category parsing ───────────────────────────────────────────────
function decodeSeg(seg) {
  try { return decodeURIComponent(seg); } catch { return seg; }
}

function prettify(s) {
  return decodeSeg(s)
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, c => c.toUpperCase());
}

function parseOnlineUrl(pageUrl) {
  let pathname;
  try { pathname = new URL(pageUrl).pathname; } catch { return null; }
  const segs = pathname.split('/').filter(Boolean);
  const idx = segs.findIndex(s => s.toLowerCase() === ONLINE_SEGMENT);
  if (idx === -1 || idx === segs.length - 1) return null;

  const rootSeg = segs[idx + 1];
  const meaningful = segs.slice(idx + 2).filter(s => s && !/^\d+$/.test(s) && !SKIP_SEGMENTS.has(s.toLowerCase()));

  return {
    rootKey: rootSeg.toLowerCase(),
    rootLabel: prettify(rootSeg),
    subKey: meaningful[0] ? meaningful[0].toLowerCase() : null,
    subLabel: meaningful[0] ? prettify(meaningful[0]) : null,
    subsubKey: meaningful[1] ? meaningful[1].toLowerCase() : null,
    subsubLabel: meaningful[1] ? prettify(meaningful[1]) : null
  };
}

// ── Category tree aggregation ────────────────────────────────────────────
function newNode(key, label) {
  return { key, label, clicks: 0, impressions: 0, posW: 0, pageCount: 0, children: new Map() };
}

function accumulate(node, row) {
  node.clicks += row.clicks;
  node.impressions += row.impressions;
  node.posW += row.position * row.impressions;
  node.pageCount += 1;
}

function finalizeNode(node) {
  const ctr = node.impressions ? node.clicks / node.impressions : 0;
  const position = node.impressions ? node.posW / node.impressions : 0;
  const children = [...node.children.values()]
    .map(finalizeNode)
    .sort((a, b) => b.clicks - a.clicks);
  return { key: node.key, label: node.label, clicks: node.clicks, impressions: node.impressions, ctr, position, pageCount: node.pageCount, children };
}

function buildCategoryTree(pageRows, { onlyRoot } = {}) {
  const roots = new Map();
  for (const row of pageRows) {
    const parsed = parseOnlineUrl(row.page);
    if (!parsed) continue;
    if (onlyRoot && parsed.rootKey !== onlyRoot) continue;

    let root = roots.get(parsed.rootKey);
    if (!root) { root = newNode(parsed.rootKey, parsed.rootLabel); roots.set(parsed.rootKey, root); }
    accumulate(root, row);

    if (parsed.subKey) {
      let sub = root.children.get(parsed.subKey);
      if (!sub) { sub = newNode(parsed.subKey, parsed.subLabel); root.children.set(parsed.subKey, sub); }
      accumulate(sub, row);

      if (parsed.subsubKey) {
        let subsub = sub.children.get(parsed.subsubKey);
        if (!subsub) { subsub = newNode(parsed.subsubKey, parsed.subsubLabel); sub.children.set(parsed.subsubKey, subsub); }
        accumulate(subsub, row);
      }
    }
  }
  return roots;
}

function aggregateTotals(trend) {
  let clicks = 0, impressions = 0, posW = 0;
  for (const r of trend) {
    clicks += r.clicks;
    impressions += r.impressions;
    posW += r.position * r.impressions;
  }
  return {
    clicks, impressions,
    ctr: impressions ? clicks / impressions : 0,
    position: impressions ? posW / impressions : 0
  };
}

// ── Handler ───────────────────────────────────────────────────────────────
export async function onRequestGet(context) {
  const { env, request } = context;
  try {
    const url = new URL(request.url);
    const requestedRange = parseInt(url.searchParams.get('range') || '30', 10);
    const range = VALID_RANGES.includes(requestedRange) ? requestedRange : 30;
    const categoryKey = (url.searchParams.get('category') || '').trim().toLowerCase() || null;

    const siteUrls = getSiteUrls(env);
    if (!siteUrls.length) return json({ error: 'GSC_SITE_URL is not configured' }, 500);
    if (!env.GSC_REFRESH_TOKEN) return json({ error: 'GSC_REFRESH_TOKEN is not configured' }, 500);

    const token = await getAccessToken(env);
    const { startDate, endDate } = dateWindow(range);
    const pathRegex = categoryKey ? `/${ONLINE_SEGMENT}/${escapeRegex(categoryKey)}(/|$)` : `/${ONLINE_SEGMENT}/`;
    const warnings = [];

    const [trend, pageRows] = await Promise.all([
      fetchDateSeries(token, siteUrls, { startDate, endDate, pathRegex }, warnings),
      fetchPageBreakdown(token, siteUrls, { startDate, endDate, pathRegex, rowLimit: rowLimitFromEnv(env) }, warnings)
    ]);

    const totals = aggregateTotals(trend);

    if (categoryKey) {
      const tree = buildCategoryTree(pageRows, { onlyRoot: categoryKey });
      const rootNode = tree.get(categoryKey);
      const finalized = rootNode ? finalizeNode(rootNode) : null;
      const topPages = pageRows
        .slice()
        .sort((a, b) => b.clicks - a.clicks)
        .slice(0, 30)
        .map(r => ({ page: r.page, clicks: r.clicks, impressions: r.impressions, ctr: r.impressions ? r.clicks / r.impressions : 0, position: r.position }));

      return json({
        mode: 'category',
        range, startDate, endDate,
        category: categoryKey,
        label: finalized?.label || prettify(categoryKey),
        totals, trend,
        subcategories: finalized?.children || [],
        pageCount: pageRows.length,
        topPages,
        warnings
      });
    }

    const tree = buildCategoryTree(pageRows, {});
    const categories = [...tree.values()].map(finalizeNode).sort((a, b) => b.clicks - a.clicks);

    return json({
      mode: 'overview',
      range, startDate, endDate,
      totals, trend, categories,
      pageCount: pageRows.length,
      siteUrls,
      warnings
    });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}
