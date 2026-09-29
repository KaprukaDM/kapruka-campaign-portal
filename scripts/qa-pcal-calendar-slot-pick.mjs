// scripts/qa-pcal-calendar-slot-pick.mjs
// ---------------------------------------------------------------------------
// Drives the admin dashboard's Posting Calendar tab to prove a FREE time slot
// can be clicked DIRECTLY IN THE CALENDAR GRID (not just in the Good-to-Go
// detail form), that a TAKEN slot there is inert, and that Save then books the
// slot that was clicked.
//
//   python -m http.server 8800            # from the repo root
//   node <skill>/browser.mjs http://127.0.0.1:8800/admin-dashboard.html#postingcal \
//        --script scripts/qa-pcal-calendar-slot-pick.mjs --screenshot out.png
//
// /api/posting-calendar needs live Google Sheets credentials, which no local
// run has, so it is stubbed with a fake day that already has 10:00 AM taken —
// the "4 of 5 slots free" case from the request. Everything under test (the
// grid strip's rendering, the click path, holding a slot with no post selected,
// the stale-slot refusal, the request body Save sends) is client-side, so the
// stub does not weaken what is verified. The server-side slot model is covered
// by scripts/test-posting-calendar-slots.mjs, and the detail-form chips by
// scripts/qa-pcal-slot-picker.mjs.
//
// Pass STALE=1 to make /?slotsFor= report 6:00 PM as ALSO taken — i.e. the slot
// the grid still shows as free was booked by someone else a moment ago. The
// pick must be refused BY NAME rather than silently sliding to another slot.
// ---------------------------------------------------------------------------
const SLOT_LABELS = ['10:00 AM', '12:00 PM', '3:00 PM', '6:00 PM', '9:00 PM'];
// The grid opens on the CURRENT month, so the stubbed day has to live there or
// the cell the script clicks has no occupancy and the "taken" case never renders.
const NOW = new Date();
const TEST_DATE = `${NOW.getFullYear()}-${String(NOW.getMonth() + 1).padStart(2, '0')}-15`;
const SIX_PM = 3; // index of the slot this script clicks in the grid

// NOTE: the driver is patchright, which runs page.evaluate() in an ISOLATED
// world — page globals are not reachable from here. Everything below drives the
// real UI (clicks, keypresses) and only reads the DOM from evaluate().
export default async function run(page) {
  const stale = process.env.STALE === '1';
  const savedBodies = [];

  await page.route('**/ivllhheqqiseagmctfyp.supabase.co/**', r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));

  const availability = takenIdx => ({
    occupiedCount: takenIdx.length,
    freeCount: SLOT_LABELS.length - takenIdx.length,
    nextAvailableIndex: SLOT_LABELS.findIndex((_, i) => !takenIdx.includes(i)),
    slots: SLOT_LABELS.map((time, i) => ({
      index: i, time,
      available: !takenIdx.includes(i),
      takenBy: takenIdx.includes(i) ? (i === SIX_PM ? 'STU-9999' : 'STU-1111') : null,
    })),
    stacking: takenIdx.length >= SLOT_LABELS.length,
  });

  await page.route('**/api/posting-calendar**', async route => {
    const req = route.request();
    const url = new URL(req.url());
    const json = body => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

    if (req.method() === 'POST') {
      const body = JSON.parse(req.postData() || '{}');
      savedBodies.push(body);
      return json({ ok: true, date: body.date, slot: SLOT_LABELS[body.slotIndex], slotIndex: body.slotIndex, stacked: false, studioSynced: true });
    }
    if (url.searchParams.get('slotsFor')) {
      // The month payload says only 10:00 AM is taken; under STALE the
      // authoritative per-date read disagrees — 6:00 PM went in the meantime.
      return json(availability(stale ? [0, SIX_PM] : [0]));
    }
    if (url.searchParams.get('month')) {
      // The grid renders from this: 10:00 AM taken, the other four free.
      return json({
        days: [{
          date: TEST_DATE, occupied: 1,
          items: [{ contentId: 'STU-1111', page: 'Kapruka', posted: false, slotIndex: 0, time: '10:00 AM', primaryText: 'Existing post', mediaUrl: '', mediaType: 'Image' }],
        }],
        slotsPerDay: 5,
        slotLabels: SLOT_LABELS,
        metaScheduled: [], metaConfigured: false,
      });
    }
    return json({ posts: [{ contentId: 'STU-2345', studioId: 2345, contentType: 'Image', page: 'Kapruka', primaryText: 'Fresh cut flowers, delivered island-wide the same day.', mediaUrl: '', isFolder: false, productCode: '' }] });
  });

  await page.evaluate(() => {
    sessionStorage.setItem('adminLoggedIn', 'true');
    sessionStorage.setItem('adminRole', 'admin');
  });
  await page.reload({ waitUntil: 'domcontentloaded' });

  await page.waitForSelector('#adminContent', { state: 'visible', timeout: 20000 });
  await page.getByRole('button', { name: /Posting Calendar/i }).click();
  await page.waitForSelector('#pcalCalGrid .pcal-cal-day', { timeout: 20000 });

  const readGridChips = () => page.evaluate(() =>
    Array.from(document.querySelectorAll('#pcalCalDayDetail .pcal-slot')).map(el => ({
      time: el.textContent.trim(),
      taken: el.classList.contains('taken'),
      selected: el.classList.contains('next'),
      ariaChecked: el.getAttribute('aria-checked'),
      ariaDisabled: el.getAttribute('aria-disabled'),
      tabindex: el.getAttribute('tabindex'),
      lineThrough: getComputedStyle(el).textDecorationLine,
      cursor: getComputedStyle(el).cursor,
      title: el.getAttribute('title'),
    })));
  const readGridHint = () => page.evaluate(() =>
    document.querySelector('#pcalCalDayDetail .pcal-hint')?.textContent.trim() ?? null);
  const readFormHint = () => page.evaluate(() =>
    document.querySelector('#pcalSlotInfo .pcal-hint')?.textContent.trim() ?? null);

  const result = { stale };

  // ── 1. No post selected yet: clicking the day must still show the strip ──
  const dayCell = `#pcalCalGrid .pcal-cal-day:not(.blank) >> nth=14`; // the 15th
  await page.locator('#pcalCalGrid .pcal-cal-day:not(.blank)').nth(14).click();
  await page.waitForSelector('#pcalCalDayDetail .pcal-slot', { timeout: 10000 });
  result.stripWithNoPostSelected = {
    chips: await readGridChips(),
    hint: await readGridHint(),
  };

  // ── 2. A TAKEN slot in the grid is inert ────────────────────────────────
  await page.click('#pcalCalDayDetail .pcal-slot[data-cal-slot="0"]', { force: true });
  await page.waitForTimeout(200);
  result.afterClickingTakenGridSlot = {
    hint: await readGridHint(),
    anySelected: (await readGridChips()).some(c => c.selected),
  };

  // ── 3. Click FREE 6:00 PM with no post in hand — it should be HELD ──────
  await page.click('#pcalCalDayDetail .pcal-slot[data-cal-slot="3"]');
  await page.waitForTimeout(300);
  result.afterHolding6pm = {
    chips: await readGridChips(),
    hint: await readGridHint(),
  };
  await shoot(page, process.env.QA_SHOT_HELD || 'pcal-cal-slot-held.png');

  // ── 4. Now pick a Good to Go post — the held date+slot must apply ───────
  await page.waitForSelector('#pcalList .pcal-post', { timeout: 20000 });
  await page.click('#pcalList .pcal-post');
  await page.waitForSelector('#pcalDateInput', { timeout: 10000 });
  await page.waitForTimeout(900); // let loadPcalSlots() resolve
  result.afterSelectingPost = {
    dateInput: await page.evaluate(() => document.getElementById('pcalDateInput')?.value ?? null),
    formHint: await readFormHint(),
    formChips: await page.evaluate(() =>
      Array.from(document.querySelectorAll('#pcalSlotInfo .pcal-slot'))
        .map(el => ({ time: el.textContent.trim(), selected: el.classList.contains('next'), taken: el.classList.contains('taken') }))),
    gridChips: await readGridChips(),
    gridHint: await readGridHint(),
    formNotice: await page.evaluate(() =>
      document.querySelector('#pcalSlotInfo .pcal-msg.err')?.textContent.trim() ?? null),
  };

  await shoot(page, process.env.QA_SHOT_APPLIED || 'pcal-cal-slot-applied.png');

  // ── 5. Save — the body must carry the slot clicked in the GRID ──────────
  if (!stale) {
    await page.click('#pcalSaveBtn');
    await page.waitForTimeout(1200);
    result.savedBody = savedBodies[savedBodies.length - 1] || null;
    result.savedSlotLabel = result.savedBody ? SLOT_LABELS[result.savedBody.slotIndex] : null;
  }

  return result;
}

async function shoot(page, path) {
  await page.locator('#pcalCalDayDetail').scrollIntoViewIfNeeded();
  await page.waitForTimeout(250);
  await page.screenshot({ path });
}
