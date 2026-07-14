// Verifier human-journey drive: landing page CTA + waitlist submit, screenshots at both widths.
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const outDir = "/Users/yaakovscher/dev/coldstart/pw-shots/human-journey-2026-07-14";
fs.mkdirSync(outDir, { recursive: true });

async function shootBoth(browser, url, name, action) {
  for (const view of [
    { label: "desktop", width: 1440, height: 900 },
    { label: "mobile", width: 390, height: 844 },
  ]) {
    const ctx = await browser.newContext({ viewport: { width: view.width, height: view.height } });
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
    if (action) await action(page, view.label);
    await page.screenshot({ path: path.join(outDir, `${name}-${view.label}.png`), fullPage: true });
    await ctx.close();
  }
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const results = {};

  // 1. Landing page as-is
  await shootBoth(browser, "https://coldrig.dev/", "landing");

  // 2. Drive the waitlist form with a junk email, capture network response
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    let waitlistResponse = null;
    page.on("response", async (res) => {
      if (res.url().includes("/api/waitlist")) {
        try {
          waitlistResponse = { url: res.url(), status: res.status(), body: await res.text() };
        } catch (e) {
          waitlistResponse = { url: res.url(), status: res.status(), body: `<err: ${e.message}>` };
        }
      }
    });
    await page.goto("https://coldrig.dev/#waitlist", { waitUntil: "networkidle", timeout: 30000 });
    const junkEmail = `verifier-junk-${Date.now()}@example.com`;
    await page.fill('input[type="email"]', junkEmail);
    await page.click('form.waitlist button[type="submit"]');
    await page.waitForTimeout(2000);
    const statusText = await page.locator(".form-status").textContent();
    results.waitlist = { junkEmail, statusText, waitlistResponse };
    await page.screenshot({ path: path.join(outDir, "waitlist-submitted-desktop.png"), fullPage: true });
    await ctx.close();
  }

  // 3. CTA inventory on landing page
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await page.goto("https://coldrig.dev/", { waitUntil: "networkidle", timeout: 30000 });
    const ctas = await page.$$eval(".cta-row a", (els) => els.map((e) => ({ text: e.textContent.trim(), href: e.getAttribute("href") })));
    results.ctas = ctas;
    await ctx.close();
  }

  // 4. Legal pages — check the Cloudflare email-obfuscation rendering (rendered text + href) after JS runs
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await page.goto("https://coldrig.dev/terms", { waitUntil: "networkidle", timeout: 30000 });
    const emailLinks = await page.$$eval('a[href*="cdn-cgi"]', (els) => els.map((e) => ({ text: e.textContent, href: e.getAttribute("href") })));
    results.termsEmailLinks = emailLinks;
    await ctx.close();
  }

  // 5. Dashboard cold-arrival at /app with no auth
  await shootBoth(browser, "https://agent-cold-email-api.yaakovscher.workers.dev/app", "dashboard-cold-arrival");

  await browser.close();
  console.log(JSON.stringify(results, null, 2));
})();
