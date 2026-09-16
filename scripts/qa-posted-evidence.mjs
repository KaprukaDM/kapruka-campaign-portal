// Positive control for the Posted gate.
//
// Right now NOTHING in the live DB has usable evidence, so every Posted row
// correctly reads "Pending verification" — which on its own can't tell a
// working gate apart from a blanket relabel. This intercepts the evidence
// lookup (studio_activity_log) and hands back a posted_verified row for the
// FIRST slot it asks about, so that one slot should flip back to "Posted"
// while the rest stay pending. Nothing is written to Supabase.
export default async function run(page) {
  // The page loads the CURRENT month first and March only after the clicks,
  // so the first slot of every lookup is injected, not just the first one
  // ever seen — otherwise the evidence lands on a month nobody is looking at.
  const injectedSlots = [];

  await page.route('**/rest/v1/studio_activity_log*', async (route) => {
    const url = route.request().url();
    if (!url.includes('posted_verified')) return route.continue();
    const ids = decodeURIComponent(url).match(/slot_id=in\.\(([^)]+)\)/);
    if (!ids) return route.continue();
    const slot = Number(ids[1].split(',')[0]);
    injectedSlots.push(slot);
    const body = [{ slot_id: slot, event_type: 'posted_verified', detail: 'Verified posted — https://www.facebook.com/1335119825321833/posts/1579113710922442' }];
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify(body)
    });
  });

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#calendarGrid .day-cell', { timeout: 25000 });
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

  return { injectedSlots, studioBadgeCounts: badges };
}
