const { chromium } = require("playwright");
const { pathToFileURL } = require("node:url");
const fs = require("node:fs");
const path = require("node:path");

const pages = [
  "index", "signup", "connect", "support", "status", "security",
  "replies", "byo-domain", "unsubscribe", "why-email", "404",
];
const viewports = [
  { label: "desktop", width: 1440, height: 1000 },
  { label: "mobile", width: 390, height: 844 },
];
const screenshotPages = new Set(["signup", "connect", "security", "unsubscribe"]);
const outputDir = "/private/tmp/coldrig-human-qa";

(async () => {
  fs.mkdirSync(outputDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const report = [];

  for (const viewport of viewports) {
    const context = await browser.newContext({ viewport, colorScheme: "light" });
    for (const pageName of pages) {
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
      await page.goto(pathToFileURL(path.resolve(`site/${pageName}.html`)).href, { waitUntil: "load" });

      const layout = await page.evaluate(() => ({
        title: document.title,
        h1: document.querySelector("h1")?.textContent.trim(),
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
        missingImages: [...document.images].filter((image) => !image.complete || image.naturalWidth === 0).map((image) => image.getAttribute("src")),
      }));
      if (!layout.title || !layout.h1) throw new Error(`${pageName} is missing a title or h1`);
      if (layout.scrollWidth > layout.clientWidth + 1) throw new Error(`${pageName} overflows at ${viewport.width}px: ${JSON.stringify(layout)}`);
      if (layout.missingImages.length) throw new Error(`${pageName} has missing images: ${layout.missingImages.join(", ")}`);
      if (errors.length) throw new Error(`${pageName} browser errors: ${errors.join(" | ")}`);

      if (pageName === "connect") {
        await page.getByRole("tab", { name: "Claude Code" }).click();
        if (!(await page.locator('[data-panel="claude"]').isVisible())) throw new Error("Claude setup tab did not open");
      }
      if (pageName === "unsubscribe") {
        await page.getByLabel("Email address").fill("recipient@example.com");
        await page.getByRole("button", { name: "Preview unsubscribe" }).click();
        if (!(await page.locator(".recipient-result").isVisible())) throw new Error("recipient preview confirmation did not open");
      }
      if (screenshotPages.has(pageName)) {
        await page.screenshot({ path: path.join(outputDir, `${pageName}-${viewport.label}.png`), fullPage: true });
      }
      report.push({ page: pageName, viewport: viewport.label, h1: layout.h1, width: layout.scrollWidth });
      await page.close();
    }
    await context.close();
  }

  await browser.close();
  process.stdout.write(`${JSON.stringify({ ok: true, outputDir, report }, null, 2)}\n`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
