// M2 dashboard SPA verification — logs in through the REAL token-gate,
// drives the app like a human, screenshots at 1440px + 390px, light + dark.
// Run via the playwright-cli skill wrapper:
//   ~/.claude/skills/playwright-cli/run.sh pw-scripts/dashboard-shots.js
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = 'http://localhost:8787';
const OUT = path.join(__dirname, '..', 'pw-shots', 'dashboard-m2');
fs.mkdirSync(OUT, { recursive: true });

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const token = arg('token');
if (!token) { console.error('--token required'); process.exit(1); }

const VIEWPORTS = [
  { label: 'desktop', width: 1440, height: 900 },
  { label: 'mobile', width: 390, height: 844 },
];
const THEMES = ['light', 'dark'];

async function shoot(page, name) {
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  const size = fs.statSync(file).size;
  console.log(JSON.stringify({ file, bytes: size }));
  return { file, size };
}

(async () => {
  const browser = await chromium.launch({ headless: true });

  for (const theme of THEMES) {
    for (const vp of VIEWPORTS) {
      const ctx = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        colorScheme: theme,
      });
      const page = await ctx.newPage();
      const tag = `${vp.label}-${theme}`;

      try {
      // 1. Token-gate.
      await page.goto(`${BASE}/app/`, { waitUntil: 'load' });
      await page.waitForSelector('text=Sign in to your dashboard', { timeout: 15000 });
      await shoot(page, `token-gate-${tag}`);

      // 2. Log in for real through the form.
      await page.getByLabel(/tenant token/i).fill(token);
      await page.getByRole('button', { name: /sign in/i }).click();

      // 3. Dashboard, populated — wait for a real data-bearing widget value,
      // not just the heading, so we never screenshot a pre-data skeleton.
      await page.waitForSelector('h1:has-text("Dashboard")', { timeout: 15000 });
      await page.waitForSelector('text=Mailbox health', { timeout: 15000 });
      await page.waitForSelector('table >> text=founderoutreach', { timeout: 15000 });
      await page.waitForTimeout(400); // let polling settle visually
      await shoot(page, `dashboard-populated-${tag}`);

      // 4. Hidden-widget variant — hide "Mailbox health" via the layout
      // editor (the starterDashboardLayout seeded default view has exactly
      // kpi_row/mailbox_health/inbox_preview — not quota_usage).
      await page.getByRole('button', { name: 'Edit layout' }).click();
      await page.waitForSelector('text=Show, hide, and reorder widgets');
      const mailboxRow = page.locator('li', { hasText: 'Mailbox health' });
      await mailboxRow.getByRole('button', { name: 'Hide' }).click();
      await page.getByRole('button', { name: 'Save' }).click();
      await page.waitForSelector('text=Show, hide, and reorder widgets', { state: 'detached', timeout: 15000 });
      await page.waitForTimeout(400);
      await shoot(page, `dashboard-hidden-widget-${tag}`);

      // Restore the widget so subsequent runs (and other screenshots) see the
      // full default layout again.
      await page.getByRole('button', { name: 'Edit layout' }).click();
      await page.waitForSelector('text=Show, hide, and reorder widgets');
      const mailboxRow2 = page.locator('li', { hasText: 'Mailbox health' });
      await mailboxRow2.getByRole('button', { name: 'Show' }).click();
      await page.getByRole('button', { name: 'Save' }).click();
      await page.waitForSelector('text=Show, hide, and reorder widgets', { state: 'detached', timeout: 15000 });

      // 5. Settings.
      const settingsLink = page.getByRole('link', { name: /settings/i });
      await settingsLink.click();
      await page.waitForSelector('h1:has-text("Settings")', { timeout: 15000 });
      await page.waitForSelector('table >> text=founderoutreach', { timeout: 15000 });
      await page.waitForTimeout(300);
      await shoot(page, `settings-${tag}`);
      } catch (err) {
        console.error(`FAILED (${tag}):`, err.message);
      }

      await ctx.close();
    }
  }

  await browser.close();
})();
