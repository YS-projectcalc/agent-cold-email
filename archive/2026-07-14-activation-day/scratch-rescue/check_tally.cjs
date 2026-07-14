const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await page.goto('https://tally.so/r/wAydjB', { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: 'tally-01-initial.png', fullPage: true });
    console.log('URL:', page.url());
    const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 3000));
    console.log('BODY:', bodyText);
    const inputs = await page.$$('input, textarea, select');
    console.log('field count:', inputs.length);
    for (const inp of inputs) {
      const tag = await inp.evaluate(el => el.tagName);
      const ph = await inp.getAttribute('placeholder');
      const name = await inp.getAttribute('name');
      const type = await inp.getAttribute('type');
      const ariaLabel = await inp.getAttribute('aria-label');
      const id = await inp.getAttribute('id');
      console.log(JSON.stringify({ tag, ph, name, type, ariaLabel, id }));
    }
  } catch (e) {
    console.log('ERROR:', e.message);
  }
  await browser.close();
})();
