const { chromium } = require('playwright');
(async () => {
  const url = process.argv[2];
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: 'networkidle' });
  const result = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('pre').forEach((el, i) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      out.push({ i, rectWidth: r.width, rectLeft: r.left, rectRight: r.right, scrollWidth: el.scrollWidth, overflowX: cs.overflowX, width: cs.width, parentTag: el.parentElement.tagName, parentWidth: el.parentElement.getBoundingClientRect().width });
    });
    return out;
  });
  console.log(JSON.stringify(result, null, 2));
  await browser.close();
})();
