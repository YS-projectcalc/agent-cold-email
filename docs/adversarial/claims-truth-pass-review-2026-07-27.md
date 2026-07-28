# Claims-truth-pass adversarial review — 2026-07-27

**Reviewer:** adversary (fresh context)
**Scope:** uncommitted claim-surface diff in worktree `.claude/worktrees/agent-a918d6cd637d586de`
**Worktree HEAD:** `a0249705a7800565e861e8315501e5f1c1cdbaa6` (branch `worktree-agent-a918d6cd637d586de`)
**Main HEAD at review time:** `15a2e011` — **main is AHEAD of the worktree base** (go-live lane `c3aae88` + intent-log `5b2a64c` + a 24→25 tool-count sweep all merged after this worktree branched). Cross-checks below are against main/prod, not the stale base.
**Battery:** typecheck 0 across all 5 workspaces; platform **939/939**, CLI **9/9**, overall `npm test` exit 0 (dashboard/engine/shared passed, exact counts truncated by tail but exit 0).

---

## VERDICT: SHIP-AFTER-FIXES (2 BLOCKING — a NO-SHIP as-is)

The price-math rubric, self-serve purchase-path truth, and concierge sweep of the 34 marketing pages are **substantively sound and well-scoped**. But the diff ships a **factually-wrong tool count (24, prod is 25)** across ~20 surfaces — including self-contradictions on four pages this diff itself edited — and leaves the retired **"concierge"** framing on **three living directory/npm surfaces** the sweep never touched. Both fail against main's current state; the worktree battery is green only because the worktree lacks main's tool-count guard.

---

## Findings (most severe first)

### 1. BLOCKING · lens 3 (live-surface) + 4 (arm/merge plumbing) · Tool count is stale at 24 (prod = 25) across ~20 surfaces, with self-contradiction on 4 pages this diff edited
**Failure scenario:** A buyer-agent fetches `for-agents.html`. Line 135 (a paragraph THIS diff added) says checkout "is not one of the **25** MCP tools"; line 150 (a quote THIS diff rewrote) says "confirm the **24** tools cover our workflow." Same page, two counts. Identical split in `llms.txt` (`:44` says 25, `:3`/`:72` say 24), `agent-evaluation.md` (new going-live section says 25; the capability table says "24 authenticated intents"), and `docs.html` (`:113` says 25, `:156` says "All 24 authed intents"). The real count is **25** (`apps/platform/src/mcp/tools.ts:1`; prod/main uniformly 25 — `README.md:27` "The 25 tools", `for-agents.html:142`, `llms.txt:3/25/64`, `server.json`, `server-card.json`). So every "24" is now false, and the same-page contradictions are an instant credibility kill.
**Merge landmine:** main's guard `apps/platform/test/site-tool-count-claims.test.ts` defines `RETIRED_TOOL_COUNTS = [17, 19, 21, 24]` and asserts no CLAIM_SURFACE matches them. The merged tree WILL fail that guard on ~20 surfaces (README.md, server.json, AGENTS.md, server-card.json, all guides, og-image.svg, for-agents/llms/agent-evaluation/compare-vs-salesforge/connect/etc.). Conflict sites where BOTH lanes touched the count line (`server.json:4`, `server-card.json:6`, `for-agents.html:150`) risk a wrong hand-resolution silently shipping stale "24".
**Why the battery missed it:** the worktree has NO tool-count guard (that guard was added on main, after this branch cut) — green here is false comfort.
**file:line:** `site/for-agents.html:135` vs `:150`; `site/llms.txt:44` vs `:3`/`:72`; `site/agent-evaluation.md` (going-live vs table); `site/docs.html:113` vs `:156`; `README.md:29`; `server.json:4`; `site/.well-known/mcp/server-card.json:6`.
**Verification:** grepped worktree vs main; read `tools.ts:1` (25); read main's guard (`RETIRED_TOOL_COUNTS`); confirmed the diff both retains 24 and introduces 25.
**Fix:** reconcile every surface to **25** (rebase onto main + take 25 at each conflict), then run main's `site-tool-count-claims.test.ts` on the merged tree as the gate.

### 2. BLOCKING · lens 3 (live-surface) · Concierge sweep incomplete on 3 living buyer surfaces the guard doesn't cover
**Failure scenario:** An MCP directory (Glama et al.) renders `llms-install.md` as its install/status copy: "new accounts activate real sending through a short **concierge** step while self-serve activation rolls out" (`:9`) + "24 tools" (`:7`). The Claude Code plugin manifest `.claude-plugin/plugin.json:4` says "24-tool Coldrig MCP server … activate real sending via a short **concierge** step." The npm README `packages/cli/README.md:30/45` says "runs through a short **concierge** step" ×2. ROADMAP `:157` records a buyer-panel cycle-2 KILL traced **directly** to a directory listing carrying pre-reframe copy — this is that exact failure mode, on the exact directory-facing files.
**Why it matters for the verdict:** the new guard `site-claim-surface-scope.test.ts` and its comment claim "No surface keeps the word at all, so this is a strict ban" — false; three living surfaces keep it, and none are in `CLAIM_SURFACES`. The pass's stated DoD ("concierge swept everywhere") is unmet.
**Caveat (honest):** all three are pre-existing on main too (not a regression this diff introduced) — this is "the pass didn't finish the job," not "the pass broke something."
**file:line:** `.claude-plugin/plugin.json:4`; `llms-install.md:7,9`; `packages/cli/README.md:30,45`.
**Verification:** full-worktree `grep -rIl concierge` (excluding node_modules/docs/archive); confirmed same strings on main; confirmed none are in the guard's `CLAIM_SURFACES`.
**Fix:** extend the sweep + the guard's `CLAIM_SURFACES` to these three (they are canonical buyer/directory surfaces). Reconcile their tool count to 25 in the same edit.

### 3. NON-BLOCKING · lens 1 (spec-vs-reality) + 6 (attack the design) · "typically same-day" send-authorization is a soft overclaim (no track record)
**Failure scenario:** A skeptical evaluator asks "typical over what sample?" Reality (main ROADMAP, verified): real sending is prod-proven, Stripe live is armed (07-23), InboxKit provisioning + engine are armed (07-27) — but the remaining real-customer step is a **per-mailbox `GMAIL_OAUTH_GRANTS` OAuth mint**, a **manual founder action, classifier-blocked from automation** ("actionable at provisioning"). **Zero** real self-serve customers have completed this end-to-end (pilot #1 Mordy "unblocked by his signup, not by us"). "typically same-day" asserts an observed distribution that does not exist. It's hedged and plausible, but unsubstantiated — and it's a STRONGER claim than the old vague "short concierge step."
**file:line:** every surface (e.g. `README.md:9`, `site/pricing.html:164`, `site/faq.html`, `AGENTS.md:9`).
**Verification:** traced arming state in main `ROADMAP.md` (`:53` Stripe flip, `:136` engine/InboxKit arm, click-queue `GMAIL_OAUTH_GRANTS` still gated:founder, Mordy not onboarded).
**Recommendation (founder call):** soften to remove the empirical-turnaround implication — e.g. "a manual send-authorization step on our side (usually within a day)" — or drop the time qualifier until there's a completed-activation track record.

### 4. NON-BLOCKING · lens 1 + 2 (would-it-run) · "call POST /checkout with { mailboxes } (5-60)" under-explains the charge
**Failure scenario:** Copy juxtaposes the per-mailbox ladder ($99/5 … $649/60) with "call `POST /checkout` with `{ mailboxes }` (5-60)", implying the value sets the subscription size. In code, `input.mailboxes` is validated (5-60) but **unused** in `startCheckout` (`billing.ts:142-155`); the charge is `checkoutMailboxQuantity(ctx) = max(5, provisioned-count)` (`billing.ts:89-93,151`). A fresh tenant POSTing `{mailboxes:20}` gets a **$99 (5-mailbox)** Stripe session, not $249; the bill only rises as mailboxes actually provision.
**Why NON-BLOCKING (self-refuted down):** the machine-readable contract is honest — `openapi.yaml:52` says "$10 x **provisioned** mailboxes" — and the `docs.html` curl example uses `{"mailboxes":5}` (correct for a fresh tenant). No page states a false number; the gap is under-explanation of billing timing. Member of the [[coldstart-golive-ui-control-ignored-by-server]] class (input feeds a money endpoint but doesn't reach the immediate charge), but without the rendered confident-wrong "$X for N" quote that made the prior instance blocking.
**file:line:** `README.md:25`, `site/pricing.html:164`, `site/for-agents.html:135`, `site/llms.txt:44`, `site/docs.html` going-live block; code `apps/platform/src/engine/billing.ts:89-93,142-155`.
**Verification:** read `routes/checkout.ts`, `intents.ts:72` (`CheckoutInput`), `tenant-do.ts:617`, `billing.ts:82-93,142-155`.
**Recommendation:** add one clause — "the first charge is the 5-mailbox floor ($99); billing then tracks mailboxes as they provision."

---

## Attacks that failed (HELD)

- **$112 / $76.50 sourcing (lens 1):** `$112` appears verbatim in the frozen source `tools/buyer-panel/runs/2026-07-19-claude-starter.md:75/111/158` ("$80 Salesforge Growth + $30 Mailforge 10-slot min + ~$2.33 domains"), and `:77` states "$99 … cheaper than this cycle's $112/mo winner." The `$76.50–140` DIY band is the brief's ratified figure. Quoted accurately, and never claims the shopper *chose* Coldrig (pages concede Salesforge is the lower-risk pick on track record). HELD.
- **$0 per-send fee (lens 1):** `SEND_USAGE_FEE` is entirely gone from `apps/platform/src` and `packages/shared/src` (grep-confirmed) — fee deleted per founder ruling A (07-19). "$0 per-send fees" TRUE. HELD.
- **Stripe live / real cards (lens 3):** LIVE keys flipped 07-23 — `cs_live_` session, Stripe read-back `livemode:true`, `amount_total 9900`, line-item "Coldrig Launch" (ROADMAP `:53`); webhook secret LIVE since 07-23 (`:31`). "live billing (Stripe live mode, real cards)" TRUE. HELD.
- **Agency-scale falsification (lens 6):** every one of the 7 price surfaces (README, pricing, compare, compare-vs-salesforge, for-agents, llms.txt, faq, agent-evaluation) scopes the win to the 5–15 starter/solo shape AND explicitly concedes "at agency scale … does not win, and no claim is made." No unscoped superlative. HELD.
- **Waitlist consent (lens 8):** form promise was **weakened** ("activate real sending" → "product updates"), `waitlist.js` matches, `/api/waitlist` (`routes/waitlist.ts`) still durably stores the email in D1. No over-promise, no consent mismatch. `#waitlist`→`#get-started` rename left zero dangling anchors; `docs#going-live` target exists (`docs.html:64` TOC + `:107` heading). HELD.
- **Guard test non-vacuity (lens 5):** strict `concierge` ban across all 34 CLAIM_SURFACES (would fail on any reintroduction — proven by the green run, which requires all 34 clean), plus waitlist/early-access/request-activation bans on marketing surfaces with documented safe-pattern stripping; promo-code assertions pin the "Add promotion code" phrase. Non-vacuous **for its scope** (its scope-gap is finding #2). HELD.
- **Glama description (lens 1):** "25 MCP/HTTP tools / real sending live / $99 all-in / no guarantees ever" — all true, and it correctly says **25** (evidence the builder knew the count while leaving the site at 24). HELD.

---

## UNVERIFIABLE

- **Actual "same-day" turnaround** — no completed self-serve activation exists to measure; resolvable only after the first real customer (Mordy) completes provisioning + send-auth end-to-end.
- **Hand-merge resolution** — whether the human merger takes "25" at every 24-conflict site. Main's `site-tool-count-claims.test.ts` is the backstop, but I cannot pre-verify a resolution that hasn't happened. Running that guard on the merged tree resolves it.
- **dashboard/engine/shared exact test counts** — `tail` truncated their summaries; overall exit 0 confirms pass.

---

## NEW (out-of-scope) observations — no verdict weight

- `packages/cli` is `0.2.0` in the worktree but `0.2.1` on main; README/server-card "0.2.0" version strings are stale relative to main (same merge-gap class as the tool count).
- The `{ mailboxes }`-vs-charge gap (finding #4) is a broader product-truth question worth a founder ruling: `openapi.yaml` is honest ("provisioned"), marketing is loose. Deciding whether to document the "bill tracks provisioning" timing would close it cleanly.
