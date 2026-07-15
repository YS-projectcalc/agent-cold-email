# Adversarial gate — design-integration merge (`d68be4f`)

**Reviewer:** adversary (fresh context) · **Date:** 2026-07-15
**Target:** merge commit `d68be4f615daf10ade982ef082fe741ae4ff629d`
**Parents:** main `9174dac` + external-designer `442383d` (designer merge-base `355926c`, i.e. designer branched 11 commits stale, before the B4 opt-out + legal-D3 + waitlist-fix commits).
**Worktree:** `/Users/yaakovscher/dev/coldstart/.claude/worktrees/agent-affd823ae7fd92292` (branch `integrate/design-2026-07-15`). Git read-only throughout.

---

## VERDICT: NO-SHIP

One BLOCKING finding survives self-refutation: a merge-introduced honesty page (`status.html`) prominently links its "live health endpoint" reachability CTA to a path that returns HTTP 404. Everything else on the brief's checklist HELD, including the full merge-loss hunt, the banned compliance classes, the founder pricing directive, dashboard integrity, and all suites. The blocker is a wrong-URL, one-token fix; re-review only that.

---

## Findings (most severe first)

### F1 · BLOCKING · lens 2/3 (run-it / live-surface) — `status.html` "live health endpoint" CTA 404s
- **Where:** `site/status.html:7` (new page, introduced by designer commit `442383d`).
- **What:** The hero says *"Use the live health endpoint for an immediate API check"*; the aside says *"The API health response is the source for immediate reachability"* and links **`Open live health endpoint ↗` → `https://agent-cold-email-api.yaakovscher.workers.dev/health`**.
- **Failure scenario:** A buyer agent evaluating Coldrig reads the status page to confirm the service is live, sees "API and MCP transport: Live," and (per the page's explicit instruction) follows the CTA to verify reachability. It receives `HTTP 404 {"error":"not found"}` — evidence that directly contradicts the "Live" claim on the same page, on the exact honesty surface `docs/research/agent-buyer-research-forensics-2026-07-14.md §4` says buyer agents quote literally and kill on.
- **Verification method:** `curl` of `/health` returned **HTTP 404 three times** (deterministic, not transient). Route grep of the merged worker (`apps/platform/src/routes/*`) confirms **no `/health` route exists** — the reachability endpoint is **`/status`** (`apps/platform/src/routes/status.ts`, purpose-built: *"a minimal PUBLIC status surface... confirms the Worker + D1 binding are reachable, which is what a status page's uptime probe actually needs"*), which returned **HTTP 200 `{"status":"ok"}`** live. Not a deploy-lag artifact: the merged code has no `/health` route, so the link 404s even after deploying `d68be4f`.
- **Fix (one token):** `.../health` → `.../status` in `status.html:7`. Same fix should correct the "health endpoint" phrasing in the hero/aside and the inherited description in `llms.txt:53` ("the live API health endpoint") and internal note `site/README.md:60` ("dashboard/health endpoint").
- **Honest severity note:** this is a broken-link/wrong-path defect, NOT a false capability or compliance claim — the reachability check IS shipped, at `/status`. A reviewer applying a looser bar could SHIP with a must-fix follow-up. Ruled BLOCKING under the brief's explicit standard ("every page must be exactly true TODAY, pre-deploy, pre-activation" + buyer-agents-kill-on-inaccuracy), because the page's central interactive affordance self-falsifies on click and the site is not yet deployed (the fix is a pre-deploy edit, not a hotfix).

### F2 · NON-BLOCKING · lens 6 — `compare-vs-diy.html:118` states the $49 decomposition with no $99 anchor on-page
- **Where:** `site/compare-vs-diy.html:118` — *"Coldrig's provisional retail formula is $49/month for the platform plus $10 per provisioned mailbox, with a five-mailbox minimum."* This is the page's only price statement; the `$99/5-mailbox` headline appears nowhere on the page (only behind a `/pricing` link).
- **Ruling:** the founder directive allows the `$49+$10` decomposition "as explanation." This is mid-paragraph explanatory context inside a DIY per-mailbox cost comparison (~$7/mo fully-loaded), so it's defensible — but it lacks the required `$99-first` anchor on the surface itself. Recommend adding "($99 for 5 mailboxes)" for full compliance. Contrast `compare-vs-salesforge.html:94`, which leads with the decomposition but immediately anchors *"That is $99 for 5 mailboxes, $149 for 10..."* — that one is compliant.

---

## Rulings on the integrator's 4 flagged judgment calls

1. **`aup.html §5` restored to main's clause (design's "health-based caps" rewrite parked)** — **CORRECT.** `git diff 9174dac..d68be4f -- site/aup.html` shows only brand/OG/favicon/nav-tag changes; the legal body is byte-identical to main. No design pricing-cap language leaked into the AUP.
2. **Compare-page `$49` decomposition leads (`compare-vs-diy:118`, `compare-vs-salesforge:94`)** — salesforge = OK (anchored to $99 immediately after). diy = NON-BLOCKING weakness (see F2). Neither is a headline/hero; both are explanatory. No ship-block.
3. **`site/README.md` + `pricing.ts` docstring keep the raw formula (internal)** — **OK.** Both are internal dev docs, not customer-facing rendered surfaces. `pricing.ts` correctly encodes the ratified constants (PLATFORM_FEE_CENTS=4900, MAILBOX_PRICE_CENTS=1000, MIN=5, MAX=60).
4. **DPA footer extended to all 25+ pages (beyond policy minimum)** — **OK.** Harmless and beneficial (consistent legal nav); policy required DPA links survive, and they do.

---

## Attacks that FAILED (this is what makes the PASS-of-these meaningful)

**Lens 1/8 — Merge-loss hunt (main compliance/legal silently dropped):** Diffed `9174dac..d68be4f` across `site/` + `AGENTS.md` and hand-classified every removed line matching compliance/legal/truth keywords. **Every removed line is a reworded replacement, not a loss.** Legal bodies (terms/privacy/aup) changed only brand/OG/favicon/nav-tag; clause content untouched. `/dpa.html` is byte-identical to main, linked from terms+aup+privacy+sitemap (and now the FAQ footer). `openapi.yaml` untouched. No-guarantee / test-mode / not-yet-real-sending honesty framing survives across all 21 content pages (grep-confirmed). The banned **"verified sender identity"** class = **zero survivors** sitewide (every "sender identity" hit is now the true "captured at setup" phrasing, which `appendComplianceFooter` backs). Every RFC 8058 claim is the true one (hosted one-click endpoint real). The designer's `server-card.json` rewrite actually *corrected* a stale "RFC 8058 on the roadmap" hedge that main still carried — a merge-gain, accurate.

**Lens 4 — AGENTS.md "CLI is published to npm" flip:** Main said "not yet published"; the merge flips to "published, v0.1.0, latest dist-tag, registry-verified 2026-07-14." **Verified TRUE** against the live registry: `https://registry.npmjs.org/agent-cold-email` → `dist-tags.latest = "0.1.0"`. Main's line was stale; the flip is a fix.

**Lens 2 — New-page overclaim sweep:** `security.html` explicitly *disclaims* SOC 2 / ISO 27001 / pen-test attestation / uptime SLA and lists honest gaps (no production sends, no push webhooks, no readable token recovery). `status.html` board correctly marks Production sending + Push webhooks "Not active," claims no uptime %/SLA. `replies.html` says *the agent* classifies intent (no service-side auto-classification overclaim; matches the manual `label_thread` tool). `byo-domain.html` repeatedly frames BYO as "Designed, not released / does not provision real BYO domains yet" (matches SPEC §20 unbuilt). `signup.html` states "No payment method requested," "Production sending stays unavailable until activation." All pricing surfaces exact.

**Lens 3 — Live-surface drive:** `/mcp` POST initialize → **HTTP 200** (endpoint live; connect.html's per-client config points at the real worker `/mcp` URL). `/app` → 307 (mounted). `/status` → 200. `/api/waitlist` live POST → **HTTP 200** (form provably fires server-side; route contract `{email}`→`{ok:true}` matches `waitlist.js`). npm registry live. Only `/health` failed (F1).

**Lens 3/4 — Pricing directive ($99-first) across EVERY surface:** pricing.html (title/meta/OG/H1-lede all `$99`-first; capacity note "not a purchased allowance or guarantee... determine actual safe volume"), pricing.js calculator (`49 + 10*mailboxes`, range clamped min=5 max=60 so never sub-$99), JSON-LD AggregateOffer (`lowPrice 99 / highPrice 649 / offerCount 56`, "$99-first" description; stale tier offers removed), signup.html, for-agents.html, agent-evaluation.md, llms.txt, server-card, dashboard BillingPage — all lead `$99` with the `$49+$10` decomposition as explanation only. Capacity is framed as ideal-rate guidance everywhere, never a cap/guarantee/contract. `pricing.ts` `quoteProvisionedMailboxes` reproduces 5→$99, 20→$249, 60→$649. Stale `$299/$799` tiers = **zero** in `site/`.

**Lens 4 — Dashboard integrity:** Rebuilt the dashboard from merged source to a scratch outDir; the build **reproduced all 16 committed asset content-hashes exactly**, including the 246 kB entry `index-LuA6fPjp.js` (and the designer branch's entry was a *different* hash `index-DZM__X6M.js`, proving the integrator rebuilt on the merged tree). All 4 assets referenced by `app/index.html` exist. Billing mutations disabled at the **code** level: `BillingPage.tsx` has **zero `.mutate` calls** (mutation grep across `src/` finds only inbox/auth/view-CRUD, no billing/checkout/stripe), every action button is `disabled`, copy honest ("subscription mutations remain disabled until Stripe quantity billing replaces the legacy test tiers"). Signup one-time token: shown once with a password-tier warning, gated behind a "saved" checkbox, exchanged for an **httpOnly cookie** session — **no console.log / localStorage / sessionStorage / URL leak anywhere in the dashboard** (grep = empty; client.ts: "never stores the bearer token or session id in JS-readable storage"). `RecoveryPage.tsx` claims match hash-only storage ("Coldrig stores a one-way hash, not a recoverable copy... No token is disclosed by email").

**Lens 2/5 — Suites (independently re-run in the worktree; `.dev.vars` provisioned by integrator, confirmed present):**
- Root typecheck: **0 errors** across all 5 workspaces (dashboard/engine/platform/cli/shared).
- Tests: dashboard **99/99** (23 files), engine **30 passed / 3 skipped** (7 files), platform **319/319** (53 files). The platform "uncaught exception" log lines are test-injected rejection paths (well-known-brand reject, frozen-tenant reject, rate limits, isolation) that the tests assert — all passed.
- `wrangler deploy --dry-run`: **OK**, all bindings resolve (TenantDO, RateLimiterDO, WAITLIST KV, D1, ASSETS, PUBLIC_BASE_URL), 22 asset files, 828.59 KiB.

---

## UNVERIFIABLE

- **Live production serving origin.** The waitlist API returns `Access-Control-Allow-Origin: https://agent-cold-email.pages.dev` even for an `Origin: https://coldrig.dev` request. IF the deployed site serves from `coldrig.dev` (all canonical/OG URLs say so), an in-browser waitlist fetch would be CORS-blocked and degrade to the JS "isn't connected yet" message. I confirmed the endpoint works server-side (200) and the ACAO value read-only, but cannot determine the live Pages custom-domain/origin configuration read-only. **Resolution:** load `https://coldrig.dev` in a browser and submit the waitlist form, or confirm the Pages primary domain. NOTE: out-of-scope for this merge regardless — `routes/waitlist.ts` (the ACAO source) and the CSP `connect-src` were **not touched** by the merge; this is pre-existing main-side deploy config.

---

## NEW (out-of-scope) observations — no verdict weight

- **`apps/platform/src/admin/support-kb.ts:35-36` quotes STALE tier pricing** ("Growth $299/mo, Scale $799/mo, Custom $49 + $13/mailbox"). The merge did **not** touch this file (main-side, pre-existing). But it is the knowledge base the support-triage agent uses to answer customer billing questions, so it contradicts the ratified `$49+$10` formula the whole customer-facing site now leads with (20 mailboxes = $249, not $299; 60 = $649, not $799). Note `pricing.ts` still carries the legacy `PLAN_QUOTAS` ($99/$299/$799) as the *actual* checkout implementation "until the quantity-billing migration lands" — so today there is a three-way gap between advertised formula, support-KB tiers, and live checkout tiers. Worth the founder's attention; not a design-merge blocker.
- Waitlist CORS origin mismatch (see UNVERIFIABLE) — pre-existing.

---

**VERDICT: NO-SHIP** — blocked on F1 (`status.html:7` health-endpoint CTA 404s; fix `/health`→`/status`). All other checklist items HELD; re-review only the one-line link fix.
