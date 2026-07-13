// M3 unified inbox verification — logs in through the REAL token-gate,
// drives the app like a human (including a real touch-swipe gesture via CDP
// for the mobile label sheet), screenshots at 1440px + 390px, light + dark.
// VIEWPORT-sized captures only (not full-page — fixed bottom bars/composers
// lie in full-page captures, per the M3 build brief).
//
// Run via the playwright-cli skill wrapper:
//   ~/.claude/skills/playwright-cli/run.sh pw-scripts/inbox-shots.js --token <tenant-token>
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = 'http://localhost:8787';
const OUT = path.join(__dirname, '..', 'pw-shots', 'dashboard-m3');
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
  await page.screenshot({ path: file }); // viewport-sized only, no fullPage
  const size = fs.statSync(file).size;
  console.log(JSON.stringify({ file, bytes: size }));
  return { file, size };
}

/** A real touch-swipe via CDP (not a mouse-drag stand-in) — the app's swipe
 * handler (inbox/useSwipeAction.ts) listens to native touchstart/touchmove/
 * touchend, which only a genuine touch event sequence exercises. */
async function swipeLeft(cdp, x, y, distance) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  for (const dx of [20, 45, 70, distance]) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x - dx, y }] });
    await new Promise((r) => setTimeout(r, 30));
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

(async () => {
  const browser = await chromium.launch({ headless: true });

  for (const theme of THEMES) {
    for (const vp of VIEWPORTS) {
      const isMobile = vp.label === 'mobile';
      const ctx = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        colorScheme: theme,
        hasTouch: isMobile,
      });
      const page = await ctx.newPage();
      const tag = `${vp.label}-${theme}`;

      try {
        // 1. Token-gate, then real login.
        await page.goto(`${BASE}/app/`, { waitUntil: 'load' });
        await page.waitForSelector('text=Sign in to your dashboard', { timeout: 15000 });
        await page.getByLabel(/tenant token/i).fill(token);
        await page.getByRole('button', { name: /sign in/i }).click();

        // 2. Land on Dashboard, then navigate to Inbox.
        await page.waitForSelector('h1:has-text("Dashboard")', { timeout: 15000 });
        await page.getByRole('link', { name: /inbox/i }).click();
        await page.waitForSelector('text=morgan.reply@demo-leads.coldstart.dev', { timeout: 15000 });
        await page.waitForTimeout(300); // let the mailbox/campaign filter queries settle visually

        // 3. Inbox list — populated, mixed labels (interested / wrong_person /
        // unlabeled read+unread rows). Default filter hides the bounce.
        await shoot(page, `inbox-list-${tag}`);

        // 4. Thread detail + composer — open the labeled "interested" thread.
        await page.getByText('morgan.reply@demo-leads.coldstart.dev').click();
        await page.waitForSelector('text=Replying from', { timeout: 15000 });
        await page.waitForTimeout(200);
        await shoot(page, `thread-detail-${tag}`);

        // 5. Command palette (Cmd+K / Ctrl+K). Dispatched as a synthetic
        // page-level KeyboardEvent rather than `page.keyboard.press` — real
        // Chromium intercepts Ctrl+K/Cmd+K itself (omnibox search shortcut)
        // before it reaches the page's own listener.
        await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true })));
        await page.getByPlaceholder(/type a command/i).waitFor({ timeout: 15000 });
        await shoot(page, `command-palette-${tag}`);
        await page.keyboard.press('Escape');
        await page.getByPlaceholder(/type a command/i).waitFor({ state: 'detached', timeout: 15000 });

        // 6. Mobile only: swipe-left on a row opens the label sheet.
        if (isMobile) {
          // Back to the list (thread detail is open from step 4). Exact
          // match: a loose /back/i also matches the "jordan.prospect" row's
          // own accessible name (its snippet text contains "checking back
          // in"), since the underlying list stays mounted under the detail
          // overlay (SPEC.md §19.6 "back returns to list position").
          await page.getByRole('button', { name: '← Back', exact: true }).click();
          await page.waitForSelector('text=morgan.reply@demo-leads.coldstart.dev', { timeout: 15000 });
          await page.waitForTimeout(200); // let the list settle back into place before measuring a row's box

          const cdp = await ctx.newCDPSession(page);
          const row = page.locator('[role="listitem"]', { hasText: 'casey.bounce' }).first();
          // Bounce is hidden by the default filter — swipe the visible
          // "jordan.prospect" row instead (present in the default view).
          const target = (await row.count()) > 0 ? row : page.locator('[role="listitem"]', { hasText: 'jordan.prospect' }).first();
          const box = await target.boundingBox();
          if (box) {
            await swipeLeft(cdp, box.x + box.width - 40, box.y + box.height / 2, 90);
            await page.waitForSelector('text=Label this thread', { timeout: 15000 });
            await page.waitForTimeout(150);
            await shoot(page, `label-sheet-mobile-${tag}`);
            await page.keyboard.press('Escape').catch(() => {});
          } else {
            console.error(`FAILED (${tag}): could not locate a row to swipe`);
          }
        }

        // 7. Empty-filtered state — filter by a label nothing has.
        await page.goto(`${BASE}/app/inbox`, { waitUntil: 'load' });
        await page.waitForSelector('text=morgan.reply@demo-leads.coldstart.dev', { timeout: 15000 });
        await page.getByLabel(/filter by label/i).fill('no_such_label_zzz');
        await page.waitForSelector('text=No threads match these filters', { timeout: 15000 });
        await page.waitForTimeout(150);
        await shoot(page, `empty-filtered-${tag}`);
      } catch (err) {
        console.error(`FAILED (${tag}):`, err.message);
      }

      await ctx.close();
    }
  }

  await browser.close();
})();
