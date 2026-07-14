// Verifier: check the dashboard Settings page for billing/upgrade/cancel UI, and invalid-token error handling.
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const outDir = "/Users/yaakovscher/dev/coldstart/pw-shots/human-journey-2026-07-14";
fs.mkdirSync(outDir, { recursive: true });

const TOKEN = process.argv[2];

(async () => {
  const browser = await chromium.launch({ headless: true });
  const results = {};

  // 1. Valid token -> Settings page
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await page.goto("https://agent-cold-email-api.yaakovscher.workers.dev/app", { waitUntil: "networkidle", timeout: 30000 });
    await page.locator("input").first().fill(TOKEN);
    await page.locator('button:has-text("Sign in")').click();
    await page.waitForTimeout(2000);
    // Navigate to Settings
    const settingsLink = page.locator('text=Settings').first();
    if (await settingsLink.count() > 0) {
      await settingsLink.click();
      await page.waitForTimeout(1500);
    }
    await page.screenshot({ path: path.join(outDir, "dashboard-settings-desktop.png"), fullPage: true });
    const bodyText = await page.locator("body").textContent();
    results.settingsBodyText = bodyText;
    await ctx.close();
  }

  // 2. Invalid/garbage token -> error handling
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await page.goto("https://agent-cold-email-api.yaakovscher.workers.dev/app", { waitUntil: "networkidle", timeout: 30000 });
    await page.locator("input").first().fill("cs_test_totally_invalid_garbage_token_12345");
    await page.locator('button:has-text("Sign in")').click();
    await page.waitForTimeout(2000);
    await page.screenshot({ path: path.join(outDir, "dashboard-invalid-token-desktop.png"), fullPage: true });
    const bodyText = await page.locator("body").textContent();
    results.invalidTokenBodyText = bodyText.slice(0, 500);
    results.invalidTokenUrl = page.url();
    await ctx.close();
  }

  await browser.close();
  console.log(JSON.stringify(results, null, 2));
})();
