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
//    Optional "Product Name" field in the scheduling form builds a wa.me
//      customer-inquiry link, wraps it in a branded short.io link
//      (kapruka.s.gy — see buildWhatsAppLink() below), and appends it as a
//      second line under the caption text in column E itself — so it goes
//      out as part of the actual published post (Content.gs posts column E
//      verbatim), not a sheet-only reference column. Left untouched when no
//      product name is given.
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
  PAGE: 5, SCHEDULE_DATE: 6, STATUS: 7
};
// Column Q — new, additive. Columns I-P are already spoken for (see the
// header comment above) and Content.gs only ever writes those via
// single-cell getRange() calls, never a wide range, so a new column here is
// safe and won't be touched or clobbered by the posting bot.
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

// Per-day occupancy for a whole month, for the calendar grid view.
//
// The sheet has no explicit time-of-day column — a post's slot (10am, 12pm,
// 3pm, 6pm, 9pm) is never stored, only implied at save-time by how many
// occupying rows already existed for that date (see slotAvailability/
// computeOccupiedSlots above, used by the POST handler). Reconstructing it
// here the same way: since `rows` is sheet-append order and a date's
// occupying rows keep that relative order, the Nth occupying row for a date
// is the one that landed in the Nth slot when it was scheduled. 6th+ rows in
// a day all stack on the last slot (9pm), matching that same save-time logic.
function monthOccupancy(rows, year, month) {
  const byDate = {};
  rows.forEach(row => {
    const st = String(row[COL.STATUS] || '').trim();
    const occupies = (st === 'Approved' || st.indexOf('Posted') === 0);
    if (!occupies) return;
    const d = serialToDate(row[COL.SCHEDULE_DATE]);
    if (!d) return;
    if (d.getFullYear() !== year || d.getMonth() !== month - 1) return;
    const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (!byDate[dateStr]) byDate[dateStr] = { date: dateStr, occupied: 0, items: [] };
    const slotIndex = Math.min(byDate[dateStr].occupied, POSTING_SLOTS.length - 1);
    byDate[dateStr].occupied++;
    byDate[dateStr].items.push({
      contentId: String(row[COL.CONTENT_ID] || '').trim(),
      page: String(row[COL.PAGE] || '').trim(),
      posted: st.indexOf('Posted') === 0,
      time: SLOT_LABELS[slotIndex],
      primaryText: String(row[COL.PRIMARY_TEXT] || '').trim(),
      mediaUrl: String(row[COL.MEDIA_URL] || '').trim(),
      mediaType: String(row[COL.MEDIA_TYPE] || '').trim()
    });
  });
  return Object.values(byDate);
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

    const sheetRows = await sheetsGet(env, token, `${SHEET_NAME}!A2:H`);

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

      return json({ days: monthOccupancy(sheetRows, y, m), slotsPerDay: POSTING_SLOTS.length, metaScheduled, metaSyncError, metaConfigured });
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
    const { studioId, date, primaryText, mediaOrder, productName } = await request.json();
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
    const sheetRows = await sheetsGet(env, token, `${SHEET_NAME}!A2:H`);

    const contentId = `STU-${item.id}`;
    if (sheetRows.some(r => String(r[COL.CONTENT_ID] || '').trim() === contentId)) {
      return json({ error: 'This item has already been scheduled.' }, 409);
    }

    const avail = slotAvailability(sheetRows, date);
    const slotLabel = SLOT_LABELS[avail.nextAvailableIndex];

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
    // H Status, I-P (existing columns, left blank here)
    await sheetsAppend(env, token, `${SHEET_NAME}!A:P`, [
      contentId, '', mediaType, mediaUrl, finalPrimaryText, page, date, 'Approved'
    ]);

    // Sheet append is the critical step (it's what the posting bot reads) — if this
    // status update fails, don't fail the whole request, just flag it in the response.
    let studioSynced = true;
    try {
      await supabaseQuery(`studio_calendar?id=eq.${encodeURIComponent(studioId)}`, 'PATCH', { studio_status: 'Scheduled' });
    } catch (patchErr) {
      studioSynced = false;
    }

    return json({ ok: true, date, slot: slotLabel, stacked: avail.stacking, studioSynced });
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
    const { contentId, date, primaryText } = await request.json();
    if (!contentId) return json({ error: 'contentId is required' }, 400);
    if (!date && typeof primaryText !== 'string') return json({ error: 'date or primaryText is required' }, 400);

    const token = await getAccessToken(env);
    const sheetRows = await sheetsGet(env, token, `${SHEET_NAME}!A2:H`);
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

    // Slot for the response message only — the real slot a post lands in is
    // always recomputed from row order at read time (see monthOccupancy),
    // this is just an informational preview.
    const avail = slotAvailability(sheetRows, date);
    return json({ ok: true, date, slot: SLOT_LABELS[avail.nextAvailableIndex], stacked: avail.stacking });
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
    const sheetRows = await sheetsGet(env, token, `${SHEET_NAME}!A2:H`);
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
