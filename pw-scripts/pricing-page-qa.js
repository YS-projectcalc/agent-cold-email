const { chromium } = require("playwright");
const { pathToFileURL } = require("node:url");
const path = require("node:path");

const expected = new Map([
  [5, { price: "99", domains: "2", capacity: "3,300" }],
  [10, { price: "149", domains: "4", capacity: "6,600" }],
  [20, { price: "249", domains: "7", capacity: "13,200" }],
  [60, { price: "649", domains: "20", capacity: "39,600" }],
]);

async function inspect(page, viewport) {
  await page.setViewportSize(viewport);
  await page.goto(pathToFileURL(path.resolve("site/pricing.html")).href, { waitUntil: "load" });
  await page.waitForSelector("[data-price-output]");

  const jsonLd = await page.locator('script[type="application/ld+json"]').allTextContents();
  jsonLd.forEach((value) => JSON.parse(value));

  const results = [];
  for (const [mailboxes, values] of expected) {
    await page.locator("#mailbox-count").evaluate((element, value) => {
      element.value = String(value);
      element.dispatchEvent(new Event("input", { bubbles: true }));
    }, mailboxes);

    const actual = await page.evaluate(() => ({
      price: document.querySelector("[data-price-output]").textContent.trim(),
      domains: document.querySelector("[data-domain-output]").textContent.trim(),
      capacity: document.querySelector("[data-capacity-output]").textContent.trim(),
    }));
    if (JSON.stringify(actual) !== JSON.stringify(values)) {
      throw new Error(`${mailboxes}-mailbox quote mismatch: ${JSON.stringify(actual)}`);
    }
    results.push({ mailboxes, ...actual });
  }

  const layout = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    h1: document.querySelector("h1")?.textContent.trim(),
    rangeLabel: document.querySelector('label[for="mailbox-count"]')?.textContent.trim(),
  }));
  if (layout.scrollWidth > layout.clientWidth + 1) {
    throw new Error(`horizontal overflow at ${viewport.width}px: ${JSON.stringify(layout)}`);
  }
  if (!layout.rangeLabel) throw new Error("mailbox slider has no explicit label");

  return { viewport, layout, results };
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });

  const reports = [];
  reports.push(await inspect(page, { width: 1440, height: 1000 }));
  reports.push(await inspect(page, { width: 390, height: 844 }));
  await browser.close();

  if (errors.length) throw new Error(`browser errors: ${errors.join(" | ")}`);
  process.stdout.write(`${JSON.stringify({ ok: true, reports }, null, 2)}\n`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
