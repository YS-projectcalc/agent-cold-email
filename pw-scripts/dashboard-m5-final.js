// M5 perfection-loop round 2 (FINAL) verification (SPEC.md §19.8) — fresh
// tenant self-provisioned via the real HTTP facade, {leads:24, campaigns:2}
// demo/run seed (the SAME call that induces a real domain burn -> 5 paused
// mailboxes, which is what makes the M5 R2 item 1 failsafe banner visible
// with REAL data, not a mock), full screenshot matrix at 1440px/390px x
// light/dark: the new default seed, an agent-configured variant, inbox
// list/filters, thread detail+composer, command palette, and settings.
//
// Run via the playwright-cli skill wrapper (wrangler dev must already be
// running on :8787, dashboard SPA build must be current):
//   ~/.claude/skills/playwright-cli/run.sh pw-scripts/dashboard-m5-final.js
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = 'http://localhost:8787';
const OUT = path.join(__dirname, '..', 'pw-shots', 'dashboard-m5-final');
fs.mkdirSync(OUT, { recursive: true });

function log(label, value) {
  console.log(`\n=== ${label} ===`);
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

async function api(pathName, { method = 'GET', token, body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${pathName}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

let rpcId = 0;
async function mcpCall(token, name, args) {
  rpcId += 1;
  const request = { jsonrpc: '2.0', id: rpcId, method: 'tools/call', params: { name, arguments: args } };
  const res = await api('/mcp', { method: 'POST', token, body: request });
  const text = res.body?.result?.content?.[0]?.text;
  let result;
  try {
    result = text !== undefined ? JSON.parse(text) : undefined;
  } catch {
    result = text;
  }
  return { status: res.status, request, envelope: res.body, isError: Boolean(res.body?.result?.isError), result };
}

async function shoot(page, name) {
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file }); // viewport-sized, matches M3/M4/M5-R1 convention
  console.log(JSON.stringify({ file, bytes: fs.statSync(file).size }));
}

async function login(page, token) {
  await page.goto(`${BASE}/app/`, { waitUntil: 'load' });
  await page.waitForSelector('text=Sign in to your dashboard', { timeout: 15000 });
  await page.getByLabel(/tenant token/i).fill(token);
  await page.getByRole('button', { name: /sign in/i }).click();
}

const VIEWPORTS = [
  { label: 'desktop', width: 1440, height: 900 },
  { label: 'mobile', width: 390, height: 844 },
];
const THEMES = ['light', 'dark'];

(async () => {
  const stamp = Date.now();
  const brand = `M5 Final ${stamp}`;
  const domain = `m5final${stamp}.com`;

  // --- 1. Fresh tenant, provisioned + seeded via the real HTTP facade ---
  const signup = await api('/signup', { method: 'POST', body: { brand, contactEmail: `founder@${domain}` } });
  if (signup.status !== 201) { console.error('FAILED: signup', signup); process.exit(1); }
  const { token, tenantId } = signup.body;
  log('1a. Fresh tenant', { tenantId, brand, domain });

  const setup = await api('/setup-infrastructure', {
    method: 'POST',
    token,
    body: { brand, primaryDomain: domain, domains: 1, inboxesEach: 5, persona: 'Sender', physicalAddress: '1 M5 St', senderIdentity: `Sender <s@${domain}>` },
  });
  if (setup.status !== 202) { console.error('FAILED: setup-infrastructure', setup); process.exit(1); }

  // The exact prescribed seed ({leads:24, campaigns:2}) already crosses the
  // domain-burn bounce-rate threshold (bounceRate=0.25 over 24 sends >>
  // burnBounceRate=0.15) on a FIRST run — no synthetic mocking needed, this
  // is real engine output: the 5 original mailboxes get PAUSED (REPLACE_
  // DOMAIN), which is exactly the condition the item-1 failsafe banner
  // watches for. Verified via a throwaway probe before writing this script.
  const demoRun = await api('/demo/run', { method: 'POST', token, body: { leads: 24, campaigns: 2 } });
  if (demoRun.status !== 200) { console.error('FAILED: demo/run', demoRun); process.exit(1); }
  log('1b. Rich demo/run summary (leads:24, campaigns:2)', demoRun.body);

  const account = await api('/account', { token });
  log('1c. Deliverability summary (proves the banner condition is REAL, not mocked)', account.body.deliverability);
  if (account.body.deliverability.pausedMailboxes === 0 && account.body.deliverability.throttledMailboxes === 0) {
    console.error('WARNING: no paused/throttled mailbox induced — the banner matrix shots will show it ABSENT, not as evidence of the built behavior.');
  }

  const browser = await chromium.launch({ headless: true });

  // --- 2. Full matrix: dashboard (NEW default seed, banner visible),
  // inbox list, thread detail, settings, command palette x 1440/390 x
  // light/dark ---
  for (const theme of THEMES) {
    for (const vp of VIEWPORTS) {
      const tag = `${vp.label}-${theme}`;
      const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, colorScheme: theme });
      const page = await ctx.newPage();
      try {
        await login(page, token);
        await page.waitForSelector('h1:has-text("Dashboard")', { timeout: 15000 });
        // The NEW starter layout (M5 R2 item 3) — wait for the last widget
        // in stack order so the whole seeded layout has painted.
        await page.waitForSelector('text=Note from your agent', { timeout: 15000 });
        await page.waitForSelector('role=status', { timeout: 15000 }).catch(() => {}); // banner (best-effort: only present if paused/throttled)
        await page.waitForTimeout(500);
        await shoot(page, `dashboard-default-${tag}`);

        await page.getByRole('link', { name: /inbox/i }).click();
        await page.waitForSelector('text=Q1', { timeout: 15000 }).catch(() => {});
        await page.waitForSelector('li, [role="listitem"]', { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(400);
        await shoot(page, `inbox-list-${tag}`);

        const firstRow = page.locator('main ul li button, main [role="listitem"] button').first();
        await firstRow.click();
        await page.waitForSelector('text=Replying from', { timeout: 15000 });
        await page.waitForTimeout(250);
        await shoot(page, `thread-detail-composer-${tag}`);

        if (vp.label === 'mobile') {
          await page.getByRole('button', { name: '← Back', exact: true }).click();
          await page.waitForTimeout(200);
        }

        await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true })));
        await page.getByPlaceholder(/type a command/i).waitFor({ timeout: 15000 });
        await shoot(page, `command-palette-${tag}`);
        await page.keyboard.press('Escape');
        await page.getByPlaceholder(/type a command/i).waitFor({ state: 'detached', timeout: 15000 });

        await page.getByRole('link', { name: /settings/i }).click();
        await page.waitForSelector('h1:has-text("Settings")', { timeout: 15000 });
        await page.waitForSelector('table', { timeout: 15000 });
        await page.waitForTimeout(350);
        await shoot(page, `settings-${tag}`);
      } catch (err) {
        console.error(`FAILED (${tag}):`, err.message);
        process.exitCode = 1;
      }
      await ctx.close();
    }
  }

  // --- 3. Dashboard agent-configured variant (MCP configure_dashboard):
  // reorder + hide a widget + write an agent_note ---
  const viewDetail = await mcpCall(token, 'get_dashboard', { id: 'default' });
  const widgets = viewDetail.result.layout.widgets;
  const reordered = widgets.map((w) => {
    if (w.type === 'kpi_row') return { ...w, visible: false }; // hidden — noisy per the note below
    if (w.type === 'inbox_preview') return { ...w, gridPos: { ...w.gridPos, x: 0, y: 0, w: 12, h: 4 } }; // promoted to the top, full width
    return w;
  });
  const agentNoteMarkdown = ['Promoted the inbox to the top and hid the KPI row — replies matter more than vanity counts for this run.', '', 'See the [docs](https://coldrig.dev/docs) for what changed.'].join('\n');
  const configuredLayout = {
    schemaVersion: viewDetail.result.layout.schemaVersion,
    widgets: reordered.map((w) => (w.type === 'agent_note' ? { ...w, props: { ...w.props, markdown: agentNoteMarkdown } } : w)),
  };
  const configureUpdate = await mcpCall(token, 'configure_dashboard', {
    action: 'update',
    id: 'default',
    rev: viewDetail.result.rev,
    layout: configuredLayout,
    note: 'Promoted the inbox, hid the KPI row, and left you a note.',
  });
  log('3. MCP configure_dashboard (agent-configured variant)', { isError: configureUpdate.isError });
  if (configureUpdate.isError) { console.error('FAILED: configure_dashboard', configureUpdate.result); process.exit(1); }

  for (const theme of THEMES) {
    for (const vp of VIEWPORTS) {
      const tag = `${vp.label}-${theme}`;
      const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, colorScheme: theme });
      const page = await ctx.newPage();
      try {
        await login(page, token);
        await page.waitForSelector('text=Configured by your agent', { timeout: 15000 });
        await page.waitForSelector('text=Promoted the inbox to the top', { timeout: 15000 });
        await page.waitForTimeout(400);
        await shoot(page, `dashboard-agent-configured-${tag}`);
      } catch (err) {
        console.error(`FAILED (agent-configured ${tag}):`, err.message);
        process.exitCode = 1;
      }
      await ctx.close();
    }
  }

  await browser.close();
  console.log('\n=== M5 R2 FINAL screenshot matrix: DONE ===');
})().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
