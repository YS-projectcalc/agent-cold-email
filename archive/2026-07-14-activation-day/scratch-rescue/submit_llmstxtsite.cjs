const { chromium } = require('playwright');

const NOTES = "Submitted by the maintainer. agent-cold-email is agent-native cold-email infrastructure (hosted MCP server + CLI + HTTP API, 17 tools) for provisioning isolated branded domains/mailboxes, warmup, sequences, and replies. Early access / test mode only — no real sending yet, no deliverability guarantees.";

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1100 } });
  try {
    await page.goto('https://llmstxt.site/submit', { waitUntil: 'networkidle', timeout: 30000 });
    await page.fill('input[placeholder="Enter your product name"]', 'agent-cold-email');
    await page.fill('input[placeholder="https://example.com"]', 'https://coldrig.dev');
    await page.fill('input[placeholder="Enter your name"]', 'Jacob Scher');
    await page.fill('input[placeholder="you@example.com"]', 'jacob@epiphanymade.com');
    await page.fill('input[placeholder="Enter URL for llms.txt file"]', 'https://coldrig.dev/llms.txt');
    await page.fill('input[placeholder="Enter URL for llms-full.txt file"]', 'https://coldrig.dev/llms-full.txt');
    const notesField = page.locator('input[placeholder="Enter any additional notes for considering the submission"], textarea[placeholder="Enter any additional notes for considering the submission"]').first();
    await notesField.fill(NOTES);

    await page.screenshot({ path: 'llmstxtsite-02-filled.png', fullPage: true });

    const submitBtn = page.locator('button', { hasText: 'Submit LLMs.txt' }).first();
    await submitBtn.click();
    await page.waitForTimeout(3000);
    await page.screenshot({ path: 'llmstxtsite-03-after-submit.png', fullPage: true });
    console.log('URL after submit:', page.url());
    const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 1500));
    console.log('BODY:', bodyText);
  } catch (e) {
    console.log('ERROR:', e.message);
    try { await page.screenshot({ path: 'llmstxtsite-ERROR.png', fullPage: true }); } catch {}
  }
  await browser.close();
})();
