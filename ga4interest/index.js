require('dotenv').config();
const express = require('express');
const { google } = require('googleapis');
const ExcelJS = require('exceljs');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Auth helpers ───────────────────────────────────────────────────────────

function getOAuth2Client() {
  const client = new google.auth.OAuth2(
    process.env.GA4_CLIENT_ID || process.env.GOOGLE_CLIENT_ID,
    process.env.GA4_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET
  );
  client.setCredentials({
    refresh_token: process.env.GA4_REFRESH_TOKEN || process.env.GSC_REFRESH_TOKEN
  });
  return client;
}

// ─── Date helpers ───────────────────────────────────────────────────────────

function getDateRanges() {
  const now = new Date();
  const currentEnd = new Date(now);
  currentEnd.setDate(currentEnd.getDate() - 1); // yesterday
  const currentStart = new Date(currentEnd);
  currentStart.setDate(currentStart.getDate() - 29); // 30 days

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
  // Product pages: /buyonline/{slug}/kid/{id}
  const productMatch = pagePath.match(/^\/buyonline\/(.+?)\/kid\/(.+?)$/);
  if (productMatch) {
    return {
      level: 'product',
      slug: productMatch[1],
      productId: productMatch[2],
      hierarchy: null // products don't have category hierarchy in URL
    };
  }

  // Category pages: /online/{root}/price/{sub}/lanka/{subsub}...
  const catMatch = pagePath.match(/^\/online\/(.+?)$/);
  if (catMatch) {
    const parts = catMatch[1].split('/');
    const root = parts[0] || null;
    let sub = null;
    let subsub = null;

    // /online/root/price/sub
    if (parts[1] === 'price' && parts[2]) {
      sub = parts[2];
    }
    // /online/root/price/sub/lanka/subsub
    if (parts[3] === 'lanka' && parts[4]) {
      subsub = parts[4];
    }

    let level = 'root';
    if (subsub) level = 'sub_sub';
    else if (sub) level = 'sub';

    return { level, root, sub, subsub, hierarchy: [root, sub, subsub].filter(Boolean).join(' > ') };
  }

  return null; // not a category or product page
}

// ─── GSC data fetch — aggregate on the fly ─────────────────────────────────

async function fetchGSCIntoBuckets(auth, startDate, endDate, buckets) {
  const webmasters = google.searchconsole({ version: 'v1', auth });
  let startRow = 0;
  const rowLimit = 5000; // smaller batches = less peak memory
  let totalRows = 0;

  while (true) {
    try {
      const res = await webmasters.searchanalytics.query({
        siteUrl: process.env.GSC_SITE_URL,
        requestBody: { startDate, endDate, dimensions: ['page'], rowLimit, startRow, dataState: 'final' }
      });

      const rows = res.data.rows || [];
      if (rows.length === 0) break;
      totalRows += rows.length;

      // Aggregate immediately, don't store raw rows
      for (const row of rows) {
        let pathname;
        try { pathname = new URL(row.keys[0]).pathname; } catch { continue; }
        const classified = classifyUrl(pathname);
        if (!classified) continue;

        const key = classified.level === 'product'
          ? `product::${classified.productId}`
          : `${classified.level}::${classified.hierarchy}`;

        if (!buckets[key]) {
          buckets[key] = { ...classified, key, gsc_impressions: 0, gsc_clicks: 0, ga4_views: 0, ga4_engaged: 0, ga4_sessions: 0 };
        }
        buckets[key].gsc_impressions += row.impressions || 0;
        buckets[key].gsc_clicks += row.clicks || 0;
      }

      if (rows.length < rowLimit) break;
      startRow += rowLimit;
    } catch (err) {
      console.error('GSC fetch error:', err.message);
      break;
    }
  }

  console.log(`GSC: ${totalRows} rows aggregated`);
  return buckets;
}

// ─── GA4 data fetch — aggregate on the fly ─────────────────────────────────

async function fetchGA4IntoBuckets(auth, startDate, endDate, buckets) {
  const analyticsData = google.analyticsdata({ version: 'v1beta', auth });
  let offset = 0;
  const limit = 10000;
  let totalRows = 0;

  while (true) {
    try {
      const res = await analyticsData.properties.runReport({
        property: `properties/${process.env.GA4_PROPERTY_ID}`,
        requestBody: {
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
        }
      });

      const rows = res.data.rows || [];
      if (rows.length === 0) break;
      totalRows += rows.length;

      // Aggregate immediately
      for (const row of rows) {
        const pagePath = row.dimensionValues[0].value;
        const classified = classifyUrl(pagePath);
        if (!classified) continue;

        const key = classified.level === 'product'
          ? `product::${classified.productId}`
          : `${classified.level}::${classified.hierarchy}`;

        if (!buckets[key]) {
          buckets[key] = { ...classified, key, gsc_impressions: 0, gsc_clicks: 0, ga4_views: 0, ga4_engaged: 0, ga4_sessions: 0 };
        }
        buckets[key].ga4_views += parseInt(row.metricValues[0].value) || 0;
        buckets[key].ga4_engaged += parseInt(row.metricValues[1].value) || 0;
        buckets[key].ga4_sessions += parseInt(row.metricValues[2].value) || 0;
      }

      if (rows.length < limit) break;
      offset += limit;
    } catch (err) {
      console.error('GA4 fetch error:', err.message);
      break;
    }
  }

  console.log(`GA4: ${totalRows} rows aggregated`);
  return buckets;
}

// aggregateData removed — aggregation now happens during fetch

// ─── Score calculation ─────────────────────────────────────────────────────

function calculateScores(buckets) {
  const levels = { root: [], sub: [], sub_sub: [], product: [] };

  for (const item of Object.values(buckets)) {
    if (levels[item.level]) {
      levels[item.level].push(item);
    }
  }

  // Normalize and score within each level
  for (const [level, items] of Object.entries(levels)) {
    if (items.length === 0) continue;

    const maxImpressions = Math.max(...items.map(i => i.gsc_impressions), 1);
    const maxClicks = Math.max(...items.map(i => i.gsc_clicks), 1);
    const maxViews = Math.max(...items.map(i => i.ga4_views), 1);

    for (const item of items) {
      const normImpressions = (item.gsc_impressions / maxImpressions) * 100;
      const normClicks = (item.gsc_clicks / maxClicks) * 100;
      const normViews = (item.ga4_views / maxViews) * 100;
      const engagedRatio = item.ga4_sessions > 0
        ? (item.ga4_engaged / item.ga4_sessions) * 100
        : 0;

      item.interest_score = Math.round(
        normImpressions * 0.30 +
        normClicks * 0.30 +
        normViews * 0.25 +
        engagedRatio * 0.15
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
  wb.creator = 'Kapruka Category Interest Tool';

  const headerStyle = {
    font: { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 },
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1a1a2e' } },
    alignment: { horizontal: 'center', vertical: 'middle' },
    border: {
      top: { style: 'thin' }, bottom: { style: 'thin' },
      left: { style: 'thin' }, right: { style: 'thin' }
    }
  };

  const levelConfigs = [
    { key: 'root', title: 'Root Categories', nameCol: 'Category' },
    { key: 'sub', title: 'Sub Categories', nameCol: 'Sub Category' },
    { key: 'sub_sub', title: 'Sub-Sub Categories', nameCol: 'Sub-Sub Category' },
    { key: 'product', title: 'Products', nameCol: 'Product' }
  ];

  // Summary sheet first
  const summarySheet = wb.addWorksheet('Summary');
  summarySheet.columns = [
    { header: 'Metric', key: 'metric', width: 30 },
    { header: 'Value', key: 'value', width: 20 }
  ];
  summarySheet.addRow({ metric: 'Current Period', value: `${dateRanges.current.start} to ${dateRanges.current.end}` });
  summarySheet.addRow({ metric: 'Previous Period', value: `${dateRanges.previous.start} to ${dateRanges.previous.end}` });
  summarySheet.addRow({ metric: '', value: '' });
  summarySheet.addRow({ metric: 'Root Categories', value: data.root.length });
  summarySheet.addRow({ metric: 'Sub Categories', value: data.sub.length });
  summarySheet.addRow({ metric: 'Sub-Sub Categories', value: data.sub_sub.length });
  summarySheet.addRow({ metric: 'Products Tracked', value: data.product.length });
  summarySheet.addRow({ metric: '', value: '' });
  summarySheet.addRow({ metric: 'Scoring Weights', value: '' });
  summarySheet.addRow({ metric: 'GSC Impressions', value: '30%' });
  summarySheet.addRow({ metric: 'GSC Clicks', value: '30%' });
  summarySheet.addRow({ metric: 'GA4 Page Views', value: '25%' });
  summarySheet.addRow({ metric: 'GA4 Engagement Rate', value: '15%' });

  // Top Movers sheet
  const moversSheet = wb.addWorksheet('Top Movers');
  const allItems = [...data.root, ...data.sub, ...data.sub_sub, ...data.product];
  const risers = allItems.filter(i => i.score_change > 0).sort((a, b) => b.score_change - a.score_change).slice(0, 20);
  const fallers = allItems.filter(i => i.score_change < 0).sort((a, b) => a.score_change - b.score_change).slice(0, 20);

  moversSheet.addRow(['TOP RISERS']);
  moversSheet.addRow(['Name', 'Level', 'Score', 'Change', 'Trend']);
  const riserHeaderRow = moversSheet.getRow(2);
  riserHeaderRow.eachCell(c => Object.assign(c, headerStyle));

  for (const item of risers) {
    const name = item.level === 'product' ? (item.slug || item.productId) : item.hierarchy;
    moversSheet.addRow([name, item.level, item.interest_score, `+${item.score_change}`, item.trend]);
  }

  moversSheet.addRow([]);
  moversSheet.addRow(['TOP FALLERS']);
  const fallerHeaderRowNum = moversSheet.lastRow.number + 1;
  moversSheet.addRow(['Name', 'Level', 'Score', 'Change', 'Trend']);
  const fallerHeaderRow = moversSheet.getRow(fallerHeaderRowNum + 1);
  fallerHeaderRow.eachCell(c => Object.assign(c, headerStyle));

  for (const item of fallers) {
    const name = item.level === 'product' ? (item.slug || item.productId) : item.hierarchy;
    moversSheet.addRow([name, item.level, item.interest_score, `${item.score_change}`, item.trend]);
  }

  moversSheet.columns = [
    { width: 40 }, { width: 12 }, { width: 10 }, { width: 10 }, { width: 12 }
  ];

  // Per-level sheets
  for (const config of levelConfigs) {
    const items = data[config.key];
    if (items.length === 0) continue;

    const ws = wb.addWorksheet(config.title);
    const headers = [
      config.nameCol,
      'Interest Score', 'Trend', 'Score Change',
      'GSC Impressions', 'GSC Clicks',
      'GA4 Views', 'GA4 Engaged Sessions', 'GA4 Sessions',
      'Engagement Rate %',
      'Norm Impressions', 'Norm Clicks', 'Norm Views',
      'Prev Score'
    ];

    if (config.key === 'sub') headers.unshift('Parent (Root)');
    if (config.key === 'sub_sub') { headers.unshift('Parent (Sub)'); headers.unshift('Parent (Root)'); }

    ws.addRow(headers);
    const hRow = ws.getRow(1);
    hRow.eachCell(c => Object.assign(c, headerStyle));

    for (const item of items) {
      const name = item.level === 'product' ? (item.slug || item.productId) : (item.hierarchy || '');
      const row = [
        name,
        item.interest_score, item.trend, item.score_change,
        item.gsc_impressions, item.gsc_clicks,
        item.ga4_views, item.ga4_engaged, item.ga4_sessions,
        item.engaged_ratio,
        item.norm_impressions, item.norm_clicks, item.norm_views,
        item.prev_score
      ];

      if (config.key === 'sub') row.unshift(item.root || '');
      if (config.key === 'sub_sub') { row.unshift(item.sub || ''); row.unshift(item.root || ''); }

      ws.addRow(row);
    }

    // Auto-width
    ws.columns.forEach(col => { col.width = Math.max(col.width || 10, 14); });

    // Conditional formatting hint: color the interest score column
    const scoreColIdx = config.key === 'sub_sub' ? 4 : config.key === 'sub' ? 3 : 2;
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

  const outputPath = path.join('/tmp', `kapruka-category-interest-${Date.now()}.xlsx`);
  await wb.xlsx.writeFile(outputPath);
  return outputPath;
}

// ─── Main analysis endpoint ────────────────────────────────────────────────

app.get('/analyze', async (req, res) => {
  try {
    console.log('Starting category interest analysis...');
    const auth = getOAuth2Client();
    const dateRanges = getDateRanges();

    console.log(`Current: ${dateRanges.current.start} to ${dateRanges.current.end}`);
    console.log(`Previous: ${dateRanges.previous.start} to ${dateRanges.previous.end}`);

    // Current period — aggregate directly into buckets
    console.log('Fetching current period...');
    let currentBuckets = {};
    await fetchGSCIntoBuckets(auth, dateRanges.current.start, dateRanges.current.end, currentBuckets);
    await fetchGA4IntoBuckets(auth, dateRanges.current.start, dateRanges.current.end, currentBuckets);
    const currentLevels = calculateScores(currentBuckets);
    currentBuckets = null; // free memory

    // Previous period
    console.log('Fetching previous period...');
    let previousBuckets = {};
    await fetchGSCIntoBuckets(auth, dateRanges.previous.start, dateRanges.previous.end, previousBuckets);
    await fetchGA4IntoBuckets(auth, dateRanges.previous.start, dateRanges.previous.end, previousBuckets);
    const previousLevels = calculateScores(previousBuckets);
    previousBuckets = null; // free memory

    // Trends
    const finalData = calculateTrends(currentLevels, previousLevels);

    // Generate Excel
    const excelPath = await generateExcel(finalData, dateRanges);

    // Flatten for frontend
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
  } catch (err) {
    console.error('Analysis error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Excel download endpoint
app.get('/download/:filename', (req, res) => {
  const filePath = path.join('/tmp', req.params.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  res.download(filePath);
});

// Health check (API)
app.get('/health', (req, res) => {
  res.json({ status: 'running', service: 'Kapruka Category Interest Analyzer' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Category Interest Analyzer running on port ${PORT}`));
