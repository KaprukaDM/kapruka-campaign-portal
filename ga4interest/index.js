require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Auth ───────────────────────────────────────────────────────────────────

let cachedToken = null;
let tokenExpiry = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GA4_CLIENT_ID || process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GA4_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: process.env.GA4_REFRESH_TOKEN || process.env.GSC_REFRESH_TOKEN,
      grant_type: 'refresh_token'
    })
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('Token refresh failed: ' + JSON.stringify(data));
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return cachedToken;
}

// ─── Date helpers ───────────────────────────────────────────────────────────

function getDateRanges() {
  const now = new Date();
  const currentEnd = new Date(now); currentEnd.setDate(currentEnd.getDate() - 1);
  const currentStart = new Date(currentEnd); currentStart.setDate(currentStart.getDate() - 29);
  const previousEnd = new Date(currentStart); previousEnd.setDate(previousEnd.getDate() - 1);
  const previousStart = new Date(previousEnd); previousStart.setDate(previousStart.getDate() - 29);
  const fmt = (d) => d.toISOString().split('T')[0];
  return {
    current: { start: fmt(currentStart), end: fmt(currentEnd) },
    previous: { start: fmt(previousStart), end: fmt(previousEnd) }
  };
}

// ─── URL classification ────────────────────────────────────────────────────

function classifyUrl(pagePath) {
  const productMatch = pagePath.match(/^\/buyonline\/(.+?)\/kid\/(.+?)$/);
  if (productMatch) {
    return { level: 'product', slug: productMatch[1], productId: productMatch[2], hierarchy: null };
  }
  const catMatch = pagePath.match(/^\/online\/(.+?)$/);
  if (catMatch) {
    const parts = catMatch[1].split('/');
    const root = parts[0] || null;
    let sub = null, subsub = null;
    if (parts[1] === 'price' && parts[2]) sub = parts[2];
    if (parts[3] === 'lanka' && parts[4]) subsub = parts[4];
    let level = 'root';
    if (subsub) level = 'sub_sub';
    else if (sub) level = 'sub';
    return { level, root, sub, subsub, hierarchy: [root, sub, subsub].filter(Boolean).join(' > ') };
  }
  return null;
}

// ─── Fetch a single period into buckets ─────────────────────────────────────

async function fetchPeriod(token, startDate, endDate) {
  const buckets = { categories: {}, products: {} };

  // GSC
  let startRow = 0;
  let gscTotal = 0;
  while (true) {
    const res = await fetch(
      `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(process.env.GSC_SITE_URL)}/searchAnalytics/query`,
      {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ startDate, endDate, dimensions: ['page'], rowLimit: 5000, startRow, dataState: 'final' })
      }
    );
    const data = await res.json();
    const rows = data.rows || [];
    if (rows.length === 0) break;
    gscTotal += rows.length;

    for (const row of rows) {
      let pathname;
      try { pathname = new URL(row.keys[0]).pathname; } catch { continue; }
      const c = classifyUrl(pathname);
      if (!c) continue;

      const isProduct = c.level === 'product';
      const store = isProduct ? buckets.products : buckets.categories;
      const key = isProduct ? c.productId : c.hierarchy;

      if (!store[key]) {
        store[key] = { ...c, gsc_i: 0, gsc_c: 0, ga4_v: 0, ga4_e: 0, ga4_s: 0 };
      }
      store[key].gsc_i += row.impressions || 0;
      store[key].gsc_c += row.clicks || 0;
    }

    if (rows.length < 5000) break;
    startRow += 5000;
  }
  console.log(`  GSC: ${gscTotal} rows`);

  // GA4
  let offset = 0;
  let ga4Total = 0;
  while (true) {
    const res = await fetch(
      `https://analyticsdata.googleapis.com/v1beta/properties/${process.env.GA4_PROPERTY_ID}:runReport`,
      {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dateRanges: [{ startDate, endDate }],
          dimensions: [{ name: 'pagePath' }],
          metrics: [{ name: 'screenPageViews' }, { name: 'engagedSessions' }, { name: 'sessions' }],
          limit: 10000, offset, keepEmptyRows: false
        })
      }
    );
    const data = await res.json();
    const rows = data.rows || [];
    if (rows.length === 0) break;
    ga4Total += rows.length;

    for (const row of rows) {
      const c = classifyUrl(row.dimensionValues[0].value);
      if (!c) continue;

      const isProduct = c.level === 'product';
      const store = isProduct ? buckets.products : buckets.categories;
      const key = isProduct ? c.productId : c.hierarchy;

      if (!store[key]) {
        store[key] = { ...c, gsc_i: 0, gsc_c: 0, ga4_v: 0, ga4_e: 0, ga4_s: 0 };
      }
      store[key].ga4_v += parseInt(row.metricValues[0].value) || 0;
      store[key].ga4_e += parseInt(row.metricValues[1].value) || 0;
      store[key].ga4_s += parseInt(row.metricValues[2].value) || 0;
    }

    if (rows.length < 10000) break;
    offset += 10000;
  }
  console.log(`  GA4: ${ga4Total} rows`);

  // Prune products: keep top 500 by total activity
  const prodEntries = Object.entries(buckets.products);
  if (prodEntries.length > 500) {
    prodEntries.sort((a, b) => (b[1].ga4_v + b[1].gsc_c) - (a[1].ga4_v + a[1].gsc_c));
    buckets.products = {};
    for (const [k, v] of prodEntries.slice(0, 500)) {
      buckets.products[k] = v;
    }
  }
  console.log(`  Categories: ${Object.keys(buckets.categories).length}, Products: ${Object.keys(buckets.products).length}`);

  return buckets;
}

// ─── Score + flatten ────────────────────────────────────────────────────────

function scoreItems(store) {
  const levels = { root: [], sub: [], sub_sub: [], product: [] };

  for (const item of Object.values(store)) {
    if (levels[item.level]) levels[item.level].push(item);
  }

  for (const items of Object.values(levels)) {
    if (items.length === 0) continue;
    const maxI = Math.max(...items.map(i => i.gsc_i), 1);
    const maxC = Math.max(...items.map(i => i.gsc_c), 1);
    const maxV = Math.max(...items.map(i => i.ga4_v), 1);

    for (const item of items) {
      const nI = (item.gsc_i / maxI) * 100;
      const nC = (item.gsc_c / maxC) * 100;
      const nV = (item.ga4_v / maxV) * 100;
      const eR = item.ga4_s > 0 ? (item.ga4_e / item.ga4_s) * 100 : 0;
      item.score = Math.round(nI * 0.30 + nC * 0.30 + nV * 0.25 + eR * 0.15);
      item.engaged_ratio = Math.round(eR);
    }
    items.sort((a, b) => b.score - a.score);
  }

  return levels;
}

// ─── Merge into keyed map for trend comparison ──────────────────────────────

function toKeyedScores(levels) {
  const map = {};
  for (const items of Object.values(levels)) {
    for (const item of items) {
      const key = item.level === 'product' ? item.productId : item.hierarchy;
      map[key] = item.score;
    }
  }
  return map;
}

// ─── CSV generation (no ExcelJS needed) ─────────────────────────────────────

function generateCSV(levels) {
  const rows = [['Level', 'Name', 'Interest Score', 'Trend', 'Change', 'GSC Impressions', 'GSC Clicks', 'GA4 Views', 'Engagement Rate %', 'Prev Score']];

  for (const [level, items] of Object.entries(levels)) {
    for (const item of items) {
      const name = item.level === 'product' ? (item.slug || item.productId) : (item.hierarchy || '');
      rows.push([
        level, `"${name}"`, item.score, item.trend || '', item.score_change || 0,
        item.gsc_i, item.gsc_c, item.ga4_v, item.engaged_ratio, item.prev_score || 0
      ]);
    }
  }

  return rows.map(r => r.join(',')).join('\n');
}

// ─── Main endpoint ─────────────────────────────────────────────────────────

app.get('/analyze', async (req, res) => {
  try {
    console.log('Starting analysis...');
    const token = await getAccessToken();
    const dateRanges = getDateRanges();
    console.log(`Current: ${dateRanges.current.start} → ${dateRanges.current.end}`);
    console.log(`Previous: ${dateRanges.previous.start} → ${dateRanges.previous.end}`);

    // Current period
    console.log('Current period:');
    const curBuckets = await fetchPeriod(token, dateRanges.current.start, dateRanges.current.end);
    const allCurrent = { ...curBuckets.categories, ...curBuckets.products };
    const currentLevels = scoreItems(allCurrent);

    // Previous period
    console.log('Previous period:');
    const prevBuckets = await fetchPeriod(token, dateRanges.previous.start, dateRanges.previous.end);
    const allPrevious = { ...prevBuckets.categories, ...prevBuckets.products };
    const previousLevels = scoreItems(allPrevious);
    const prevScores = toKeyedScores(previousLevels);

    // Add trends to current
    for (const items of Object.values(currentLevels)) {
      for (const item of items) {
        const key = item.level === 'product' ? item.productId : item.hierarchy;
        const prev = prevScores[key];
        if (prev !== undefined && prev > 0) {
          item.prev_score = prev;
          item.score_change = item.score - prev;
          item.trend = item.score_change > 2 ? '↑ Rising' : item.score_change < -2 ? '↓ Falling' : '→ Stable';
        } else {
          item.prev_score = prev || 0;
          item.score_change = 0;
          item.trend = prev !== undefined ? '→ Stable' : '★ New';
        }
      }
    }

    // Generate CSV download
    const csv = generateCSV(currentLevels);
    const csvPath = path.join('/tmp', `kapruka-interest-${Date.now()}.csv`);
    fs.writeFileSync(csvPath, csv);

    // Flatten for frontend
    const flatten = (items) => items.map(i => ({
      name: i.level === 'product' ? (i.slug || i.productId) : (i.hierarchy || ''),
      level: i.level,
      interest_score: i.score,
      trend: i.trend,
      score_change: i.score_change || 0,
      gsc_impressions: i.gsc_i,
      gsc_clicks: i.gsc_c,
      ga4_views: i.ga4_v,
      engaged_ratio: i.engaged_ratio,
      prev_score: i.prev_score || 0
    }));

    res.json({
      success: true,
      dateRanges,
      summary: {
        root_categories: currentLevels.root.length,
        sub_categories: currentLevels.sub.length,
        sub_sub_categories: currentLevels.sub_sub.length,
        products: currentLevels.product.length,
        total_items: Object.values(currentLevels).flat().length
      },
      all_root: flatten(currentLevels.root),
      all_sub: flatten(currentLevels.sub),
      all_sub_sub: flatten(currentLevels.sub_sub),
      all_product: flatten(currentLevels.product),
      download: `/download/${path.basename(csvPath)}`
    });

    console.log('Analysis complete.');
  } catch (err) {
    console.error('Analysis error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/download/:filename', (req, res) => {
  const filePath = path.join('/tmp', req.params.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  res.download(filePath);
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Running on port ${PORT}`));
