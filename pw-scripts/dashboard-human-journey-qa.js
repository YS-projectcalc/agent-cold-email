const { chromium } = require("playwright");
const fs = require("node:fs");
const path = require("node:path");

const base = "http://localhost:8787/app";
const outputDir = "/private/tmp/coldrig-dashboard-human-qa";

function assertNoOverflow(layout, label) {
  if (layout.scrollWidth > layout.clientWidth + 1) throw new Error(`${label} overflows: ${JSON.stringify(layout)}`);
}

(async () => {
  fs.mkdirSync(outputDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: "light" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 500) errors.push(`${response.status()} ${response.url()}`);
  });

  await page.goto(`${base}/signup`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Create your Coldrig sandbox." }).waitFor();
  await page.screenshot({ path: path.join(outputDir, "signup-desktop.png"), fullPage: true });
  await page.getByLabel("Company or brand").fill("Northstar QA");
  await page.getByLabel("Work email").fill("owner@northstar.example");
  await page.getByRole("button", { name: "Create free sandbox" }).click();
  await page.getByRole("heading", { name: "Save your tenant token now." }).waitFor();
  const token = (await page.locator("code").first().textContent()).trim();
  if (!token) throw new Error("signup did not reveal a one-time token");
  await page.screenshot({ path: path.join(outputDir, "token-desktop.png"), fullPage: true });
  await page.getByLabel(/I saved the token/).check();
  await page.getByRole("button", { name: "Open setup checklist" }).click();

  await page.getByRole("heading", { name: "Connect the agent. Keep the owner in control." }).waitFor();
  await page.getByRole("tab", { name: "Claude Code" }).click();
  await page.screenshot({ path: path.join(outputDir, "setup-desktop.png"), fullPage: true });

  await page.getByRole("link", { name: "Billing" }).click();
  await page.getByRole("heading", { name: "Know the cost before the agent provisions." }).waitFor();
  await page.locator("#billing-mailboxes").fill("20");
  await page.getByText("$249", { exact: true }).first().waitFor();
  await page.screenshot({ path: path.join(outputDir, "billing-desktop.png"), fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${base}/setup`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Connect the agent. Keep the owner in control." }).waitFor();
  await page.screenshot({ path: path.join(outputDir, "setup-mobile.png"), fullPage: true });
  assertNoOverflow(await page.evaluate(() => ({ clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth })), "setup mobile");

  await page.getByRole("link", { name: "Billing" }).click();
  await page.getByRole("heading", { name: "Know the cost before the agent provisions." }).waitFor();
  await page.screenshot({ path: path.join(outputDir, "billing-mobile.png"), fullPage: true });
  assertNoOverflow(await page.evaluate(() => ({ clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth })), "billing mobile");

  if (errors.length) throw new Error(`browser errors: ${errors.join(" | ")}`);
  await context.close();
  await browser.close();
  process.stdout.write(`${JSON.stringify({ ok: true, outputDir, tenantTokenShownOnce: true, quote20: "$249" }, null, 2)}\n`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
