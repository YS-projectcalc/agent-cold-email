const { chromium } = require('playwright');

const NOTES = "agent-cold-email is agent-native cold-email infrastructure (hosted MCP server + CLI + HTTP API, 17 tools) for provisioning isolated branded domains/mailboxes, warmup, sequences, and replies. Submitted by the maintainer. Early access / test mode only — no real sending yet, no deliverability guarantees.";

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1400 } });
  try {
    await page.goto('https://tally.so/r/wAydjB', { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(1000);

    await page.fill('input[aria-label="Website or product name"]', 'agent-cold-email');
    await page.fill('input[aria-label="llms.txt URL"]', 'https://coldrig.dev/llms.txt');
    await page.fill('input[aria-label="Category"]', 'Developer Tools / AI Agent Infrastructure');
    await page.fill('input[aria-label="Email"]', 'jacob@epiphanymade.com');
    await page.fill('textarea[aria-label="Anything you\'d like to share with us about your adoption of the LLMs.txt standard?"]', NOTES);

    await page.screenshot({ path: 'tally-02-filled.png', fullPage: true });

    const submitBtn = page.locator('button[type="submit"], button', { hasText: 'Submit' }).first();
    await submitBtn.click();
    await page.waitForTimeout(3000);
    await page.screenshot({ path: 'tally-03-after-submit.png', fullPage: true });
    console.log('URL after submit:', page.url());
    const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 1500));
    console.log('BODY:', bodyText);
  } catch (e) {
    console.log('ERROR:', e.message);
    try { await page.screenshot({ path: 'tally-ERROR.png', fullPage: true }); } catch {}
  }
  await browser.close();
})();
