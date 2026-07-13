// M5 perfection-loop round 1 verification (SPEC.md §19.8) — fresh tenant
// self-provisioned via the real HTTP facade, rich demo/run seed, full
// screenshot matrix at 1440px/390px x light/dark, plus targeted proofs for
// each fixed defect (A: widget width sweep w=4/6/7/12; B: 360px filters bar;
// C: labeled row chips at 390px).
//
// Run via the playwright-cli skill wrapper (wrangler dev must already be
// running on :8787, dashboard SPA build must be current):
//   ~/.claude/skills/playwright-cli/run.sh pw-scripts/dashboard-m5-r1.js
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = 'http://localhost:8787';
const OUT = path.join(__dirname, '..', 'pw-shots', 'dashboard-m5-r1');
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
  await page.screenshot({ path: file }); // viewport-sized, matches M3/M4 convention
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
  const brand = `M5 R1 ${stamp}`;
  const domain = `m5r1${stamp}.com`;

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

  const demoRun = await api('/demo/run', { method: 'POST', token, body: { leads: 24, campaigns: 2 } });
  if (demoRun.status !== 200) { console.error('FAILED: demo/run', demoRun); process.exit(1); }
  log('1b. Rich demo/run summary (leads:24, campaigns:2)', demoRun.body);

  const inboxSeed = await api('/inbox?archived=include&limit=200', { token });
  const seedThreads = inboxSeed.body.threads;
  const labelTarget = seedThreads.find((t) => t.leadEmail.includes('.reply@'));
  if (!labelTarget) { console.error('FAILED: no reply thread to label', seedThreads); process.exit(1); }
  const labelResult = await mcpCall(token, 'label_thread', { threadId: labelTarget.threadId, label: 'interested' });
  log('1c. Labeled a thread via MCP for the H proof', { threadId: labelTarget.threadId, leadEmail: labelTarget.leadEmail, isError: labelResult.isError });
  if (labelResult.isError) { console.error('FAILED: label_thread'); process.exit(1); }

  const browser = await chromium.launch({ headless: true });

  // --- 2. Full matrix: dashboard (default), inbox list, thread detail,
  // settings, command palette x 1440/390 x light/dark ---
  for (const theme of THEMES) {
    for (const vp of VIEWPORTS) {
      const tag = `${vp.label}-${theme}`;
      const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, colorScheme: theme });
      const page = await ctx.newPage();
      try {
        await login(page, token);
        await page.waitForSelector('h1:has-text("Dashboard")', { timeout: 15000 });
        await page.waitForSelector('text=Mailbox health', { timeout: 15000 });
        await page.waitForTimeout(400);
        await shoot(page, `dashboard-default-${tag}`);

        await page.getByRole('link', { name: /inbox/i }).click();
        await page.waitForSelector('text=interested', { timeout: 15000 });
        await page.waitForTimeout(300);
        await shoot(page, `inbox-list-${tag}`);

        await page.locator('[role="listitem"]', { hasText: 'interested' }).first().click();
        await page.waitForSelector('text=Replying from', { timeout: 15000 });
        await page.waitForTimeout(200);
        await shoot(page, `thread-detail-${tag}`);

        if (vp.label === 'mobile') {
          await page.getByRole('button', { name: '← Back', exact: true }).click();
          await page.waitForSelector('text=interested', { timeout: 15000 });
        }

        await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true })));
        await page.getByPlaceholder(/type a command/i).waitFor({ timeout: 15000 });
        await shoot(page, `command-palette-${tag}`);
        await page.keyboard.press('Escape');
        await page.getByPlaceholder(/type a command/i).waitFor({ state: 'detached', timeout: 15000 });

        await page.getByRole('link', { name: /settings/i }).click();
        await page.waitForSelector('h1:has-text("Settings")', { timeout: 15000 });
        await page.waitForSelector('table >> text=sender', { timeout: 15000 });
        await page.waitForTimeout(300);
        await shoot(page, `settings-${tag}`);
      } catch (err) {
        console.error(`FAILED (${tag}):`, err.message);
        process.exitCode = 1;
      }
      await ctx.close();
    }
  }

  // --- 3. Dashboard agent-configured variant (MCP configure_dashboard),
  // same reorder/hide/agent_note pattern as the M4 proof, re-verified after
  // the M5 fixes (item E's agent_note dead-space fix, item F/G's
  // rename/default-pill cleanup) x 1440/390 x light/dark ---
  const viewDetail = await mcpCall(token, 'get_dashboard', { id: 'default' });
  const widgets = viewDetail.result.layout.widgets;
  const reordered = widgets.map((w, i) => {
    if (i === 0) return { ...w, gridPos: { ...w.gridPos, y: 2 }, visible: false };
    if (i === 1) return { ...w, gridPos: { ...w.gridPos, y: 0 } };
    return w;
  });
  const agentNoteMarkdown = ['Reordered your dashboard so replies surface first, and hid the top widget since it was noisy.', '', 'See the [docs](https://coldrig.dev/docs) for what changed.'].join('\n');
  const configuredLayout = {
    schemaVersion: viewDetail.result.layout.schemaVersion,
    widgets: [
      ...reordered,
      { id: 'w_agent_note_m5', type: 'agent_note', gridPos: { x: 0, y: 4, w: 12, h: 3 }, visible: true, props: { refreshSeconds: 30, markdown: agentNoteMarkdown } },
      // campaign_performance isn't in the starter layout — the agent adds it
      // here at a narrow w=5 so the M5 defect A container-query fix (and the
      // friendly campaign names from defect D) get a live visual proof too.
      { id: 'w_campaigns_m5', type: 'campaign_performance', gridPos: { x: 0, y: 7, w: 5, h: 4 }, visible: true, props: { refreshSeconds: 30 } },
    ],
  };
  const configureUpdate = await mcpCall(token, 'configure_dashboard', { action: 'update', id: 'default', rev: viewDetail.result.rev, layout: configuredLayout, note: 'Reordered widgets, hid the noisy one, and left you a note.' });
  log('3. MCP configure_dashboard (agent-configured variant)', { isError: configureUpdate.isError });
  if (configureUpdate.isError) { console.error('FAILED: configure_dashboard'); process.exit(1); }

  for (const theme of THEMES) {
    for (const vp of VIEWPORTS) {
      const tag = `${vp.label}-${theme}`;
      const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, colorScheme: theme });
      const page = await ctx.newPage();
      try {
        await login(page, token);
        await page.waitForSelector('text=Configured by your agent', { timeout: 15000 });
        await page.waitForSelector('text=Reordered your dashboard so replies surface first', { timeout: 15000 });
        await page.waitForTimeout(400);
        await shoot(page, `dashboard-agent-configured-${tag}`);

        // The added campaign_performance widget (defect A/D live proof)
        // renders below the fold at this viewport height — the scroll
        // container is AppShell's own `<main>` (not the window), so scroll
        // it directly rather than relying on scrollIntoViewIfNeeded picking
        // the right ancestor.
        await page.evaluate(() => document.querySelector('main')?.scrollTo(0, 999999));
        await page.waitForTimeout(200);
        await shoot(page, `dashboard-agent-configured-campaigns-widget-${tag}`);
      } catch (err) {
        console.error(`FAILED (agent-configured ${tag}):`, err.message);
        process.exitCode = 1;
      }
      await ctx.close();
    }
  }

  // --- 4. Defect A proof: mailbox_health widget width sweep. Set gridPos.w
  // to 4, 6, 7, 12 in turn (x always 0 so it never runs off the 12-col
  // grid) and screenshot each at 1440px light — the widget must never clip
  // "Warmup"/email text against the card edge at any of these widths. ---
  const widthSweepCtx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const widthSweepPage = await widthSweepCtx.newPage();
  await login(widthSweepPage, token);
  await widthSweepPage.waitForSelector('h1:has-text("Dashboard")', { timeout: 15000 });

  for (const w of [4, 6, 7, 12]) {
    const current = await mcpCall(token, 'get_dashboard', { id: 'default' });
    // Siblings hidden for the sweep — isolates the mailbox_health widget so
    // each screenshot is unambiguous proof of ITS OWN responsive behavior,
    // not an incidental overlap from leaving a neighbor at its old gridPos
    // while this one widens underneath it.
    const sweepWidgets = current.result.layout.widgets.map((wd) => (wd.type === 'mailbox_health' ? { ...wd, visible: true, gridPos: { ...wd.gridPos, x: 0, y: 0, w } } : { ...wd, visible: false }));
    const sweepUpdate = await mcpCall(token, 'configure_dashboard', {
      action: 'update',
      id: 'default',
      rev: current.result.rev,
      layout: { schemaVersion: current.result.layout.schemaVersion, widgets: sweepWidgets },
      note: `width sweep w=${w}`,
    });
    if (sweepUpdate.isError) { console.error(`FAILED: width sweep w=${w}`, sweepUpdate.result); process.exitCode = 1; continue; }
    await widthSweepPage.reload({ waitUntil: 'load' });
    await widthSweepPage.waitForSelector('text=Mailbox health', { timeout: 15000 });
    await widthSweepPage.waitForTimeout(400);
    await shoot(widthSweepPage, `defect-a-mailbox-health-w${w}-1440-light`);
  }
  await widthSweepCtx.close();

  // --- 5. Defect B proof: filters bar at 360px (in addition to the
  // required 390px in the main matrix above). ---
  const narrowCtx = await browser.newContext({ viewport: { width: 360, height: 800 }, colorScheme: 'light' });
  const narrowPage = await narrowCtx.newPage();
  try {
    await login(narrowPage, token);
    await narrowPage.getByRole('link', { name: /inbox/i }).click();
    await narrowPage.waitForSelector('text=interested', { timeout: 15000 });
    await narrowPage.waitForTimeout(300);
    await shoot(narrowPage, 'defect-b-filters-bar-360-light');
  } catch (err) {
    console.error('FAILED (360px filters bar):', err.message);
    process.exitCode = 1;
  }
  await narrowCtx.close();

  await browser.close();
  console.log('\n=== M5 R1 screenshot matrix + defect proofs: DONE ===');
})().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
