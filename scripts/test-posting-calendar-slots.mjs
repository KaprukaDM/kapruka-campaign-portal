// scripts/test-posting-calendar-slots.mjs
// ---------------------------------------------------------------------------
// Tests the posting calendar's slot bookkeeping WITHOUT needing Google
// credentials.
//
//   node scripts/test-posting-calendar-slots.mjs
//
// The slot picker's correctness lives in four pure functions — parseSlotIndex,
// assignSlots, slotAvailability and monthOccupancy — so they are tested here
// directly against the real source file. The I/O around them (Google auth,
// Sheets read/append) needs a live credential and is NOT covered here.
//
// The regression that matters most: rows written before column Q existed have
// no stored slot, and they must still resolve to exactly the slot the calendar
// showed for them under the old row-order inference.
//
// functions/*.js are ES modules for Cloudflare but this repo has no root
// package.json declaring "type":"module", so the real source is loaded through
// a data: URL (same trick as scripts/test-studio-posted-sync.mjs).
// ---------------------------------------------------------------------------
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'functions', 'api', 'posting-calendar.js'), 'utf8');
const mod = await import('data:text/javascript;charset=utf-8,' + encodeURIComponent(src));
const { parseSlotIndex, assignSlots, slotAvailability, monthOccupancy, slotCellValue } = mod;

let passed = 0;
const failures = [];
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; console.log('  ok   ' + name); }
  else { failures.push(name); console.log('  FAIL ' + name + '\n         expected ' + e + '\n         actual   ' + a); }
}

const SLOT_COL = 16;
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);
// Sheets hands back dates as serials with valueRenderOption=UNFORMATTED_VALUE.
function serial(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return (Date.UTC(y, m - 1, d) - EXCEL_EPOCH_MS) / 86400000;
}
// A sheet row: A ContentID … G ScheduleDate, H Status, Q Slot.
function row(contentId, dateStr, status, slotCell) {
  const r = new Array(17).fill('');
  r[0] = contentId;
  r[5] = 'Kapruka';
  r[6] = serial(dateStr);
  r[7] = status;
  if (slotCell !== undefined) r[SLOT_COL] = slotCell;
  return r;
}
const times = a => a.slots.map(s => (s.available ? '' : 'X') + s.time);

// ── 1. Reading column Q ────────────────────────────────────────────────────
console.log('\nparseSlotIndex — what counts as a stored slot');
check('the format we write',            parseSlotIndex('Slot 3 — 3:00 PM'), 2);
check('slot 1 is the 10am slot',        parseSlotIndex('Slot 1 — 10:00 AM'), 0);
check('slot 5 is the 9pm slot',         parseSlotIndex('Slot 5 — 9:00 PM'), 4);
check('a bare label typed by hand',     parseSlotIndex('6:00 PM'), 3);
check('label is case-insensitive',      parseSlotIndex('6:00 pm'), 3);
check('a bare 1-based number',          parseSlotIndex('3'), 2);
check('Sheets time serial for 3pm',     parseSlotIndex(0.625), 2);
check('Sheets time serial for 10am',    parseSlotIndex(10 / 24), 0);
check('blank means no stored slot',     parseSlotIndex(''), null);
check('null means no stored slot',      parseSlotIndex(null), null);
check('undefined (short row) is null',  parseSlotIndex(undefined), null);
check('out-of-range slot number',       parseSlotIndex('Slot 9 — 1:00 AM'), null);
check('nonsense is ignored',            parseSlotIndex('sometime tuesday'), null);
check('writes back what it reads',      parseSlotIndex(slotCellValue(2)), 2);

// ── 2. Legacy rows keep the old row-order inference ────────────────────────
// This is the no-regression guarantee for every row already in the sheet.
console.log('\nassignSlots — rows with no stored slot (pre-column-Q rows)');
check('1st row of the day → 10:00 AM',
  assignSlots([row('STU-1', '2026-10-01', 'Approved')]).map(e => e.slotIndex), [0]);
check('sheet order fills 10am,12pm,3pm',
  assignSlots(['STU-1', 'STU-2', 'STU-3'].map(id => row(id, '2026-10-01', 'Approved'))).map(e => e.slotIndex),
  [0, 1, 2]);
check('a 6th post stacks on the 9pm slot',
  assignSlots(['a', 'b', 'c', 'd', 'e', 'f'].map(id => row(id, '2026-10-01', 'Approved'))).map(e => e.slotIndex),
  [0, 1, 2, 3, 4, 4]);

console.log('\nassignSlots — stored slots are honoured');
check('a row that chose 6:00 PM keeps it',
  assignSlots([row('STU-1', '2026-10-01', 'Approved', 'Slot 4 — 6:00 PM')]).map(e => e.slotIndex), [3]);
check('a legacy row fills around a chosen one',
  assignSlots([
    row('STU-1', '2026-10-01', 'Approved', 'Slot 2 — 12:00 PM'),
    row('STU-2', '2026-10-01', 'Approved'),           // legacy → first free = 10am
  ]).map(e => e.slotIndex), [1, 0]);
check('two rows claiming one slot — first wins, second re-infers',
  assignSlots([
    row('STU-1', '2026-10-01', 'Approved', 'Slot 3 — 3:00 PM'),
    row('STU-2', '2026-10-01', 'Approved', 'Slot 3 — 3:00 PM'),
  ]).map(e => e.slotIndex), [2, 0]);

// ── 3. Availability, as the chips render it ────────────────────────────────
console.log('\nslotAvailability');
const oneTaken = [row('STU-1', '2026-10-01', 'Approved', 'Slot 1 — 10:00 AM')];
check('X marks the taken slot',   times(slotAvailability(oneTaken, '2026-10-01')), ['X10:00 AM', '12:00 PM', '3:00 PM', '6:00 PM', '9:00 PM']);
check('4 of 5 free',              slotAvailability(oneTaken, '2026-10-01').freeCount, 4);
check('default lands on 12:00 PM', slotAvailability(oneTaken, '2026-10-01').nextAvailableIndex, 1);
check('the taken chip names its holder', slotAvailability(oneTaken, '2026-10-01').slots[0].takenBy, 'STU-1');
check('a free chip has no holder', slotAvailability(oneTaken, '2026-10-01').slots[1].takenBy, null);
check('not stacking yet',         slotAvailability(oneTaken, '2026-10-01').stacking, false);

// A mid-day slot taken on its own — the case the old row-order code could not
// represent at all (it could only ever mark a prefix of the day as taken).
const midTaken = [row('STU-9', '2026-10-01', 'Approved', 'Slot 3 — 3:00 PM')];
check('only 3:00 PM is taken',    times(slotAvailability(midTaken, '2026-10-01')), ['10:00 AM', '12:00 PM', 'X3:00 PM', '6:00 PM', '9:00 PM']);
check('default is still 10:00 AM', slotAvailability(midTaken, '2026-10-01').nextAvailableIndex, 0);

console.log('\nslotAvailability — other dates and statuses are ignored');
check('another date does not occupy this one',
  slotAvailability([row('STU-1', '2026-10-02', 'Approved', 'Slot 1 — 10:00 AM')], '2026-10-01').freeCount, 5);
check('a Posted row still occupies',
  slotAvailability([row('STU-1', '2026-10-01', 'Posted 2026-10-01', 'Slot 1 — 10:00 AM')], '2026-10-01').freeCount, 4);
check('a non-approved row does not occupy',
  slotAvailability([row('STU-1', '2026-10-01', 'Pending', 'Slot 1 — 10:00 AM')], '2026-10-01').freeCount, 5);

console.log('\nslotAvailability — a full day');
const full = ['a', 'b', 'c', 'd', 'e'].map((id, i) => row(id, '2026-10-01', 'Approved', slotCellValue(i)));
check('nothing free',   slotAvailability(full, '2026-10-01').freeCount, 0);
check('stacking is on', slotAvailability(full, '2026-10-01').stacking, true);
check('stacks on 9pm',  slotAvailability(full, '2026-10-01').nextAvailableIndex, 4);

console.log('\nslotAvailability — excludeRowIndex (the reschedule path)');
const moving = [
  row('STU-1', '2026-10-01', 'Approved', 'Slot 2 — 12:00 PM'),
  row('STU-2', '2026-10-01', 'Approved', 'Slot 1 — 10:00 AM'),
];
check('without the exclusion 12:00 PM reads as taken',
  slotAvailability(moving, '2026-10-01').slots[1].available, false);
check("a post does not block itself when it stays on the day",
  slotAvailability(moving, '2026-10-01', 0).slots[1].available, true);

// ── 4. The month grid renders the chosen times ─────────────────────────────
console.log('\nmonthOccupancy');
const month = monthOccupancy([
  row('STU-1', '2026-10-01', 'Approved', 'Slot 4 — 6:00 PM'),
  row('STU-2', '2026-10-01', 'Approved'),               // legacy → 10:00 AM
  row('STU-3', '2026-10-05', 'Posted 2026-10-05'),      // legacy → 10:00 AM
  row('STU-4', '2026-11-01', 'Approved'),               // different month
], 2026, 10);
const oct1 = month.find(d => d.date === '2026-10-01');
check('only October days come back', month.map(d => d.date).sort(), ['2026-10-01', '2026-10-05']);
check('the chosen 6:00 PM shows as 6:00 PM', oct1.items.find(i => i.contentId === 'STU-1').time, '6:00 PM');
check('the legacy row still infers 10:00 AM', oct1.items.find(i => i.contentId === 'STU-2').time, '10:00 AM');
check('occupied counts rows, not slots', oct1.occupied, 2);
check('a Posted row is flagged posted', month.find(d => d.date === '2026-10-05').items[0].posted, true);

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
