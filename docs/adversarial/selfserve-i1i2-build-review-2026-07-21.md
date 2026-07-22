# Adversarial re-attack — self-serve activation BUILD (I1 + I2)

- **Target lane:** worktree `.claude/worktrees/agent-ae74fe3cd5cdba531`, branch `worktree-agent-ae74fe3cd5cdba531`, commit **`7ef372d98e78371d578a567ee04d3bef49f3a360`** (`feat(activation): I1 product-driven activation gate + I2 promo checkout`), parent `fee873f`.
- **Reviewed against:** `docs/research/self-serve-activation-design-2026-07-21.md` (activation formula §2.1:87-91, §2.5, §2.6) and `docs/adversarial/selfserve-activation-design-review-2026-07-21.md` (F1/F2/F3 binding).
- **Posture:** refute-by-default, read-only git (log/diff/show only — no state mutation in the shared worktree), every candidate self-refuted before listing.
- **My own battery (run in the lane worktree, its own node_modules + .dev.vars):** `tsc --noEmit -p tsconfig.json` → **exit 0**. `vitest run` → **81 test files passed, 573 tests passed, 0 failed** (Duration 326.88s). Matches the builder's claimed 573/573 across 81 files. The `NotFoundError: checkout session … not found` lines in stderr are an intentional not-found-path test plus a known vitest-pool-workers unhandled-rejection double-report (documented at `checkout.test.ts:216-221`), not failures.

## VERDICT: **SHIP-after-fixes** (one BLOCKING finding survives self-refutation)

I1's gate formula is faithful to the design (verbatim), re-evaluates FRESH SQL on every `buildAdapters()` (F3 satisfied), the freeze/dispute/cancel lanes flip the gate off on the very next build, the `ENGINE_TENANTS` deletion is clean with no straggler callers, the adapter cache is tenant-scoped and cannot serve a stale sandbox email port to an activated tenant, and the new tests assert behavior (not existence). I2's promo restriction is enforced server-side and tested. **But F1 is NARROWED, not KILLED** — the builder guarded the wrong arming signal, leaving the original arming-order window (infra armed before Stripe live keys) fully open as a free real-spend activation bypass. That must be closed before this drives any prod arming.

---

## Findings (most severe first)

### 1 — BLOCKING · lens 1/8 (fail-open, regression ring) · F1 simulate bypass is NARROWED, not killed — the guard checks the payment-arming signal (`STRIPE_SECRET_KEY`) while the threat is the spend-arming signal (engine wired)

**What the builder did:** `GET /checkout/simulate` returns 404 when `c.env.STRIPE_SECRET_KEY` is set (`routes/checkout.ts:37-39`), and `completeSimulatedCheckout` throws when `ctx.env.STRIPE_SECRET_KEY` is set (`engine/billing.ts:84-86`). This closes the sub-case the design review named at vector (a): a stale pending session hit *after* live Stripe keys are configured.

**What survives — the original F1 arming-order window (design review vector b):** the design review's F1 explicitly included "if `ENGINE_BASE_URL`/InboxKit are armed BEFORE live Stripe keys, `startCheckout` still takes the simulated branch and the global-armed gate is already true, opening a live window." In that window **`STRIPE_SECRET_KEY` is UNSET**, so both guards are INERT. Concrete sequence (engine + `inboxKitConfig` armed, Stripe key not yet set):

1. Stranger self-serve signs up → demo tenant + bearer token (`routes/signup.ts`, rate-limited but open).
2. Stranger `POST /checkout {plan:"launch"}` → `STRIPE_SECRET_KEY` unset → simulated branch → returns their own simulate URL + session id (`engine/billing.ts:40-64`).
3. Stranger `GET /checkout/simulate?tenant=THEIRS&session=THEIRS` → route guard: `STRIPE_SECRET_KEY` unset → NOT 404 → proceeds → `completeSimulatedCheckout`: `STRIPE_SECRET_KEY` unset → NOT thrown → writes `plan='launch', billing_state='active'` (`engine/billing.ts:107-111`).
4. Next `buildAdapters()`: plan is paid, not demo/free → `readActivationState` → `isTenantActivated` = paid ∧ active ∧ not-frozen ∧ clear = **TRUE**; `engineConfig` present → `useRealEmail` TRUE (`factory.ts:105`) → **RealEmailPort**.
5. With `inboxKitConfig` also armed, `useSandbox` is false → real mailbox port → `setupInfrastructure`/`provisionMailboxesForDomain` → **real InboxKit mailbox buys = real vendor spend for $0, OFAC-unscreened** (screening stubbed `clear`). ENGINE_TENANTS is deleted, so no operator allowlist stands between the stranger and real spend.

There is **no code enforcing arming order**, and the code's own documentation asserts engine-first (`factory.ts:70`: "the founder already armed the engine first"), which is exactly this window. A symmetric reopening also exists if `STRIPE_SECRET_KEY` is ever transiently unset (key rotation) while the engine stays armed.

**Verification:** traced the route mount + both guards; confirmed both key off `STRIPE_SECRET_KEY` *presence*. The lane's OWN F1 test proves the residual: `checkout.test.ts:191-197` explicitly asserts that with `STRIPE_SECRET_KEY` unset the same session **still completes and writes `billing_state='active'`** ("legit" branch). The test only covers the key-SET case; the arming-order window is left demonstrated-open, not closed.

**Fix (the design review already prescribed it; the builder shipped only the weakest option):** gate the simulate route AND `completeSimulatedCheckout` on the **spend-arming** signal, not the payment-arming one — fail-closed the moment this environment CAN do real vendor spend, i.e. when `engineConfig` (`ENGINE_BASE_URL`/`ENGINE_AUTH_SECRET`) or `inboxKitConfig` is present, independent of `STRIPE_SECRET_KEY`. Equivalently: purge pending simulated sessions at arming AND add a positive "real-spend-armed" gate. A `STRIPE_SECRET_KEY`-only guard cannot close a window whose defining condition is that `STRIPE_SECRET_KEY` is absent.

**Cite:** `routes/checkout.ts:36-49`, `engine/billing.ts:78-111`, `vendors/factory.ts:105-108`, design review F1:16-20, lane test `checkout.test.ts:191-197`.

### 2 — NON-BLOCKING · lens 6 (design honesty) · a PAID + billing-active tenant with the engine unarmed silently gets the SANDBOX email port — fake-successful "sent" campaigns

`factory.ts:105` requires `engineConfig` too, so a genuinely activated paid tenant whose engine isn't wired yet gets `SandboxEmailPort` (`factory.ts:110`; `tenant-do.ts:321` returns real email only when `engineConfig()` is defined). The `account()` surface reports `plan` + `billingState='active'` but **no adapter-kind / "real sending not yet live" signal**, and the sandbox port simulates successful sends (`activation-gate.test.ts:129-142` proves the sandbox send "works" and returns a `@sandbox.local` messageId). So a tenant who has paid sees `active` + apparently-successful campaigns while **nothing real is sent** — a confident-wrong worse than a clean failure.

- **Why NON-BLOCKING for this pilot:** the single pilot is comped (100%-off, no real money paid) and the founder arms the engine before Mordy pays (documented order), so Mordy gets the real port. The builder's choice (sandbox fallback over a permanently-dark `NotActivatedError` port) is defensible for the *demo* experience.
- **Why it must be closed before public GA:** any real-paying self-serve tenant who pays before/without the engine armed (or during an engine outage/secret rotation) is silently simulated while charged. A paid+active+engine-unarmed tenant should surface an explicit "activation pending / infrastructure not yet live" state, not a silent sandbox success.

**Cite:** `factory.ts:56-70,105,110`, `tenant-do.ts:312-321`, `activation-gate.test.ts:129-142`.

### 3 — NON-BLOCKING · lens 6 · F2 aggregate-spend cap is enforceable only in the founder's Stripe coupon config (`max_redemptions`), not in code; the absolute-$ / tenant-count spend ceiling remains unbuilt

The plan-restriction half of F2 IS enforced in code and tested: promo params are set only for `launch` (`stripe-client.ts:44,90-96`; `stripe-client-checkout.test.ts:41-57` proves growth/scale get neither param). But the redemption cap that prevents *many* strangers from redeeming a leaked 100%-off code is a Stripe-dashboard control the code cannot enforce — the builder documents it as a REQUIRED COUPON CONSTRAINT at the call site (`stripe-client.ts:56-71`) for the arming runbook, which is the best achievable. Residual: if the founder mints the coupon without `max_redemptions:1`, F2's aggregate hole reopens, and the design's named "owner spend ceiling" (absolute-$/tenant-count) still does not exist (design Q2, founder-accepted deferral for the single pilot). Acceptable for one comped tenant; **must exist before signup opens to strangers.**

**Cite:** `stripe-client.ts:44,56-71,90-96`, design review F2:22-26, design Q2:179.

---

## Attacks that FAILED (why the residual is narrow)

- **Gate formula fidelity (attack 3):** `isTenantActivated` (`activation.ts:47-54`) is the design §2.1 formula verbatim — `isPaidPlanTier(plan) && billingState==='active' && !isLifecycleFrozen(status,billingState) && screening==='clear'`. HELD.
- **F3 fresh-SQL re-evaluation:** `buildAdapters()` calls `readActivationState` (a fresh `SELECT … FROM tenant_profile WHERE id=?`) on every non-demo/free call; the real/sandbox DECISION is never cached — only the sandbox INSTANCE is (`tenant-do.ts:295-321`). `activation-gate.test.ts:84-127` proves the swap both directions (active→RealEmailPort, past_due→SandboxEmailPort) within a single DO instance, and that the sandbox instance is the SAME object across calls. HELD.
- **Freeze/dispute/cancel flip the gate OFF next build:** `billing_state ∈ {disputed,canceling,canceled,past_due,none}` fails the `==='active'` conjunct directly, and `status='suspended'` is caught by `isLifecycleFrozen` (`billing-state.ts:31-33`). Webhook-driven `invoice.payment_failed`→past_due and `subscription.deleted`→canceled both flip `activated` false, TESTED end-to-end through the real webhook HTTP surface (`activation-gate.test.ts:148-197`). HELD.
- **Demo/free short-circuit fail-open (attack 3):** `tenant-do.ts:306` short-circuits on in-memory `this.plan`, but the dangerous direction (in-memory says paid, SQL says demo) is caught by the fresh read's `isPaidPlanTier(row.plan)` on the SQL value; the safe direction (in-memory demo, SQL paid) only over-restricts. `this.plan` is read fresh from SQL in the constructor (`:133`) and updated by every activation writer (`:258,541,547`). Cannot misclassify a paid tenant into real spend. HELD.
- **Adapter cache serves stale sandbox to an activated tenant (attack 6):** the cache is a per-DO-instance field (`sandboxAdapters`, tenant-scoped by construction); an activated tenant's email is rebuilt real on the very next call and every other port is intentionally sandbox (I3/I4 unbuilt). No path keeps an activated tenant on a cached sandbox email. HELD.
- **ENGINE_TENANTS straggler (attack 5):** the `env.ts` binding is deleted; grep across `apps/` finds ZERO code binding, ZERO `wrangler.toml` var, ZERO caller passing the removed `realAdaptersActivated`/`ENGINE_TENANTS`/`isEngineAllowlisted` params — only explanatory comments, the test README, and hard-builder agent-memory remain (all inert). `createVendorAdapters`'s new signature is called cleanly at `tenant-do.ts:297,321`. HELD. (Docs `ACTIVATION.md:26` known-stale, out of code scope.)
- **Tests are existence-theater (attack 8):** a gate returning true for a frozen tenant would FAIL `activation-gate.test.ts:37-39`; a simulate guard keying off the wrong env var would FAIL `checkout.test.ts:180-181` (sets `STRIPE_SECRET_KEY`, expects 404). Behavior-asserting confirmed.

## UNVERIFIABLE (needs a deployment fact / live vendor)

- **Does the pilot arm the EXISTING prod DO namespace** (giving finding 1 stale-session live ammo) **or a fresh DB, and in what arming order?** Not determinable from the repo. Finding 1's standing hole (engine-armed-before-Stripe window + transient key-unset) is independent of this and requires the code fix regardless.
- **Programmatic gmail_api OAuth mint (I3 long pole)** — not in this lane's scope (I1+I2 only); unverifiable without live InboxKit.

## NEW (out-of-scope) — no verdict weight

- `replyToThread` (`engine/threads.ts`) still sends with no independent freeze/cap check — it relies entirely on the §2.2 port-swap making `adapters.email` sandbox when not activated (design review F3/NEW). The port-swap IS implemented correctly here, so this is safe *as built*, but it becomes load-bearing the moment the concurrent warm-lead `schedule_followup` reuses that primitive. Flagged for the warm-lead integration, not this lane.

---

## ROUND 3 — re-attack of the F1 fix (commit `dc934e9`, parent `7ef372d`)

**Grounded at HEAD `dc934e99c30bb8f7efcb6c72a8f6506e18574999`** (`fix(F1): close the engine-armed-before-Stripe simulate bypass`). Read-only git. My own battery: `tsc --noEmit` → **exit 0**; `vitest run` → **exit 0, 81 files / 574 tests passed, 0 failed** (426s). Matches the builder's 574/574 (+1 vs round-2 = the new arming-order test).

### VERDICT (round 3): **CLEAN-SHIP** for the pilot scope — finding 1 (BLOCKING) is CLOSED. No BLOCKING findings survive.

**Finding 1 dies in every real-spend permutation.** The fix adds `isRealSpendArmed(env) = STRIPE_SECRET_KEY || (ENGINE_BASE_URL && ENGINE_AUTH_SECRET)` (`engine/billing.ts:37`) and wires it into BOTH the route guard (`routes/checkout.ts:44`) AND the DO-level defense-in-depth (`completeSimulatedCheckout`, `engine/billing.ts:109` — so the guard is not route-only). Traced all four permutations:

| Env state | `isRealSpendArmed` | Simulate | Real spend reachable? | Verdict |
|---|---|---|---|---|
| engine-only armed (the original hole) | true | 404 / throws | — | **CLOSED** |
| Stripe-only armed | true | 404 / throws | — | closed (was already) |
| both armed | true | 404 / throws | — | closed |
| neither armed | false | OPEN | NO — `useRealEmail` needs `engineConfig`, mailbox needs `inboxKitConfig` (unbindable); both fall to sandbox | safe-open (test-mode) |

The engine arm mirrors `engineConfig()` exactly (both require `ENGINE_BASE_URL` AND `ENGINE_AUTH_SECRET`), so a partial-engine state (`BASE` set, `AUTH` unset) is inert on both sides — no drift. The simulate path is the ONLY unauthenticated writer of `billing_state='active'` (grep-confirmed: the other two writers are the signature-gated webhook handlers), and `completeSimulatedCheckout` has no caller other than the guarded route → no bypass path. **My round-2 finding 1 is closed; verified by tracing, not by trusting the commit message.**

**New test quality (Q3): end-to-end, RED-proven.** `checkout.test.ts` (round-2 test, `+it("...ENGINE is armed even though STRIPE_SECRET_KEY is still unset...")`) reproduces my exact exploit — sets `ENGINE_BASE_URL`/`ENGINE_AUTH_SECRET`, forces `STRIPE_SECRET_KEY = undefined` ("the defining condition of the original window") — and asserts BOTH surfaces (`res.status === 404` AND `completeCheckoutSimulated` throws) PLUS the end state (`billing_state` stays `none`, `plan` stays `demo`). Against the old `7ef372d` guard (`if (c.env.STRIPE_SECRET_KEY)`), that case returns 200 and writes `active` → the test's three assertions all fail → genuine FAILS-on-old-code (verified by tracing the old guard I read in round 2, not by mutating the shared worktree).

### Round-3 findings

**R3-1 — NON-BLOCKING (does not block `dc934e9`) · lens 6/7 · InboxKit deferral is safe TODAY, but a doc comment is an insufficient systemic guard for a spend-bypass class.**
Verified the builder's claim: grep finds ZERO `INBOXKIT_*` env binding in `env.ts`/`wrangler.toml` (the only `INBOXKIT_` hits are the hardcoded `INBOXKIT_DEFAULT_BASE_URL`/`INBOXKIT_VENDOR` constants + the doc comment). No call site supplies `inboxKitConfig`, so the real mailbox/domain ports are structurally unreachable → the bypass window CANNOT exist on the InboxKit vendor today. **Deferral is acceptable** (nothing to check). **But** `isRealSpendArmed` is a hand-maintained list that must stay in sync with "what env signals arm a real spend port," and today the only re-introduction guard is a doc comment (`billing.ts:32-35`) telling a future builder to remember. Per CLAUDE.md Bug Response ("systemic guard against re-introduction" for correctness/spend/security defects), a comment relying on future-builder diligence is the weakest guard for the single highest-stakes class in this lane. **Ruling: when I3/I4 lands `INBOXKIT_API_KEY`/`INBOXKIT_WORKSPACE_ID`, a failing-by-construction check is required** — e.g. a test asserting that every vendor-arming env field declared in `env.ts` (any `INBOXKIT_*`, or a maintained allowlist) is referenced by `isRealSpendArmed`, so the class trips a RED test instead of silently reopening on the mailbox vendor. This is a finding for the I3/I4 lane, not a fix for this commit.

### Carried NON-BLOCKING items (unchanged by `dc934e9`, GA-scoped, not pilot blockers)
- Round-2 finding 2 (silent sandbox for a paid+engine-unarmed tenant — surface a "pending activation" state before public GA).
- Round-2 finding 3 (F2 `max_redemptions` is Stripe-dashboard-only; absolute-$ owner ceiling unbuilt — required before stranger signup).
