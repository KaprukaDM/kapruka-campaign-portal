// functions/api/posting-calendar.js
// ============================================================================
//  POSTING CALENDAR API — talks directly to the "Content Approval List"
//  Google Sheet via an OAuth refresh token (no Apps Script involved).
//
//  Env vars required (set as Cloudflare Pages secrets — see README setup notes):
//    GOOGLE_CLIENT_ID       from the Desktop OAuth client JSON
//    GOOGLE_CLIENT_SECRET   from the Desktop OAuth client JSON
//    GOOGLE_REFRESH_TOKEN   obtained once via a consent flow (OAuth Playground),
//                           scoped to https://www.googleapis.com/auth/spreadsheets,
//                           authorized as the Google account that can edit the sheet
//    CONTENT_SHEET_ID       1CNSZqL5MCbTaj5fF4L_e95oJECVMpOZMUAz-b9r9Bpk
//
//  Sheet columns (1-based, "Content Approval List" tab — must match Content.gs COL):
//    A ContentID  B Platform  C MediaType  D MediaURL  E PrimaryText
//    F Page  G ScheduleDate  H Status  I..O Links  P TT_RESULT
//
//  STATUS must include "Good to Go" as a valid dropdown value — run
//  setupStatusValidation() once in the Apps Script project (see PostingCalendar.gs).
// ============================================================================

const SHEET_NAME = 'Content Approval List';
const COL = {
  CONTENT_ID: 0, PLATFORM: 1, MEDIA_TYPE: 2, MEDIA_URL: 3, PRIMARY_TEXT: 4,
  PAGE: 5, SCHEDULE_DATE: 6, STATUS: 7
};
const POSTING_SLOTS = [
  { hour: 10, minute: 0 }, { hour: 12, minute: 0 }, { hour: 15, minute: 0 },
  { hour: 18, minute: 0 }, { hour: 21, minute: 0 }
];
const SLOT_LABELS = ['10:00 AM', '12:00 PM', '3:00 PM', '6:00 PM', '9:00 PM'];
const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);

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

async function sheetsUpdate(env, token, range, values) {
  const url = `${SHEETS_API}/${env.CONTENT_SHEET_ID}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ range, values: [values] })
  });
  const body = await res.json();
  if (!res.ok) throw new Error('Sheets write failed: ' + JSON.stringify(body));
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
function detectContentType(mediaTypeRaw, mediaUrlRaw) {
  const t = String(mediaTypeRaw || '').trim().toLowerCase();
  if (t.includes('video')) return 'Video';
  if (t.includes('image') || t.includes('photo') || t.includes('post')) return 'Image';
  const firstUrl = String(mediaUrlRaw || '').split(',')[0].trim();
  return isVideoUrl(firstUrl) ? 'Video' : 'Image';
}

function computeOccupiedSlots(rows, targetKey) {
  let count = 0;
  rows.forEach(row => {
    const st = String(row[COL.STATUS] || '').trim();
    const occupies = (st === 'Approved' || st.indexOf('Posted') === 0);
    if (!occupies) return;
    const d = serialToDate(row[COL.SCHEDULE_DATE]);
    if (!d) return;
    if (dateKey(d) === targetKey) count++;
  });
  return count;
}

function slotAvailability(rows, dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const targetKey = y + '-' + (m - 1) + '-' + d;
  const occupied = computeOccupiedSlots(rows, targetKey);
  return {
    occupiedCount: occupied,
    freeCount: Math.max(POSTING_SLOTS.length - occupied, 0),
    nextAvailableIndex: Math.min(occupied, POSTING_SLOTS.length - 1),
    slots: SLOT_LABELS.map((time, i) => ({ index: i, time, available: i >= occupied })),
    stacking: occupied >= POSTING_SLOTS.length
  };
}

// ── HTTP handlers ────────────────────────────────────────────────────────
export async function onRequestGet(context) {
  const { env, request } = context;
  try {
    const url = new URL(request.url);
    const token = await getAccessToken(env);
    const rows = await sheetsGet(env, token, `${SHEET_NAME}!A2:H`);

    const slotsFor = url.searchParams.get('slotsFor');
    if (slotsFor) {
      return json(slotAvailability(rows, slotsFor));
    }

    const posts = rows
      .map((row, i) => ({ row, rowIndex: i + 2 }))
      .filter(({ row }) => String(row[COL.STATUS] || '').trim() === 'Good to Go')
      .map(({ row, rowIndex }) => ({
        contentId: String(row[COL.CONTENT_ID] || '').trim(),
        rowIndex,
        contentType: detectContentType(row[COL.MEDIA_TYPE], row[COL.MEDIA_URL]),
        page: String(row[COL.PAGE] || '').trim() || 'Kapruka',
        primaryText: String(row[COL.PRIMARY_TEXT] || ''),
        mediaUrl: String(row[COL.MEDIA_URL] || '')
      }))
      .filter(p => p.contentId);

    return json({ posts });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

export async function onRequestPost(context) {
  const { env, request } = context;
  try {
    const { contentId, date, primaryText } = await request.json();
    if (!contentId || !date || !primaryText || !String(primaryText).trim()) {
      return json({ error: 'contentId, date, and primaryText are all required' }, 400);
    }

    const token = await getAccessToken(env);
    const rows = await sheetsGet(env, token, `${SHEET_NAME}!A2:H`);

    const idx = rows.findIndex(row => String(row[COL.CONTENT_ID] || '').trim() === String(contentId).trim());
    if (idx === -1) return json({ error: 'Content ID not found: ' + contentId }, 404);
    const rowIndex = idx + 2;
    const currentStatus = String(rows[idx][COL.STATUS] || '').trim();
    if (currentStatus !== 'Good to Go') {
      return json({ error: `This post is no longer Good to Go (current status: "${currentStatus}"). Refresh and try again.` }, 409);
    }

    const avail = slotAvailability(rows, date);
    const slotLabel = SLOT_LABELS[avail.nextAvailableIndex];

    // E = Primary Text, G = Schedule Date, H = Status — write in one row-scoped call each
    await sheetsUpdate(env, token, `${SHEET_NAME}!E${rowIndex}`, [String(primaryText).trim()]);
    await sheetsUpdate(env, token, `${SHEET_NAME}!G${rowIndex}`, [date]);
    await sheetsUpdate(env, token, `${SHEET_NAME}!H${rowIndex}`, ['Approved']);

    return json({ ok: true, date, slot: slotLabel, stacked: avail.stacking });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}
