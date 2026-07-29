# Adversarial review — registrar arming + registrant capture (combined diff)

- **Date:** 2026-07-28
- **Reviewer:** adversary (fresh context)
- **Worktree:** `/Users/yaakovscher/dev/coldstart/.claude/worktrees/agent-ae2d6f14e41fd6a02`
- **Branch / base HEAD:** `worktree-agent-ae2d6f14e41fd6a02` @ `f52ee61` (all changes uncommitted on disk)
- **Gates:** production deploy to the live paying-customer Worker; on SHIP the diff merges, deploys, and `REGISTRAR_PROVIDER=inboxkit` is armed → real InboxKit-wallet domain purchases become reachable.

## VERDICT: NO-SHIP (1 BLOCKING)

Battery is genuinely green (1109/1109 platform, typecheck clean across all workspaces) and the four priority-attack surfaces the brief called out (MCP refinement drop, two-leg decouple, spend choke, migration safety) all HELD on re-derivation. The blocker is a **new** class the suite cannot see: the registrar-arming state is read **one call stale**, so the very feature this deploy arms does not function on its intended primary path and its founder-mandated per-tenant control is off-by-one in both directions. No *unconsented or unbounded* spend is reachable (the spend ceiling still governs and the unsafe direction requires prior persisted consent) — so the narrow money-safety bar is not breached — but arming a real-money feature in this state is not ship-ready.

---

## BLOCKING

### B1 · lens 2 (run it) + lens 5 (fixture realism) · Registrar-arming state is read one call stale — primary opt-in flow returns a false 503, opt-out still spends

**Root cause.** `TenantDO.setupInfrastructure` calls `requireContext()` → `buildAdapters()` (`tenant-do.ts:437,445`) which reads `tenant_profile.register_domains` + `registrant_json` via `readRegistrarArming` (`tenant-do.ts:403`) to (a) pick the domain port and (b) bake the registrant into `RealInboxKitDomainPort`. Only **afterward** does `runSetupInfrastructure` run the `UPDATE tenant_profile SET … register_domains = ?, registrant_json = ?` (`provisioning.ts:252`) that persists **this call's** opt-in + registrant. `register_domains` has no other writer (grep: only `provisioning.ts:252`), so the adapter always reflects the **pre-call** profile. The pre-flight (`provisioning.ts:174`, `if (ctx.adapters.domain instanceof RealInboxKitDomainPort) assertCompleteRegistrant(readRegistrarOptInState(...).registrant)`) re-reads only registrant **completeness** from a fresh SQL read — it never re-selects the port and never passes the fresh registrant into `buy()` (which uses the construction-time baked registrant).

**Failure scenario a — primary flow broken (SAFE, but defeats the deploy's purpose). VERIFIED by running it.**
Fresh activated `managed` tenant, `REGISTRAR_PROVIDER=inboxkit` + InboxKit creds armed, single HTTP `POST /setup-infrastructure` with `registerDomains:true` + a complete `registrant`:
- Result: **HTTP 503** `{code:"registrar_unarmed"}`, `searchLookalikes` fetch count **0**, `/domains/register` (buy) count **0**. `buildAdapters` read `register_domains=0` → handed out `RegistrarUnarmedDomainPort`, whose `searchLookalikes` throws `RegistrarUnarmedError` (`domain-port.ts:37`) → caught in `provisioning.ts` → `alertRegistrarUnarmed` fires a **false "registrar unarmed" founder alert** (the registrar IS armed; the tenant just opted in this call) → rethrown → `index.ts` maps to 503.
- The `UPDATE` at `provisioning.ts:252` commits `register_domains=1` **before** the throw, so a **second** identical call succeeds. Net: the documented single-call opt-in+buy fails on first use with a misleading 503 + false founder alert; it silently requires a retry. (If the agent follows the tool's "resend the same idempotencyKey on retry" guidance, whether the retry re-runs or replays the recorded 503 depends on `withRequestIdempotency`'s on-error semantics — untested here; worth confirming.)

**Failure scenario b — opt-out ignored one call, real spend, stale registrant filed (money direction). VERIFIED by running it.**
Reachable precondition: a prior successful opt-in persisted `register_domains=1` + registrant R1. This call sends `registerDomains:false` + a *different* complete registrant R2 (schema permits `registrant` when `registerDomains` is false — it's `.optional()`, only *required* when true):
- Result: `/domains/register` (buy) count **1** — a **real domain purchase fired despite `registerDomains:false` this call**. The `contact_details.first_name` filed with InboxKit was **R1 ("Alice"), not the R2 ("Bob") supplied and validated this call** — the pre-flight `assertCompleteRegistrant` validated fresh R2 (persisted by this call's UPDATE) while `buy()` sent the adapter's construction-time baked R1. TOCTOU: validate-fresh, buy-stale. The request then returned 500 after the buy (partly a mock artifact, but the buy-before-error shape is real → double-buy risk on agent retry).
- The completeness guarantee the code advertises ("never send a partially-blank `contact_details` payload to InboxKit", `registrar-arming.ts:110`) is thus enforced against a *different* registrant than the one actually transmitted. In the not-API-reachable-post-deploy edge (`register_domains=1` + `registrant_json=null`, only via an out-of-band write — exactly the builder's own test (d) fixture), the baked registrant is *incomplete*, so `buy()`'s coarse `if (!this.registrant)` (a non-null partial object) passes and a **blank-field** `contact_details` would be sent.

**Money-safety caveat (stated so the team can make an informed call).** This is graded BLOCKING for *feature-correctness + control-integrity*, not because the strict money bar is breached: the spend ceiling still governs every domain buy (test `(d)`, `withSpendCeiling("domain", …)` — ceiling-exceeded is blocked before any vendor call with zero reservation leak), and scenario-b spend requires *prior persisted consent* (`register_domains=1`), so no truly-unconsented or unbounded spend is reachable. If the team judges "broken-but-spend-bounded" acceptable to arm, that is a defensible override — but as delivered the primary flow does not work and the per-tenant opt-in/opt-out control is off-by-one in both directions.

**Why the green suite misses it (lens 5).** Every opt-in *success* test constructs `createVendorAdapters(...)` with a hand-built `{armed, optIn, registrant}` (tests a/b/c, incomplete-registrant, spend) or pre-seeds `register_domains=1` via an out-of-band `UPDATE` in a *separate* `runInDurableObject` block before building adapters (`registrar-arming.test.ts:167,354`, and test `(d)` whose own comment at :473-481 documents that `buildAdapters()` reads the row "BEFORE this call's own persistence write runs"). No test drives a fresh tenant sending `registerDomains:true`+registrant in one HTTP call to a real buy. The builder knew `buildAdapters` reads pre-UPDATE but only exercised the already-`register_domains=1` state.

**Suggested fix (needs re-attack).** Read/construct the registrar arming **after** the `tenant_profile` UPDATE within `setup_infrastructure` (rebuild or refresh the domain port from the just-persisted row), or at the pre-flight re-select the port from a fresh `readRegistrarArming` (re-checking `armed && optIn`, not just registrant completeness) and pass the fresh registrant into `buy()`. Any fix touches the request lifecycle → re-review required.

---

## Attacks that HELD (self-refutation complete)

- **Lens 8 / brief #1 — MCP `.extend()` refinement drop.** *Tried:* the brief's premise (zod `.extend()` silently drops `.superRefine()`). *Held because:* this repo is **zod v4** (`4.4.3`), where `.superRefine()` returns a `ZodObject` (not v3's `ZodEffects`) and `.extend()` **preserves** the refinement. Verified both in isolation and against the real schema: `SetupInfrastructureToolInput` (= `SetupInfrastructureInput.extend({idempotencyKey})`, `schemas.ts:44`) rejects `{registerDomains:true}` with no registrant AND rejects a partial registrant, identically to the HTTP-path `SetupInfrastructureInput`. Both surfaces parse through the same refined schema (`routes/infrastructure.ts:9`). No agent-facing bypass. Typecheck clean confirms `.extend()` on the refined type compiles.
- **Brief #2 — two-leg decouple.** `useInboxKitRegistrar = Boolean(registrarArming?.armed && registrarArming?.optIn)` (`factory.ts`). armed-without-optIn → `RegistrarUnarmedDomainPort` (test a; my single-call repro 503'd through it); optIn-without-armed → hard-block (test b). The real branch is only reached when `useSandbox` is false (⇒ `inboxKitConfig` present), so `RealInboxKitDomainPort(inboxKitConfig, …)` never gets an undefined config. **No other port widened:** the factory `return {kind:"real"}` block changed only the `domain:` line — `mailbox/email/billing/metrics/dnsScan/reputation` are byte-identical.
- **Brief #3 — spend choke (for the tested cases).** Ceiling-exceeded domain buy → `CapacityPendingError` before the vendor callback runs, `reserved_cents=0`/`committed_cents=0` (test d, real `withSpendCeiling`). Incomplete-registrant pre-flight throws before any `withSpendCeiling` reservation and before any fetch (`fetchSpy` not called, `vendor_spend_entries` count 0). (The validate-fresh/buy-stale TOCTOU is folded into B1, not counted here.)
- **Brief #4 — registrant data integrity.** `Registrant` fields are length-bounded (`.max()` 200/500/50/100/20…); `parseRegistrantJson` is try/catch → `null` on corrupt/truncated input (non-throwing, as claimed); error bodies name **field names only** (`missing.join`, `IncompleteRegistrantError.missingFields`) — no registrant **values** are echoed. Strings go to InboxKit as a JSON body (`JSON.stringify`-escaped) — not an injection vector.
- **Brief #5 — migration safety.** `ensureColumnMigrations()` runs in the DO **constructor** (`tenant-do.ts:136`) before any request handler; `addColumnIfMissing("tenant_profile","register_domains","INTEGER NOT NULL DEFAULT 0")` + `("registrant_json","TEXT")` are idempotent and nullable/defaulted → safe on Mordy's pre-existing DO with rows predating both columns. No SELECT of either column runs before the migration.
- **Brief #6 — test honesty (assertion, not existence).** Tests assert real behavior: real HTTP facade for backward-compat `(c)` and stale-row `(d)`; real `withSpendCeiling` ledger rows for `(d)`-spend; a fixture-level assertion on the exact outbound `/domains/register` `contact_details` body `(b)`. Not coverage theater — but see B1 for the systematic single-call-path gap.
- **Brief #7 — battery.** `npm run typecheck` clean (all 5 workspaces). `npx vitest run` in `apps/platform`: **Test Files 120 passed (120), Tests 1109 passed (1109)**, duration 224s. The builder's green claim holds this run (contrast the sibling token lane's false-green earlier today).

## UNVERIFIABLE (environment gaps)

- `withRequestIdempotency` on-error semantics for a **retry after the scenario-a 503** (does a same-key retry re-run or replay the recorded error?) — determines whether the tool's "resend the same idempotencyKey" guidance strands the feature or recovers it. Not driven here.
- Whether InboxKit mailbox creds (`INBOXKIT_API_KEY`/`WORKSPACE_ID`) are actually armed at this deploy. If they are NOT, `useSandbox` stays true and the domain port never goes real regardless — no real domain spend reachable. The brief states the arm makes purchases reachable, so B1 is reviewed as reachable.
- Live InboxKit `/domains/register` wire shape — fixtures are documented captures (2026-07-20), not re-verified against the live vendor this pass.

## NEW / out-of-scope (no verdict weight)

- `Registrant.email` has no explicit `.max()` (format-constrained by `.email()` only) — minor; other fields bounded.
- Opt-out with **no** registrant (register_domains=1 persisted) returns a spurious `400 incomplete_registrant` (confusing but safe) — same root cause as B1, listed for completeness.
- `env.ts` comment note about `isRealSpendArmed` treating the env as arming even if the ceiling is bypassed — pre-existing, unchanged.

---

# Round 2 — B1 fix re-attack (2026-07-29)

## VERDICT: SHIP

B1 (the sole round-1 blocker) is **closed in both directions** with no regression. Independent repros driving the real single HTTP `POST /setup-infrastructure` confirm THIS call's opt-in + registrant is now authoritative at buy time; the two-leg decouple, sandbox-dominance, and env-leg guards all hold; battery green (1113/1113 platform, +4 new B1 e2e tests) and typecheck clean (builder's claim verified by re-running, not trusted).

## What changed (verified)
- `factory.ts` — extracted `selectRealDomainPort(inboxKitConfig, registrarArming)` as the single two-leg gate (`Boolean(armed && optIn)`); `createVendorAdapters`' real branch calls it. Byte-identical selection to round 1.
- `tenant-do.ts` — `setupInfrastructure` builds a local ctx replacing **only** the domain port via `selectSetupDomainPort(base.adapters, input)`: sandbox bundles returned untouched (`if (bundle.kind !== "real") return bundle.domain`); real-eligible bundles re-run `selectRealDomainPort` with `{armed: env leg, optIn: THIS call's input.registerDomains, registrant: deriveInboxKitRegistrant(THIS call's input)}`. All other ports spread unchanged.
- Test (d) rewritten + 4 net-new B1 end-to-end HTTP tests.

## Round-2 repros (all RAN, real HTTP facade, fetch mocked, buys counted + filed registrant inspected)
| # | scenario | result | check |
|---|---|---|---|
| i | fresh activated tenant, env armed, ONE call `{registerDomains:true, registrant:R2}` | buy=1, filed **R2**, not-503 | opt-in works same-call, no false 503/alert |
| ii | persisted opt-in `register_domains=1`+R1, ONE call `{registerDomains:false, registrant:R2}` | **buy=0**, 503, persists reg=0/R2 | money leak CLOSED — opt-out no longer buys |
| iii | persisted R1, ONE call `{registerDomains:true, registrant:R2}` | buy=1, filed **R2 not R1** | TOCTOU CLOSED (validate-fresh == buy value) |
| iv | sandbox-eligible (unactivated) tenant, `registerDomains:true`, env armed | **realBuy=0**, 202 | sandbox-eligibility dominates |
| v | env unset (`REGISTRAR_PROVIDER` absent) + activated + `{registerDomains:true, registrant:complete}` | **buy=0**, 503 | env leg inviolable |

## Seam attacks that HELD (self-refutation complete)
- **`selectSetupDomainPort` widening.** Cannot flip a sandbox tenant to a real port: `bundle.kind !== "real"` returns the (cached) sandbox domain untouched regardless of `registerDomains:true` — verified (iv). A `kind:"real"` bundle guarantees `useSandbox===false` ⇒ `inboxKitConfig` present, so `selectRealDomainPort(this.inboxKitConfig(), …)` never gets an undefined config.
- **Fresh-ctx leak.** The replaced-domain ctx is a local const passed only to this call's `runSetupInfrastructure`; every other intent calls `requireContext()`→`buildAdapters()`→persisted-state domain port, so REPLACE_DOMAIN/burn flows keep persisted-state authority. The `{...base.adapters, domain}` spread creates a new bundle object without mutating `this.sandboxAdapters` (the sandbox domain instance is reused by reference, preserving in-memory state).
- **Selection-vs-pre-flight registrant disagreement.** The port's baked registrant is `deriveInboxKitRegistrant` of THIS call's input; the `provisionDomainWithMailboxes` pre-flight validates `deriveInboxKitRegistrant` of the **just-persisted row** — and the UPDATE writes `input.brand/physicalAddress/senderIdentity/registrant_json` verbatim before the pre-flight runs, so the two derivations are identical (including the `organization ← brand` fallback). The pre-flight validates exactly what `buy()` sends. No reachable disagreement found.
- **Env-leg inviolability.** `armed = isInboxKitRegistrarArmed(env)`; env unset ⇒ `selectRealDomainPort` returns `RegistrarUnarmedDomainPort` regardless of the call's opt-in — verified (v).
- **MCP parity.** The MCP `setup_infrastructure` tool dispatches to the same `stub.setupInfrastructure(args, idempotencyKey)` method (`mcp/tools.ts`), so the per-call re-selection applies identically; the MCP schema still rejects `registerDomains:true` without a registrant (round-1 zod-v4 finding). Structurally guaranteed by the shared method.
- **Rewritten test semantics.** Test (d) now asserts the **decided** semantics (orchestrator ruling: current-call authority) — a stale `register_domains=1` row + a call omitting `registerDomains` → 503 hard-block, zero buys, **not** `incomplete_registrant`. The comment explains the shift and that the `incomplete_registrant→400` mapping is now reachable only via persisted-state flows. This is the ruling, not fitted-to-code.
- **The 500 on repros i/iii is NOT a B1 defect.** Captured the raw throw: `VendorError: inboxkit keyword search … returned a NON-EXACT match … refusing to act on the wrong mailbox` at `RealMailboxPort.resolveMailboxUid` ← `startWarmup` — a real-**mailbox** warmup failure caused by the `IK_MAILBOX_LIST_SUCCESS` fixture returning an unrelated hardcoded mailbox. The domain buy succeeded (buy=1); the failure is downstream, gated on separate INBOXKIT arming. This is exactly the builder's "orthogonal to B1" note (their tests assert `not.toBe(503)` + buy/registrant, not `toBe(202)`).

## Adjudicated-by-orchestrator (noted, not gated)
- `incomplete_registrant→400` (index.ts) is now HTTP-unreachable for a fresh setup call (current-call authority hard-blocks first); kept as defense-in-depth for persisted-state flows. Accepted.
- Opt-out on a real-eligible tenant 503s with the pre-existing "registrar not armed" wording — imprecise for an opt-out, accepted polish follow-up.

## NEW / out-of-scope (don't gate; team awareness)
- **Torn provision / double-buy risk (pre-existing, not this diff).** In the synchronous B0 saga the domain buy commits (real spend) BEFORE mailbox creation + warmup; a downstream throw returns non-2xx with the domain already bought, and `RealInboxKitDomainPort.buy` ignores its `_idempotencyKey`, so an agent retry re-buys. Property of the real mailbox+domain provisioning saga (gated on INBOXKIT arming; B2 async saga is future scope) — arming the registrar is what makes it reachable, so flag for awareness.
- **`register_domains` rewritten every setup call** (`input.registerDomains ? 1 : 0`): a normal setup call omitting `registerDomains` resets a prior opt-in to 0, and a registrar-using tenant must include `registerDomains:true`+registrant on **every** setup call (setup always buys domains) or it 503s. Intended under current-call-authority + safe-direction, but a documentation-worthy footgun. Pre-existing UPDATE behavior, unchanged by the fix.
