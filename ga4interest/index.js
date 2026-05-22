require('dotenv').config();
const express = require('express');
const ExcelJS = require('exceljs');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Auth — raw OAuth2 token refresh via fetch ──────────────────────────────

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
  const currentEnd = new Date(now);
  currentEnd.setDate(currentEnd.getDate() - 1);
  const currentStart = new Date(currentEnd);
  currentStart.setDate(currentStart.getDate() - 29);

  const previousEnd = new Date(currentStart);
  previousEnd.setDate(previousEnd.getDate() - 1);
  const previousStart = new Date(previousEnd);
  previousStart.setDate(previousStart.getDate() - 29);

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

// ─── GSC fetch + aggregate via raw fetch ────────────────────────────────────

async function fetchGSCIntoBuckets(token, startDate, endDate, buckets) {
  let startRow = 0;
  const rowLimit = 5000;
  let totalRows = 0;

  while (true) {
    const res = await fetch(
      `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(process.env.GSC_SITE_URL)}/searchAnalytics/query`,
      {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ startDate, endDate, dimensions: ['page'], rowLimit, startRow, dataState: 'final' })
      }
    );

    const data = await res.json();
    const rows = data.rows || [];
    if (rows.length === 0) break;
    totalRows += rows.length;

    for (const row of rows) {
      let pathname;
      try { pathname = new URL(row.keys[0]).pathname; } catch { continue; }
      const c = classifyUrl(pathname);
      if (!c) continue;

      const key = c.level === 'product' ? `product::${c.productId}` : `${c.level}::${c.hierarchy}`;
      if (!buckets[key]) {
        buckets[key] = { ...c, key, gsc_impressions: 0, gsc_clicks: 0, ga4_views: 0, ga4_engaged: 0, ga4_sessions: 0 };
      }
      buckets[key].gsc_impressions += row.impressions || 0;
      buckets[key].gsc_clicks += row.clicks || 0;
    }

    if (rows.length < rowLimit) break;
    startRow += rowLimit;
  }

  console.log(`GSC: ${totalRows} rows aggregated`);
}

// ─── GA4 fetch + aggregate via raw fetch ────────────────────────────────────

async function fetchGA4IntoBuckets(token, startDate, endDate, buckets) {
  let offset = 0;
  const limit = 10000;
  let totalRows = 0;

  while (true) {
    const res = await fetch(
      `https://analyticsdata.googleapis.com/v1beta/properties/${process.env.GA4_PROPERTY_ID}:runReport`,
      {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dateRanges: [{ startDate, endDate }],
          dimensions: [{ name: 'pagePath' }],
          metrics: [
            { name: 'screenPageViews' },
            { name: 'engagedSessions' },
            { name: 'sessions' }
          ],
          limit,
          offset,
          keepEmptyRows: false
        })
      }
    );

    const data = await res.json();
    const rows = data.rows || [];
    if (rows.length === 0) break;
    totalRows += rows.length;

    for (const row of rows) {
      const pagePath = row.dimensionValues[0].value;
      const c = classifyUrl(pagePath);
      if (!c) continue;

      const key = c.level === 'product' ? `product::${c.productId}` : `${c.level}::${c.hierarchy}`;
      if (!buckets[key]) {
        buckets[key] = { ...c, key, gsc_impressions: 0, gsc_clicks: 0, ga4_views: 0, ga4_engaged: 0, ga4_sessions: 0 };
      }
      buckets[key].ga4_views += parseInt(row.metricValues[0].value) || 0;
      buckets[key].ga4_engaged += parseInt(row.metricValues[1].value) || 0;
      buckets[key].ga4_sessions += parseInt(row.metricValues[2].value) || 0;
    }

    if (rows.length < limit) break;
    offset += limit;
  }

  console.log(`GA4: ${totalRows} rows aggregated`);
}

// ─── Score calculation ─────────────────────────────────────────────────────

function calculateScores(buckets) {
  const levels = { root: [], sub: [], sub_sub: [], product: [] };

  for (const item of Object.values(buckets)) {
    if (levels[item.level]) levels[item.level].push(item);
  }

  for (const [level, items] of Object.entries(levels)) {
    if (items.length === 0) continue;

    const maxImpressions = Math.max(...items.map(i => i.gsc_impressions), 1);
    const maxClicks = Math.max(...items.map(i => i.gsc_clicks), 1);
    const maxViews = Math.max(...items.map(i => i.ga4_views), 1);

    for (const item of items) {
      const normImpressions = (item.gsc_impressions / maxImpressions) * 100;
      const normClicks = (item.gsc_clicks / maxClicks) * 100;
      const normViews = (item.ga4_views / maxViews) * 100;
      const engagedRatio = item.ga4_sessions > 0 ? (item.ga4_engaged / item.ga4_sessions) * 100 : 0;

      item.interest_score = Math.round(
        normImpressions * 0.30 + normClicks * 0.30 + normViews * 0.25 + engagedRatio * 0.15
      );
      item.norm_impressions = Math.round(normImpressions);
      item.norm_clicks = Math.round(normClicks);
      item.norm_views = Math.round(normViews);
      item.engaged_ratio = Math.round(engagedRatio);
    }

    items.sort((a, b) => b.interest_score - a.interest_score);
  }

  return levels;
}

// ─── Trend calculation ─────────────────────────────────────────────────────

function calculateTrends(currentLevels, previousLevels) {
  for (const level of Object.keys(currentLevels)) {
    const prevMap = {};
    for (const item of (previousLevels[level] || [])) {
      prevMap[item.key] = item;
    }

    for (const item of currentLevels[level]) {
      const prev = prevMap[item.key];
      if (prev && prev.interest_score > 0) {
        item.prev_score = prev.interest_score;
        item.score_change = item.interest_score - prev.interest_score;
        item.score_change_pct = Math.round(((item.interest_score - prev.interest_score) / prev.interest_score) * 100);
        item.trend = item.score_change > 2 ? '↑ Rising' : item.score_change < -2 ? '↓ Falling' : '→ Stable';
      } else {
        item.prev_score = prev ? prev.interest_score : 0;
        item.score_change = item.interest_score;
        item.score_change_pct = 0;
        item.trend = prev ? '→ Stable' : '★ New';
      }
    }
  }
  return currentLevels;
}

// ─── Excel export ──────────────────────────────────────────────────────────

async function generateExcel(data, dateRanges) {
  const wb = new ExcelJS.Workbook();

  const headerStyle = {
    font: { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 },
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1a1a2e' } },
    alignment: { horizontal: 'center', vertical: 'middle' },
    border: { top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' } }
  };

  // Summary sheet
  const ss = wb.addWorksheet('Summary');
  ss.columns = [{ header: 'Metric', key: 'metric', width: 30 }, { header: 'Value', key: 'value', width: 20 }];
  ss.addRow({ metric: 'Current Period', value: `${dateRanges.current.start} to ${dateRanges.current.end}` });
  ss.addRow({ metric: 'Previous Period', value: `${dateRanges.previous.start} to ${dateRanges.previous.end}` });
  ss.addRow({});
  ss.addRow({ metric: 'Root Categories', value: data.root.length });
  ss.addRow({ metric: 'Sub Categories', value: data.sub.length });
  ss.addRow({ metric: 'Sub-Sub Categories', value: data.sub_sub.length });
  ss.addRow({ metric: 'Products', value: data.product.length });
  ss.addRow({});
  ss.addRow({ metric: 'Weights: GSC Impressions', value: '30%' });
  ss.addRow({ metric: 'Weights: GSC Clicks', value: '30%' });
  ss.addRow({ metric: 'Weights: GA4 Page Views', value: '25%' });
  ss.addRow({ metric: 'Weights: GA4 Engagement Rate', value: '15%' });

  const configs = [
    { key: 'root', title: 'Root Categories', nameCol: 'Category' },
    { key: 'sub', title: 'Sub Categories', nameCol: 'Sub Category' },
    { key: 'sub_sub', title: 'Sub-Sub Categories', nameCol: 'Sub-Sub Category' },
    { key: 'product', title: 'Products', nameCol: 'Product' }
  ];

  for (const cfg of configs) {
    const items = data[cfg.key];
    if (items.length === 0) continue;

    const ws = wb.addWorksheet(cfg.title);
    const headers = [
      cfg.nameCol, 'Interest Score', 'Trend', 'Score Change',
      'GSC Impressions', 'GSC Clicks', 'GA4 Views', 'GA4 Engaged', 'GA4 Sessions',
      'Engagement Rate %', 'Prev Score'
    ];
    if (cfg.key === 'sub') headers.unshift('Parent (Root)');
    if (cfg.key === 'sub_sub') { headers.unshift('Parent (Sub)'); headers.unshift('Parent (Root)'); }

    ws.addRow(headers);
    ws.getRow(1).eachCell(c => Object.assign(c, headerStyle));

    for (const item of items) {
      const name = item.level === 'product' ? (item.slug || item.productId) : (item.hierarchy || '');
      const row = [
        name, item.interest_score, item.trend, item.score_change,
        item.gsc_impressions, item.gsc_clicks, item.ga4_views, item.ga4_engaged, item.ga4_sessions,
        item.engaged_ratio, item.prev_score
      ];
      if (cfg.key === 'sub') row.unshift(item.root || '');
      if (cfg.key === 'sub_sub') { row.unshift(item.sub || ''); row.unshift(item.root || ''); }
      ws.addRow(row);
    }

    ws.columns.forEach(col => { col.width = Math.max(col.width || 10, 14); });

    // Color score column
    const scoreColIdx = cfg.key === 'sub_sub' ? 4 : cfg.key === 'sub' ? 3 : 2;
    for (let r = 2; r <= items.length + 1; r++) {
      const cell = ws.getRow(r).getCell(scoreColIdx);
      const score = cell.value || 0;
      if (score >= 70) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF27ae60' } };
        cell.font = { color: { argb: 'FFFFFFFF' }, bold: true };
      } else if (score >= 40) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFf39c12' } };
        cell.font = { bold: true };
      } else {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFe74c3c' } };
        cell.font = { color: { argb: 'FFFFFFFF' } };
      }
    }
  }

  const outputPath = path.join('/tmp', `kapruka-interest-${Date.now()}.xlsx`);
  await wb.xlsx.writeFile(outputPath);
  return outputPath;
}

// ─── Main endpoint ─────────────────────────────────────────────────────────

app.get('/analyze', async (req, res) => {
  try {
    console.log('Starting analysis...');
    const token = await getAccessToken();
    const dateRanges = getDateRanges();
    console.log(`Current: ${dateRanges.current.start} to ${dateRanges.current.end}`);
    console.log(`Previous: ${dateRanges.previous.start} to ${dateRanges.previous.end}`);

    // Current period
    console.log('Fetching current period...');
    let currentBuckets = {};
    await fetchGSCIntoBuckets(token, dateRanges.current.start, dateRanges.current.end, currentBuckets);
    await fetchGA4IntoBuckets(token, dateRanges.current.start, dateRanges.current.end, currentBuckets);
    const currentLevels = calculateScores(currentBuckets);
    currentBuckets = null;
    if (global.gc) global.gc();

    // Previous period
    console.log('Fetching previous period...');
    let previousBuckets = {};
    await fetchGSCIntoBuckets(token, dateRanges.previous.start, dateRanges.previous.end, previousBuckets);
    await fetchGA4IntoBuckets(token, dateRanges.previous.start, dateRanges.previous.end, previousBuckets);
    const previousLevels = calculateScores(previousBuckets);
    previousBuckets = null;
    if (global.gc) global.gc();

    const finalData = calculateTrends(currentLevels, previousLevels);
    const excelPath = await generateExcel(finalData, dateRanges);

    const flatten = (items) => items.map(i => ({
      name: i.level === 'product' ? (i.slug || i.productId) : (i.hierarchy || ''),
      level: i.level,
      interest_score: i.interest_score,
      trend: i.trend,
      score_change: i.score_change || 0,
      gsc_impressions: i.gsc_impressions,
      gsc_clicks: i.gsc_clicks,
      ga4_views: i.ga4_views,
      engaged_ratio: i.engaged_ratio,
      prev_score: i.prev_score || 0
    }));

    res.json({
      success: true,
      dateRanges,
      summary: {
        root_categories: finalData.root.length,
        sub_categories: finalData.sub.length,
        sub_sub_categories: finalData.sub_sub.length,
        products: finalData.product.length,
        total_items: Object.values(finalData).flat().length
      },
      all_root: flatten(finalData.root),
      all_sub: flatten(finalData.sub),
      all_sub_sub: flatten(finalData.sub_sub),
      all_product: flatten(finalData.product),
      download: `/download/${path.basename(excelPath)}`
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

app.get('/health', (req, res) => {
  res.json({ status: 'running' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Running on port ${PORT}`));
