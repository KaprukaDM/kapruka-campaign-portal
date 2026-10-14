// QA: campaign-booking slot-selection progress UI
// node <skill>/browser.mjs http://localhost:8811/campaign-booking.html --script ./scripts/qa-campaign-booking-progress.mjs
const SHOT_DIR = 'C:/Users/fari/Desktop/MARKETING HUB/runs/project_screenshots/campaign-portal/';

export default async function run(page, ui) {
  const out = {};
  await page.setViewportSize({ width: 1320, height: 1500 });

  // Wait for the slot grid to load from Supabase (month auto-selects).
  await page.waitForSelector('.slot.available', { timeout: 20000 });

  out.formHiddenBeforePick = await page.evaluate(
    () => getComputedStyle(document.getElementById('formCard')).display
  );

  // Pick the first available slot.
  await page.locator('.slot.available').first().click();
  await page.waitForTimeout(600);

  const read = () => page.evaluate(() => ({
    formDisplay: getComputedStyle(document.getElementById('formCard')).display,
    summary: [
      document.getElementById('ssDept').textContent,
      document.getElementById('ssSlot').textContent,
      document.getElementById('ssMonth').textContent
    ].join(' | '),
    fill: document.getElementById('bpFill').style.width,
    step1: document.getElementById('bpStep1').className,
    step2: document.getElementById('bpStep2').className,
    step3: document.getElementById('bpStep3').className,
    slotValue: document.getElementById('bpSlotValue').textContent,
    detailsValue: document.getElementById('bpDetailsValue').textContent,
    dateValue: document.getElementById('bpDateValue').textContent,
    hint: document.getElementById('submitHint').textContent,
    submitDisabled: document.getElementById('submitBtn').disabled
  }));

  out.afterSlotPick = await read();
  await page.locator('#slotSummary').screenshot({ path: SHOT_DIR + 'booking-step1-slot-picked.png' }).catch(() => {});

  // Step 2: campaign details
  await page.fill('#campaign', 'Bike jackets — Don\u2019t Let the Rain Stop You promo');
  await page.waitForTimeout(200);
  out.afterDetails = await read();

  // Bad duration should knock step 2 back out of "done"
  await page.fill('#duration', '99');
  await page.waitForTimeout(200);
  out.afterBadDuration = await read();
  await page.fill('#duration', '7');
  await page.waitForTimeout(200);

  // Step 3: pick a selectable go-live date
  await page.locator('.golive-calendar .cal-day.selectable').first().click();
  await page.waitForTimeout(400);
  out.afterDatePick = await read();

  // Shot 1: the new header area (summary + stepper) at 100%
  await page.evaluate(() => document.getElementById('formCard').scrollIntoView());
  await page.waitForTimeout(400);
  const card = await page.locator('#formCard').boundingBox();
  await page.screenshot({
    path: SHOT_DIR + 'campaign-booking-slot-progress.png',
    clip: { x: card.x - 10, y: Math.max(card.y - 10, 0), width: card.width + 20, height: 420 }
  });

  // Shot 2: the gated submit button + hint
  const btn = await page.locator('#submitBtn').boundingBox();
  await page.evaluate(() => document.getElementById('submitBtn').scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(300);
  const btn2 = await page.locator('#submitBtn').boundingBox();
  await page.screenshot({
    path: SHOT_DIR + 'campaign-booking-submit-ready.png',
    clip: { x: btn2.x - 10, y: btn2.y - 20, width: btn2.width + 20, height: 110 }
  });

  // "Change slot" should clear everything and hide the form again.
  await page.locator('.slot-summary .ss-change').click();
  await page.waitForTimeout(500);
  out.afterChangeSlot = await page.evaluate(() => ({
    formDisplay: getComputedStyle(document.getElementById('formCard')).display,
    selectedSlots: document.querySelectorAll('.slot.selected').length
  }));

  return out;
}
