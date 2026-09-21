// Checks what a "Posted" row is actually labelled as in the admin Studio
// tab, across a pre-evidence month (March 2026, nothing could ever prove it)
// and a month the posting sheet can still confirm (August/September 2026).
//
//   QA_ADMIN_PASSWORD=... QA_SHOT_DIR=<dir> node <skill>/browser.mjs \
//        http://127.0.0.1:8800/admin-dashboard.html \
//        --script scripts/qa-posted-badges.mjs
//
// Writes one close-up PNG per month into QA_SHOT_DIR (the whole-page shot is
// unreadable — the grid is ~15000px tall). The password comes from the
// environment on purpose: it must never be committed.
export default async function run(page) {
  const adminPassword = process.env.QA_ADMIN_PASSWORD;
  if (!adminPassword) throw new Error('Set QA_ADMIN_PASSWORD to run this QA script.');
  const shotDir = process.env.QA_SHOT_DIR;

  await page.setViewportSize({ width: 1500, height: 1000 });
  await page.fill('#adminPassword', adminPassword);
  await page.click('#loginForm button[type=submit]');
  await page.waitForSelector('#studioCalendarGrid', { timeout: 30000 });
  await page.waitForFunction(
    () => document.querySelectorAll('#monthSelector option').length > 0,
    { timeout: 30000 }
  );

  const tally = async () => page.evaluate(() => {
    const pills = [...document.querySelectorAll('#studioCalendarGrid .slot-status')];
    const out = { posted: 0, pending: 0, pendingTitles: [] };
    pills.forEach(p => {
      const t = p.textContent.trim();
      if (t.includes('Pending verification')) { out.pending++; out.pendingTitles.push(p.title.slice(0, 50)); }
      else if (t.includes('Posted')) { out.posted++; }
    });
    // Prove the two green pills are distinguishable by tooltip.
    const greens = [...document.querySelectorAll('#studioCalendarGrid .status-posted')];
    out.tooltipSample = [...new Set(greens.map(g => g.title.slice(0, 60)))];
    return out;
  });

  const result = {};
  for (const m of ['March 2026', 'August 2026', 'September 2026']) {
    await page.selectOption('#monthSelector', m);
    await page.waitForTimeout(7000);
    await page.waitForFunction(
      () => document.querySelectorAll('#studioCalendarGrid .slot-status').length > 0,
      { timeout: 30000 }
    );
    await page.waitForTimeout(2000);
    result[m] = await tally();

    if (shotDir) {
      // Scroll the first row of day cells into view and clip to it, so the
      // badge text is actually legible in the PNG.
      await page.evaluate(() => {
        const cell = document.querySelector('#studioCalendarGrid .calendar-day, #studioCalendarGrid > div');
        if (cell) cell.scrollIntoView({ block: 'start' });
        window.scrollBy(0, -120);
      });
      await page.waitForTimeout(800);
      const file = `${shotDir}/studio-${m.split(' ')[0].toLowerCase()}.png`;
      await page.screenshot({ path: file });
      result[m].screenshot = file;
    }
  }
  return result;
}
