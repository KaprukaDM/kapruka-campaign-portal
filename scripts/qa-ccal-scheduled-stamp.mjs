// scripts/qa-ccal-scheduled-stamp.mjs
// ---------------------------------------------------------------------------
// Proves the Content Calendar's "Scheduled Date" field shows the SAME combined
// stamp that the Posting Calendar wrote into the sheet — one value, one source
// of truth, no second disagreeing time.
//
//   node scripts/fake-sheet-server.mjs 8899 &
//   node <skill>/browser.mjs .../posting-calendar.html --script scripts/qa-pcal-combined-stamp.mjs
//   node <skill>/browser.mjs http://127.0.0.1:8899/content-calendar.html \
//        --script scripts/qa-ccal-scheduled-stamp.mjs --screenshot out.png
//
// The posting QA above has to run first: it is what puts STU-2307 in the fake
// sheet, and THIS script deliberately does not stub /api/posting-calendar, so
// the stamp it displays is genuinely read back out of that sheet row by the
// real handler. Supabase is stubbed (one booking whose studio_slot_id is 2307,
// the record the sheet row belongs to) because the booking side is not what is
// under test here.
// ---------------------------------------------------------------------------
const BOOKING_DATE = process.env.QA_DATE || '2026-07-02';
const STUDIO_ID = Number(process.env.QA_STUDIO_ID ?? 2307);
const EXPECTED = process.env.QA_EXPECTED || '02/07/2026 21:00:00';
const [YEAR, MONTH] = BOOKING_DATE.split('-').map(Number);

export default async function run(page) {
  const booking = {
    id: 901, date: BOOKING_DATE, slot_number: 1, category: 'Gifts & Hampers',
    product_code: 'KAP-1234', product_link: '', status: 'Approved',
    submitted_by: 'Gayathri', theme: 'Daily Post', page_name: 'Kapruka',
    booking_note: '', studio_status: 'Scheduled', created_at: '2026-06-28T09:12:00Z',
  };

  await page.route('**/ivllhheqqiseagmctfyp.supabase.co/rest/v1/**', route => {
    const url = decodeURIComponent(route.request().url());
    const json = body => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.includes('/theme_config')) {
      return json([{ id: 1, theme_name: 'Daily Post', start_date: `${YEAR}-${String(MONTH).padStart(2, '0')}-01`, end_date: `${YEAR}-${String(MONTH).padStart(2, '0')}-28` }]);
    }
    if (url.includes('/category_slots')) {
      return json([{ id: 11, date: BOOKING_DATE, slot_number: 1, category: 'Gifts & Hampers', month_year: `${YEAR}-${String(MONTH).padStart(2, '0')}` }]);
    }
    if (url.includes('/content_calendar_with_status')) return json([booking]);
    if (url.includes('/studio_calendar')) {
      return json([{ id: STUDIO_ID, date: BOOKING_DATE, source_id: booking.id,
        dm_rejection_reason: null, head_rejection_reason: null, hold_reason: null }]);
    }
    return json([]); // activity log etc.
  });

  // The first load already happened before these routes existed, so reload to
  // make the page fetch its data through them.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#calendarGrid .day-cell', { timeout: 20000 });

  // Walk the real month nav back to the booking's month.
  const monthName = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'][MONTH - 1];
  const target = `${monthName} ${YEAR}`;
  for (let i = 0; i < 24; i++) {
    const shown = (await page.textContent('#monthDisplay')).trim();
    if (shown === target) break;
    const shownYear = Number(shown.split(' ').pop());
    const shownMonth = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
      'August', 'September', 'October', 'November', 'December'].indexOf(shown.split(' ')[0]) + 1;
    const goBack = shownYear > YEAR || (shownYear === YEAR && shownMonth > MONTH);
    await page.click(`.month-selector button:nth-of-type(${goBack ? 1 : 2})`);
    await page.waitForTimeout(500);
  }
  const result = { month: (await page.textContent('#monthDisplay')).trim() };

  // Open the day, then the booked slot card → the detail popup.
  // Clicking the day can land either on the day's booking card (which opens
  // the details popup directly) or on the cell itself (which opens the day's
  // slot list first) — handle both rather than assuming one.
  await page.click(`.day-cell:not(.other-month):has-text("${Number(BOOKING_DATE.slice(8))}")`, { timeout: 10000 });
  await page.waitForSelector('#modal', { state: 'visible', timeout: 10000 });
  const slotCard = await page.$('#modalContent .slot-card.booked');
  if (slotCard) await slotCard.click();
  await page.waitForFunction(
    () => Array.from(document.querySelectorAll('#modalContent div')).some(d => d.textContent.trim() === 'Scheduled Date'),
    null, { timeout: 10000 });

  const field = await page.evaluate(() => {
    const labels = Array.from(document.querySelectorAll('#modalContent div'))
      .filter(d => d.textContent.trim() === 'Scheduled Date');
    const label = labels[0];
    if (!label) return null;
    const box = label.parentElement;
    return { value: box.children[1]?.textContent.trim(), note: box.children[2]?.textContent.trim() };
  });

  result.scheduledDateField = field;
  result.assertions = {
    'the popup shows the sheet stamp': !!field && field.value.includes(EXPECTED),
    'it says where the value comes from': !!field && /posting sheet/i.test(field.note || ''),
  };
  result.allPassed = Object.values(result.assertions).every(Boolean);
  return result;
}
