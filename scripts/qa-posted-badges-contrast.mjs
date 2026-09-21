// Screenshots the one week of the Studio tab where both answers appear at
// once: rows the posting sheet confirmed (green Posted), rows from before
// link capture existed (also green Posted), and rows recent enough that
// evidence should exist but doesn't (amber Pending verification, kept).
//
//   QA_ADMIN_PASSWORD=... QA_SHOT=<file.png> node <skill>/browser.mjs \
//        http://127.0.0.1:8800/admin-dashboard.html \
//        --script scripts/qa-posted-badges-contrast.mjs
export default async function run(page) {
  const adminPassword = process.env.QA_ADMIN_PASSWORD;
  if (!adminPassword) throw new Error('Set QA_ADMIN_PASSWORD to run this QA script.');

  await page.setViewportSize({ width: 1500, height: 950 });
  await page.fill('#adminPassword', adminPassword);
  await page.click('#loginForm button[type=submit]');
  await page.waitForSelector('#studioCalendarGrid', { timeout: 30000 });
  await page.waitForFunction(
    () => document.querySelectorAll('#monthSelector option').length > 0, { timeout: 30000 });

  await page.selectOption('#monthSelector', 'August 2026');
  await page.waitForTimeout(9000);
  await page.waitForFunction(
    () => document.querySelectorAll('#studioCalendarGrid .slot-status').length > 0, { timeout: 30000 });
  await page.waitForTimeout(1500);

  const info = await page.evaluate(() => {
    const pill = [...document.querySelectorAll('#studioCalendarGrid .status-unverified')][0];
    if (!pill) return { found: false };
    pill.scrollIntoView({ block: 'center' });
    window.scrollBy(0, -80);
    return {
      found: true,
      pending: document.querySelectorAll('#studioCalendarGrid .status-unverified').length,
      posted: document.querySelectorAll('#studioCalendarGrid .status-posted').length,
      pendingTitle: pill.title
    };
  });
  await page.waitForTimeout(800);
  if (process.env.QA_SHOT) await page.screenshot({ path: process.env.QA_SHOT });
  return info;
}
