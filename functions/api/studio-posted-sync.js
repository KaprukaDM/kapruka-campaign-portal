// functions/api/studio-posted-sync.js
// ============================================================================
//  STUDIO "POSTED" RECONCILER  —  sheet (truth about publishing) → Supabase
//
//  WHY THIS EXISTS
//  ---------------
//  The portal kept the same item's status in two places that never talked to
//  each other:
//
//    * Supabase `studio_calendar.studio_status` — what every page in this
//      portal renders (admin-dashboard Studio tab, content-calendar,
//      ad-requests). "Posted" here was a free choice in a dropdown: a human
//      picked it, nothing checked anything. Measured against the live DB when
//      this was written: 489 rows said Posted and NOT ONE had a usable link to
//      a live post. (One activity-log line does carry a real permalink, but it
//      belongs to slot 2290, which no longer exists in studio_calendar.) The
//      old modal's "Post Link / URL" box was decorative — studio_calendar has
//      no post_link column, so the value was dropped on save.
//
//    * The Google Sheet "Content Approval List" (env CONTENT_SHEET_ID) — the
//      sheet the Content.gs bot actually posts from. The bot sets column H
//      STATUS to "Posted…" AFTER a successful publish. That write is the only
//      event anywhere in this system that is caused by a real publish.
//
//  SOURCE OF TRUTH — the deliberate split
//  --------------------------------------
//    studio_calendar owns the WORKFLOW (Received → Working → Submitted →
//      Approved by Head → Good to Go → Scheduled). Every page already reads
//      it; moving that would mean rewriting the whole portal for no gain.
//
//    The SHEET owns the single fact "this went live", because the sheet row
//      is written by the thing that publishes. Supabase never observes a
//      publish, so it cannot be trusted for this one fact no matter how many
//      dropdowns offer it.
//
//  So `studio_status = 'Posted'` is DERIVED, never freely chosen: it is set
//  either by this reconciler (the bot published it) or by hand with a link to
//  the live post that passes validation (see parsePostEvidence in
//  js/supabase-api.js). The two stores can no longer disagree about Posted,
//  because only one of them is allowed to originate it.
//
//  STATUS VOCABULARY MAP (explicit — the strings genuinely differ)
//  --------------------------------------------------------------
//    SHEET column H                    →  studio_calendar.studio_status
//    ----------------------------------------------------------------
//    "Approved"                        →  "Scheduled"   (queued; bot has not
//                                          run yet — NOT posted)
//    "Posted"  /  "Posted <anything>"  →  "Posted"      (published; the only
//                                          legitimate origin of Posted)
//    ""  /  anything else              →  (no opinion — row ignored)
//
//    Reverse direction already exists in functions/api/posting-calendar.js:
//    studio "Good to Go" → appends a sheet row with STATUS "Approved" and
//    moves the studio row to "Scheduled".
//
//    The link between the two stores is the sheet's Content ID column:
//    "STU-<studio_calendar.id>".
//
//  WHAT IT WRITES, AND WHAT IT DELIBERATELY DOES NOT
//  -------------------------------------------------
//    PROMOTED   sheet says Posted, Supabase does not  → set studio_status
//               'Posted' (+ approval_status) and log the evidence.
//    BACKFILLED sheet says Posted, Supabase already says Posted but has no
//               evidence record → write the evidence record only. No status
//               change.
//    STALE      sheet does NOT say Posted (still "Approved" = sitting in the
//               schedule) but Supabase says Posted → REPORTED, NOT REWRITTEN.
//               This is the reported bug's exact shape. Nothing is mass-
//               rewritten because the UI already stops calling these "Posted"
//               (they render as "Pending verification" — see
//               studioPostedLabel in js/supabase-api.js), so flagging is
//               already visible without destroying a human's record of what
//               they believed happened.
//    ORPHAN     Supabase says Posted but the sheet has no STU-<id> row at all
//               (posted outside this pipeline, or pre-dates it) → REPORTED,
//               NOT REWRITTEN. Same reasoning.
//
//  Evidence is written into `studio_activity_log` (event_type
//  'posted_verified'), NOT a new column: studio_calendar has no
//  post_link/posted_date column (verified against the live schema) and this
//  repo has no migration tooling, so a new column would have meant blocking
//  on a manual SQL change by hand.
//
//  ENDPOINTS
//    GET  /api/studio-posted-sync            → dry-run report, writes nothing
//    POST /api/studio-posted-sync {apply:true} → applies PROMOTED + BACKFILLED
//
//  Env vars required (same Cloudflare Pages secrets posting-calendar.js uses):
//    GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN
//    CONTENT_SHEET_ID
// ============================================================================

const SHEET_NAME = 'Content Approval List';
const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';
const COL = { CONTENT_ID: 0, SCHEDULE_DATE: 6, STATUS: 7 };

// Same public anon key already embedded in js/supabase-api.js and
// functions/api/posting-calendar.js — duplicated the same way they duplicate
// it, because this repo has no build step to share a module across the
// browser/Functions boundary.
const SUPABASE_URL = 'https://ivllhheqqiseagmctfyp.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml2bGxoaGVxcWlzZWFnbWN0ZnlwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg1NzQzMzksImV4cCI6MjA4NDE1MDMzOX0.OnkYNACtdknKDY2KqLfiGN0ORXpKaW906fD0TtSJlIk';

const POSTED_VERIFIED_EVENT = 'posted_verified';
const STUDIO_POSTED = 'Posted';
const SHEET_POSTED_PREFIX = 'Posted';
const SHEET_SCHEDULED = 'Approved';
// PostgREST refuses to return more than this per request whatever `limit`
// asks for, so every "read them all" here has to page instead of trusting a
// big limit. Confirmed against this project: limit=5000 returns exactly 1000.
const SUPABASE_PAGE_SIZE = 1000;

// Mirror of POST_EVIDENCE_PATTERNS in js/supabase-api.js — kept in sync by
// hand for the same no-build-step reason as the Supabase key above. Only used
// here to decide whether a LEGACY "Marked as Posted — <url>" log line still
// counts as evidence, so a drift here is not safety-critical.
const POST_EVIDENCE_PATTERNS = [
  /^https?:\/\/(www\.|m\.|web\.)?facebook\.com\/[^\/\s]+\/(posts|videos|photos|reel)\/[A-Za-z0-9._-]+/i,
  /^https?:\/\/(www\.|m\.|web\.)?facebook\.com\/(reel|share\/p|share\/v|share\/r)\/[A-Za-z0-9._-]+/i,
  /^https?:\/\/(www\.|m\.|web\.)?facebook\.com\/(permalink\.php|photo\.php|photo\/|story\.php|watch\/?)\?.*\b(story_fbid|fbid|v)=\d+/i,
  /^https?:\/\/fb\.watch\/[A-Za-z0-9._-]+/i,
  /^https?:\/\/(www\.)?instagram\.com\/(p|reel|reels|tv)\/[A-Za-z0-9._-]+/i,
  /^\d{6,}_\d{6,}$/
];
export function isValidEvidence(value) {
  const v = String(value || '').trim();
  return !!v && POST_EVIDENCE_PATTERNS.some(re => re.test(v));
}

// Sheet STATUS string → what it means for studio_status. Returns null when
// the sheet expresses no opinion, so unknown strings are ignored rather than
// guessed at.
export function sheetStatusToStudioStatus(sheetStatus) {
  const s = String(sheetStatus || '').trim();
  if (!s) return null;
  if (s.indexOf(SHEET_POSTED_PREFIX) === 0) return STUDIO_POSTED;
  if (s === SHEET_SCHEDULED) return 'Scheduled';
  return null;
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

// Reads every row matching `endpoint`, page by page. `endpoint` must not
// already carry limit/offset. Needed because of the 1000-row cap above —
// a reconciler that only sees the first 1000 rows would report the rest as
// missing from the sheet and flag them wrongly.
async function supabaseSelectAll(endpoint) {
  const out = [];
  for (let offset = 0; ; offset += SUPABASE_PAGE_SIZE) {
    const page = await supabaseQuery(
      `${endpoint}&order=id.asc&limit=${SUPABASE_PAGE_SIZE}&offset=${offset}`
    );
    out.push(...page);
    if (page.length < SUPABASE_PAGE_SIZE) return out;
  }
}

// ── Google ───────────────────────────────────────────────────────────────
async function getAccessToken(env) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_REFRESH_TOKEN) {
    throw new Error('Google Sheets credentials are not configured for this deployment ' +
      '(GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN). ' +
      'The reconciler cannot confirm anything as posted without them.');
  }
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

async function sheetsGet(env, token, range) {
  const url = `${SHEETS_API}/${env.CONTENT_SHEET_ID}/values/${encodeURIComponent(range)}?valueRenderOption=UNFORMATTED_VALUE`;
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  const body = await res.json();
  if (!res.ok) throw new Error('Sheets read failed: ' + JSON.stringify(body));
  return body.values || [];
}

// ── Classification (pure) ────────────────────────────────────────────────
//
// The whole decision table, with no I/O in it, so it can be tested directly
// (scripts/test-studio-posted-sync.mjs) rather than only through a live
// Google Sheet.
//
//   byId             Map<studioId, studio_calendar row>
//   sheetByStudioId  Map<studioId, { contentId, sheetStatus, mapped }>
//   verified         Set<studioId> that already carry posted evidence
export function classifyRows(byId, sheetByStudioId, verified) {
  const promoted = [];   // sheet posted, studio not → will be fixed
  const backfilled = []; // sheet posted, studio posted, no evidence → will be fixed
  const stale = [];      // studio posted, sheet says NOT posted → flagged only
  const orphan = [];     // studio posted, no sheet row at all → flagged only
  const alreadyInSync = [];

  const summarise = (row, sheetInfo) => ({
    id: row.id,
    date: row.date || null,
    page: row.page_name || null,
    content: String(row.content_details || '').slice(0, 90),
    studioStatus: row.studio_status || null,
    sheetStatus: sheetInfo ? sheetInfo.sheetStatus : null
  });

  byId.forEach((row, id) => {
    const sheetInfo = sheetByStudioId.get(id) || null;
    const sheetSaysPosted = !!sheetInfo && sheetInfo.mapped === STUDIO_POSTED;
    const studioSaysPosted = row.studio_status === STUDIO_POSTED;

    if (sheetSaysPosted && !studioSaysPosted) {
      promoted.push(summarise(row, sheetInfo));
    } else if (sheetSaysPosted && studioSaysPosted && !verified.has(id)) {
      backfilled.push(summarise(row, sheetInfo));
    } else if (studioSaysPosted && sheetInfo && !sheetSaysPosted) {
      stale.push(summarise(row, sheetInfo));
    } else if (studioSaysPosted && !sheetInfo && !verified.has(id)) {
      orphan.push(summarise(row, sheetInfo));
    } else if (studioSaysPosted) {
      alreadyInSync.push(summarise(row, sheetInfo));
    }
  });

  return { promoted, backfilled, stale, orphan, alreadyInSync };
}

// ── Reconciliation ───────────────────────────────────────────────────────
//
// Builds the full picture without writing anything. `apply` decides whether
// the safe half of it gets committed.
async function reconcile(env, { apply, actor }) {
  const token = await getAccessToken(env);
  const sheetRows = await sheetsGet(env, token, `${SHEET_NAME}!A2:H`);

  // Sheet side: only STU-<id> rows are ours to reconcile. A later row for the
  // same Content ID wins (re-scheduled duplicates), which matches how the
  // sheet is appended to.
  const sheetByStudioId = new Map();
  sheetRows.forEach(row => {
    const contentId = String(row[COL.CONTENT_ID] || '').trim();
    if (!contentId.startsWith('STU-')) return;
    const studioId = contentId.slice(4);
    if (!/^\d+$/.test(studioId)) return;
    const sheetStatus = String(row[COL.STATUS] || '').trim();
    sheetByStudioId.set(Number(studioId), {
      contentId,
      sheetStatus,
      mapped: sheetStatusToStudioStatus(sheetStatus)
    });
  });

  // Supabase side: every row that currently claims Posted, plus every row the
  // sheet has an opinion about (so a sheet-Posted row whose studio status is
  // still "Scheduled" gets picked up too).
  const idsFromSheet = [...sheetByStudioId.keys()];
  const SELECT = '&select=id,date,page_name,studio_status,approval_status,content_details';
  const postedRows = await supabaseSelectAll(
    `studio_calendar?studio_status=eq.${encodeURIComponent(STUDIO_POSTED)}${SELECT}`
  );
  // Chunked: the id list rides in the URL, so it cannot be unbounded.
  const sheetRowsFromDb = [];
  for (let i = 0; i < idsFromSheet.length; i += 150) {
    const chunk = idsFromSheet.slice(i, i + 150);
    sheetRowsFromDb.push(
      ...await supabaseSelectAll(`studio_calendar?id=in.(${chunk.join(',')})${SELECT}`)
    );
  }

  const byId = new Map();
  [...postedRows, ...sheetRowsFromDb].forEach(r => byId.set(r.id, r));

  // Which of those already carry evidence?
  const allIds = [...byId.keys()];
  const verified = new Set();
  // Chunked because PostgREST puts the id list in the URL, and paged because
  // it caps every response at 1000 rows regardless of `limit` (verified
  // against this project: limit=5000 returns exactly 1000). The old
  // `limit=5000` here was a silent correctness bug — once the log passed
  // 1000 rows for a chunk, real evidence would drop off the end and rows
  // would be re-flagged as unverified on every run. The or=() filter keeps
  // the volume down as well as making the paging honest.
  for (let i = 0; i < allIds.length; i += 150) {
    const chunk = allIds.slice(i, i + 150);
    for (let offset = 0; ; offset += SUPABASE_PAGE_SIZE) {
      const logs = await supabaseQuery(
        `studio_activity_log?slot_id=in.(${chunk.join(',')})` +
        `&or=(event_type.eq.${POSTED_VERIFIED_EVENT},detail.ilike.*Marked as Posted*)` +
        `&select=slot_id,event_type,detail&order=id.asc` +
        `&limit=${SUPABASE_PAGE_SIZE}&offset=${offset}`
      );
      logs.forEach(l => {
        if (l.event_type === POSTED_VERIFIED_EVENT) { verified.add(l.slot_id); return; }
        const detail = l.detail || '';
        if (!/Marked as Posted/i.test(detail)) return;
        const m = detail.match(/https?:\/\/[^\s)]+/);
        if (m && isValidEvidence(m[0])) verified.add(l.slot_id);
      });
      if (logs.length < SUPABASE_PAGE_SIZE) break;
    }
  }

  const { promoted, backfilled, stale, orphan, alreadyInSync } =
    classifyRows(byId, sheetByStudioId, verified);

  let applied = { promoted: 0, backfilled: 0, errors: [] };
  if (apply) {
    for (const item of promoted) {
      try {
        await supabaseQuery(`studio_calendar?id=eq.${item.id}`, 'PATCH', {
          studio_status: STUDIO_POSTED,
          approval_status: STUDIO_POSTED,
          updated_at: new Date().toISOString()
        });
        await logStudioActivity(item.id,
          `Marked as Posted — confirmed published by the posting bot (sheet status "${item.sheetStatus}")` +
          (item.studioStatus ? ` (was ${item.studioStatus})` : ''), actor);
        await logStudioActivity(item.id,
          `Verified posted — sheet row ${sheetByStudioId.get(item.id).contentId} status "${item.sheetStatus}"`,
          actor, POSTED_VERIFIED_EVENT);
        applied.promoted++;
      } catch (e) {
        applied.errors.push({ id: item.id, error: e.message });
      }
    }
    for (const item of backfilled) {
      try {
        await logStudioActivity(item.id,
          `Verified posted — sheet row ${sheetByStudioId.get(item.id).contentId} status "${item.sheetStatus}"`,
          actor, POSTED_VERIFIED_EVENT);
        applied.backfilled++;
      } catch (e) {
        applied.errors.push({ id: item.id, error: e.message });
      }
    }
  }

  return {
    ok: true,
    applied: !!apply,
    sourceOfTruth: 'Google Sheet "Content Approval List" decides Posted; studio_calendar owns every other status.',
    counts: {
      sheetStuRows: sheetByStudioId.size,
      studioPostedRows: postedRows.length,
      verifiedBefore: [...verified].length,
      promoted: promoted.length,
      backfilled: backfilled.length,
      staleFlagged: stale.length,
      orphanFlagged: orphan.length,
      alreadyInSync: alreadyInSync.length
    },
    promoted,
    backfilled,
    // Deliberately not rewritten — the UI already shows these as
    // "Pending verification" rather than Posted.
    stale,
    orphan: orphan.slice(0, 200),
    orphanTruncated: orphan.length > 200,
    result: applied
  };
}

// logStudioActivity's Functions-side twin. Never throws — a failed log must
// not abort a reconciliation run midway and leave it half applied.
async function logStudioActivity(slotId, detail, actor, eventType = 'status_changed') {
  try {
    await supabaseQuery('studio_activity_log', 'POST', {
      slot_id: slotId,
      event_type: eventType,
      detail: detail || null,
      actor: actor || 'Sheet Sync'
    });
  } catch (e) {
    console.warn('activity log skipped:', e.message);
  }
}

export async function onRequestGet(context) {
  try {
    return json(await reconcile(context.env, { apply: false, actor: 'Sheet Sync' }));
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

export async function onRequestPost(context) {
  try {
    let body = {};
    try { body = await context.request.json(); } catch (_) { /* empty body = apply */ }
    const actor = String(body.actor || 'Sheet Sync').slice(0, 60);
    return json(await reconcile(context.env, { apply: body.apply !== false, actor }));
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}
