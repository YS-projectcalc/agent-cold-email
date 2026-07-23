# Adversarial design review — GA Gates (G1–G4)

**Reviewer:** adversary (fresh context) · **Date:** 2026-07-23
**Target:** `docs/research/ga-gates-design-2026-07-22.md`
**Ground ref:** `main` @ `62e3fc6` (committed). I3/I4 worktree reviewed at `.claude/worktrees/agent-a8f87cd1437a20f72` @ `a38fae3` (the tree this design merges after).
**Read-only git; no deploys; no secrets; no live vendor/Stripe calls.**

## VERDICT: SHIP-AFTER-FIXES — 2 BLOCKING

The design's spend choke-point (G0/G2), review-not-reject OFAC posture (G1), grandfathering, and the two-concurrent-reserve atomicity claim are sound and buildable. Two blocking defects must be fixed **in the design** before the build lane opens; both are localized and fixable-in-design (not fundamental), so this is not a NO-SHIP.

---

## Findings

### BLOCKING

**B1 · lens 4 (deploy/arm-time plumbing) + lens 1 (spec-vs-code) · Gate (a) is entirely absent from the wave, yet the founder ruled it BLOCKS credential-push activation.**

- **Ruling:** `ROADMAP.md:19` — "ADDED TO PROGRAM: gate (a) separate domain-port arming flag (registrarConfig decoupling, S) is still UNBUILT and now **BLOCKS credential-push activation** — build it in the GA-gates wave (or a micro-lane at I3 merge)." `ROADMAP.md:33`/`:43` define it: the domain port must get its own `registrarConfig` distinct from the mailbox `inboxKitConfig`, Cloudflare Registrar as default, InboxKit-as-registrar per-tenant opt-in only.
- **Verification (traced both trees):** the micro-lane-at-I3 option was **not taken** — grep for `registrarConfig` returns zero code matches in `main` and zero in the I3/I4 worktree (`a8f87cd`); `apps/platform/src/vendors/factory.ts:137` in both still reads `domain: inboxKitConfig ? new RealInboxKitDomainPort(...) : new RealDomainPort()`. So the domain port is still welded to the mailbox credential in every tree. The GA-gates design's build increments (G0–G4, doc §"Ordered build increments") do not include it, and the design never even names it as a dependency — the only registrar mention is a passing spend-site cost note (design line 26).
- **Failure scenario:** the go-live program's authorized autonomous arming (`ROADMAP.md:19`) sets `INBOXKIT_API_KEY`/`INBOXKIT_WORKSPACE_ID` to enable real mailbox provisioning. The moment `inboxKitConfig` is present, `factory.ts:137` **also** constructs `RealInboxKitDomainPort`, so `domain.buy` (which the design's own spend inventory, line 26, lists as a money-out site) routes to InboxKit `/domains/register` — silently making InboxKit the registrar, the exact posture `ROADMAP.md:33` forbids ("never inherited from the mailbox credential"). Compounding it: the fallback `RealDomainPort` arm is a **Porkbun** stub (`ROADMAP.md:33`: "stubbed against Porkbun … needs a rewrite against Cloudflare Registrar"), a registrar the founder DROPPED. So the wave arms a domain-buy path whose registrar selection is wrong and whose default adapter targets a dropped vendor. Reachable at GA scope: the Mordy pilot connects an existing domain (no buy), but "ready for all customers" means a stranger running `setup_infrastructure` triggers lookalike `domain.buy` → wrong registrar.
- **Site:** design build increments (omission); `apps/platform/src/vendors/factory.ts:137`; `ROADMAP.md:19,33,43`.
- **Fix:** add gate (a) as an explicit S-sized increment in this wave — the `registrarConfig` decoupling in `factory.ts` **and** the `RealDomainPort` rewrite against Cloudflare Registrar (`apps/platform/src/vendors/real/domain-port.ts:4`, currently Porkbun) — or hard-block the domain-buy spend path until it lands. The design must not wrap-and-arm `domain.buy` while its registrar selection is defective.

**B2 · lens 1 (spec-vs-code line-trace) + lens 5/7 (fixture/regression) · G3's `realSendPathLive` formula drops the InboxKit conjunct its own prose requires → reintroduces the confident-wrong G3 exists to kill.**

- **Contradiction inside the design:** prose (line 100) names the confident-wrong as a paid tenant "whose real send path isn't live (engine unarmed, **or InboxKit unbound**, or in screening 'review')". The load-bearing formula (line 114) then defines `realSendPathLive(env) = engineConfig present` **only** — dropping the InboxKit conjunct — and mislabels it "the same conjunct the factory uses to hand out a real email port." That is true for the *email* port, but a real end-to-end *send* also needs real mailboxes (`factory.ts:108`: `useSandbox = … || !inboxKitConfig`); the email port alone is not the send path.
- **Failure scenario:** a paid, `billing_state='active'`, screened-clear tenant with `ENGINE_BASE_URL`/`ENGINE_AUTH_SECRET` armed but `INBOXKIT_API_KEY` not yet armed (a real steady state — arming is per-secret `wrangler secret put`, engine-then-InboxKit per the documented order) gets a **real** `RealEmailPort` but **sandbox** mailboxes (fake, never created upstream). The formula derives `realSendPathLive=true` → G3 reports `'active'` while sends reference nonexistent mailboxes and nothing really leaves — the exact "shows active while sends don't leave" confident-wrong G3 is built to eliminate, now recreated for the engine-armed-InboxKit-unbound window.
- **Guard blesses the hole:** the design's own systemic-guard test (line 167) only asserts the `engineConfig`-UNSET case reports `pending_provisioning`. It never covers `engineConfig` SET + InboxKit UNSET, so the guard is aligned with the buggy formula and would pass. (Same class as prior fixture-encodes-the-blind-spot escapes.)
- **Site:** design lines 100 vs 104–114 vs 167; `apps/platform/src/vendors/factory.ts:105,108`.
- **Fix:** define `realSendPathLive(env) = engineConfig present && inboxKitConfig present` (the full real-send conjunction the factory actually requires), and extend the G3 guard test to the engine-armed-InboxKit-unbound case.

### NON-BLOCKING

**N1 · lens 6 (attack the design) · Screening site vs. operative sending identity mismatch.** G1 screens the **signup** brand + contact email at checkout (`billing.ts`). But `tenant_profile.brand` is **overwritten** at `setup_infrastructure` (`provisioning.ts:167`, `SET brand = ?, primary_domain = ?, …`), which runs *after* activation, and `primary_domain` is not populated until then either. So the platform screens a field that isn't the one the tenant ultimately sends under, and a tenant can screen-clean at checkout then set a sanctioned brand at `setup_infrastructure`, never re-screened. Recommend screening at (or additionally at) `setup_infrastructure` where the real sending identity is finalized; if kept at checkout only, the honesty statement (N4) must say the operative brand is not re-screened.

**N2 · lens 2 (would it run) + founder ceiling-race lens · Reservation leak: the ceiling is not crash/replay-safe.** The two-concurrent-reserve race IS closed by the single conditional D1 UPDATE (attack held, below). But `reserved_cents` is stranded if the TenantDO dies between reserve (D1 write) and commit/release, or when the I3/I4 `withRequestIdempotency` replay returns the recorded result without re-entering `withSpendCeiling` to move reserved→committed. No TTL/reconcile is specified. Direction is fail-CLOSED (over-restricts, never over-spends), so it is not a spend-safety blocker, but over time leaked reservations silently shrink the effective ceiling and generate false `capacity_pending` alerts. The design's "atomic, no TOCTOU" claim is true for concurrency but oversells crash-safety. Add a reservation TTL + reconcile sweep.

**N3 · founder false-positive-flood + money-path lens · Subset-token match + paid-but-held remedy unspecified.** The v1 match ("every token of an SDN name present in the tenant brand, for names ≥2 tokens") will collide on common 2-token SDN names against a free-text brand, risking a flood into the single founder inbox. Independently: a false-positive strands a **paying** tenant on sandbox (Stripe charged, sandbox delivered) with no refund path or review SLA specified. Founder-ruled operationally (watchtower alert + manual clear), so non-blocking, but add a token-specificity guard (min token length / drop ultra-common tokens / require the full SDN name as a contiguous substring) and specify the money remedy (auto-refund on reject, or a stated review SLA).

**N4 · founder overclaim lens · Missing explicit "what OFAC v1 does NOT catch" statement.** Customer copy is honest ("account review", no OFAC-compliance claim — good). But the design/founder-facing ledger should spell out the honest limits so no external claim overstates: v1 misses transliteration/phonetic/alias/single-token variants, does not re-screen brand mutation (N1), and is a review-trigger, not a compliance certification.

**Minor (fold into fixes, not separately blocking):**
- G3 derivation branch order puts `screening_hold` before the billing-freeze branch, so a disputed+in-review tenant shows "account review" and masks the dispute freeze. Low severity.
- The "fire a direct one-shot ops mail at the review-write moment" option (design line 58) may not be buildable — `OpsMailer` is invoked from the Worker `scheduled()`/watchtower context (`admin/watchtower.ts:156,207`), not obviously constructible inside the TenantDO at checkout. Commit to the sweep-signal path (also offered).
- G2 must specify `period_key` row seeding/upsert; the reserve UPDATE fails-closed (blocks all spend) if the period row doesn't exist yet.

---

## Attacks that failed (why the PASS-able parts are meaningful)

- **[coldstart-simulate-spend, my standing class] Does this design re-arm the simulate route as a spend authorizer?** No. The F1 fix is present and correct in the merged tree: `isRealSpendArmed = STRIPE_SECRET_KEY || (ENGINE_BASE_URL && ENGINE_AUTH_SECRET)` (`billing.ts:37`) gates both `routes/checkout.ts` and `completeSimulatedCheckout` (`billing.ts:109`, throws once real spend is armed). G1 adds screening at both write sites; billing_state='active' reached via `subscription.updated`/dispute-won reuses the persisted `screening_status`. No new re-arming introduced. Held.
- **Is the brand a bootstrap placeholder at checkout (screening theater)?** Refuted. `signup.ts:48,57` captures the real user-supplied `brand` into both the D1 tenant index and `tenant_profile` at signup — G1 screens real data, not the DO-bootstrap fallback. (The later `setup_infrastructure` overwrite is a separate, real gap — N1 — but the checkout-time screen is not theater.)
- **G2 two-concurrent-reserve TOCTOU.** The single conditional `UPDATE … WHERE reserved+committed+est <= ceiling` on D1 (single-writer SQLite) genuinely serializes; two joint-over-ceiling reserves cannot both write. Held. (Only crash-safety is weak — N2.)
- **Auto-upgrade coupled to the OPEN quantity-billing migration.** Refuted as coupling: G4 auto-upgrade draws InboxKit wallet overage — it changes OUR vendor cost, not the customer's Stripe charge (plan price is fixed per tier; per-tenant provisioning is quota-capped by `assertWithinProvisioningCap`). Decoupled from the unbuilt quantity-billing work. Held. (Design should state this explicitly.)
- **I3/I4 collision accuracy.** The design's collision table matches the real `a8f87cd` tree: `provisioning.ts` `withRequestIdempotency` + `maybePushProvisionedMailbox` present (`:58`, `:9`), env `// spend-arming` markers, `isRealSpendArmed` InboxKit-leg note. Held.

---

## UNVERIFIABLE (needs live vendor account / real data — not foldable into the verdict)

- **G4 slot overage semantics:** whether InboxKit `/mailboxes/buy` past 10 slots draws wallet overage vs hard-fails, and whether a plan-upgrade API exists. The design's attempt-then-`capacity_pending` fallback is correct either way, so this is genuinely arming-time-deferrable. **Resolves at:** the gate-(e) throwaway-mailbox probe (`ROADMAP.md:19,43`).
- **G1a cron CPU budget:** whether parsing ~10MB / ~17k-row `SDN.CSV` + shadow-swap upsert fits the Worker cron CPU/subrequest limits. The design flags batched-shadow-swap but the budget isn't provable without running it. **Resolves at:** a spike parsing the real SDN.CSV in a Worker before committing to the piggyback-cron.

---

## NEW (out-of-scope) observations — no verdict weight

- `apps/platform/src/vendors/real/domain-port.ts:4` being a Porkbun stub (dropped registrar) is a live gap the whole domain-registration path depends on, surfaced here via B1 but broader than the GA-gates wave — flagging so it is not lost if B1 is scoped narrowly.

---

## G5 build review — 2026-07-23

**Reviewer:** adversary (fresh re-attack) · **Target:** the build closing B1 (gate (a) domain-registrar decoupling).
**Ground ref:** branch `worktree-g5-gate-a-20260723` @ `e7272ec`, worktree `/Users/yaakovscher/dev/coldstart/.claude/worktrees/g5-gate-a-20260723`, on `main` @ `24d9436` (post-I3+I4 merge). Scope = decouple + hard-block only (CF adapter deferred to GA wave, per the 2026-07-23 scope note) — my accepted B1 fallback.
**Read-only git; ran suites/typecheck locally; no live calls.**

### VERDICT: SHIP (0 blocking) — safe to merge and to proceed to the INBOXKIT_* secret-arming this gates.

B1 is proven closed at two independent layers, with a standing tripwire that locks it. Two non-blocking findings exist, but both are structurally dark until a *future* code change (wiring `inboxKitConfig` into the DO's factory call) that is **not** part of this build and **not** part of the secret-arming step — so neither is reachable at the arming this verdict gates.

### B1 closure — re-attack result: NO path to a real `domain.buy` / InboxKit-as-registrar

Re-ran my original attack one layer up. The weld is closed at two layers:
1. **Not wired.** Both `createVendorAdapters` call sites in `tenant-do.ts` (`:303`, `:327`) pass 4 args — never `inboxKitConfig`. `buildAdapters` returns `{...this.sandboxAdapters, email}`, and `sandboxAdapters` is built with `inboxKitConfig=undefined` → `useSandbox` always true → `domain` is always `SandboxDomainPort` in the deployed build, regardless of which secrets are armed. The only reader of `INBOXKIT_*` is `mailbox-credential-push.ts:62` (the engine-push path), **not** the vendor factory. So arming `INBOXKIT_*` cannot reach a real domain port at all.
2. **Hard-blocked even if wired.** `factory.ts:142` unconditionally constructs `RegistrarUnarmedDomainPort` in the real branch — it no longer reads `inboxKitConfig`. `RealInboxKitDomainPort` is constructed nowhere in `src` (grep: only its class def + tests). `domain.buy` throws `RegistrarUnarmedError` (retryable:false). The removed `inboxKitDomainRegistrant` param and the deleted Porkbun `RealDomainPort` leave zero stale live refs (one doc-comment mention only).
3. **Standing tripwire (not existence theater).** `inboxkit-adapter-dark-gating.test.ts:69-75` asserts that `inboxKitConfig`-alone yields `RegistrarUnarmedDomainPort` and `domain.buy` rejects with `RegistrarUnarmedError`. This genuinely reverses the old weld's outcome — the pre-fix code returned `RealInboxKitDomainPort`, so the `toBeInstanceOf(RegistrarUnarmedDomainPort)` + `not.toBeInstanceOf(RealInboxKitDomainPort)` assertions go RED on the old logic. A future accidental re-weld fails loudly here, while preserving the founder-ruled explicit `registrarConfig.kind==='inboxkit'` opt-in as a distinct future path.

### Attack 2 (the deliberate deviation — unconditional hard-block, no `registrarConfig` threading): HELD

`isRealSpendArmed` gains a separate registrar leg (`billing.ts:43`, `REGISTRAR_PROVIDER && CLOUDFLARE_REGISTRAR_API_TOKEN`), decoupled from the `INBOXKIT_*` leg. The coverage test (`spend-armed-env-coverage.test.ts`) is **strengthened, not loosened**: it pins the exact spend-arming Set including both new fields (non-vacuous anchor), and the "every `// spend-arming` field is referenced by isRealSpendArmed" loop now enforces both new fields are actually read — I verified `isRealSpendArmed` reads them. The registrar-leg-true-but-no-spend-possible state (creds set, adapter deferred) is conservative-safe: its only effect is disabling simulated checkout (`billing.ts:119`, `routes/checkout.ts:44`) — it never *enables* spend, and the factory hard-blocks `domain` regardless. No malfunctioning consumer. The GA adapter will land guarded by the tripwire above.

### Standard lanes

- **Typecheck:** clean across all 5 workspaces (`npm run typecheck`).
- **Platform suite:** ran `npm run test --workspace apps/platform` → **638 passed / 91 files** (matches the builder's claim). New alert test (`registrar-unarmed-alert.test.ts`) is a real behavior test: asserts `runSetupInfrastructure` rejects with `RegistrarUnarmedError` (no silent sandbox fallthrough) + fires exactly one founder alert naming tenant+domain, AND a negative case (no alert on the ordinary path).
- **Secrets:** no tracked `.dev.vars` (only `.dev.vars.example`); alert logs an email address, never a token value. Clean.
- **Engine package:** untouched by the diff + typecheck-clean.

### NON-BLOCKING findings (both dark until a future `inboxKitConfig`-wiring change)

**N-G5-1 (attack 3 — customer-facing message leak, G5-INTRODUCED).** `index.ts:146` returns the raw `err.message` to the customer/agent in the 503. `RegistrarUnarmedError.message` contains internal env var names (`REGISTRAR_PROVIDER`/`CLOUDFLARE_REGISTRAR_API_TOKEN`), an internal doc ref (`ACTIVATION.md gate (a)`), and architecture detail ("real domain purchase never happens via the mailbox vendor credential alone"). Pre-G5 this error fell through to the generic `{error:"internal error"}` 500, so this is a **regression** on a surface G5 deliberately added — same class as the project's prior engineer-copy-on-live-surface leaks. It also misdirects the customer to an operator-only action. Reachable only once `inboxKitConfig` is wired into the DO factory call (so `setup_infrastructure`'s real `searchLookalikes` throws) → non-blocking for this arming. **Fix (cheap, do now):** return a generic customer 503 body ("domain provisioning is temporarily unavailable — our team has been notified"); keep the detailed message in the founder alert only (`registrar-alert.ts` already carries `err.message` — the correct home). MUST be fixed before the real domain path is wired for all-customers.

**N-G5-2 (attack 4 — half-swept RegistrarUnarmedError class).** The deliverability REPLACE_DOMAIN path (`deliverability-actions.ts:100`, `pickReplacementDomain → searchLookalikes`) has no `RegistrarUnarmedError` isolation/founder-alert, unlike `setup_infrastructure`. Blast radius is bounded: the burning domain is retired + mailboxes paused *before* the throw (no unsafe sending continues), and the cron isolates per-tenant (`ops-sweep.ts:145` try/catch → `console.error`, sweep continues for other tenants). Reachable only post-`inboxKitConfig`-wiring when a BYO/connected domain burns. Non-blocking; flag for the wiring step so a burned domain post-InboxKit-arming produces a founder alert, not just a `console.error`.

### NEW (out-of-scope) observation

Setting `INBOXKIT_*` secrets alone does **not** enable real mailbox provisioning via the vendor factory — no call site passes `inboxKitConfig` to `createVendorAdapters`; only `mailbox-credential-push.ts` reads `INBOXKIT_*`. So real vendor provisioning (and thus the real domain hard-block, N-G5-1, N-G5-2) requires a further code change beyond secret-arming. Informational for the arming sequence and confirms why the two findings above are dark — not a G5 defect.

---

## OFAC build review — 2026-07-23

**Reviewer:** adversary (fresh re-attack) · **Target:** the OFAC/SDN screening lane (§G1 + round-1 NB-1/3/4 + Founder Q2, all adopted).
**Ground ref:** branch `worktree-ofac-20260723` @ `413a4ae` (G1a `52420c1` + G1b `413a4ae`), on `main` @ `de6a044`. `main` has since gained the signup-auth merge — reviewed the branch as-is; integration conflicts are the team-lead's.
**Read-only git; ran the battery locally; no live treasury.gov fetch (fixtures only).**

### VERDICT: SHIP (0 blocking) — safe to MERGE (screening path is dark until the SDN list is loaded + real-send is armed; pilot grandfathered). One required-before-open condition below — "SHIP" means safe to merge dark, NOT safe to open checkout to strangers as-is.

The lead fail-open attack is closed for every webhook/reactivation path; the shadow-swap, async conversion, grandfather race, terminate extraction, and test-fetch hygiene all hold; suite 698/698, typecheck clean. The one genuine unscreened-active hole is the empty-list startup window (below), which is closable at the arming step and dark until then — non-blocking for the merge, required before opening checkout to non-grandfathered customers.

### Lead attack (FAIL-OPEN) — traced, and the one hole found

I enumerated every writer of `billing_state='active'` and every writer of `plan`→paid:
- **`plan`→paid is written ONLY by the two checkout paths** (`completeSimulatedCheckout`, `applyStripeWebhookEvent`'s `checkout.session.completed`), and **both now call `screenTenant` in the same invocation.** `customer.subscription.updated` (status→active) and `charge.dispute.closed` (won) only move `billing_state`/`status`, never `plan`. Since `isTenantActivated` requires `isPaidPlanTier(plan)`, a tenant cannot be activated without having transited a screened checkout. **`isPaidPlanTier ⟹ screened-at-least-once`, and `screening_status` persists.** The webhook-reorder case (subscription.updated arrives before checkout.session.completed) leaves the tenant active-but-**free** (not activated) until the checkout screen runs. **No unscreened-active path via webhooks/reactivation.** HELD.
- **D1-throw after the billing write is fail-CLOSED.** `screenTenant`'s pre-verdict D1 reads (`getActiveSdnListVersion`, `getActiveSdnEntries`) propagate errors (they don't swallow), so a D1 hiccup throws after `billing_state='active'` was written. The DO invocation's implicit transaction rolls back that synchronous `ctx.storage.sql` write on the throw (awaiting external D1 does not commit the DO's SQLite; the codebase relies on this transactionality throughout) — the checkout errors out and retries, never leaving the tenant active+clear. (The post-verdict throws — `upsertScreeningReview`, `alertScreeningHit` — run *after* `persistVerdict('review')`, so they're fail-closed too.) HELD.

**N-OF-1 (NON-BLOCKING for merge, REQUIRED before opening checkout — the one hole).** When no SDN list has been built yet, `screenTenant` (`ofac/screening.ts:87-89`) persists `'clear'` (with a null `list_version`) and returns — and the column default is `'clear'` (`schema.ts:50`). So on first deploy, and during any window where no list build has yet succeeded, a paying tenant's checkout screens `'clear'`, unscreened — **activated, not blocked**, only audit-distinguishable via the null `list_version`. The list is loaded solely by the 5-min sweep's `maybeRefreshSdnList` (no deploy/migration seed), so the window is post-deploy until the first successful fetch+parse+swap (longer if the first fetch fails). The honesty doc claims "checked against the SDN list at checkout" without this caveat. **Direction is wrong for a sanctions gate** (fail-open). Non-blocking for the merge because the screen is dark until the list loads, the real-send path is independently dark, and the pilot is grandfathered — but signup+checkout can go live before real-send arming, so this **must** be closed before opening checkout to non-grandfathered tenants. **Fix (main loop owns scope):** (a) an arming-order gate — verify `sdn_list_meta.active_version` is non-null before opening checkout; AND (b) caveat the startup window in the honesty doc. Durable code fix to consider: default `screening_status`/empty-list verdict to `'review'` (fail-closed) — closes the empty-list AND the (already-safe) throw case independent of any semantics; tradeoff is that a prolonged fetch outage lands new tenants in `'review'` needing manual clear.

### Other findings (NON-BLOCKING)

**N-OF-2 (minor, dark).** The `setup_infrastructure` re-screen (`provisioning.ts:212`) flips `screening_status` to `'review'` on a sanctioned brand-change but does NOT abort the in-flight provisioning in the same call (the swap only takes effect on the next `buildAdapters`), so a brand-change-to-sanctioned still provisions once before it's gated. Bounded to one provision and dark until the real vendor path is armed.

**N-OF-3 (rare).** Two-read TOCTOU in `screenTenant`: `getActiveSdnListVersion` then `getActiveSdnEntries` are separate D1 reads; a concurrent daily refresh that swaps + deletes the old version (`sdn-list.ts:136`) between them yields an empty entry set → false `'clear'` for that one checkout. Once-daily × ms-window, bounded to one missed screen. Fix: grace-period delete of old versions, or a single consistent read.

### Attacks that failed (why the PASS is meaningful)

- **Shadow-swap partial-list poisoning:** rows insert under a NEW version; the active pointer flips atomically only after all inserts; a mid-batch failure best-effort-deletes the partial version and rethrows WITHOUT touching the pointer; even if that cleanup fails, orphans live under a non-active version that `getActiveSdnEntries(activeVersion)` never reads. Crash-safe. Versions are `sdn-${nowMs}` (unique per refresh — no collision).
- **Async fire-and-forget:** both now-async functions are awaited at their only callers (`tenant-do.ts:582,591`; routes `checkout.ts:55`, `webhooks.ts:62`); `screenTenant`'s three call sites all `await`. No unhandled rejection.
- **Grandfather race:** `grandfatherActiveScreening` runs synchronously in the constructor (before any RPC), guarded by `screening_list_version IS NOT NULL → return`; and `persistVerdict` always sets a non-null version alongside `'review'`, so a real `'review'` verdict always has a non-null version and can never be re-stamped `'clear'`. Can't stamp over a real verdict.
- **`admin/terminate.ts` extraction:** byte-for-byte behavior-preserving — identical response shape (`{tenantId, terminated:true, enforcementLogged, suspended, alreadyTornDown, teardown}`), identical order, same idempotent `insertEnforcementActionIfNew` (re-terminate → `enforcementLogged:false`).
- **Test live-fetch:** the only production global-`fetch` path (`maybeRefreshSdnList` via the sweep) is stubbed in `scheduled.test.ts`; `ofac-sdn-refresh.test.ts` injects a fake fetch; no other test reaches the sweep. `maybeRefreshSdnList` is fully try/caught (alerts + keeps prior list; never throws), so a refresh failure can't abort the sweep.
- **Matcher honesty / flood:** the code does exactly what the honesty doc states (exact + 2-token subset, no single-token/edit-distance); the false-positive flood is the accepted NB-3 review-not-reject tradeoff with match context carried. No overclaim.
- **Suite/typecheck:** ran `npm run test --workspace apps/platform` → 698 passed / 101 files; typecheck clean across workspaces.

### UNVERIFIABLE (arming-time only)

The real `SDN.CSV` wire shape (parser assumes 12-column, no-header, `"-0-"` placeholder) and the Worker cron CPU budget for ~17k rows — both flagged by the honesty doc as verified once at the arming session's live fetch (no live gov fetch permitted in-build). Resolves at arming.
