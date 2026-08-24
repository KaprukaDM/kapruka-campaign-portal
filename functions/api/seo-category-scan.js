// functions/api/seo-category-scan.js
// ============================================================================
//  Admin Dashboard "SEO Performance" tab — live catalog scan.
//
//  There is no internal product/catalog API or DB in this project, so product
//  counts and the sub-category/brand facet tree are read straight off the
//  public kapruka.com category pages a shopper would see, the same way
//  seo-performance.js reads GSC data for the same /online/ URL scheme.
//
//  Kapruka's category pages expose two things we rely on, found in the raw
//  HTML (server-rendered, no JS execution needed):
//    - `totalProductsLoaded / <N>`     — total product count for the page's
//                                         current filter scope.
//    - Filter-sidebar links like `.../price/vogue_jewelers">Vogue (136)</a>`
//      — one facet (brand, gender, or — one level deeper — jewelry type,
//      etc.) per link, with its own product count in parentheses.
//
//  GET /api/seo-category-scan?url=<https://www.kapruka.com/online/... page>
//      → { url, totalProducts, facets: [{ key, label, count, url }] }
//      facets are the DIRECT children of the given page (one meaningful
//      segment deeper), sorted by count descending.
// ============================================================================

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

const ALLOWED_HOST = 'www.kapruka.com';

// Facet/filter wrapper segments that aren't themselves a category, brand, or
// type name — kept in sync with seo-performance.js's SKIP_SEGMENTS.
const SKIP_SEGMENTS = new Set(['price', 'brand', 'offer', 'offers', 'discount', 'sort', 'filter', 'sale', 'p', 'lanka']);

function safeParseUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.hostname !== ALLOWED_HOST) return null;
  if (!/^\/online\//i.test(u.pathname)) return null;
  return u;
}

function extractTotalProducts(html) {
  const m = html.match(/totalProductsLoaded\s*\/\s*(\d+)/i);
  return m ? parseInt(m[1], 10) : null;
}

// Loosely normalize a URL segment for comparison — Kapruka's own markup is
// inconsistent about apostrophe vs backtick in facet slugs (e.g. "men's_jewelry"
// vs "men`s_jewelry" both appear, pointing at the same page), so comparisons
// strip everything but letters/digits rather than doing an exact match.
function norm(s) {
  return decodeURIComponent(s).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function meaningfulSegs(segs) {
  return segs.slice(2).filter(s => !SKIP_SEGMENTS.has(s.toLowerCase()));
}

// Pull every internal /online/{root}/... link on the page, and keep only the
// ones that are exactly one meaningful segment deeper than the page we
// fetched — i.e. real children in the filter sidebar for THIS page.
function extractFacets(html, baseUrl) {
  const baseSegs = baseUrl.pathname.split('/').filter(Boolean);
  const baseRoot = (baseSegs[1] || '').toLowerCase();
  const baseMeaningful = meaningfulSegs(baseSegs).map(norm);

  const re = /<a[^>]*href="(https:\/\/www\.kapruka\.com\/online\/[^"#?]*)"[^>]*>([\s\S]{0,150}?)<\/a>/g;
  const byKey = new Map(); // normalized child key -> { key, label, count, url }
  let m;
  while ((m = re.exec(html))) {
    const href = m[1];
    let u;
    try { u = new URL(href); } catch { continue; }
    const segs = u.pathname.split('/').filter(Boolean);
    if ((segs[1] || '').toLowerCase() !== baseRoot) continue;

    const meaningful = meaningfulSegs(segs);
    if (meaningful.length !== baseMeaningful.length + 1) continue;
    const normed = meaningful.map(norm);
    const prefixMatches = baseMeaningful.every((s, i) => s === normed[i]);
    if (!prefixMatches) continue;

    const childRaw = meaningful[meaningful.length - 1];
    const childKey = normed[normed.length - 1];

    const rawText = m[2].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
    const countMatch = rawText.match(/\((\d+)\)\s*$/);
    const label = (countMatch ? rawText.slice(0, countMatch.index) : rawText).trim();
    if (!label || /^all items$/i.test(label)) continue;

    const count = countMatch ? parseInt(countMatch[1], 10) : null;
    const existing = byKey.get(childKey);
    if (!existing || (count != null && existing.count == null)) {
      byKey.set(childKey, { key: childRaw, label, count, url: u.toString() });
    }
  }
  return [...byKey.values()].sort((a, b) => (b.count ?? -1) - (a.count ?? -1));
}

export async function onRequestGet(context) {
  const { request } = context;
  try {
    const url = new URL(request.url);
    const target = url.searchParams.get('url') || '';
    const parsed = safeParseUrl(target);
    if (!parsed) return json({ error: 'url must be a https://www.kapruka.com/online/... page' }, 400);

    const res = await fetch(parsed.toString(), {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; KaprukaAdminSEOBot/1.0)' }
    });
    if (!res.ok) return json({ error: `Failed to fetch category page (${res.status})` }, 502);
    const html = await res.text();

    return json({
      url: parsed.toString(),
      totalProducts: extractTotalProducts(html),
      facets: extractFacets(html, parsed)
    });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}
