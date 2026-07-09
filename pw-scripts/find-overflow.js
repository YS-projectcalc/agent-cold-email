const { chromium } = require('playwright');
(async () => {
  const url = process.argv[2];
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: 'networkidle' });
  const result = await page.evaluate(() => {
    const docWidth = document.documentElement.clientWidth;
    const offenders = [];
    document.querySelectorAll('body *').forEach(el => {
      if (el.scrollWidth > docWidth + 2) {
        offenders.push({
          tag: el.tagName,
          cls: el.className && el.className.toString().slice(0,60),
          scrollWidth: el.scrollWidth,
          text: el.textContent.slice(0, 60)
        });
      }
    });
    return { docWidth, scrollWidth: document.documentElement.scrollWidth, offenders: offenders.slice(0, 15) };
  });
  console.log(JSON.stringify(result, null, 2));
  await browser.close();
})();
