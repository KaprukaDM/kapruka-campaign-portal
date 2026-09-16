// Checks what the public content calendar calls a "Posted" item, and opens
// one so the detail popup can be seen too. March 2026 is the month with the
// big block of unevidenced Posted rows.
export default async function run(page) {
  await page.waitForSelector('#calendarGrid .day-cell', { timeout: 25000 });
  // Walk back to March 2026 through the page's own control, rather than
  // poking at globals (the script world is isolated here).
  const back = page.locator('button', { hasText: '←' }).last();
  for (let i = 0; i < 24; i++) {
    const label = (await page.locator('#monthDisplay').innerText()).trim();
    if (label === 'March 2026') break;
    await back.click();
    await page.waitForTimeout(1200);
  }
  await page.waitForTimeout(4000);

  const badges = await page.evaluate(() => {
    const out = {};
    document.querySelectorAll('#calendarGrid .studio-badge').forEach(el => {
      const t = el.textContent.trim();
      out[t] = (out[t] || 0) + 1;
    });
    return out;
  });

  // Grid shot first — the popup would cover the badges being compared.
  if (process.env.QA_SHOT) {
    await page.locator('#calendarGrid').scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
    await page.screenshot({ path: process.env.QA_SHOT });
  }

  // Open a slot that claims Posted, so the popup wording is in the shot.
  const slot = page.locator('#calendarGrid .slot-preview')
    .filter({ hasText: /Posted|Pending verification/ }).first();
  if (await slot.count()) {
    await slot.scrollIntoViewIfNeeded();
    await slot.click();
    await page.waitForTimeout(1200);
  }
  const popup = await page.evaluate(() => {
    const m = document.getElementById('modal');
    if (!m || m.style.display === 'none') return null;
    return m.innerText.replace(/\s+/g, ' ').slice(0, 420);
  });

  if (process.env.QA_SHOT2 && popup) await page.screenshot({ path: process.env.QA_SHOT2 });
  return { studioBadgeCounts: badges, popup };
}
