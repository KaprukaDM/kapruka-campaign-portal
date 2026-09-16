// scripts/test-studio-posted-sync.mjs
// ---------------------------------------------------------------------------
// Tests the Posted reconciler's decision table and the post-evidence
// validator WITHOUT needing Google credentials.
//
//   node scripts/test-studio-posted-sync.mjs
//
// The reconciler's only real judgement calls are (a) which sheet strings mean
// "published", (b) what to do about each shape of disagreement, and (c) what
// counts as proof a post is live. All three are pure functions, so they are
// tested here directly against the real source file. The I/O around them
// (Google auth, Sheets read, Supabase PATCH) needs a live credential and is
// NOT covered here — see the README note in the reconciler's header.
//
// functions/*.js are ES modules for Cloudflare, but this repo has no root
// package.json declaring "type":"module", so Node would otherwise read the
// file as CommonJS and choke on `export`. Loading the real source through a
// data: URL sidesteps that without adding a build step or a fake package.json.
// ---------------------------------------------------------------------------
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'functions', 'api', 'studio-posted-sync.js'), 'utf8');
const mod = await import('data:text/javascript;charset=utf-8,' + encodeURIComponent(src));
const { classifyRows, sheetStatusToStudioStatus, isValidEvidence } = mod;

let passed = 0;
const failures = [];
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; console.log('  ok   ' + name); }
  else { failures.push(name); console.log('  FAIL ' + name + '\n         expected ' + e + '\n         actual   ' + a); }
}

// ── 1. Sheet vocabulary → studio vocabulary ────────────────────────────────
// The two stores genuinely use different strings; this is the whole mapping.
console.log('\nsheet status → studio status');
check('"Posted" means published',              sheetStatusToStudioStatus('Posted'), 'Posted');
check('"Posted 2026-03-04" means published',   sheetStatusToStudioStatus('Posted 2026-03-04'), 'Posted');
check('"Posted (FB+IG)" means published',      sheetStatusToStudioStatus('Posted (FB+IG)'), 'Posted');
check('whitespace is trimmed',                 sheetStatusToStudioStatus('  Posted  '), 'Posted');
check('"Approved" means QUEUED, not posted',   sheetStatusToStudioStatus('Approved'), 'Scheduled');
check('empty means no opinion',                sheetStatusToStudioStatus(''), null);
check('unknown string means no opinion',       sheetStatusToStudioStatus('Needs rework'), null);
check('null means no opinion',                 sheetStatusToStudioStatus(null), null);
// Guards the exact bug being fixed: nothing may infer "posted" from a word
// that merely contains "post".
check('"Repost pending" is NOT published',     sheetStatusToStudioStatus('Repost pending'), null);

// ── 2. What counts as proof a post went live ───────────────────────────────
console.log('\npost evidence validation');
check('fb page permalink',      isValidEvidence('https://www.facebook.com/kapruka/posts/1234567890'), true);
check('fb numeric-id permalink',isValidEvidence('https://www.facebook.com/1335119825321833/posts/1579113710922442'), true);
check('fb reel',                isValidEvidence('https://www.facebook.com/reel/1234567890'), true);
check('fb video',               isValidEvidence('https://www.facebook.com/kapruka/videos/998877'), true);
check('permalink.php',          isValidEvidence('https://www.facebook.com/permalink.php?story_fbid=123456&id=789'), true);
check('fb.watch short link',    isValidEvidence('https://fb.watch/aB3dE5/'), true);
check('instagram post',         isValidEvidence('https://www.instagram.com/p/CxYz12AbCdE/'), true);
check('graph post id',          isValidEvidence('1335119825321833_1579113710922442'), true);
// The rejections matter more than the acceptances — these are the things
// people actually pasted (or would paste) that prove nothing.
check('empty rejected',         isValidEvidence(''), false);
check('null rejected',          isValidEvidence(null), false);
check('free text rejected',     isValidEvidence('posted on FB'), false);
check('page link rejected',     isValidEvidence('https://www.facebook.com/kapruka'), false);
check('drive link rejected',    isValidEvidence('https://drive.google.com/file/d/1a2b3c/view'), false);
check('bare domain rejected',   isValidEvidence('facebook.com'), false);
check('"yes" rejected',         isValidEvidence('yes'), false);
check('short number rejected',  isValidEvidence('12345'), false);

// ── 3. The disagreement decision table ─────────────────────────────────────
// One row of each shape that exists in the real data.
console.log('\nreconciliation decision table');
const row = (id, studio_status) => ({ id, studio_status, date: '2026-03-04', page_name: 'Kapruka', content_details: 'x' });
const sheet = (id, sheetStatus) => [id, {
  contentId: 'STU-' + id, sheetStatus, mapped: sheetStatusToStudioStatus(sheetStatus)
}];

const byId = new Map([
  [1, row(1, 'Scheduled')],  // bot posted it, portal never noticed   → PROMOTE
  [2, row(2, 'Posted')],     // both agree, but no proof on file      → BACKFILL
  [3, row(3, 'Posted')],     // portal claims posted, sheet says queued → STALE
  [4, row(4, 'Posted')],     // portal claims posted, no sheet row     → ORPHAN
  [5, row(5, 'Posted')],     // both agree and proof already on file   → IN SYNC
  [6, row(6, 'Received')],   // sheet queued it, portal still working  → ignored
]);
const sheetMap = new Map([
  sheet(1, 'Posted'),
  sheet(2, 'Posted'),
  sheet(3, 'Approved'),
  sheet(5, 'Posted'),
  sheet(6, 'Approved'),
]);
const verified = new Set([5]);
const r = classifyRows(byId, sheetMap, verified);
const ids = list => list.map(i => i.id);

check('PROMOTE: sheet posted, portal did not know', ids(r.promoted), [1]);
check('BACKFILL: agreed but unproven',              ids(r.backfilled), [2]);
check('STALE: claims posted, sheet still queued',   ids(r.stale), [3]);
check('ORPHAN: claims posted, no sheet row',        ids(r.orphan), [4]);
check('IN SYNC: agreed and proven',                 ids(r.alreadyInSync), [5]);
check('a non-posted row with a queued sheet row is left alone',
  [...r.promoted, ...r.backfilled, ...r.stale, ...r.orphan, ...r.alreadyInSync].some(i => i.id === 6), false);

// The safety property the user specifically asked for: nothing that merely
// CLAIMS Posted gets rewritten. Only promote/backfill are ever applied, and
// neither of them ever downgrades a status.
check('stale + orphan are report-only (never in the applied sets)',
  [...r.promoted, ...r.backfilled].some(i => i.id === 3 || i.id === 4), false);
check('the sheet status is carried into the report so a human can judge it',
  r.stale[0].sheetStatus, 'Approved');

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.error('FAILED: ' + failures.join(', ')); process.exit(1); }
