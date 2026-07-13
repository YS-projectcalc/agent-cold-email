// M5 R2 item 2 — precise before/after measurement of the review's EXACT
// repro: an agent_note widget at gridPos.h=4 (352px reserved: 4*76 + 3*16)
// whose real content is ~short (a couple lines), stacked directly above a
// second full-width widget. Measures the ACTUAL rendered gap between the
// two cards via getBoundingClientRect, not a screenshot-crop guess.
//
//   ~/.claude/skills/playwright-cli/run.sh pw-scripts/dashboard-m5-gap-measure.js
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = 'http://localhost:8787';
const OUT = path.join(__dirname, '..', 'pw-shots', 'dashboard-m5-final');
fs.mkdirSync(OUT, { recursive: true });

async function api(pathName, { method = 'GET', token, body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${pathName}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

let rpcId = 0;
async function mcpCall(token, name, args) {
  rpcId += 1;
  const request = { jsonrpc: '2.0', id: rpcId, method: 'tools/call', params: { name, arguments: args } };
  const res = await api('/mcp', { method: 'POST', token, body: request });
  const text = res.body?.result?.content?.[0]?.text;
  let result;
  try { result = text !== undefined ? JSON.parse(text) : undefined; } catch { result = text; }
  return { isError: Boolean(res.body?.result?.isError), result };
}

async function login(page, token) {
  await page.goto(`${BASE}/app/`, { waitUntil: 'load' });
  await page.waitForSelector('text=Sign in to your dashboard', { timeout: 15000 });
  await page.getByLabel(/tenant token/i).fill(token);
  await page.getByRole('button', { name: /sign in/i }).click();
}

async function measureGap(page) {
  return page.evaluate(() => {
    const sections = [...document.querySelectorAll('main section')];
    const note = sections.find((s) => s.querySelector('h2')?.textContent?.includes('Note from your agent'));
    const campaigns = sections.find((s) => s.querySelector('h2')?.textContent?.includes('Campaigns'));
    if (!note || !campaigns) return { error: 'widgets not found', found: sections.map((s) => s.querySelector('h2')?.textContent) };
    const noteBox = note.getBoundingClientRect();
    const campaignsBox = campaigns.getBoundingClientRect();
    return { noteHeight: Math.round(noteBox.height), noteBottom: Math.round(noteBox.bottom), campaignsTop: Math.round(campaignsBox.top), gap: Math.round(campaignsBox.top - noteBox.bottom) };
  });
}

(async () => {
  const stamp = Date.now();
  const brand = `M5 Gap ${stamp}`;
  const domain = `m5gap${stamp}.com`;

  const signup = await api('/signup', { method: 'POST', body: { brand, contactEmail: `founder@${domain}` } });
  if (signup.status !== 201) { console.error('FAILED: signup', signup); process.exit(1); }
  const { token } = signup.body;
  await api('/setup-infrastructure', { method: 'POST', token, body: { brand, primaryDomain: domain, domains: 1, inboxesEach: 2, persona: 'Sender', physicalAddress: '1 Gap St', senderIdentity: `Sender <s@${domain}>` } });

  const viewDetail = await mcpCall(token, 'get_dashboard', { id: 'default' });
  const rev = viewDetail.result.rev;

  // The review's exact repro: agent_note at h=4 (352px reserved) with short
  // content, stacked directly above a full-width campaign_performance widget.
  const reproLayout = {
    schemaVersion: viewDetail.result.layout.schemaVersion,
    widgets: [
      { id: 'w_note_repro', type: 'agent_note', gridPos: { x: 0, y: 0, w: 12, h: 4 }, visible: true, props: { refreshSeconds: 30, markdown: 'Short note.' } },
      { id: 'w_campaigns_repro', type: 'campaign_performance', gridPos: { x: 0, y: 4, w: 12, h: 4 }, visible: true, props: { refreshSeconds: 30 } },
    ],
  };
  const update = await mcpCall(token, 'configure_dashboard', { action: 'update', id: 'default', rev, layout: reproLayout, note: 'Repro grid gap' });
  if (update.isError) { console.error('FAILED: configure_dashboard', update.result); process.exit(1); }

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const page = await ctx.newPage();
  await login(page, token);
  await page.waitForSelector('h1:has-text("Dashboard")', { timeout: 15000 });
  await page.waitForSelector('text=Campaigns', { timeout: 15000 });
  await page.waitForTimeout(500);

  const measurement = await measureGap(page);
  console.log('\n=== M5 R2 item 2 — measured gap (AFTER fix) ===');
  console.log(JSON.stringify(measurement, null, 2));

  const file = path.join(OUT, 'grid-gap-fixed-1440-light.png');
  await page.screenshot({ path: file });
  console.log(JSON.stringify({ file, bytes: fs.statSync(file).size }));

  await browser.close();
})().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
