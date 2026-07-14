// Verifier: drive the documented dashboard-session flow with a real tenant token in a real browser.
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const outDir = "/Users/yaakovscher/dev/coldstart/pw-shots/human-journey-2026-07-14";
fs.mkdirSync(outDir, { recursive: true });

const TOKEN = process.argv[2];
if (!TOKEN) { console.error("usage: node verifier-dashboard-session.js <token>"); process.exit(1); }

(async () => {
  const browser = await chromium.launch({ headless: true });
  const results = {};

  for (const view of [
    { label: "desktop", width: 1440, height: 900 },
    { label: "mobile", width: 390, height: 844 },
  ]) {
    const ctx = await browser.newContext({ viewport: { width: view.width, height: view.height } });
    const page = await ctx.newPage();
    const sessionCalls = [];
    page.on("response", async (res) => {
      if (res.url().includes("/dashboard/session")) {
        let body = "<unreadable>";
        try { body = await res.text(); } catch (e) { body = `err:${e.message}`; }
        sessionCalls.push({ status: res.status(), body, setCookie: res.headers()["set-cookie"] || null });
      }
    });
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));

    await page.goto("https://agent-cold-email-api.yaakovscher.workers.dev/app", { waitUntil: "networkidle", timeout: 30000 });
    await page.screenshot({ path: path.join(outDir, `dashboard-signin-${view.label}.png`), fullPage: true });

    // Find the token input and sign-in button.
    const tokenInput = page.locator('input').first();
    await tokenInput.fill(TOKEN);
    const signInButton = page.locator('button:has-text("Sign in")');
    await signInButton.click();
    await page.waitForTimeout(3000);

    const cookies = await ctx.cookies();
    const url = page.url();
    await page.screenshot({ path: path.join(outDir, `dashboard-after-signin-${view.label}.png`), fullPage: true });

    results[view.label] = { sessionCalls, pageErrors, cookies: cookies.map(c => ({ name: c.name, httpOnly: c.httpOnly, secure: c.secure, sameSite: c.sameSite })), finalUrl: url };

    // If we landed on a dashboard, try to navigate to inbox and screenshot.
    const bodyText = await page.locator("body").textContent();
    results[view.label].bodyTextSnippet = bodyText.slice(0, 300);

    await ctx.close();
  }

  await browser.close();
  console.log(JSON.stringify(results, null, 2));
})();
