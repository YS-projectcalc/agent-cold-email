// M4 agent-control end-to-end proof (SPEC.md §19.7 item 4 — the AI-native
// gate). Self-provisions a FRESH tenant via the real HTTP facade (signup ->
// setup-infrastructure -> a rich /demo/run seed), drives the SPA through the
// real token-gate like a human for the BEFORE/AFTER screenshots, and drives
// the MCP `tools/call` surface directly (raw fetch, tenant bearer token) for
// configure_dashboard/label_thread — proving the dashboard-mutation path an
// agent actually uses, not a UI simulation of it. Then exercises a human
// override via the real UI (layout edit + relabel) to prove the provenance
// flip, a stale-rev retry to quote the structured 409-equivalent MCP error,
// and the agent_note XSS guard live.
//
// Run via the playwright-cli skill wrapper (wrangler dev must already be
// running on :8787 — the dashboard SPA build must be current, `npm run
// build -w @coldstart/dashboard` first if source changed):
//   ~/.claude/skills/playwright-cli/run.sh pw-scripts/agent-control-e2e.js
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = 'http://localhost:8787';
const OUT = path.join(__dirname, '..', 'pw-shots', 'dashboard-m4');
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
/** A raw JSON-RPC 2.0 `tools/call` — the exact surface a customer's agent
 * hits. Returns { status, envelope, result } where `result` is the tool's
 * own JSON payload (parsed out of the `content[0].text` string every MCP
 * tool call returns — mcp/handler.ts), so callers don't have to re-parse it
 * inline everywhere below. */
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
  await page.screenshot({ path: file }); // viewport-sized, matches M2/M3 convention
  console.log(JSON.stringify({ file, bytes: fs.statSync(file).size }));
}

(async () => {
  const stamp = Date.now();
  const brand = `E2E Agent Control ${stamp}`;
  const domain = `e2eagentcontrol${stamp}.com`;

  // --- 1. Fresh tenant, provisioned + seeded via the real HTTP facade ---
  const signup = await api('/signup', { method: 'POST', body: { brand, contactEmail: `founder@${domain}` } });
  if (signup.status !== 201) { console.error('FAILED: signup', signup); process.exit(1); }
  const { token, tenantId } = signup.body;
  log('1a. Fresh tenant', { tenantId, brand, domain });

  const setup = await api('/setup-infrastructure', {
    method: 'POST',
    token,
    body: { brand, primaryDomain: domain, domains: 1, inboxesEach: 3, persona: 'Sender', physicalAddress: '1 E2E St', senderIdentity: `Sender <s@${domain}>` },
  });
  if (setup.status !== 202) { console.error('FAILED: setup-infrastructure', setup); process.exit(1); } // 202 = job accepted (runs synchronously under the hood — routes/infrastructure.ts)

  // Backend gaps brief item 3 — the richer bounded seed: 12 leads / 2
  // campaigns, deterministic reply/bounce/ooo/silent mix, so the inbox has
  // real multi-thread variety (not just the original 3-lead canned set) for
  // the label round-trip below.
  const demoRun = await api('/demo/run', { method: 'POST', token, body: { leads: 12, campaigns: 2 } });
  if (demoRun.status !== 200) { console.error('FAILED: demo/run', demoRun); process.exit(1); }
  log('1b. Rich demo/run summary', demoRun.body);

  const inboxBefore = await api('/inbox?archived=include&limit=200', { token });
  const threads = inboxBefore.body.threads;
  const threadA = threads.find((t) => t.leadEmail.includes('.reply@')); // a genuine reply thread
  const threadB = threads.find((t) => t.leadEmail.includes('.bounce@')); // a bounce thread
  if (!threadA || !threadB) { console.error('FAILED: could not find two distinct threads to label', threads); process.exit(1); }
  log('1c. Threads picked for labeling', { threadA: threadA.threadId, threadB: threadB.threadId });

  // --- 2. BEFORE screenshot (real UI login through the token-gate) ---
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const page = await ctx.newPage();

  await page.goto(`${BASE}/app/`, { waitUntil: 'load' });
  await page.waitForSelector('text=Sign in to your dashboard', { timeout: 15000 });
  await page.getByLabel(/tenant token/i).fill(token);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForSelector('h1:has-text("Dashboard")', { timeout: 15000 });
  await page.waitForSelector('table >> text=sender', { timeout: 15000 });
  await page.waitForTimeout(400);
  await shoot(page, 'before-dashboard-1440-light');

  // --- 3. Agent round trip over MCP (raw fetch, tenant bearer — the actual
  // agent transport, not a UI stand-in). Fetch the current default view's
  // rev+layout first (get_dashboard), same as any agent would before an
  // update. ---
  const listViews = await mcpCall(token, 'get_dashboard', {});
  log('3a. MCP get_dashboard (list)', listViews.result);
  const viewDetail = await mcpCall(token, 'get_dashboard', { id: 'default' });
  log('3b. MCP get_dashboard (id=default)', viewDetail.result);
  const staleRev = viewDetail.result.rev; // captured NOW, deliberately reused stale later (step 6)
  const widgets = viewDetail.result.layout.widgets;

  // Reorder (swap the first two widgets' y) + hide one + append an agent_note
  // widget whose markdown carries a legitimate link, an explanatory note, AND
  // an XSS payload (<script> + a javascript: link) — the live proof that
  // AgentNote's sanitizer neuters both (§19.1 content-safety class 2).
  const reordered = widgets.map((w, i) => {
    if (i === 0) return { ...w, gridPos: { ...w.gridPos, y: 2 }, visible: false }; // was first, now last + hidden
    if (i === 1) return { ...w, gridPos: { ...w.gridPos, y: 0 } }; // was second, now first
    return w;
  });
  const agentNoteMarkdown = [
    'Reordered your dashboard so replies surface first, and hid the top widget since it was noisy.',
    '',
    'See the [docs](https://coldrig.dev/docs) for what changed.',
    '',
    '<script>alert(1)</script>',
    '',
    '[click me](javascript:alert(1))',
  ].join('\n');
  const newLayout = {
    schemaVersion: viewDetail.result.layout.schemaVersion,
    widgets: [
      ...reordered,
      { id: 'w_agent_note_e2e', type: 'agent_note', gridPos: { x: 0, y: 4, w: 12, h: 3 }, visible: true, props: { refreshSeconds: 30, markdown: agentNoteMarkdown } },
    ],
  };

  const configureUpdate = await mcpCall(token, 'configure_dashboard', {
    action: 'update',
    id: 'default',
    rev: viewDetail.result.rev,
    layout: newLayout,
    note: 'Reordered widgets, hid the noisy one, and left you a note — see the agent_note widget.',
  });
  log('3c. MCP configure_dashboard (update) — REQUEST', configureUpdate.request);
  log('3c. MCP configure_dashboard (update) — RESPONSE', { status: configureUpdate.status, isError: configureUpdate.isError, result: configureUpdate.result });
  if (configureUpdate.isError) { console.error('FAILED: configure_dashboard update was rejected'); process.exit(1); }

  const labelA = await mcpCall(token, 'label_thread', { threadId: threadA.threadId, label: 'interested' });
  const labelB = await mcpCall(token, 'label_thread', { threadId: threadB.threadId, label: 'not_now' });
  log('3d. MCP label_thread x2', { threadA: labelA.result, threadB: labelB.result });

  // --- 4. Stale-rev path — retry the SAME update with the rev captured
  // BEFORE step 3c's update landed. Quote the structured 409-equivalent MCP
  // error payload verbatim (§19.5: currentRev + currentLayout, so an agent
  // can rebase). ---
  const staleUpdate = await mcpCall(token, 'configure_dashboard', {
    action: 'update',
    id: 'default',
    rev: staleRev, // stale: configureUpdate already advanced the rev past this
    layout: newLayout,
    note: 'this should be rejected — stale rev',
  });
  log('4. MCP configure_dashboard STALE-REV — REQUEST', staleUpdate.request);
  log('4. MCP configure_dashboard STALE-REV — RESPONSE (structured conflict)', { status: staleUpdate.status, isError: staleUpdate.isError, result: staleUpdate.result });
  if (!staleUpdate.isError || typeof staleUpdate.result?.currentRev !== 'number') {
    console.error('FAILED: stale-rev retry did not return the expected structured conflict');
    process.exit(1);
  }

  // --- 5. AFTER: reload the SPA and prove the agent's changes landed —
  // new layout, agent_note rendered (sanitized), "Configured by your agent"
  // badge, labels visible in the inbox (1440 + 390). ---
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('text=Configured by your agent', { timeout: 15000 });
  await page.waitForSelector('text=Reordered your dashboard so replies surface first', { timeout: 15000 });
  await page.waitForTimeout(400);
  await shoot(page, 'after-dashboard-agent-configured-1440-light');

  // XSS-inert proof: no <script> element and no javascript: href survived
  // sanitization, even though the raw markdown above contained both.
  const noteHtml = await page.locator('.prose-note').innerHTML();
  const xssProof = {
    containsScriptTag: /<script/i.test(noteHtml),
    containsJavascriptHref: /href\s*=\s*"javascript:/i.test(noteHtml),
    containsLegitimateLink: /href="https:\/\/coldrig\.dev\/docs"/i.test(noteHtml),
    renderedHtml: noteHtml,
  };
  log('5a. agent_note sanitized DOM (XSS guard live proof)', xssProof);
  if (xssProof.containsScriptTag || xssProof.containsJavascriptHref) {
    console.error('FAILED: XSS payload survived sanitization', xssProof);
    process.exit(1);
  }

  await page.getByRole('link', { name: /inbox/i }).click();
  await page.waitForSelector('text=interested', { timeout: 15000 });
  await page.waitForTimeout(300);
  await shoot(page, 'after-inbox-labels-1440-light');

  // Filtered-by-label view + the thread detail pane's own label chip — both
  // more legible proof of "labels visible in inbox" than a list row, whose
  // chips can wrap/clip under the virtualizer at 3-chips-wide (mailbox +
  // campaign + label) with this seed's longer generated campaign names.
  await page.getByLabel(/filter by label/i).fill('interested');
  await page.waitForSelector('text=Pinecrest Media', { timeout: 15000 });
  await page.waitForTimeout(300);
  await shoot(page, 'after-inbox-filtered-by-label-1440-light');
  await page.getByText('Pinecrest Media').first().click();
  await page.waitForSelector('text=Replying from', { timeout: 15000 });
  await page.waitForTimeout(200);
  await shoot(page, 'after-thread-detail-label-chip-1440-light');
  await page.getByLabel(/filter by label/i).fill('');
  await page.waitForTimeout(200);

  const ctxMobile = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'light' });
  const pageMobile = await ctxMobile.newPage();
  await pageMobile.goto(`${BASE}/app/`, { waitUntil: 'load' });
  await pageMobile.waitForSelector('text=Sign in to your dashboard', { timeout: 15000 });
  await pageMobile.getByLabel(/tenant token/i).fill(token);
  await pageMobile.getByRole('button', { name: /sign in/i }).click();
  await pageMobile.waitForSelector('nav', { timeout: 15000 });
  await pageMobile.goto(`${BASE}/app/inbox`, { waitUntil: 'load' });
  await pageMobile.waitForSelector('text=interested', { timeout: 15000 });
  await pageMobile.waitForTimeout(300);
  await shoot(pageMobile, 'after-inbox-labels-390-light');

  // Same filtered-by-label view as desktop above — the unfiltered mobile
  // list has the identical 3-chip wrap/clip issue under the row virtualizer,
  // so this is the legible proof at 390px.
  await pageMobile.getByLabel(/filter by label/i).fill('interested');
  await pageMobile.waitForSelector('text=Pinecrest Media', { timeout: 15000 });
  await pageMobile.waitForTimeout(300);
  await shoot(pageMobile, 'after-inbox-filtered-by-label-390-light');

  // --- 6. Human override — relabel one thread + edit the layout via the
  // REAL UI (cookie-authed), proving the provenance flip away from the
  // agent. ---
  await pageMobile.close();
  await ctxMobile.close();

  await page.locator('[role="listitem"]', { hasText: threadA.leadEmail }).first().click();
  await page.getByRole('button', { name: /^label$/i }).click();
  await page.waitForSelector('text=Label this thread', { timeout: 15000 });
  await page.getByRole('button', { name: /meeting booked/i }).click();
  await page.waitForTimeout(300);

  await page.getByRole('link', { name: /dashboard/i }).click();
  await page.waitForSelector('h1:has-text("Dashboard")', { timeout: 15000 });
  await page.getByRole('button', { name: 'Edit layout' }).click();
  await page.waitForSelector('text=Show, hide, and reorder widgets', { timeout: 15000 });
  // Scoped to the modal dialog specifically — several dashboard WIDGETS
  // (AgentLog/ActivityFeed/InboxPreview) render their own <li> rows on the
  // page underneath, so an unscoped `page.locator('li')` grabs one of those
  // instead of the layout editor's own list.
  const editorDialog = page.getByRole('dialog', { name: /edit view layout/i });
  const firstWidgetRow = editorDialog.locator('li').first();
  await firstWidgetRow.getByRole('button', { name: /^(hide|show)$/i }).click();
  await editorDialog.getByRole('button', { name: /^save$/i }).click();
  await page.waitForSelector('text=Show, hide, and reorder widgets', { state: 'detached', timeout: 15000 });
  await page.waitForSelector('text=Edited by you', { timeout: 15000 });
  await page.waitForTimeout(300);
  await shoot(page, 'after-human-override-provenance-by-you-1440-light');

  // Label provenance flip: no visual badge exists on a thread's label chip
  // (apps/dashboard has no labelSource UI element today) — proven instead via
  // the API's own row, the same field the dashboard's data layer reads.
  const inboxAfterOverride = await api('/inbox?archived=include&limit=200', { token });
  const relabeledRow = inboxAfterOverride.body.threads.find((t) => t.threadId === threadA.threadId);
  log('6. Human-relabeled thread — provenance flip (label + source)', relabeledRow);
  if (relabeledRow?.labelSource !== 'dashboard') {
    console.error('FAILED: expected labelSource=dashboard after the UI relabel', relabeledRow);
    process.exit(1);
  }

  await ctx.close();
  await browser.close();

  console.log('\n=== M4 agent-control e2e proof: ALL ASSERTIONS PASSED ===');
})().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
