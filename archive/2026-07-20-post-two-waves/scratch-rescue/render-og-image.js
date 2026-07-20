const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const svgPath = path.resolve(process.argv[2]);
  const outPath = path.resolve(process.argv[3]);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  await page.goto('file://' + svgPath);
  // SVG loads as the document element; screenshot the exact viewport
  await page.screenshot({ path: outPath, clip: { x: 0, y: 0, width: 1200, height: 630 } });
  await browser.close();
  console.log('rendered', outPath);
})().catch((e) => { console.error(e.message); process.exit(1); });
