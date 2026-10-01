// scripts/qa-pcal-combined-stamp.mjs
// ---------------------------------------------------------------------------
// Drives the real Posting Calendar UI against the real /api/posting-calendar
// handler (served by scripts/fake-sheet-server.mjs, whose only fake part is
// Google itself) and proves that picking a date + a time-slot chip and hitting
// Save schedule puts ONE combined "DD/MM/YYYY HH:mm:ss" value in the sheet's
// Schedule Date cell.
//
//   node scripts/fake-sheet-server.mjs 8899 &
//   node <skill>/browser.mjs http://127.0.0.1:8899/posting-calendar.html \
//        --script scripts/qa-pcal-combined-stamp.mjs --screenshot out.png
//
// Unlike the other qa-pcal-* scripts, nothing here is stubbed in the browser —
// the POST really reaches the handler and really lands in the fake sheet, which
// the script then reads back from /__sheet.json and asserts against.
//
// QA_PAGE=admin runs the SAME checks against the admin dashboard's Posting
// Calendar tab (point browser.mjs at admin-dashboard.html#postingcal instead),
// because that tab is a second copy of this screen with its own ids — both
// copies have to write the same stamp and both have to keep the confirmation
// visible after the panel resets.
// ---------------------------------------------------------------------------
const DATE = process.env.QA_DATE || '2026-07-02';
const SLOT = Number(process.env.QA_SLOT ?? 4);        // 4 = the 9:00 PM chip
const EXPECTED = process.env.QA_EXPECTED || '02/07/2026 21:00:00';

// The two copies of the screen, element for element.
const PAGES = {
  standalone: {
    unlock: async page => { await page.evaluate(() => sessionStorage.setItem('pcalAuth', 'true')); },
    list: '#postList .post-card', panel: '#rightPanel', heading: '#rightPanel h2',
    date: '#dateInput', slots: '#slotInfo .slot', hint: '#slotInfo .hint',
    save: '#saveBtn', msg: '.msg',
  },
  admin: {
    unlock: async page => {
      await page.evaluate(() => {
        sessionStorage.setItem('adminLoggedIn', 'true');
        sessionStorage.setItem('adminRole', 'admin');
      });
    },
    // The admin page only builds this tab once it is opened.
    open: async page => {
      await page.waitForSelector('#adminContent', { state: 'visible', timeout: 20000 });
      await page.getByRole('button', { name: /Posting Calendar/i }).click();
    },
    list: '#pcalList .pcal-post', panel: '#pcalRightPanel', heading: '#pcalRightPanel h2',
    date: '#pcalDateInput', slots: '#pcalSlotInfo .pcal-slot', hint: '#pcalSlotInfo .pcal-hint',
    save: '#pcalSaveBtn', msg: '.pcal-msg',
  },
};

export default async function run(page) {
  const ui = PAGES[process.env.QA_PAGE || 'standalone'];
  const result = { page: process.env.QA_PAGE || 'standalone', date: DATE, slotIndex: SLOT };

  // Login/password gate (client-side only) — same trick the other qa scripts use.
  await ui.unlock(page);
  await page.reload({ waitUntil: 'domcontentloaded' });
  if (ui.open) await ui.open(page);
  await page.waitForSelector(ui.list, { timeout: 20000 });

  // Pick the Good-to-Go job, the date, then the slot chip.
  await page.click(ui.list);
  await page.waitForSelector(ui.date);
  result.job = (await page.textContent(ui.heading)).trim();
  await page.fill(ui.date, DATE);
  await page.waitForSelector(ui.slots, { timeout: 15000 });
  await page.click(`${ui.slots}[data-slot="${SLOT}"]`);
  result.hintBeforeSave = (await page.textContent(ui.hint).catch(() => '')).trim();
  // Optional shot of the form as it stands just before Save — date filled, the
  // chosen chip highlighted — since the panel is replaced on success.
  if (process.env.QA_SHOT_FORM) {
    await page.locator(ui.panel).screenshot({ path: process.env.QA_SHOT_FORM });
  }

  // The confirmation survives the panel reset (it is re-rendered with the
  // placeholder), so this waits on the VISIBLE message, not a detached one.
  await page.click(ui.save);
  await page.waitForSelector(`${ui.panel} ${ui.msg}.ok, ${ui.panel} ${ui.msg}.err`, { state: 'visible', timeout: 20000 });
  result.saveMessage = (await page.textContent(`${ui.panel} ${ui.msg}`)).trim();
  result.saveOk = !!(await page.$(`${ui.panel} ${ui.msg}.ok`));

  // What actually landed in the sheet, read back out of the server.
  const sheet = await page.evaluate(async () => {
    const res = await fetch('/__sheet.json');
    return res.json();
  });
  const last = sheet.rows.length - 1;
  result.sheetRow = {
    contentId: sheet.rows[last][0],
    page: sheet.rows[last][5],
    scheduleDateValue: sheet.rows[last][6],
    scheduleDateFormat: sheet.formats[last],
    scheduleDateDisplayed: sheet.displayed[last],
    status: sheet.rows[last][7],
    slot: sheet.rows[last][16],
  };

  result.assertions = {
    'the cell reads DD/MM/YYYY HH:mm:ss': result.sheetRow.scheduleDateDisplayed === EXPECTED,
    'the cell holds a real datetime value, not text': typeof result.sheetRow.scheduleDateValue === 'number',
    'the 9pm slot did not roll onto the next day': result.sheetRow.scheduleDateDisplayed.startsWith(EXPECTED.slice(0, 10)),
    // Pre-existing bug this run also fixed: the panel reset used to wipe the
    // confirmation, so it has to be asserted VISIBLE, not merely produced.
    'the confirmation quotes the same stamp': result.saveMessage.includes(EXPECTED),
    'the confirmation is still on screen after the reset':
      await page.isVisible(`${ui.panel} ${ui.msg}.ok`),
    'it saved': result.saveOk === true,
  };
  result.allPassed = Object.values(result.assertions).every(Boolean);
  return result;
}
