const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const consoleMsgs = [];
  const pageErrors = [];
  const requests = [];
  page.on("console", (m) => consoleMsgs.push(`${m.type()}: ${m.text()}`));
  page.on("pageerror", (e) => pageErrors.push(e.message));
  page.on("request", (r) => { if (r.url().includes("waitlist")) requests.push({ url: r.url(), method: r.method() }); });
  page.on("response", async (res) => {
    if (res.url().includes("waitlist")) {
      let body = "<unreadable>";
      try { body = await res.text(); } catch (e) { body = `err:${e.message}`; }
      requests.push({ respUrl: res.url(), status: res.status(), body });
    }
  });

  await page.goto("https://coldrig.dev/", { waitUntil: "networkidle", timeout: 30000 });

  const formExists = await page.locator("form.waitlist").count();
  const inputExists = await page.locator('form.waitlist input[type="email"]').count();
  const buttonExists = await page.locator('form.waitlist button[type="submit"]').count();

  await page.locator("#waitlist").scrollIntoViewIfNeeded();
  const emailInput = page.locator('form.waitlist input[type="email"]');
  await emailInput.fill(`verifier-junk-${Date.now()}@example.com`);
  const filledValue = await emailInput.inputValue();

  await page.locator('form.waitlist button[type="submit"]').click();
  await page.waitForTimeout(3000);
  const statusText = await page.locator(".form-status").textContent();

  console.log(JSON.stringify({
    formExists, inputExists, buttonExists, filledValue, statusText,
    consoleMsgs, pageErrors, requests,
  }, null, 2));

  await browser.close();
})();
