// Proves the Studio tab reconciles with the posting sheet WITHOUT anyone
// clicking a button — the half of the two-store bug that a manual button
// never fixed.
//
// The real endpoint needs GOOGLE_REFRESH_TOKEN / CONTENT_SHEET_ID, which
// only exist as Cloudflare Pages secrets, so /api/studio-posted-sync is
// stubbed here with a realistic response. What's being checked is that the
// page calls it by itself and reports the result — not Google's behaviour.
export default async function run(page) {
  const calls = [];

  await page.route('**/api/studio-posted-sync', async (route) => {
    calls.push({ method: route.request().method(), body: route.request().postData() });
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        applied: true,
        counts: { promoted: 2, backfilled: 3, staleFlagged: 7, orphanFlagged: 11, alreadyInSync: 4 },
        result: { promoted: 2, backfilled: 3, errors: [] },
        stale: [], orphan: []
      })
    });
  });

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.fill('#adminPassword', 'Superadmin');
  await page.click('#loginForm button[type=submit]');
  await page.waitForSelector('#studioCalendarGrid', { timeout: 25000 });

  // Wait for the page to report the automatic run on its own.
  await page.waitForFunction(
    () => (document.getElementById('postedSyncAuto')?.textContent || '').includes('Synced'),
    { timeout: 30000 }
  );
  const note = (await page.locator('#postedSyncAuto').innerText()).trim();
  await page.locator('#postedSyncAuto').scrollIntoViewIfNeeded();
  await page.waitForTimeout(800);
  if (process.env.QA_SHOT) await page.screenshot({ path: process.env.QA_SHOT });

  return { autoCalls: calls, autoNote: note };
}
