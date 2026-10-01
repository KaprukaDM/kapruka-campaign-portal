// scripts/fake-sheet-server.mjs
// ---------------------------------------------------------------------------
// Runs the REAL /api/posting-calendar handler against an in-memory stand-in
// for the Google Sheet, and serves the static pages beside it, so the whole
// "pick a date + a slot → Save schedule → what lands in the sheet cell" path
// can be driven from a browser with no Google credentials.
//
//   node scripts/fake-sheet-server.mjs [port]      # default 8899
//
//   http://127.0.0.1:8899/posting-calendar.html    the real UI
//   http://127.0.0.1:8899/__sheet                  the fake sheet, rendered
//                                                  the way Sheets would show
//                                                  it (each cell through its
//                                                  own number format)
//   http://127.0.0.1:8899/__sheet.json             the raw cell values
//
// WHAT THIS DOES AND DOES NOT PROVE. Everything from the click to the exact
// value+format handed to the Sheets API is the real code path: the handler is
// imported from functions/api/posting-calendar.js and runs unmodified. What is
// faked is Google itself — OAuth, the Sheets REST API and Supabase are
// intercepted here. So this proves what the app WRITES; it does not prove the
// live sheet accepted it, because the spreadsheets-scoped refresh token is a
// Cloudflare Pages secret this machine does not have.
//
// The seed rows deliberately mirror the shapes really in "Content Approval
// List" today (checked against the live sheet): old hand-filled rows with a
// time in column G, and recent app-written rows that are date-only.
// ---------------------------------------------------------------------------
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const PORT = Number(process.argv[2] || 8899);
const SHEET_ID = 'FAKE_SHEET_ID';
const TAB = 'Content Approval List';
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);

// ── The fake spreadsheet ───────────────────────────────────────────────────
// rows[] are column A..Q arrays, exactly as the Sheets values API returns them
// with UNFORMATTED_VALUE (dates as serials). formats[] is the per-cell number
// format of column G, which is what decides how the cell DISPLAYS.
const serial = (y, m, d, hh = 0, mm = 0) =>
  (Date.UTC(y, m - 1, d) - EXCEL_EPOCH_MS) / 86400000 + (hh * 3600 + mm * 60) / 86400;

function blankRow(fields) {
  const r = new Array(17).fill('');
  Object.entries(fields).forEach(([i, v]) => { r[i] = v; });
  return r;
}

const sheet = {
  rows: [
    // A legacy hand-filled row: column G already carried a time in May.
    blankRow({ 0: '101', 2: 'Image', 5: 'Kapruka', 6: serial(2026, 5, 5, 18, 30), 7: 'Posted' }),
    // A row written by this app BEFORE the combined stamp — date only.
    blankRow({ 0: 'STU-2301', 2: 'Image', 5: 'Kapruka', 6: serial(2026, 10, 1), 7: 'Approved', 16: 'Slot 1 — 10:00 AM' }),
  ],
  // Column-G number format per row, mirroring what those rows carry today.
  formats: ['d/m/yyyy hh:mm:ss', 'yyyy-mm-dd'],
};

const studio = [
  { id: 2307, studio_status: 'Good to Go', page_name: 'Kapruka', date: '2026-07-02',
    content_details: 'Mid-season sale — image post. Free delivery island-wide.',
    content_link: '', reference_links: '', product_code: 'KAP-1234' },
  { id: 2311, studio_status: 'Good to Go', page_name: 'Global Shop', date: '2026-07-03',
    content_details: 'New arrivals carousel', content_link: '', reference_links: '', product_code: '' },
];

// ── Fake Google / Supabase ─────────────────────────────────────────────────
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const colLetter = n => String.fromCharCode(65 + n);
// "Content Approval List!A2:Q" → { startRow, startCol }  (1-based row)
function parseRange(range) {
  const m = String(range).match(/!([A-Z]+)(\d+)?/);
  return { col: m ? m[1].charCodeAt(0) - 65 : 0, row: m && m[2] ? Number(m[2]) : null };
}

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  const method = (init.method || 'GET').toUpperCase();
  // The OAuth call posts form-encoded, everything else posts JSON.
  let body = null;
  if (init.body) { try { body = JSON.parse(init.body); } catch { body = null; } }

  if (url.startsWith('https://oauth2.googleapis.com/token')) {
    return json({ access_token: 'fake-token', expires_in: 3599 });
  }

  if (url.includes('/rest/v1/studio_calendar')) {
    if (method === 'PATCH') {
      const id = Number(decodeURIComponent(url).match(/id=eq\.(\d+)/)?.[1]);
      const item = studio.find(s => s.id === id);
      if (item && body) Object.assign(item, body);
      return json(item ? [item] : []);
    }
    const idMatch = decodeURIComponent(url).match(/id=eq\.(\d+)/);
    if (idMatch) return json(studio.filter(s => s.id === Number(idMatch[1])));
    return json(studio.filter(s => s.studio_status === 'Good to Go'));
  }

  if (url.includes('sheets.googleapis.com')) {
    // Tab metadata (gid lookup, used before the number-format write).
    if (url.includes('fields=sheets.properties')) {
      return json({ sheets: [{ properties: { title: TAB, sheetId: 0 } }] });
    }
    // Number-format write.
    if (url.endsWith(':batchUpdate')) {
      (body.requests || []).forEach(req => {
        const r = req.repeatCell;
        if (!r) return;
        const pattern = r.cell?.userEnteredFormat?.numberFormat?.pattern;
        for (let i = r.range.startRowIndex; i < r.range.endRowIndex; i++) {
          // grid row index → data row index (row 0 of the grid is the header)
          if (r.range.startColumnIndex === 6 && pattern) sheet.formats[i - 1] = pattern;
        }
      });
      return json({ replies: [{}] });
    }
    // Append.
    if (url.includes(':append')) {
      const values = body.values[0];
      sheet.rows.push(values.concat(new Array(Math.max(0, 17 - values.length)).fill('')));
      sheet.formats.push('yyyy-mm-dd'); // a fresh row inherits the row above's format
      const n = sheet.rows.length + 1; // +1 for the header row
      return json({ updates: { updatedRange: `'${TAB}'!A${n}:Q${n}`, updatedRows: 1 } });
    }
    // Single-cell update (reschedule / headline write).
    if (method === 'PUT') {
      const range = decodeURIComponent(url.split('/values/')[1].split('?')[0]);
      const { col, row } = parseRange(range);
      if (row) sheet.rows[row - 2][col] = body.values[0][0];
      return json({ updatedCells: 1 });
    }
    // Read.
    return json({ values: sheet.rows.map(r => r.slice()) });
  }

  if (url.includes('graph.facebook.com')) return json({ data: [] });
  if (url.includes('api.short.io')) return json({ shortURL: 'https://kapruka.s.gy/fake' });

  return realFetch(input, init);
};

const api = await import('../functions/api/posting-calendar.js');
const env = {
  GOOGLE_CLIENT_ID: 'fake', GOOGLE_CLIENT_SECRET: 'fake', GOOGLE_REFRESH_TOKEN: 'fake',
  CONTENT_SHEET_ID: SHEET_ID,
};

// ── Rendering the fake sheet the way Sheets would show it ──────────────────
// Applies the cell's own number format to the stored serial, which is the
// point: the VALUE is a datetime, the FORMAT is what makes it read as
// "02/07/2026 21:00:00".
const pad2 = n => String(n).padStart(2, '0');
function displayCell(value, pattern) {
  if (typeof value !== 'number') return String(value ?? '');
  const d = new Date(EXCEL_EPOCH_MS + Math.round(value * 86400) * 1000);
  const Y = d.getUTCFullYear(), M = d.getUTCMonth() + 1, D = d.getUTCDate();
  const h = d.getUTCHours(), m = d.getUTCMinutes(), s = d.getUTCSeconds();
  if (pattern === 'dd/MM/yyyy HH:mm:ss') return `${pad2(D)}/${pad2(M)}/${Y} ${pad2(h)}:${pad2(m)}:${pad2(s)}`;
  if (pattern === 'd/m/yyyy hh:mm:ss') return `${D}/${M}/${Y} ${pad2(h)}:${pad2(m)}:${pad2(s)}`;
  return `${Y}-${pad2(M)}-${pad2(D)}`; // the date-only format recent rows carry
}

function sheetHtml() {
  const head = ['A Content ID', 'C Media', 'F Page', 'G Schedule Date', 'H Status', 'Q Slot'];
  const body = sheet.rows.map((r, i) => {
    const fresh = i >= 2;
    return `<tr class="${fresh ? 'fresh' : ''}">
      <td>${r[0] || ''}</td><td>${r[2] || ''}</td><td>${r[5] || ''}</td>
      <td class="g">${displayCell(r[6], sheet.formats[i])}
        <div class="raw">value ${typeof r[6] === 'number' ? r[6] : JSON.stringify(r[6])} · format ${sheet.formats[i]}</div></td>
      <td>${r[7] || ''}</td><td>${r[16] || ''}</td></tr>`;
  }).join('');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Fake sheet — Content Approval List</title>
  <style>
    body { font-family: -apple-system, Segoe UI, sans-serif; background:#f6f7f9; margin:0; padding:24px; color:#202124; }
    h1 { font-size:17px; margin:0 0 4px; } p.sub { font-size:12px; color:#5f6368; margin:0 0 16px; }
    table { border-collapse:collapse; background:#fff; box-shadow:0 1px 3px rgba(0,0,0,.15); font-size:13px; }
    th, td { border:1px solid #dadce0; padding:7px 11px; text-align:left; vertical-align:top; }
    th { background:#f1f3f4; font-size:11px; text-transform:uppercase; letter-spacing:.06em; color:#5f6368; }
    td.g { font-family:'DM Mono', Consolas, monospace; white-space:nowrap; }
    tr.fresh td { background:#e6f4ea; } tr.fresh td.g { font-weight:700; }
    .raw { font-size:10px; color:#5f6368; font-weight:400; margin-top:3px; }
  </style></head><body>
  <h1>Fake "Content Approval List" — local stand-in, not the live Google Sheet</h1>
  <p class="sub">Written by the real /api/posting-calendar handler. Column G shows the stored value through that cell's own number format. Green = rows this run created.</p>
  <table><thead><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table>
  </body></html>`;
}

// ── HTTP ───────────────────────────────────────────────────────────────────
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/__sheet') {
    res.writeHead(200, { 'Content-Type': 'text/html' }).end(sheetHtml());
    return;
  }
  if (url.pathname === '/__sheet.json') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ rows: sheet.rows, formats: sheet.formats,
        displayed: sheet.rows.map((r, i) => displayCell(r[6], sheet.formats[i])) }, null, 2));
    return;
  }

  if (url.pathname === '/api/posting-calendar') {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const request = new Request(url.href, {
      method: req.method,
      headers: { 'Content-Type': 'application/json' },
      body: chunks.length ? Buffer.concat(chunks) : undefined,
    });
    const handler = { GET: api.onRequestGet, POST: api.onRequestPost,
      PATCH: api.onRequestPatch, DELETE: api.onRequestDelete }[req.method];
    if (!handler) { res.writeHead(405).end(); return; }
    try {
      const out = await handler({ env, request });
      res.writeHead(out.status, { 'Content-Type': 'application/json' }).end(await out.text());
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Static files from the repo root.
  const rel = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = normalize(join(root, decodeURIComponent(rel)));
  if (!file.startsWith(normalize(root)) || !existsSync(file)) { res.writeHead(404).end('Not found'); return; }
  const ext = file.slice(file.lastIndexOf('.'));
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  res.end(await readFile(file));
}).listen(PORT, '127.0.0.1', () => {
  console.log(`fake-sheet server on http://127.0.0.1:${PORT}`);
  console.log(`  UI    http://127.0.0.1:${PORT}/posting-calendar.html`);
  console.log(`  sheet http://127.0.0.1:${PORT}/__sheet`);
});
