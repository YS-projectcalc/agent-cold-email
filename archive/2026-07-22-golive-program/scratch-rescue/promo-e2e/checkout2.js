const { chromium } = require('playwright');
const fs = require('fs');
(async () => {
  const dir = '/private/tmp/claude-503/-Users-yaakovscher/b380b1f8-5dd1-4412-8ff6-3e30b328f084/scratchpad/promo-e2e';
  const url = fs.readFileSync(dir + '/url.txt', 'utf8').trim();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(4000);
    const usd = page.locator('button.CurrencyOptionButton', { hasText: 'USD' }).first();
    if (await usd.count()) { await usd.click().catch(()=>{}); await page.waitForTimeout(2000); }
    const email = page.locator('input#email, input[name="email"]').first();
    if (await email.count()) await email.fill('promo-e2e@example.com').catch(()=>{});
    // promo input: the sibling of the PromotionCodeEntry Apply button
    const promoInput = page.locator('[class*="PromotionCodeEntry"] input, input[name="promotionCode"], #promotionCode').first();
    await promoInput.waitFor({ state: 'visible', timeout: 10000 });
    await promoInput.fill('MORDYPILOTTEST');
    const apply = page.locator('button[class*="PromotionCodeEntry"]', { hasText: 'Apply' }).first();
    if (await apply.count()) { await apply.click(); } else { await promoInput.press('Enter'); }
    await page.waitForTimeout(4000);
    const body = await page.textContent('body');
    console.log('zero total shown:', /(\$|₪)0\.00/.test(body));
    console.log('100% off shown:', /100% off/i.test(body));
    await page.screenshot({ path: dir + '/02-promo-applied.png', fullPage: true });
    const submit = page.locator('button.SubmitButton').first();
    await submit.click({ timeout: 15000 });
    await page.waitForURL(u => !String(u).includes('checkout.stripe.com'), { timeout: 45000 }).catch(() => {});
    await page.waitForTimeout(2500);
    console.log('final URL:', page.url());
    await page.screenshot({ path: dir + '/03-final.png', fullPage: true });
  } catch (e) {
    await page.screenshot({ path: dir + '/99-error2.png', fullPage: true }).catch(() => {});
    console.error('E2E error:', e.message.split('\n')[0]);
    process.exitCode = 1;
  } finally { await browser.close(); }
})();
