// No ad request currently claims Posted, so this forces the case rather
// than proving nothing: the studio lookup is intercepted and ONE slot is
// rewritten to studio_status 'Posted' with no evidence. That chip must come
// out as "Pending verification", not "Posted". Nothing is written to Supabase.
export default async function run(page) {
  let forcedRequestId = null;

  await page.route('**/rest/v1/studio_calendar?source_type=eq.ad_request*', async (route) => {
    const res = await route.fetch();
    const rows = await res.json();
    if (Array.isArray(rows) && rows.length) {
      rows[0].studio_status = 'Posted';
      forcedRequestId = rows[0].source_id;
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify(rows)
    });
  });

  await page.reload({ waitUntil: 'domcontentloaded' });
  // The board defaults to next month; step back to the month with data.
  await page.waitForSelector('.category-card', { timeout: 25000 });
  const back = page.locator('button', { hasText: '←' }).last();
  for (let i = 0; i < 12; i++) {
    const label = (await page.locator('#monthDisplay').innerText()).trim();
    if (/August 2026/.test(label)) break;
    await back.click();
    await page.waitForTimeout(1200);
  }
  await page.waitForTimeout(3000);

  const badges = await page.evaluate(() => {
    const out = {};
    document.querySelectorAll('.studio-badge').forEach(el => {
      const t = el.textContent.trim();
      out[t] = (out[t] || 0) + 1;
    });
    return out;
  });

  // Open the forced chip so the explanation is visible in the shot.
  const chip = page.locator('.request-chip').filter({ hasText: 'Pending verification' }).first();
  let popup = null;
  if (await chip.count()) {
    await chip.scrollIntoViewIfNeeded();
    await chip.click();
    await page.waitForTimeout(1200);
    popup = await page.evaluate(() => {
      const m = document.getElementById('modal');
      if (!m || m.style.display === 'none') return null;
      return m.innerText.replace(/\s+/g, ' ').slice(0, 380);
    });
  }

  if (process.env.QA_SHOT) await page.screenshot({ path: process.env.QA_SHOT });
  return { forcedRequestId, studioBadgeCounts: badges, popup };
}
