// Drives the admin Studio tab far enough to see what a "Posted" row is
// actually labelled as. Used with the browser-automation skill:
//   QA_ADMIN_PASSWORD=... node <skill>/browser.mjs \
//        http://127.0.0.1:8800/admin-dashboard.html \
//        --script scripts/qa-studio-tab.mjs --screenshot out.png
//
// The password comes from the environment on purpose — it is a real admin
// credential and must never be committed to this repo.
export default async function run(page) {
  const adminPassword = process.env.QA_ADMIN_PASSWORD;
  if (!adminPassword) throw new Error('Set QA_ADMIN_PASSWORD to run this QA script.');

  // Superadmin goes straight to the Studio tab.
  await page.fill('#adminPassword', adminPassword);
  await page.click('#loginForm button[type=submit]');
  await page.waitForSelector('#studioCalendarGrid', { timeout: 20000 });

  // March 2026 is the month with the big block of "Posted" rows.
  await page.waitForFunction(
    () => document.querySelectorAll('#monthSelector option').length > 0,
    { timeout: 20000 }
  );
  await page.selectOption('#monthSelector', 'March 2026');
  await page.waitForTimeout(6000);
  await page.waitForFunction(
    () => document.querySelectorAll('#studioCalendarGrid .slot-status').length > 0,
    { timeout: 25000 }
  );
  await page.waitForTimeout(2500);

  const counts = await page.evaluate(() => {
    const out = {};
    document.querySelectorAll('#studioCalendarGrid .slot-status').forEach(el => {
      const t = el.textContent.trim();
      out[t] = (out[t] || 0) + 1;
    });
    return out;
  });

  // The dashboard is ~13000px tall, so a full-page shot is unreadable.
  // Frame the calendar grid itself instead, which is the thing under test.
  if (process.env.QA_SHOT) {
    await page.locator('#studioCalendarGrid').scrollIntoViewIfNeeded();
    await page.waitForTimeout(600);
    await page.screenshot({ path: process.env.QA_SHOT });
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  return { statusBadgeCounts: counts };
}
