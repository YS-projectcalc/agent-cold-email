# Claim-class adversarial review — early-access → fully-live reframe

- **Date:** 2026-07-19
- **Reviewer:** adversary (fresh context)
- **Ground ref:** `git rev-parse HEAD` = `c30cd689898321ff2c35213f764505948f733704` (branch `main`)
- **Scope:** uncommitted working-tree diff, `git diff -- site/ README.md packages/cli/README.md` (39 files). Other dirty lanes (ROADMAP/HANDOFF/SPEC/ACTIVATION/Dockerfile/archive/untracked docs) explicitly OUT of scope and not reviewed.
- **Ruling audited against:** ROADMAP.md `## Open` 2026-07-15 [ASK] — lead with what's genuinely live, demote (never delete) the caveat to one forward-motion line per surface; send-framing rulings (NO SEND QUOTA headline, never headline raw 3,300, no bare "unlimited"); deploy ordering Worker-BEFORE-site.

## VERDICT: SHIP-AFTER-FIXES (3 blocking)

The reframe is well-executed on posture: no caveat is deleted (every surface keeps a concierge / no-track-record / Stripe-test-keys line), BYO stays honestly "not yet exposed," and the send-framing rulings are respected (no bare "unlimited" about Coldrig, 3,300 stays second-position, NO SEND QUOTA preserved). But three checkable-false claim classes block a clean ship.

---

## BLOCKING FINDINGS

### B1 · SMTP claimed as a live production transport (27 occurrences, 19 files) · lens 1/2/8
**Claim (verbatim, representative):** "Real sending is live in production **(Gmail API and SMTP transports)**" — README.md, `site/.well-known/mcp/server-card.json`, `agent-evaluation.md`, `openapi.yaml`, `faq.html`, `docs.html`, `for-agents.html`, `terms.html`, all 4 operation guides, `guide-mcp-cold-email.html`, `pricing.html`, `llms.txt`, `compare-vs-salesforge/-skyp/-smartlead-instantly`, `packages/cli/README.md`.

**Why false:** The one production send on 2026-07-19 was over `gmail_api`/443 (ROADMAP evidence: `POST /v1/send` via gmail_api → 200, IMAP-verified). SMTP has NEVER sent from production — it was proven only from a Mac on 465 (07-16). DigitalOcean blocks 465/587 egress from the droplet; the engine's own code comment says so: `apps/engine/src/config.ts:15-19` — *"the HTTPS/443 lane that survives the SMTP-egress wall … the API transports send over 443 with OAuth2."* SMTP is the DEFAULT transport (`config.ts:79`, `engine.ts:178`) and is exactly the one that fails from the current host. So "SMTP transports [are] live in production" is not merely unproven — it asserts a production capability that is host-blocked on its standard ports.

**Verification:** traced `git show HEAD:apps/engine/src/config.ts` (three transports: `smtp` default, `gmail_api`, `ms_graph`; SMTP-wall comment); cross-checked against inventory item (4) and ROADMAP smoke evidence; `grep` = 27 occurrences across 19 scoped files.

**Suggested truthful wording:** replace "Gmail API and SMTP transports" with "**Gmail API (HTTPS/443)**". SMTP must be dropped from any live-production claim. Note `ms_graph` is the other 443 transport, built but NOT smoke-proven in production and mentioned nowhere on the site — safest to name only Gmail API.

### B2 · 19-tool + webhooks claims are verify-false against the LIVE Worker (ordering precondition UNMET at review time) · lens 3/4
**Claim:** every surface now says "19 tools / 19 intents" and "push webhooks (`get_webhooks`, `configure_webhook`) are live."

**Why false-on-arrival if ordering breaks:** I curled the live Worker `https://agent-cold-email-api.yaakovscher.workers.dev/mcp` `tools/list` → **17 tools**, and `get_webhooks`/`configure_webhook` are ABSENT. The committed code (HEAD) does have 19 (`apps/platform/src/mcp/tools.ts` header + `get_webhooks`@225 / `configure_webhook`@232; `d0e91ec` confirmed ancestor of HEAD), so the claims become true only AFTER the platform Worker (d0e91ec+) deploys. If the site deploys first, a buyer agent's `tools/list` returns 17 with no webhook tools while all 39 surfaces say 19 — the exact stale-listing-row class that killed the Glama/Claude shopper twice.

**Verification:** live curl (17 names enumerated, count=17); `git show HEAD:.../tools.ts` (19, webhook names present); `git merge-base --is-ancestor d0e91ec HEAD` = yes.

**Gate:** deploy the platform Worker first, then re-curl `tools/list` and confirm 19 (incl. both webhook tools) BEFORE pushing the site. This is a hard precondition, not optional.

### B3 · openapi.yaml never gained the webhook paths, yet docs/brief tell buyers to verify webhooks there · lens 1/2/5
**Claims introduced by the diff:** `docs.html` — "All **19** authed intents … Full JSON Schemas: [openapi.yaml]" plus new table rows `get_webhooks → GET /webhooks`, `configure_webhook → POST/PATCH/DELETE /webhooks[/{id}]`; `agent-evaluation.md` — "Reply/bounce/complaint webhooks | Live | **Inspect the OpenAPI paths** and the get_webhooks/configure_webhook tools"; `llms.txt` — "openapi.yaml — the same **19** intents as REST"; `openapi.yaml` description bumped to "**19** curated intents … live in production."

**Why false:** the working-tree `site/openapi.yaml` has 26 operationIds and **zero `/webhooks` paths** (grep `/webhooks` → nothing; grep `webhook` → nothing). openapi.yaml is CORS-open for registry scans (`site/_headers`). A buyer agent instructed to compare `tools/list` ↔ openapi.yaml ↔ docs table finds the two webhook endpoints in the first and third but missing from the second → checkable inconsistency. The capability is REAL (REST routes `apps/platform/src/routes/webhooks.ts` + `webhook-subscriptions.ts`, MCP tools committed) — this is a doc-completeness defect the count-bump introduced, not a fabricated feature.

**Verification:** `grep operationId site/openapi.yaml` = 26, none webhook; `grep -i webhook site/openapi.yaml` = empty; confirmed REST routes exist at HEAD.

**Fix:** add the `/webhooks` + `/webhooks/{id}` paths and schemas to `site/openapi.yaml` before the site deploy; OR soften the docs.html "Full JSON Schemas: openapi.yaml" webhook rows and the agent-evaluation.md "Inspect the OpenAPI paths" pointer so they don't send the buyer to a doc that omits the endpoints.

---

## NON-BLOCKING FINDINGS

- **N1 · og-image half-swept count.** `site/assets/og-image.svg:10` still renders "One token · **17** focused tools · server-side guardrails"; the deployed `og-image.png` (every page's `og:image`, fetched by social/registry crawlers) carries that text. Regenerate the PNG from an updated SVG.
- **N2 · waitlist.js status copy undercuts the live posture.** `site/assets/waitlist.js` success string = "we'll email you **when real sending is available**" (implies not available); catch string = "**Waitlist isn't connected yet in this preview — check back once the platform is deployed**" (implies not deployed) and still says "Waitlist." The CTA button was renamed to "Request real-sending activation" but these strings were not. Update both.
- **N3 · status.html residuals.** `og:description` meta still enumerates "…live, early access, activation-gated, or **not active**"; the Dashboard board row still shows an "Early access" pill while README/docs call the dashboard live. Minor consistency.
- **N4 · legal-doc date staleness.** `terms.html` and `privacy.html` draft-stamp still reads "Last updated 2026-07-15" though their status text changed 07-19. Bump the date (both are draft/pending-attorney; the edits are status-fact corrections only — no new legal commitment added, verified).
- **N5 · pricing wording tension.** README pricing says "self-serve, no 'contact sales'" in the same sentence as "paid activation runs through a short concierge step." The self-serve refers to pricing transparency, not activation; consider disambiguating.

## NEW / OUT-OF-SCOPE (no verdict weight — reframe did not touch these)
- `site/README.md` (a dev doc, NOT among the 39 files) is likely served publicly at `/README.md` — no exclusion in `_headers`/`_redirects`, Pages serves all files — and still says "17 tool"/"17 high-level tools" plus internal repo pointers (`SPEC.md §18`, `apps/platform/src/routes`, `packages/shared`). Pre-existing.
- `compare-vs-smartlead.html:69` exposes the internal codename **"buyer-panel"** in prose ("our own buyer-panel research"). Line unchanged by this diff; a prior compare-pages review apparently allowed "buyer-panel research" as methodology prose, but it is the actual internal tool-dir name — worth a follow-up scrub.
- `agent-evaluation.md` and `for-agents.html` npm-CLI rows say "v0.1.0 verified 2026-07-14" while README/cli/server-card say **v0.2.0**. Cells unchanged by this diff; a buyer cross-checking npm sees 0.2.0. Pre-existing inconsistency.

## ATTACKS THAT FAILED (PASS surface)
- **Deleted-caveat hunt (lens 1):** walked all 39 surfaces — every one that claims real sending retains a demoted caveat (concierge step + no multi-year track record + Stripe test keys). None deleted. Ruling honored.
- **Send-framing rulings (lens 6):** no bare "unlimited" about Coldrig (all "unlimited" hits describe competitors); 3,300 stays second-position, never headlined; "NO SEND QUOTA" preserved as the headline axis. Held.
- **BYO overclaim (lens 1):** `byo-domain.html` keeps "BYO-domain onboarding is **not yet exposed**"; real-send claim scoped to "Coldrig-provisioned domains." Honest. Held.
- **Internal-path leak in primary surfaces (lens 5):** grepped scoped HTML/JSON/YAML/MD for buyer-panel/briefs/CHOICE-TREND/worktree/scratchpad/private-tmp paths — no path leak introduced by the diff (the one "buyer-panel" prose hit is pre-existing/out-of-scope, see NEW).
- **Legal surfaces added-commitment check (lens 8):** terms/privacy/dpa/aup edits are status-fact/waitlist→activation-request renames only; no new legal obligation added.
- **Stripe/billing honesty (lens 1):** consistently "Stripe cannot take money yet / test keys / no real card charged." Held.
- **Waitlist CTA contract (lens 7):** form still POSTs to `/api/waitlist` (records a row); "Request activation → we'll follow up" copy matches the record-then-concierge reality. No broken promise.

## UNVERIFIABLE
- **Deploy ordering enforcement (B2):** I confirmed the live Worker is at 17 tools NOW but cannot control/verify that the Worker deploys before the site. Resolution: deploy Worker → re-curl `tools/list` = 19 → then push site.
- **Real Gmail MIME acceptance beyond the single 07-19 gmail_api smoke, and any ms_graph production send:** relied on ROADMAP/inventory evidence; cannot re-send from this env. This is precisely why B1's fix names only the Gmail-API transport.

---

# ADDENDUM — Round 2 re-attack (2026-07-19, same HEAD c30cd689, 45-file diff)

## ROUND-2 VERDICT: SHIP-AFTER-FIXES — 1 trivial content blocker + the standing deploy-ordering gate. All 3 round-1 blockers and 4 non-blockers resolved; new recipient-facing compliance copy verified clean.

### Round-1 checklist — re-verified
- **B1 (SMTP overclaim) — CLOSED.** Zero remaining "SMTP as live production transport" claims (grep of the overclaim shape = empty). 6 residual SMTP mentions are all out-of-class and correctly retained: competitor descriptions (Maildoso "15 cold/day (SMTP)", Smartlead "fresh SMTP via Mailreef", FoxReach quote) and generic deliverability mechanics ("rejected at the SMTP level" ×2). Exclusion judgment sound.
- **B3 (openapi webhooks) — CLOSED, verified hunk-by-hunk vs source.** Corrected path is `/webhook-subscriptions` (+`/{id}`), NOT `/webhooks` (that's the unrelated Stripe-inbound route) — team-lead's re-framing confirmed against `apps/platform/src/routes/webhook-subscriptions.ts`. Every added element matches source: verbs GET/POST(201)/PUT/DELETE (**PUT not PATCH** — route uses `.put`); signature `X-Coldrig-Signature: sha256=<hex>` (`webhook-security.ts:272` + `hmacSha256Hex`); eventTypes enum `[reply, bounce, soft_bounce, complaint]` (`packages/shared/src/webhooks.ts:16`); secret `minLength 16 / maxLength 200` (zod `.min(16).max(200)`); url `maxLength 2048`; update-refine "≥1 of url/eventTypes/secret/active"; response `status enum [active, disabled]`, disabledReason/consecutiveFailures/createdAt/updatedAt; auto-disable "after 5" = `WEBHOOK_DISABLE_THRESHOLD = 5` (`webhook-delivery.ts:21`, `if (failures >= 5)`). `docs.html` table corrected to `/webhook-subscriptions` + PUT/DELETE.
- **Non-blocking N1–N4 — all fixed.** `waitlist.js` success/catch strings no longer imply "not available / not deployed"; `status.html` og:description now "published, live, rolling out, or activation-gated" (dropped "early access / not active"); `terms.html` + `privacy.html` draft-stamps → 2026-07-19; `og-image.svg` → "19 focused tools" and `og-image.png` regenerated (mtime 07-19 15:13, 55221→55386 bytes). PNG visual render "19 focused tools" per orchestrator's stated headless-Chromium check — I confirmed the SVG source and PNG-byte change; did not independently OCR the PNG.
- **Quick wins.** `buyer-panel` codename → 0 occurrences (leak scrubbed). `site/README.md` scrubbed of the "17" count and internal `apps/platform/src/routes` / `packages/shared` / `SPEC.md` pointers.

### NEW copy audited — recipient-facing compliance (harshest / regulator-facing class) — CLEAN
`unsubscribe.html` + `why-email.html` claim suppression is "recorded and enforced immediately and permanently, for every account regardless of send mode (sandbox or real)" and "an agent cannot add them back." Verified code-true against the B4 opt-out path: the send-time guard is a `LEFT JOIN suppressions` in the shared engine tick (`apps/platform/src/engine/tick.ts:228`) with `if (… || row.suppressed) → 'skipped'` (`:243`), sitting BEFORE `ctx.adapters.email.send` and NOT branched on demo/sandbox/real — the identical loop runs for every tenant, so "regardless of send mode" holds. "permanently" = suppression row is `ON CONFLICT DO UPDATE`, no expiry (`suppression.ts:10`). "immediately" = checked at send time, no batch window. "cannot add back" = tick re-checks across every campaign regardless of the launch-time snapshot (`campaigns.ts:16-17`). `/unsubscribe` endpoint is live (read-only `GET` → HTTP 400 on missing/bad token, i.e. route runs and validates — not 404). The pages honestly keep the "Sandbox preview" badge and note most tenants are still sandbox. No overclaim.

### REMAINING — must fix / gate before ship
- **BLOCKING (trivial, 1 line) · `site/llms.txt:41`** still reads "npm package `agent-cold-email` is published at **v0.1.0**" while npm `latest` = **0.2.0** (verified against registry) and every other surface (README, cli README, server-card, for-agents, agent-evaluation, guide-mcp) now says 0.2.0. The round-1 npm-version fix hit 4 pages and missed the #1 machine-read discovery file — a checkable-false stale row of exactly the class this reframe exists to eliminate. Fix: `v0.1.0` → `v0.2.0`.
- **STANDING GATE (operational, not a copy defect) · B2 deploy ordering.** Re-confirmed live: Worker `tools/list` = **17**, `GET /webhook-subscriptions` → **404**. The site's 19-tools / webhooks-live / openapi `/webhook-subscriptions` claims (all correct-against-source) are verify-false until the platform Worker (`d0e91ec`+) deploys FIRST. Deploy Worker → re-curl `tools/list` = 19 AND `GET /webhook-subscriptions` ≠ 404 → THEN push site.

### Residual non-blocking (does not gate)
- `status.html` service board still shows a "Early access" pill on the **Dashboard** row — defensible component sub-status (dashboard paid mutations remain gated), consistent with the sibling "Rolling out" / "Concierge step" pills. Optional to reword.

---

# ADDENDUM — Round 3 re-attack (2026-07-19, HEAD 8175623, two lanes)

## ROUND-3 VERDICT: SHIP-AFTER-FIXES — 2 trivial spelled-out count stragglers + the standing deploy-ordering gate. Lane 2 (fee deletion) is a clean SHIP. Everything else verified.

Grounded at HEAD `8175623` (byo-intake merged; both lanes uncommitted on top). Live Worker now serves **19** tools and `/webhook-subscriptions` → 401 (webhooks deployed since round 2); `/byo-domains` → 404 (BYO not yet deployed — gate standing).

### LANE 1 — F-wave copy (19→21 + BYO + AGENTS.md)
**BLOCKING (2 trivial spelled-out stragglers)** — the numeric 19→21 sweep was complete (tree-wide numeric-19-as-count = clean; `llms.txt` correctly says "Twenty-one") but two spelled-out cardinals were missed:
- `site/index.html:177` — "**Nineteen** carefully scoped tools keep context small…" → should be "Twenty-one" (homepage; contradicts the "21" hero-proof stat on the same page).
- `site/agent-evaluation.md:31` — "**Nineteen** intent-level tools with consistent authentication…" → should be "Twenty-one" (machine-read brief; page's own claim table says 21). Both are cross-checkable-false against live `tools/list` (21 after deploy). Same class/severity as the round-2 `llms.txt` v0.1.0 straggler.

**Verified clean:**
- **openapi BYO fidelity** — validates (29 paths / 40 schemas). 6 paths / 7 ops match `apps/platform/src/routes/byo-domains.ts` exactly: `GET/POST /byo-domains`, `GET /byo-domains/{id}`, `POST …/{id}/poll-dns|consent|managed-mailboxes|connect-mailbox`; status 201 on register/managed-mailboxes/connect-mailbox, 200 elsewhere (matches the route's `.json(…, 201)`). `byoStatus` enum `[pending_kyc, pending_consent, pending_dns, active, rejected, abandoned]` byte-matches `byo-intake.ts:28`; poll-dns "→active on success / →abandoned after 7-day idle" matches `byo-intake.ts:223`.
- **BYO copy honesty (vs SPEC §20 + stubs)** — `registerByoDomain` genuinely runs the dnsScan pre-flight, abuse gate, and reputation ladder at registration and writes a real status row (sandbox adapters; real ones coded-but-unactivated) → "register/scan/consent live today" TRUE. `requestManagedByoMailboxes`/`connectByoMailbox` both throw `ValidationError` unless `byo_status === "active"`, and register provisions nothing real → "registering does not provision anything real until activated" TRUE. `byo-breaker.ts` hard-pauses with no replace action → "burned BYO domain hard-pauses, never auto-replaced" TRUE. No BYO-connected pricing anywhere — every surface (byo-domain.html, agent-evaluation.md, guide-mcp, AGENTS.md) explicitly declines to quote one (ruling-D compliant). Consistent across all four surfaces; no page still says BYO "not yet exposed."
- **ms_graph scoping** — both mentions (`guide-mcp-cold-email.html:201`, `openapi.yaml:1519`) are the customer connect-mailbox transport config, never claimed as Coldrig's own platform send transport. No B1 regression.
- **AGENTS.md** CLI `0.2.0` registry-verified 2026-07-15. **og-image** SVG now "21 focused tools", PNG re-rendered (mtime 22:03, bytes changed) — visual render taken on orchestrator's headless check; SVG source + PNG-byte change confirmed, not independently OCR'd.

### LANE 2 — 2¢ send-fee deletion (`apps/platform`) — CLEAN SHIP, no findings
- **(a) Public claims:** `pricing.html:65` "**$0** per-send fees" and the tree-wide "sends are not separately metered" are now true **by construction** — the deletion closes a latent gap (a 2¢ per-send usage ledger entry + Stripe report existed before). No public claim is invalidated.
- **(b) tick.ts is fee-only:** removed = `SEND_USAGE_FEE_CENTS`, the `billing.recordUsage` A4 try/catch, the `ledger_entries` usage insert, and `reportUsageToStripeIfConfigured`. The **send-path** A4 grading (`email.send` throw → transient-to-pending / permanent-or-at-cap-to-failed), the orphan-`sending` reclaim, `MAX_SEND_ATTEMPTS`, suppression skip, and the `sent`+cap+event commit are all **preserved** (only comments reworded). `reportUsageToStripeIfConfigured` is NOT orphaned (still called by `provisioning.ts:96` for the mailbox fee); `MAILBOX_MONTHLY_FEE_CENTS=600` billing preserved.
- **(c) Test coverage:** exactly **3** tests removed (tick-correctness −1 "sent-but-unbilled" billing test; tick-vendor-error −2 billing-A4 tests) — all fee-specific. The 4 send-path/orphan-reclaim tests in tick-vendor-error and the mailbox-fee metering test are **preserved**. **Ran** the 5 fee-affected files → **17 passed / 0 failed** against the modified tick.ts (the RateLimitError/TenantIsolationError console lines are asserted negative paths).

### STANDING GATE (operational)
Live Worker = 19 tools, `/byo-domains` → 404. The 21-tool / BYO / openapi-BYO-path claims are correct-against-source but verify-false until the platform Worker (`8175623`+, incl. the fee deletion) deploys BEFORE the site. Deploy Worker → re-curl `tools/list` = 21 AND `GET /byo-domains` ≠ 404 → THEN push site.

### Not independently verified
Full-suite (534) pass + full typecheck-0 (builder's claim) — I ran only the 5 fee-affected files (green) and the targeted BYO/webhook source reads; the affected path compiles+runs. og-image PNG visual "21" taken on the orchestrator's headless-render statement.
