// functions/api/posting-calendar.js
// ============================================================================
//  POSTING CALENDAR API
//
//  SOURCE  → Supabase `studio_calendar` table, rows where studio_status =
//            "Good to Go" (the Studio Calendar tab is where production marks
//            content ready). Uses the same public anon key already shipped
//            client-side in js/supabase-api.js — not a new secret.
//
//  DEST    → Google Sheet "Content Approval List" (the sheet Content.gs's
//            processContent() bot actually posts from). Scheduling a post
//            APPENDS a new row there with STATUS="Approved", it does NOT
//            touch the Studio Calendar item's status — "already scheduled"
//            items are recognized by looking for a "STU-<id>" Content ID
//            already present in the sheet, so nothing in the existing
//            Studio/DM-approval sync logic gets touched.
//
//  Env vars required (Cloudflare Pages secrets):
//    GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN
//    CONTENT_SHEET_ID   1CNSZqL5MCbTaj5fF4L_e95oJECVMpOZMUAz-b9r9Bpk
//
//  GOOGLE_REFRESH_TOKEN must be scoped to BOTH:
//    https://www.googleapis.com/auth/spreadsheets
//    https://www.googleapis.com/auth/drive.readonly   (for the rare
//      Drive-folder-of-images case — expandDriveFolder() below)
//  If it's only scoped to spreadsheets, folder items fail with a 401/403
//  from the Drive API at save time — everything else still works fine.
//
//  Sheet columns (1-based, "Content Approval List" tab — must match Content.gs COL):
//    A ContentID  B Platform  C MediaType  D MediaURL  E PrimaryText
//    F Page  G ScheduleDate  H Status  I..O Links  P TT_RESULT
//    Q Slot  — see "TIME SLOTS" below
//    Optional "Product Name" field in the scheduling form builds a wa.me
//      customer-inquiry link, wraps it in a branded short.io link
//      (kapruka.s.gy — see buildWhatsAppLink() below), and appends it as a
//      second line under the caption text in column E itself — so it goes
//      out as part of the actual published post (Content.gs posts column E
//      verbatim), not a sheet-only reference column. Left untouched when no
//      product name is given.
//
//  TIME SLOTS  → column Q ("Slot N — H:MM AM/PM").
//  A day has five posting slots (10am / 12pm / 3pm / 6pm / 9pm). Originally
//  the sheet stored no time at all and a post's slot was inferred purely
//  from row order within its date — the Nth occupying row for a date got the
//  Nth slot. That made the slot un-chooseable: whatever the user picked, the
//  append order decided where it landed.
//  Column Q now records the chosen slot explicitly. It is additive: columns
//  A-P are untouched and Content.gs only ever writes I-P via single-cell
//  getRange() calls, so nothing downstream is clobbered. Rows written before
//  this column existed (and any row where Q is blank) still fall back to the
//  old row-order inference — see assignSlots() — so historical rows keep
//  exactly the slot the calendar showed for them before.
//  NOTE: whether the posting bot itself publishes at that wall-clock time is
//  Content.gs's business (that script lives outside this repo); this column
//  is the portal's record of the intended slot and what the calendar renders.
//
//  SHORT LINKS  → short.io (https://short.io), domain kapruka.s.gy. Chosen
//      because this app's own Cloudflare account doesn't control the
//      www.kapruka.com DNS zone (that's owned by IT), so a real kapruka.com
//      subdomain wasn't set-uppable here — short.io's own branded domain
//      sidesteps that entirely. One API call per scheduled post with a
//      Product Name (POST https://api.short.io/links); short.io hosts the
//      redirect and click tracking itself (visible in the short.io
//      dashboard) — no database of our own needed.
//      Env var required (Cloudflare Pages secret): SHORTIO_API_KEY
//
//  META-SCHEDULED POSTS (optional, month view only):
//  Posts scheduled directly in Meta Business Suite (not through this app)
//  never touch the sheet, so they're otherwise invisible here and can
//  silently double-book a day. Facebook exposes its own unpublished/
//  scheduled Page posts via the Graph API, so those are fetched and merged
//  into the month response as a separate `metaScheduled` list. Instagram has
//  NO equivalent public API for posts scheduled natively in Business Suite
//  (only for posts an app itself scheduled via the Content Publishing API,
//  which doesn't support scheduling at all) — so this is Facebook-only by
//  necessity, not by choice.
//  Optional env vars (Cloudflare Pages secrets — same values already used
//  for functions/api/push-organic-winner-ad.js, if that's set up):
//    META_PAGE_ACCESS_TOKEN or META_ADS_ACCESS_TOKEN  — needs read access to
//      the Page's own unpublished feed (pages_manage_posts scope)
//    META_PAGE_ID
//  If unset, this section is silently skipped — the rest of the calendar
//  still works, `metaScheduled` just comes back empty.
// ============================================================================

const SHEET_NAME = 'Content Approval List';
const GRAPH_VERSION = 'v21.0';
const COL = {
  CONTENT_ID: 0, PLATFORM: 1, MEDIA_TYPE: 2, MEDIA_URL: 3, PRIMARY_TEXT: 4,
  PAGE: 5, SCHEDULE_DATE: 6, STATUS: 7,
  // Column Q — new, additive. Columns I-P are already spoken for (see the
  // header comment above) and Content.gs only ever writes those via
  // single-cell getRange() calls, never a wide range, so a new column here is
  // safe and won't be touched or clobbered by the posting bot.
  SLOT: 16
};
// Every sheet read needs column Q now, not just A:H.
const READ_RANGE = 'A2:Q';
const WHATSAPP_NUMBER = '94711222002';

// Builds the raw wa.me customer-inquiry link for a product (the actual
// destination), or '' if no product name was given.
function buildRawWhatsAppLink(productName) {
  const trimmed = String(productName || '').trim();
  if (!trimmed) return '';
  const text = `Hi I am interested ${trimmed} `; // trailing space -> trailing "+"
  const encoded = encodeURIComponent(text).replace(/%20/g, '+');
  return `https://wa.me/${WHATSAPP_NUMBER}?text=${encoded}`;
}

// short.io domain the branded links live on (Settings > Domains in the
// short.io dashboard). Independent of both this Pages project's own domain
// and www.kapruka.com's DNS zone — short.io hosts the redirect itself.
const SHORTIO_DOMAIN = 'kapruka.s.gy';

// Creates a link on short.io mapping a fresh short path -> the real wa.me
// destination, and returns the public short URL (e.g. https://kapruka.s.gy/xxxxx)
// to hand out instead of the raw wa.me link. short.io itself hosts the
// redirect and click tracking — nothing to store on our side.
async function createShortLink(env, targetUrl, productName) {
  const res = await fetch('https://api.short.io/links', {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      Authorization: env.SHORTIO_API_KEY,
    },
    body: JSON.stringify({
      domain: SHORTIO_DOMAIN,
      originalURL: targetUrl,
      title: productName,
    }),
  });
  if (!res.ok) throw new Error(`short.io link creation failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  if (!data.shortURL) throw new Error('short.io response missing shortURL');
  return data.shortURL;
}

// Builds the clickable link to store in the sheet for a product: creates a
// kapruka.s.gy short link that redirects to the real wa.me customer-inquiry
// link, so what goes out in ads/posts reads as a clean branded-looking URL
// rather than a raw wa.me address. Returns '' if no product name was given —
// caller writes '' straight into the sheet cell (no link), leaving Primary
// Text completely untouched either way.
async function buildWhatsAppLink(env, productName) {
  const rawLink = buildRawWhatsAppLink(productName);
  if (!rawLink) return '';
  try {
    return await createShortLink(env, rawLink, String(productName).trim());
  } catch (e) {
    // Short-link creation is a nice-to-have, not the critical path — if
    // short.io is unreachable or misconfigured, fall back to the raw wa.me
    // link rather than losing the WhatsApp link entirely.
    return rawLink;
  }
}
const POSTING_SLOTS = [
  { hour: 10, minute: 0 }, { hour: 12, minute: 0 }, { hour: 15, minute: 0 },
  { hour: 18, minute: 0 }, { hour: 21, minute: 0 }
];
const SLOT_LABELS = ['10:00 AM', '12:00 PM', '3:00 PM', '6:00 PM', '9:00 PM'];
const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);

// Same public anon key already embedded in js/supabase-api.js — read-only
// on studio_calendar for this app's usage pattern, not a secret we're adding.
const SUPABASE_URL = 'https://ivllhheqqiseagmctfyp.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml2bGxoaGVxcWlzZWFnbWN0ZnlwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg1NzQzMzksImV4cCI6MjA4NDE1MDMzOX0.OnkYNACtdknKDY2KqLfiGN0ORXpKaW906fD0TtSJlIk';

// Studio page_name values ("Kapruka FB", "Global Shop", ...) don't match the
// posting bot's PAGES keys — normalize known ones, default everything else
// to "Kapruka" per the agreed content default.
const PAGE_MAP = {
  'kapruka': 'Kapruka', 'kapruka fb': 'Kapruka', 'global shop': 'Kapruka',
  'electronic factory': 'Electronic Factory', 'fashion factory': 'Fashion Factory',
  'handbag factory': 'Handbag Factory', 'toys factory': 'Toys Factory',
  'social mart': 'Social Mart'
};
function normalizePage(pageName) {
  const key = String(pageName || '').trim().toLowerCase();
  return PAGE_MAP[key] || 'Kapruka';
}

// ── Drive folder expansion (rare case: media link is a whole folder) ───────
// Requires the https://www.googleapis.com/auth/drive.readonly scope on the
// refresh token — same client_id/secret, just re-consent with the wider scope.
const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const IG_CAROUSEL_MAX = 10;

function driveFolderId(url) {
  const m = String(url || '').match(/drive\.google\.com\/drive\/folders\/([^\/\?&]+)/);
  return m ? m[1] : null;
}

// Returns [{id, name}] for a folder's images, alphabetical — the natural/default order.
async function listDriveFolderImages(token, folderId) {
  const q = encodeURIComponent(`'${folderId}' in parents and trashed = false and mimeType contains 'image/'`);
  const url = `${DRIVE_API}/files?q=${q}&fields=files(id,name)&orderBy=name&pageSize=${IG_CAROUSEL_MAX}`;
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  const body = await res.json();
  if (!res.ok) throw new Error('Drive folder read failed: ' + JSON.stringify(body));
  return body.files || [];
}
function driveIdsToUrls(ids) {
  return ids.map(id => `https://drive.google.com/uc?export=download&id=${id}`);
}

// ── Supabase ─────────────────────────────────────────────────────────────
async function supabaseQuery(endpoint, method = 'GET', body = null) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${endpoint}`, {
    method,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: 'Bearer ' + SUPABASE_KEY,
      'Content-Type': 'application/json',
      Prefer: 'return=representation'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  if (!res.ok) throw new Error('Supabase error: ' + text);
  return text ? JSON.parse(text) : [];
}

// ── Google OAuth refresh-token → access-token exchange ──────────────────────
async function getAccessToken(env) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: env.GOOGLE_REFRESH_TOKEN,
      grant_type: 'refresh_token'
    })
  });
  const body = await res.json();
  if (!res.ok) throw new Error('Google auth failed: ' + JSON.stringify(body));
  return body.access_token;
}

// ── Sheets helpers ───────────────────────────────────────────────────────
async function sheetsGet(env, token, range) {
  const url = `${SHEETS_API}/${env.CONTENT_SHEET_ID}/values/${encodeURIComponent(range)}?valueRenderOption=UNFORMATTED_VALUE`;
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  const body = await res.json();
  if (!res.ok) throw new Error('Sheets read failed: ' + JSON.stringify(body));
  return body.values || [];
}

async function sheetsAppend(env, token, range, values) {
  const url = `${SHEETS_API}/${env.CONTENT_SHEET_ID}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ range, values: [values] })
  });
  const body = await res.json();
  if (!res.ok) throw new Error('Sheets append failed: ' + JSON.stringify(body));
  return body;
}

// Single-cell/row write (e.g. rescheduling — writes the new date the same
// way sheetsAppend originally wrote it, so USER_ENTERED lets Sheets parse a
// plain "YYYY-MM-DD" string into a real date serial itself).
async function sheetsUpdate(env, token, range, values) {
  const url = `${SHEETS_API}/${env.CONTENT_SHEET_ID}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ range, values: [values] })
  });
  const body = await res.json();
  if (!res.ok) throw new Error('Sheets update failed: ' + JSON.stringify(body));
  return body;
}

// Numeric internal sheetId (gid) for a tab, needed by batchUpdate's
// deleteDimension — the values API takes a title, but row deletion needs
// the grid ID.
async function getSheetGid(env, token, title) {
  const url = `${SHEETS_API}/${env.CONTENT_SHEET_ID}?fields=sheets.properties`;
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  const body = await res.json();
  if (!res.ok) throw new Error('Sheets metadata read failed: ' + JSON.stringify(body));
  const sheet = (body.sheets || []).find(s => s.properties.title === title);
  if (!sheet) throw new Error(`Sheet tab "${title}" not found`);
  return sheet.properties.sheetId;
}

// rowIndexInGrid is 0-based INCLUDING the header row (header = 0, first
// data row = 1) — i.e. the sheetsGet(...!A2:H) array index + 1.
async function sheetsDeleteRow(env, token, sheetGid, rowIndexInGrid) {
  const url = `${SHEETS_API}/${env.CONTENT_SHEET_ID}:batchUpdate`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requests: [{
        deleteDimension: {
          range: { sheetId: sheetGid, dimension: 'ROWS', startIndex: rowIndexInGrid, endIndex: rowIndexInGrid + 1 }
        }
      }]
    })
  });
  const body = await res.json();
  if (!res.ok) throw new Error('Sheets delete row failed: ' + JSON.stringify(body));
  return body;
}

function serialToDate(serial) {
  if (typeof serial !== 'number') return null;
  return new Date(EXCEL_EPOCH_MS + serial * 86400000);
}
function dateKey(d) { return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate(); }

function isVideoUrl(url) {
  return ['.mp4', '.mov', '.avi', '.mkv', '.wmv', '.flv', '.webm', '.m4v', '.mpeg', '.3gp']
    .some(ext => String(url).toLowerCase().includes(ext));
}
// "the content details box will sometimes have whether its a post or video" —
// check the free-text production note first, fall back to the media URL extension.
function detectContentType(contentDetails, mediaUrl) {
  const t = String(contentDetails || '').toLowerCase();
  if (t.includes('video')) return 'Video';
  if (t.includes('image') || t.includes('photo') || t.includes('post')) return 'Image';
  return isVideoUrl(mediaUrl) ? 'Video' : 'Image';
}

// ── Slot bookkeeping ─────────────────────────────────────────────────────
// Column Q is written as "Slot 3 — 3:00 PM": human-readable in the sheet and,
// unlike a bare "3:00 PM", not something Sheets' USER_ENTERED parsing turns
// into a time serial behind our backs. Reading is deliberately forgiving so a
// value typed by hand in the sheet still counts.
export function slotCellValue(index) {
  return `Slot ${index + 1} — ${SLOT_LABELS[index]}`;
}
export function parseSlotIndex(value) {
  if (value === null || value === undefined || value === '') return null;
  // A hand-typed "3:00 PM" comes back from UNFORMATTED_VALUE as a day fraction.
  if (typeof value === 'number') {
    if (value > 0 && value < 1) {
      const hour = Math.round(value * 24 * 60) / 60;
      const i = POSTING_SLOTS.findIndex(s => Math.abs(s.hour + s.minute / 60 - hour) < 0.01);
      return i >= 0 ? i : null;
    }
    // A bare number is read as a 1-based slot number ("3" = the 3pm slot).
    const n = Math.round(value);
    return n >= 1 && n <= POSTING_SLOTS.length ? n - 1 : null;
  }
  const s = String(value).trim();
  if (!s) return null;
  const m = s.match(/slot\s*(\d+)/i);
  if (m) {
    const n = Number(m[1]);
    if (n >= 1 && n <= POSTING_SLOTS.length) return n - 1;
  }
  const byLabel = SLOT_LABELS.findIndex(l => l.toLowerCase() === s.toLowerCase());
  if (byLabel >= 0) return byLabel;
  const n = Number(s);
  if (Number.isInteger(n) && n >= 1 && n <= POSTING_SLOTS.length) return n - 1;
  return null;
}

function rowOccupies(row) {
  const st = String(row[COL.STATUS] || '').trim();
  return st === 'Approved' || st.indexOf('Posted') === 0;
}

function occupyingRowsForDate(rows, targetKey) {
  return rows.filter(row => {
    if (!rowOccupies(row)) return false;
    const d = serialToDate(row[COL.SCHEDULE_DATE]);
    return !!d && dateKey(d) === targetKey;
  });
}

// Resolves one date's occupying rows to concrete slot indexes.
//   1. Rows with an explicit column-Q slot claim it (first row wins a tie).
//   2. Rows without one — legacy rows, and any row whose claim collided —
//      fill the remaining slots in sheet order. With no explicit slots
//      anywhere this is byte-for-byte the old row-order inference, so
//      historical rows render exactly as they did before column Q existed.
//   3. Once all five are spoken for, extra rows stack on the last slot (9pm),
//      matching the pre-existing overflow behaviour.
export function assignSlots(rowsForDate) {
  const taken = new Set();
  const entries = rowsForDate.map(row => ({
    row,
    contentId: String(row[COL.CONTENT_ID] || '').trim(),
    slotIndex: parseSlotIndex(row[COL.SLOT])
  }));
  entries.forEach(e => {
    if (e.slotIndex === null) return;
    if (taken.has(e.slotIndex)) e.slotIndex = null; // double-claim → re-infer below
    else taken.add(e.slotIndex);
  });
  entries.forEach(e => {
    if (e.slotIndex !== null) return;
    let i = 0;
    while (i < POSTING_SLOTS.length && taken.has(i)) i++;
    if (i >= POSTING_SLOTS.length) i = POSTING_SLOTS.length - 1; // stack on 9pm
    else taken.add(i);
    e.slotIndex = i;
  });
  return entries;
}

// Per-day occupancy for a whole month, for the calendar grid view. Slots come
// from assignSlots() — explicit column-Q value where there is one, row-order
// inference where there isn't.
export function monthOccupancy(rows, year, month) {
  const rowsByDate = {};
  rows.forEach(row => {
    if (!rowOccupies(row)) return;
    const d = serialToDate(row[COL.SCHEDULE_DATE]);
    if (!d) return;
    if (d.getFullYear() !== year || d.getMonth() !== month - 1) return;
    const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    (rowsByDate[dateStr] || (rowsByDate[dateStr] = [])).push(row);
  });

  return Object.keys(rowsByDate).map(dateStr => {
    const rowsForDate = rowsByDate[dateStr];
    const items = assignSlots(rowsForDate).map(entry => {
      const row = entry.row;
      const st = String(row[COL.STATUS] || '').trim();
      return {
        contentId: entry.contentId,
        page: String(row[COL.PAGE] || '').trim(),
        posted: st.indexOf('Posted') === 0,
        slotIndex: entry.slotIndex,
        time: SLOT_LABELS[entry.slotIndex],
        primaryText: String(row[COL.PRIMARY_TEXT] || '').trim(),
        mediaUrl: String(row[COL.MEDIA_URL] || '').trim(),
        mediaType: String(row[COL.MEDIA_TYPE] || '').trim()
      };
    });
    return { date: dateStr, occupied: rowsForDate.length, items };
  });
}

// `excludeRowIndex` lets the reschedule path ignore the row being moved, so a
// post doesn't see its own current slot as "taken" when it stays on the day.
export function slotAvailability(rows, dateStr, excludeRowIndex) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const targetKey = y + '-' + (m - 1) + '-' + d;
  const candidates = typeof excludeRowIndex === 'number'
    ? rows.filter((_, i) => i !== excludeRowIndex)
    : rows;
  const assigned = assignSlots(occupyingRowsForDate(candidates, targetKey));

  const heldBy = {};
  assigned.forEach(e => { if (heldBy[e.slotIndex] === undefined) heldBy[e.slotIndex] = e.contentId || null; });
  const occupiedSet = new Set(assigned.map(e => e.slotIndex));
  const firstFree = SLOT_LABELS.findIndex((_, i) => !occupiedSet.has(i));
  const stacking = firstFree === -1;

  return {
    occupiedCount: assigned.length,
    freeCount: POSTING_SLOTS.length - occupiedSet.size,
    nextAvailableIndex: stacking ? POSTING_SLOTS.length - 1 : firstFree,
    slots: SLOT_LABELS.map((time, i) => ({
      index: i,
      time,
      available: !occupiedSet.has(i),
      takenBy: occupiedSet.has(i) ? (heldBy[i] || null) : null
    })),
    stacking
  };
}

// ── Meta Business Suite scheduled posts (Facebook only — see header note) ──
async function fetchMetaScheduledFbPosts(env, year, month) {
  const token = env.META_PAGE_ACCESS_TOKEN || env.META_ADS_ACCESS_TOKEN;
  const pageId = env.META_PAGE_ID;
  if (!token || !pageId) return { items: [], configured: false };

  // Meta's /feed?is_published=false edge also returns unrelated unpublished
  // "shadow" post objects (used internally for dark/ad-only posts), which
  // can pile up into the thousands on an active ad account and trip Meta's
  // query-complexity limiter ("reduce the amount of data...") even at a
  // modest row limit. Keeping this small and re-querying per month (rather
  // than fetching everything once) is the practical way around that.
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${pageId}/feed` +
    `?is_published=false&fields=id,message,scheduled_publish_time&limit=25&access_token=${encodeURIComponent(token)}`;
  const res = await fetch(url);
  const body = await res.json();
  if (body.error) throw new Error(`Meta scheduled posts: ${body.error.message}`);

  const items = (body.data || [])
    .filter(p => p.scheduled_publish_time)
    .map(p => {
      const d = new Date(p.scheduled_publish_time * 1000); // Graph API returns unix seconds
      return {
        id: p.id,
        message: (p.message || '(no caption)').slice(0, 120),
        scheduledAt: d.toISOString(),
        dateStr: d.toISOString().slice(0, 10),
        time: d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
      };
    })
    .filter(p => {
      const [py, pm] = p.dateStr.split('-').map(Number);
      return py === year && pm === month;
    });

  return { items, configured: true };
}

// ── HTTP handlers ────────────────────────────────────────────────────────
export async function onRequestGet(context) {
  const { env, request } = context;
  try {
    const url = new URL(request.url);
    const token = await getAccessToken(env);

    // Browse a folder's images (for the manual reorder picker) — no sheet read needed.
    const folderId = url.searchParams.get('folderId');
    if (folderId) {
      const files = await listDriveFolderImages(token, folderId);
      return json({ images: files.map(f => ({ id: f.id, name: f.name })) });
    }

    const sheetRows = await sheetsGet(env, token, `${SHEET_NAME}!${READ_RANGE}`);

    const slotsFor = url.searchParams.get('slotsFor');
    if (slotsFor) {
      return json(slotAvailability(sheetRows, slotsFor));
    }

    const monthParam = url.searchParams.get('month'); // "YYYY-MM"
    if (monthParam) {
      const [y, m] = monthParam.split('-').map(Number);

      let metaScheduled = [];
      let metaSyncError = null;
      let metaConfigured = false;
      try {
        const result = await fetchMetaScheduledFbPosts(env, y, m);
        metaScheduled = result.items;
        metaConfigured = result.configured;
      } catch (e) {
        // Non-fatal — the sheet-driven calendar is the source of truth;
        // Meta's own schedule is a bonus overlay, so a failure here (bad
        // token scope, rate limit, etc.) shouldn't break the whole view.
        metaSyncError = e.message;
        metaConfigured = true; // it must have been configured to reach a real API error
      }

      // slotLabels ships the day's five slot names so the calendar grid can
      // render FREE slots too (a day's items only name the taken ones), without
      // the client keeping its own copy of the labels that could drift.
      return json({ days: monthOccupancy(sheetRows, y, m), slotsPerDay: POSTING_SLOTS.length, slotLabels: SLOT_LABELS, metaScheduled, metaSyncError, metaConfigured });
    }

    const studioItems = await supabaseQuery(
      `studio_calendar?studio_status=eq.${encodeURIComponent('Good to Go')}&order=date.asc`
    );

    // Already-scheduled items leave a "STU-<id>" Content ID in the sheet —
    // filter those back out instead of writing anything to Supabase.
    const alreadyScheduled = new Set(
      sheetRows.map(r => String(r[COL.CONTENT_ID] || '').trim()).filter(id => id.startsWith('STU-'))
    );

    const posts = studioItems
      .map(item => {
        const mediaUrl = item.content_link || item.reference_links || '';
        const isFolder = !!driveFolderId(mediaUrl);
        return {
          contentId: `STU-${item.id}`,
          studioId: item.id,
          contentType: isFolder ? 'Folder' : detectContentType(item.content_details, mediaUrl),
          page: normalizePage(item.page_name),
          primaryText: item.content_details || '',
          mediaUrl,
          isFolder,
          productCode: item.product_code || ''
        };
      })
      .filter(p => !alreadyScheduled.has(p.contentId));

    return json({ posts });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

export async function onRequestPost(context) {
  const { env, request } = context;
  try {
    const { studioId, date, primaryText, mediaOrder, productName, slotIndex } = await request.json();
    if (!studioId || !date) {
      return json({ error: 'studioId and date are required' }, 400);
    }

    const items = await supabaseQuery(`studio_calendar?id=eq.${encodeURIComponent(studioId)}`);
    if (!items.length) return json({ error: 'Studio Calendar item not found: ' + studioId }, 404);
    const item = items[0];
    if (String(item.studio_status || '').trim() !== 'Good to Go') {
      return json({ error: `This item is no longer Good to Go (current status: "${item.studio_status}"). Refresh and try again.` }, 409);
    }

    const token = await getAccessToken(env);
    const sheetRows = await sheetsGet(env, token, `${SHEET_NAME}!${READ_RANGE}`);

    const contentId = `STU-${item.id}`;
    if (sheetRows.some(r => String(r[COL.CONTENT_ID] || '').trim() === contentId)) {
      return json({ error: 'This item has already been scheduled.' }, 409);
    }

    // Slot the user actually picked in the UI. Omitted (older clients, or the
    // day being full) → fall back to the original auto-pick, so nothing that
    // doesn't send a slot changes behaviour.
    const avail = slotAvailability(sheetRows, date);
    let chosenSlot = avail.nextAvailableIndex;
    if (slotIndex !== undefined && slotIndex !== null && slotIndex !== '') {
      const n = Number(slotIndex);
      if (!Number.isInteger(n) || n < 0 || n >= POSTING_SLOTS.length) {
        return json({ error: `Invalid slot "${slotIndex}".` }, 400);
      }
      // Re-checked here against a sheet read taken moments ago — this is the
      // race guard. It is not a hard lock (see the comment on the response).
      if (!avail.slots[n].available) {
        const holder = avail.slots[n].takenBy;
        return json({
          error: `The ${SLOT_LABELS[n]} slot on ${date} was taken${holder ? ` by ${holder}` : ''} while you were editing. Pick another slot.`,
          slotConflict: true,
          availability: avail
        }, 409);
      }
      chosenSlot = n;
    }
    const slotLabel = SLOT_LABELS[chosenSlot];

    let mediaUrl = item.content_link || item.reference_links || '';
    const page = normalizePage(item.page_name);
    let mediaType = detectContentType(item.content_details, mediaUrl);

    const folderId = driveFolderId(mediaUrl);
    if (folderId) {
      let orderedIds;
      if (Array.isArray(mediaOrder) && mediaOrder.length) {
        // Chamudhi picked a manual order in the UI — trust it, just cap/dedupe.
        orderedIds = [...new Set(mediaOrder.map(String))].slice(0, IG_CAROUSEL_MAX);
      } else {
        orderedIds = (await listDriveFolderImages(token, folderId)).map(f => f.id);
      }
      if (!orderedIds.length) return json({ error: 'That folder has no images in it (or Drive access failed) — nothing to post.' }, 422);
      mediaUrl = driveIdsToUrls(orderedIds).join(',');
      mediaType = 'Image';
    }

    const whatsappLink = await buildWhatsAppLink(env, productName);
    // The link is appended as its own line under the caption text, so it goes
    // out as part of the actual published post (Content.gs posts column E
    // verbatim) — not a separate sheet-only column. '' when no Product Name
    // was given leaves Primary Text completely untouched.
    const primaryTextTrimmed = String(primaryText || '').trim();
    const finalPrimaryText = whatsappLink ? `${primaryTextTrimmed}\n${whatsappLink}` : primaryTextTrimmed;

    // A ContentID, B Platform, C MediaType, D MediaURL, E PrimaryText, F Page, G ScheduleDate,
    // H Status, I-P (existing columns, left blank here), Q Slot
    await sheetsAppend(env, token, `${SHEET_NAME}!A:Q`, [
      contentId, '', mediaType, mediaUrl, finalPrimaryText, page, date, 'Approved',
      '', '', '', '', '', '', '', '', slotCellValue(chosenSlot)
    ]);

    // Sheet append is the critical step (it's what the posting bot reads) — if this
    // status update fails, don't fail the whole request, just flag it in the response.
    let studioSynced = true;
    try {
      await supabaseQuery(`studio_calendar?id=eq.${encodeURIComponent(studioId)}`, 'PATCH', { studio_status: 'Scheduled' });
    } catch (patchErr) {
      studioSynced = false;
    }

    // `slot` is now the slot actually written to column Q, not a guess at
    // where row order would have put it.
    return json({ ok: true, date, slot: slotLabel, slotIndex: chosenSlot, stacked: avail.stacking, studioSynced });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

// Reschedule an already-scheduled post to a new date. Blocked once the post
// has actually gone out (STATUS starts with "Posted") — that's a published
// record, not something to move around.
export async function onRequestPatch(context) {
  const { env, request } = context;
  try {
    const { contentId, date, primaryText, slotIndex } = await request.json();
    if (!contentId) return json({ error: 'contentId is required' }, 400);
    if (!date && typeof primaryText !== 'string') return json({ error: 'date or primaryText is required' }, 400);

    const token = await getAccessToken(env);
    const sheetRows = await sheetsGet(env, token, `${SHEET_NAME}!${READ_RANGE}`);
    const rowIdx = sheetRows.findIndex(r => String(r[COL.CONTENT_ID] || '').trim() === contentId);
    if (rowIdx === -1) return json({ error: 'Scheduled post not found: ' + contentId }, 404);

    const status = String(sheetRows[rowIdx][COL.STATUS] || '').trim();
    if (status.indexOf('Posted') === 0) {
      return json({ error: "This has already been posted — can't edit a published post." }, 409);
    }

    const sheetRowNumber = rowIdx + 2; // +1 for header row, +1 for 1-based sheet rows

    // Picking a generated headline (Copywriter button) writes straight back
    // to the Primary Text column — same sheet, same row, so it's exactly
    // "the final post" the rest of the pipeline (scheduling, posting) reads.
    if (typeof primaryText === 'string') {
      await sheetsUpdate(env, token, `${SHEET_NAME}!E${sheetRowNumber}`, [primaryText]);
    }

    if (!date) return json({ ok: true, primaryText });

    await sheetsUpdate(env, token, `${SHEET_NAME}!G${sheetRowNumber}`, [date]);

    // Availability on the NEW date, ignoring this row's own current claim.
    const avail = slotAvailability(sheetRows, date, rowIdx);

    // Keep the slot the post already had if it's free on the new date;
    // otherwise take the first free one. An explicit slotIndex from the
    // client wins when it's actually available.
    const currentSlot = parseSlotIndex(sheetRows[rowIdx][COL.SLOT]);
    let chosenSlot = null;
    const requested = (slotIndex === undefined || slotIndex === null || slotIndex === '') ? null : Number(slotIndex);
    if (requested !== null) {
      if (!Number.isInteger(requested) || requested < 0 || requested >= POSTING_SLOTS.length) {
        return json({ error: `Invalid slot "${slotIndex}".` }, 400);
      }
      if (!avail.slots[requested].available) {
        const holder = avail.slots[requested].takenBy;
        return json({
          error: `The ${SLOT_LABELS[requested]} slot on ${date} was taken${holder ? ` by ${holder}` : ''} while you were editing. Pick another slot.`,
          slotConflict: true,
          availability: avail
        }, 409);
      }
      chosenSlot = requested;
    } else if (currentSlot !== null && avail.slots[currentSlot].available) {
      chosenSlot = currentSlot;
    } else {
      chosenSlot = avail.nextAvailableIndex;
    }

    // Write the resolved slot so the moved row carries its own time rather
    // than a stale claim that could collide on the new date.
    await sheetsUpdate(env, token, `${SHEET_NAME}!Q${sheetRowNumber}`, [slotCellValue(chosenSlot)]);

    return json({ ok: true, date, slot: SLOT_LABELS[chosenSlot], slotIndex: chosenSlot, stacked: avail.stacking });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

// Remove an already-scheduled post entirely. Blocked once published, same
// as reschedule. If it came from a Studio submission (STU-<id>), flips the
// linked studio_calendar row back to "Good to Go" so it reappears in the
// ready-to-schedule list instead of being stuck showing "Scheduled" with
// nothing actually scheduled.
export async function onRequestDelete(context) {
  const { env, request } = context;
  try {
    const { contentId } = await request.json();
    if (!contentId) return json({ error: 'contentId is required' }, 400);

    const token = await getAccessToken(env);
    const sheetRows = await sheetsGet(env, token, `${SHEET_NAME}!${READ_RANGE}`);
    const rowIdx = sheetRows.findIndex(r => String(r[COL.CONTENT_ID] || '').trim() === contentId);
    if (rowIdx === -1) return json({ error: 'Scheduled post not found: ' + contentId }, 404);

    const status = String(sheetRows[rowIdx][COL.STATUS] || '').trim();
    if (status.indexOf('Posted') === 0) {
      return json({ error: "This has already been posted — can't delete a published post from here." }, 409);
    }

    const gid = await getSheetGid(env, token, SHEET_NAME);
    await sheetsDeleteRow(env, token, gid, rowIdx + 1); // grid rows are 0-based including header

    let studioSynced = true;
    if (contentId.startsWith('STU-')) {
      const studioId = contentId.slice(4);
      try {
        await supabaseQuery(`studio_calendar?id=eq.${encodeURIComponent(studioId)}`, 'PATCH', { studio_status: 'Good to Go' });
      } catch (patchErr) {
        studioSynced = false;
      }
    }

    return json({ ok: true, studioSynced });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}
