// scripts/qa-pcal-slot-picker.mjs
// ---------------------------------------------------------------------------
// Drives the admin dashboard's Posting Calendar tab to prove the time-slot
// chips are really selectable and that Save sends the chosen slot.
//
//   python -m http.server 8800            # from the repo root
//   node <skill>/browser.mjs http://127.0.0.1:8800/admin-dashboard.html#postingcal \
//        --script scripts/qa-pcal-slot-picker.mjs --screenshot out.png
//
// /api/posting-calendar needs live Google Sheets credentials, which no local
// run has, so the API is stubbed here with a fake day that already has 10:00 AM
// taken — the exact "4 of 5 slots free" case from the bug report. Everything
// under test (chip rendering, selection, the keyboard path, the request body
// Save actually sends, the 409 race guard) is client-side, so the stub does
// not weaken what is being verified. The server side is covered separately by
// scripts/test-posting-calendar-slots.mjs.
//
// Pass FORCE_CONFLICT=1 to make the stubbed POST answer with the slot-taken
// 409 instead of succeeding, to exercise the race guard.
// ---------------------------------------------------------------------------
const SLOT_LABELS = ['10:00 AM', '12:00 PM', '3:00 PM', '6:00 PM', '9:00 PM'];
const TEST_DATE = '2026-10-15';

// NOTE: the driver is patchright, which runs page.evaluate() in an ISOLATED
// world — page globals like switchTab()/savePcalSchedule() are not reachable
// from here. Everything below therefore drives the real UI (clicks, typing,
// keypresses) and only reads the DOM from evaluate(), which is shared.
export default async function run(page) {
  const forceConflict = process.env.FORCE_CONFLICT === '1';
  const savedBodies = [];

  // Supabase calls from the other tabs — answer empty so they don't add noise.
  await page.route('**/ivllhheqqiseagmctfyp.supabase.co/**', r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));

  // 10:00 AM taken by STU-1111; the other four free.
  const availability = (takenIdx = [0]) => ({
    occupiedCount: takenIdx.length,
    freeCount: SLOT_LABELS.length - takenIdx.length,
    nextAvailableIndex: SLOT_LABELS.findIndex((_, i) => !takenIdx.includes(i)),
    slots: SLOT_LABELS.map((time, i) => ({
      index: i, time,
      available: !takenIdx.includes(i),
      takenBy: takenIdx.includes(i) ? 'STU-1111' : null,
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
      if (forceConflict) {
        return route.fulfill({
          status: 409, contentType: 'application/json',
          body: JSON.stringify({
            error: `The ${SLOT_LABELS[body.slotIndex]} slot on ${body.date} was taken by STU-9999 while you were editing. Pick another slot.`,
            slotConflict: true,
          }),
        });
      }
      // Echo back the slot the client asked for — the real API writes it to
      // sheet column Q and returns the same label.
      return json({ ok: true, date: body.date, slot: SLOT_LABELS[body.slotIndex], slotIndex: body.slotIndex, stacked: false, studioSynced: true });
    }
    if (url.searchParams.get('slotsFor')) {
      // After a conflict the day comes back with 3:00 PM taken too.
      const taken = savedBodies.length && forceConflict ? [0, 2] : [0];
      return json(availability(taken));
    }
    if (url.searchParams.get('month')) {
      return json({ days: [{ date: TEST_DATE, occupied: 1, items: [{ contentId: 'STU-1111', page: 'Kapruka', posted: false, slotIndex: 0, time: '10:00 AM', primaryText: 'Existing post', mediaUrl: '', mediaType: 'Image' }] }], slotsPerDay: 5, metaScheduled: [], metaConfigured: false });
    }
    return json({ posts: [{ contentId: 'STU-2345', studioId: 2345, contentType: 'Image', page: 'Kapruka', primaryText: 'Fresh cut flowers, delivered island-wide the same day.', mediaUrl: '', isFolder: false, productCode: '' }] });
  });

  // The login gate is sessionStorage-based, so no real credential is needed —
  // storage is shared with the isolated world even though globals are not.
  await page.evaluate(() => {
    sessionStorage.setItem('adminLoggedIn', 'true');
    sessionStorage.setItem('adminRole', 'admin');
  });
  await page.reload({ waitUntil: 'domcontentloaded' });

  // #postingcal in the hash makes the page open this tab itself; click the
  // tab button too in case that timing path changes.
  await page.waitForSelector('#adminContent', { state: 'visible', timeout: 20000 });
  await page.getByRole('button', { name: /Posting Calendar/i }).click();
  await page.waitForSelector('#pcalList .pcal-post', { timeout: 20000 });

  // Open #STU-2345 and pick the date. fill() fires the real change event the
  // date input listens on, which is what triggers the availability fetch.
  await page.click('#pcalList .pcal-post');
  await page.waitForSelector('#pcalDateInput');
  await page.fill('#pcalDateInput', TEST_DATE);
  await page.waitForSelector('#pcalSlotInfo .pcal-slot', { timeout: 15000 });

  const readChips = () => page.evaluate(() =>
    Array.from(document.querySelectorAll('#pcalSlotInfo .pcal-slot')).map(el => ({
      time: el.textContent.trim(),
      taken: el.classList.contains('taken'),
      selected: el.classList.contains('next'),
      ariaChecked: el.getAttribute('aria-checked'),
      ariaDisabled: el.getAttribute('aria-disabled'),
      tabindex: el.getAttribute('tabindex'),
      title: el.getAttribute('title'),
      cursor: getComputedStyle(el).cursor,
    })));
  const readHint = () => page.evaluate(() => document.querySelector('#pcalSlotInfo .pcal-hint').textContent.trim());

  const result = { forceConflict };
  result.defaultChips = await readChips();
  result.defaultHint = await readHint();

  await shootPanel(page, process.env.QA_SHOT_BEFORE || 'pcal-slots-default.png');

  // 1. A taken chip must be inert. force:true because Playwright's own
  // actionability check already refuses to click it (aria-disabled) — we want
  // to prove the click handler ignores it even when the click does land.
  await page.click('#pcalSlotInfo .pcal-slot[data-slot="0"]', { force: true });
  await page.waitForTimeout(150);
  result.afterClickingTakenChip = await readHint();

  // 2. Click 3:00 PM.
  await page.click('#pcalSlotInfo .pcal-slot[data-slot="2"]');
  result.afterClicking3pm = { chips: await readChips(), hint: await readHint() };

  await shootPanel(page, process.env.QA_SHOT_AFTER || 'pcal-slots-3pm.png');

  // 3. Keyboard: focus 6:00 PM and press Enter, then go back to 3:00 PM with Space.
  await page.focus('#pcalSlotInfo .pcal-slot[data-slot="3"]');
  await page.keyboard.press('Enter');
  result.afterKeyboardEnter = await readHint();
  result.focusStaysOnChip = await page.evaluate(() => document.activeElement?.dataset?.slot ?? null);
  await page.focus('#pcalSlotInfo .pcal-slot[data-slot="2"]');
  await page.keyboard.press(' ');
  result.afterKeyboardSpace = await readHint();

  // 4. Mobile width — chips must still wrap and stay tappable.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  result.mobile = await page.evaluate(() => {
    const chips = Array.from(document.querySelectorAll('#pcalSlotInfo .pcal-slot'));
    const box = document.querySelector('#pcalSlotInfo .pcal-slots').getBoundingClientRect();
    return {
      chipCount: chips.length,
      allInsideContainer: chips.every(c => c.getBoundingClientRect().right <= box.right + 1),
      minHeight: Math.min(...chips.map(c => Math.round(c.getBoundingClientRect().height))),
      rows: new Set(chips.map(c => Math.round(c.getBoundingClientRect().top))).size,
    };
  });
  await shootPanel(page, process.env.QA_SHOT_MOBILE || 'pcal-slots-mobile.png');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.waitForTimeout(300);

  // 5. Save — the request body must carry the chosen slot, not the auto-pick.
  await page.click('#pcalSaveBtn');
  await page.waitForTimeout(1200);
  result.savedBody = savedBodies[savedBodies.length - 1] || null;

  if (forceConflict) {
    result.conflictMessage = await page.evaluate(() => document.querySelector('#pcalMsg')?.textContent.trim() || null);
    result.chipsAfterConflict = await readChips();
    result.hintAfterConflict = await readHint();
    await shootPanel(page, process.env.QA_SHOT_CONFLICT || 'pcal-slots-conflict.png');
  }

  result.consoleOk = true;
  return result;
}

// The dashboard is thousands of pixels tall, so a full-page shot is
// unreadable — shoot just the scheduling panel (Playwright scrolls it in).
async function shootPanel(page, path) {
  await page.locator('#pcalRightPanel').scrollIntoViewIfNeeded();
  await page.waitForTimeout(250);
  await page.locator('#pcalRightPanel').screenshot({ path });
}
