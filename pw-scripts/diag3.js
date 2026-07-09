const { chromium } = require('playwright');
(async () => {
  const url = process.argv[2];
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: 'networkidle' });
  const result = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const offenders = [];
    document.querySelectorAll('body *').forEach(el => {
      const r = el.getBoundingClientRect();
      if (r.right > vw + 1 || r.left < -1) {
        offenders.push({ tag: el.tagName, cls: (el.className||'').toString().slice(0,40), left: Math.round(r.left), right: Math.round(r.right), text: el.textContent.trim().slice(0,50) });
      }
    });
    return { vw, count: offenders.length, offenders: offenders.slice(0, 10) };
  });
  console.log(JSON.stringify(result, null, 2));
  await browser.close();
})();
