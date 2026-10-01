#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// SEED DAILY POSTING SLOTS — open, non-seasonal content calendar slots
//
//   node scripts/seed-daily-posting-slots.mjs --from 2026-10-01 --to 2026-12-31
//
// Fills every day in the range with N bookable slots on content-calendar.html
// that are:
//   • non-seasonal  — theme_config.is_seasonal = false, so the day is not
//     painted as a season on the public calendar
//   • non-category  — category_slots.category = 'Any Category', so whoever
//     books the slot picks the product instead of being handed a category
//
// Writes to two Supabase tables (the same ones the admin "Add Content Theme"
// form writes):
//   theme_config    — one row spanning the range, so the days carry a label
//                     and the slots can be regenerated/deleted as a unit
//   category_slots  — SLOTS_PER_DAY rows per date, which is what the calendar
//                     actually reads to decide a day is bookable
//
// Safe to re-run. It never deletes and never double-books:
//   • a theme_config row with the same name + exact range is reused
//   • a (date, slot_number) that already has a slot is left untouched, so days
//     already covered by a season keep that season's slots
//
// Options
//   --from YYYY-MM-DD   first day (default: today)
//   --to   YYYY-MM-DD   last day inclusive (default: 31 Dec of --from's year)
//   --slots N           slots per day (default 3)
//   --name "..."        theme name (default "Daily Post")
//   --color #RRGGBB     theme colour (default #422B73, the portal purple)
//   --no-theme          only write category_slots, skip the theme_config row
//   --dry-run           print what would be written, write nothing
//
// Credentials: reads the project URL + anon key straight out of
// js/supabase-api.js (they are public — the same pair every page in this repo
// ships to the browser), or SUPABASE_URL / SUPABASE_KEY from the environment.
// ═══════════════════════════════════════════════════════════════
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

// ── args ──────────────────────────────────────────────────────
function arg(name, fallback = null) {
  const i = process.argv.indexOf('--' + name);
  return i === -1 ? fallback : process.argv[i + 1];
}
const has = name => process.argv.includes('--' + name);

const DRY_RUN   = has('dry-run');
const NO_THEME  = has('no-theme');
const SLOTS     = parseInt(arg('slots', '3'), 10);
const NAME      = arg('name', 'Daily Post');
const COLOR     = arg('color', '#422B73');

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const FROM = arg('from', todayStr());
const TO   = arg('to', `${FROM.slice(0, 4)}-12-31`);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
if (!DATE_RE.test(FROM) || !DATE_RE.test(TO)) {
  console.error('--from/--to must be YYYY-MM-DD'); process.exit(1);
}
if (TO < FROM) { console.error('--to is before --from'); process.exit(1); }
if (!Number.isInteger(SLOTS) || SLOTS < 1 || SLOTS > 10) {
  console.error('--slots must be 1-10'); process.exit(1);
}

// ── supabase ──────────────────────────────────────────────────
function credsFromClient() {
  const src = readFileSync(join(here, '..', 'js', 'supabase-api.js'), 'utf8');
  const pick = key => (src.match(new RegExp(`window\\.${key}\\s*=\\s*'([^']+)'`)) || [])[1];
  return { url: pick('SUPABASE_URL'), key: pick('SUPABASE_KEY') };
}
const fromClient = credsFromClient();
// Env only wins when BOTH halves are set — a stray SUPABASE_URL from some other
// project in the shell would otherwise get paired with this repo's key and 401.
const useEnv = !!(process.env.SUPABASE_URL && process.env.SUPABASE_KEY);
const SUPABASE_URL = useEnv ? process.env.SUPABASE_URL : fromClient.url;
const SUPABASE_KEY = useEnv ? process.env.SUPABASE_KEY : fromClient.key;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('No Supabase URL/key — set SUPABASE_URL and SUPABASE_KEY.'); process.exit(1);
}

async function sb(path, method = 'GET', body = null) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

// ── helpers ───────────────────────────────────────────────────
// Dates are walked in UTC so the day never slips by one in a local timezone.
function eachDate(from, to) {
  const out = [];
  const [fy, fm, fd] = from.split('-').map(Number);
  const end = Date.parse(to + 'T00:00:00Z');
  for (let t = Date.UTC(fy, fm - 1, fd); t <= end; t += 86400000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}
// Same week_number rule generateCategorySlots() in js/supabase-api.js uses.
const weekNumber = dateStr => Math.floor((Number(dateStr.slice(8, 10)) - 1) / 7) + 1;

// ── run ───────────────────────────────────────────────────────
const dates = eachDate(FROM, TO);
console.log(`Daily posting slots: ${FROM} → ${TO}  (${dates.length} days × ${SLOTS} slots)`);
console.log(`  theme "${NAME}" · seasonal: no · category: Any Category (open)`);
if (DRY_RUN) console.log('  DRY RUN — nothing will be written');

// 1. theme_config — one row for the whole range, reused if already there.
if (!NO_THEME) {
  const existingThemes = await sb(
    `theme_config?theme_name=eq.${encodeURIComponent(NAME)}` +
    `&start_date=eq.${FROM}&end_date=eq.${TO}&select=id,is_seasonal`
  );
  if (existingThemes.length) {
    console.log(`  theme: reusing existing row #${existingThemes[0].id}`);
  } else if (DRY_RUN) {
    console.log('  theme: would insert 1 row');
  } else {
    const row = await sb('theme_config', 'POST', {
      theme_name: NAME, start_date: FROM, end_date: TO,
      slots_per_day: SLOTS, theme_color: COLOR, is_seasonal: false
    });
    console.log(`  theme: inserted row #${row[0].id}`);
  }
}

// 2. category_slots — skip any (date, slot_number) that already exists, so a
//    season already sitting on a day is never overwritten or duplicated.
const existingSlots = await sb(
  `category_slots?date=gte.${FROM}&date=lte.${TO}&select=date,slot_number,category`
);
const taken = new Set(existingSlots.map(s => `${s.date}#${s.slot_number}`));
console.log(`  found ${existingSlots.length} slot row(s) already in this range`);

const toInsert = [];
for (const date of dates) {
  for (let n = 1; n <= SLOTS; n++) {
    if (taken.has(`${date}#${n}`)) continue;
    toInsert.push({
      date, slot_number: n, category: 'Any Category',
      week_number: weekNumber(date), month_year: date.slice(0, 7)
    });
  }
}

if (!toInsert.length) {
  console.log('  slots: nothing to add — every day in the range is already covered');
} else if (DRY_RUN) {
  console.log(`  slots: would insert ${toInsert.length} row(s), e.g.`, toInsert[0]);
} else {
  // Chunked so one request never carries a quarter of a year of rows.
  const CHUNK = 200;
  let written = 0;
  for (let i = 0; i < toInsert.length; i += CHUNK) {
    const batch = toInsert.slice(i, i + CHUNK);
    await sb('category_slots', 'POST', batch);
    written += batch.length;
    process.stdout.write(`\r  slots: inserted ${written}/${toInsert.length}`);
  }
  console.log('');
}

// 3. Read back what the calendar will actually see.
const after = await sb(`category_slots?date=gte.${FROM}&date=lte.${TO}&select=date,category`);
const perDay = {};
after.forEach(s => { perDay[s.date] = (perDay[s.date] || 0) + 1; });
const missing = dates.filter(d => (perDay[d] || 0) < SLOTS);
const openCount = after.filter(s => s.category === 'Any Category').length;
console.log(`  verify: ${after.length} slots across ${Object.keys(perDay).length}/${dates.length} days` +
            ` · ${openCount} open (Any Category)`);
if (missing.length && !DRY_RUN) {
  console.log(`  WARNING: ${missing.length} day(s) still under ${SLOTS} slots: ${missing.slice(0, 10).join(', ')}`);
  process.exit(1);
}
console.log('Done.');
