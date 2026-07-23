# GA Gates — design & build plan (2026-07-22)

Design lane for the four **pre-public-GA gates** the founder ledgered under the autonomous go-live program (`ROADMAP.md:18`, wave 4). These make the platform safe for **strangers paying real money**, not just the trusted Mordy pilot. Each was named by an adversary ruling as a prerequisite the code does not yet satisfy:

- **G1 — Real OFAC screening** replaces `screeningStatusStub` (`apps/platform/src/engine/activation.ts:25-27`), which always returns `"clear"` (the founder-accepted pilot risk, `selfserve-i1i2-build-review-2026-07-21.md:99`, ROADMAP D4 net-new, `ACTIVATION.md:93`).
- **G2 — Absolute vendor-spend ceiling** (adversary F2/F3: per-tenant quota is NOT an aggregate ceiling; no tenant-count cap; the "owner spend ceiling" SPEC §18 names does not exist — `selfserve-activation-design-review-2026-07-21.md:22-26`, `selfserve-i1i2-build-review-2026-07-21.md:45-49`, self-serve design §2.6:148).
- **G3 — Pending-activation state** (round-2 finding #2: a paid tenant with the engine unarmed silently gets `SandboxEmailPort` and sees "successful" sends that never leave — confident-wrong — `selfserve-i1i2-build-review-2026-07-21.md:36-43`, `factory.ts:105,110`).
- **G4 — Slot-capacity handling** (InboxKit Professional = 10 slots/$39·mo, `ROADMAP.md:45`; Mordy up to 5 + dogfood 2-4; policy ruled auto-upgrade-under-ceiling not waitlist, `ROADMAP.md:18`).

**Design only, no source edits.** Every claim file:line-cited. Grounded against `main` HEAD and the in-flight I3/I4 worktree (`worktree-agent-a8f87cd1437a20f72`) whose changes this design must merge *after* (go-live program wave 2 precedes wave 4). All four gates are **DESIGN-time additive** and inert until armed — none change the shipped sandbox-only prod behavior.

---

## 0. Shared foundation — cross-tenant accounting + the single spend choke-point

G2 and G4 both need **account-level** (cross-tenant) state. Real vendor spend today happens **inside a TenantDO** (`runSetupInfrastructure` → `provisionDomainWithMailboxes` → `provisionMailboxesForDomain`, `provisioning.ts:36-190`), but the ceiling and slot count are properties of the **whole InboxKit account**, spanning every tenant. Per-tenant DO SQLite (`ctx.sql`) cannot see other tenants (`ARCHITECTURE.md #3`, tenant isolation). So the account-level ledger lives in **D1** (`ctx.env.DB`) — the same control-plane store the admin surface already uses cross-tenant (`admin/db.ts:133` `listAllTenantIds`, `watchtower_state`, `dunning_events`, `enforcement_actions`). `TenantContext` already carries `readonly env: Env` (`tenant-context.ts:15`) and `Env.DB: D1Database` (`env.ts:11`), so a DO spend path can atomically read/write D1.

**The choke-point.** Every money-out vendor call must pass through one wrapper — `withSpendCeiling(ctx, estCents, kind, () => vendorCall())` — that (a) no-ops for sandbox ports (demo/free/unactivated tenants get sandbox and cost $0, `factory.ts:108`), and (b) for a **real** port, atomically reserves `estCents` against the D1 ceiling BEFORE the call, commits on success, releases on failure. This is the G2/G4 analogue of the I3/I4 lane's `isRealSpendArmed` env-coverage guard (`billing.ts:37`, `env.ts` `// spend-arming` markers): a single choke-point + a failing-by-construction test that no spend site bypasses it.

**Spend-bearing call-site inventory** (money out; grep-verified across `apps/platform/src`, excluding sandbox/real port internals + tests):

| Site | Call | Real-vendor cost | In choke-point? |
|---|---|---|---|
| `provisioning.ts:46` | `mailbox.provision` → InboxKit `POST /mailboxes/buy` (`mailbox-port.ts:51`) | slot consumption / wallet credits | **must wrap** |
| `provisioning.ts:47` | `mailbox.startWarmup` → InboxKit `POST /warmup/add` (`mailbox-port.ts:100`) | $3/mbx·mo add-on (prewarm research §3) | **must wrap** |
| `provisioning.ts:118` | `domain.buy` → InboxKit `POST /domains/register` (`inboxkit-domain-port.ts:91`) or Cloudflare Registrar | ~$10-15/domain (registrar-choice ruling `ROADMAP.md:33`) | **must wrap** |
| `deliverability-actions.ts:100` → `provisionDomainWithMailboxes` | REPLACE_DOMAIN burn-replacement re-enters the same two functions | same as above | covered transitively |
| `provisioning.ts:119` `domain.setDns` · `:175`/`da:100` `searchLookalikes` | nameserver set + availability probe | **not spend** (probe/config only) | no wrap needed |
| `lifecycle.ts:128` `domain.release` · `:161` `mailbox.release` | teardown/cancel | **not spend** (may refund) + decrements slot count | slot-decrement hook only |
| *(future)* prewarm "Instant Start" SKU → `POST /prewarm/buy-domain` (prewarm research §1, §5) | credits | design choke-point to cover it now |

All three money-out sites funnel through `provisionMailboxesForDomain`/`provisionDomainWithMailboxes`, so the wrapper lives at that layer (it has `ctx` = D1 + tenant + clock). **Both burn-replacement (`deliverability-actions.ts:100`) and initial setup (`runSetupInfrastructure:181`) reuse those functions** (`provisioning.ts:108` "shared implementation"), so wrapping there covers both automatically — no second site to remember.

---

## G1 — Real OFAC screening (replaces `screeningStatusStub`)

**Where it plugs in.** `isTenantActivated` already reads `screening === "clear"` as a conjunct (`activation.ts:47-54`); `readActivationState` calls `screeningStatusStub(tenantId)` (`activation.ts:73`) which hard-returns `"clear"` (`activation.ts:25-27`). The gate machinery is **already wired** — G1 replaces the stub's return with a read of a **persisted per-tenant column**, and adds the code that *writes* that column at the activation transition. No caller changes (the design note at `activation.ts:22-23` guarantees this).

**When we screen.** Once, at the **activation transition** — checkout completion, where `billing_state` first flips to `'active'`: `completeSimulatedCheckout` (`billing.ts:132-136`), `applyStripeWebhookEvent` `checkout.session.completed` (`billing.ts:229-239`). NOT at sandbox signup (`signup.ts:25` mints demo/zero-spend/zero-send — nothing to screen), NOT per-send (wasteful, and the gate re-reads fresh SQL every `buildAdapters()` anyway, `activation.ts:57-64`). Screening at checkout means a `'review'` verdict holds the tenant on the sandbox port on the **very next** `buildAdapters()` (fresh-SQL re-eval, `activation.ts:66-75`) — no separate enforcement needed.

**Fields screened** (screen everything we hold; record which):
- `tenant_profile.brand` (`schema.ts:8`, captured at signup `signup.ts:53`).
- `contactEmail` + its domain (persisted in the D1 tenant index, `signup.ts:53`, `db.ts` `insertTenantIndex`).
- Stripe **billing name** *if present* on the completed session (`customer_details.name`). ⚠️ With the pilot's 100%-off + `payment_method_collection:"if_required"` (self-serve design §2.5), **no name is collected** — so treat billing name as best-effort, screen it only when the webhook object carries it, and record `screened_fields` so a review knows what was and wasn't checked.

**List source (free, no paid provider for v1).** US Treasury OFAC **SDN list**, `SDN.CSV` (+ `ALT.CSV` aliases) from the public OFAC download service. A Worker cron fetches it, parses names + akas, and upserts normalized name-tokens into a D1 table `sdn_entries(uid, name_normalized, tokens, entity_type, program)` plus `sdn_list_meta(list_version, published_date, fetched_at, entry_count)`. ⚠️ **Build concern to flag:** `SDN.CSV` is large (~10MB, ~17k rows) — parse+upsert must be **batched** to stay inside the cron CPU budget; the daily refresh writes into a shadow table and swaps, so a partial/failed fetch never leaves a half-populated list (fail-loud on parse error, keep the prior good version — mirrors the F5 "silent-empty is unacceptable for a load-bearing store" ruling, `selfserve-activation-design-review-2026-07-21.md:38-41`).

**Refresh mechanism.** Reuse the existing cron — `scheduled()` runs the ops sweep every 5 min (`scheduled.ts:21-35`, `index.ts:156`). Add a **once-daily guard** (a `sdn_list_meta.fetched_at` cursor, same pattern as `watchtower_cursor`, `watchtower.ts:291-303`): the sweep refreshes the list only if the last fetch is >24h old. This avoids a second `[triggers] crons` entry. (Alternative: a dedicated daily cron trigger — cleaner separation, but needs a wrangler multi-cron change; the piggyback is lower-friction for v1.)

**Match strategy — conservative, review-not-reject.**
- Normalize both sides: lowercase, strip punctuation/diacritics, collapse whitespace, tokenize.
- **Exact** normalized-name match → hit.
- **Conservative fuzzy:** every token of an SDN name is present in the tenant's brand/name (subset match), for names ≥2 tokens — deliberately narrow to hold false positives down. No single-token or edit-distance fuzz in v1 (too noisy for a brand field).
- A hit **NEVER auto-rejects.** It sets `screening_status='review'`, which makes `isTenantActivated` return false (`activation.ts:53`) → the tenant stays on the sandbox port. It writes a review row to a **cross-tenant D1 queue** and fires a **watchtower ops email** for founder manual review.

**Ops alert + admin clear surface.** Reuse two existing precedents exactly:
- **Alert:** the watchtower already emails the founder on state-change via `OpsMailer` to `OPS_ALERT_EMAIL` (`watchtower.ts:225-235`, `env.ts:56`). Add a `screening_review` D1-backed signal so the next sweep surfaces "N tenants awaiting screening review" — or fire a direct one-shot ops mail at the review-write moment (simpler; no state machine needed since a review is a discrete event).
- **Admin clear:** the **exact** `requireAdminAuth` + admin-route + `enforcement_actions` audit pattern already used by `POST /admin/tenants/:id/terminate` (`admin-ops.ts:56-81`, `require-admin-auth.ts:15-24`, mounted `index.ts:67-71`). Add `POST /admin/tenants/:id/screening` `{decision:'clear'|'reject', note}` → resolves the tenant via `getTenantIndexById` (`admin/db.ts:141`), calls a new stub method `stub.resolveScreening(decision)` that writes `screening_status` + an audit row. `clear` activates on the next `buildAdapters()`; `reject` can chain into the existing terminate path. This is the **smallest honest admin surface** and is already ADMIN_TOKEN-gated + fails-closed (`require-admin-auth.ts:19`).

**Persistence & audit trail.**
- Per-tenant verdict on `tenant_profile`: add `screening_status TEXT NOT NULL DEFAULT 'clear'`, `screening_list_version TEXT`, `screened_at INTEGER` (DO SQLite, `schema.ts:6-43`; **default `'clear'` keeps every existing row byte-identical** — Mordy + pilot tenants ride through unchanged, matching the founder-accepted stub-clear posture, `ROADMAP.md:30` "FOUNDER RULED YES"). The stub becomes `SELECT screening_status FROM tenant_profile`.
- Enumerable **review queue** in D1: `screening_reviews(tenant_id PK, matched_terms, screened_fields, list_version, status, created_at, resolved_at, resolved_by)` — one row per tenant in review, so the founder (and the watchtower) can list "all pending reviews" in one query, mirroring `dunning_events`/`support_tickets` (`admin/db.ts:93,117`).

⚠️ **Screening runs inside the DO** (at checkout-complete, `billing.ts`), but the SDN list lives in **D1** (`ctx.env.DB`) — the DO reads D1 to match, writes the per-tenant verdict to its own SQLite + the review row to D1. All reachable via `ctx.env` (`tenant-context.ts:15`).

---

## G2 — Absolute vendor-spend ceiling

**Model.** A founder-tunable **monthly** ceiling on cumulative real vendor spend, checked-and-reserved BEFORE every money-out call via the §0 choke-point. Account-level D1 ledger `vendor_spend_ledger(period_key, reserved_cents, committed_cents, ceiling_cents, updated_at)` keyed by billing period (see Q1) + an append-only `vendor_spend_entries(id, tenant_id, kind, est_cents, actual_cents, status, ts)` for audit. Because exact InboxKit credit→$ is **UNVERIFIED** (prewarm research §2: "confirm with a real top-up before quoting a margin"), the cost estimates are **deliberately conservative overestimates**, founder-tunable.

**Atomic reserve (no TOCTOU).** The reserve is a single conditional D1 UPDATE — the check and the increment are one atomic statement, so two concurrent provisions can't both slip past:
```
UPDATE vendor_spend_ledger
   SET reserved_cents = reserved_cents + :est
 WHERE period_key = :pk
   AND reserved_cents + committed_cents + :est <= ceiling_cents
```
`rowsWritten == 0` → ceiling would be exceeded → the call **fails gracefully into a `'capacity_pending'` state + ops alert** (never a hard 500): the mailbox/domain row is recorded `capacity_pending` (not billed, not provisioned), the founder gets a watchtower mail ("spend ceiling reached — raise `SPEND_CEILING_CENTS` or upgrade InboxKit"), and a reconcile retries once the ceiling is raised. On vendor-call success → move `est` from `reserved` to `committed`; on failure → release the reservation (subtract from `reserved`). Single-statement atomicity matches the `watchtower_cursor`/`dunning_events` D1 idempotency idiom (`admin/db.ts:117-127`); a dedicated `SpendLedgerDO` (serialized like `RateLimiterDO`, `rate-limiter-do.ts`) is the scale path only if D1 contention ever appears.

**No bypass — the systemic guard.** Same class as the I3/I4 R3-1 guard. A **failing-by-construction test** greps `apps/platform/src` for direct `adapters.mailbox.provision(` / `adapters.mailbox.startWarmup(` / `adapters.domain.buy(` (and the future prewarm buy) call sites and asserts each is lexically inside a `withSpendCeiling(` wrapper — any new unwrapped spend site trips RED (mirrors `spend-armed-env-coverage.test.ts` the I3/I4 lane just added, `env.ts` `// spend-arming` markers). The wrapper itself no-ops for sandbox (`bundle.kind === 'sandbox'`, `factory.ts:114`), so demo/free tenants never reserve.

**Compose with the I3/I4 idempotency wrapper — integration point.** The I3/I4 lane wraps the buy in `withRequestIdempotency` (`provisioning.ts:48` in that worktree). The ceiling reserve MUST sit **inside** the idempotency body so a replayed provision that returns the *recorded* result (no re-buy) does **not** double-reserve:
```
withRequestIdempotency(ctx, `provision:${key}`, () =>
  withSpendCeiling(ctx, COST_MAILBOX_CENTS, 'mailbox', () =>
    ctx.adapters.mailbox.provision(...)))
```
Only a true first execution reserves. This is a **hard collision** with the I3/I4 edit at `provisioning.ts:46-48` — see Collisions.

**Founder-tunable, conservative default.** `SPEND_CEILING_CENTS` env var, default **15000 ($150/mo)** — comfortably above the pilot (InboxKit $39 sub + ≤10 slots × ~$3/mbx·mo warmup + a domain or two ≈ $70-90/mo) with ~2× headroom, low enough to cap a runaway. Cost table (all founder-tunable, overestimate-biased): `COST_MAILBOX_CENTS` default 690 (slot amortized + warmup add-on), `COST_DOMAIN_CENTS` default 1500, `COST_PREWARM_MAILBOX_CENTS` default 900 (prewarm research §5 top tier). These are **non-spend-arming** config and must be tagged as such so the I3/I4 `spend-armed-env-coverage.test.ts` doesn't demand them in `isRealSpendArmed`.

**Integration with the I3/I4 provision lane** (in flight): the lane's `maybePushProvisionedMailbox` (`provisioning.ts` push step) runs AFTER the buy — it's an engine push, **not vendor spend**, so it stays outside the ceiling. But the OAuth-mint seam (I3 long pole, `ROADMAP.md:24` "OAuth mint seam") — if the programmatic mint via InboxKit `client-id-request` is itself a billable vendor call, it needs its own choke-point entry; the manual-mint fallback is free. Flag for the I3/I4 integration: **confirm whether the OAuth mint bills**, and if so wrap it.

---

## G3 — Pending-activation state

**The confident-wrong being fixed.** A PAID, `billing_state='active'` tenant whose real send path isn't live (engine unarmed, or InboxKit unbound, or in screening `'review'`) gets `SandboxEmailPort` (`factory.ts:105` requires `engineConfig` too; `:110` falls to sandbox) which **simulates successful sends** — the tenant sees `active` + "sent" campaigns while nothing leaves (`selfserve-i1i2-build-review-2026-07-21.md:36-43`). G3 surfaces the truth.

**Derive it (don't store a flag).** A pure function of state already computed, mirroring the activation gate's own derive-don't-store discipline (`activation.ts:47`):
```
activationState(tenant, env) =
    !isPaidPlanTier(plan)                      -> 'sandbox'      (demo/free — expected, honest)
    screening_status === 'review'              -> 'screening_hold'
    isPaidPlanTier && billing_state==='active'
      && isTenantActivated(...)
      && realSendPathLive(env)                 -> 'active'
    isPaidPlanTier && billing_state==='active'
      && !realSendPathLive(env)                -> 'pending_provisioning'
    else (past_due/frozen/canceled)            -> 'suspended' | 'canceled' (existing billing_state)
```
`realSendPathLive(env)` = `engineConfig` present (`ENGINE_BASE_URL && ENGINE_AUTH_SECRET`, `env.ts:38-39`, `factory.ts:105`) **AND** `inboxKitConfig` present (`INBOXKIT_API_KEY && INBOXKIT_WORKSPACE_ID`) — BOTH conjuncts, per adversary B2 (2026-07-23): an engine-armed-but-InboxKit-unbound paid tenant gets a real `EmailPort` with sandbox mailboxes, so an engine-only formula reports `'active'` while nothing really sends — the exact confident-wrong G3 exists to kill. This is exactly what distinguishes "paid but silently sandboxed" from "paid and really sending." (`'capacity_pending'` from G2 and G4 is a further sub-state of `pending_provisioning` — surface it when present.)

**Where it surfaces** (three parity surfaces — SPEC §19.0 parity law: the agent reads everything the human reads):
1. **`account()` JSON** — add `activationState` to `AccountSummary` (`reporting.ts:85-104`, `getAccount:155-193`). The reader already selects `plan/status/billing_state` (`reporting.ts:157`); add the derivation. **Collides** with the I3/I4 lane's `AccountSummary`/`api/types.ts` edits (Collisions).
2. **MCP `account` tool** — update the tool description (`mcp/tools.ts:161-167`) to document `activationState` so a buyer-agent reads honest state, not fake "sent." **Same-file collision** with the I3/I4 `infrastructure_status` description edit (`mcp/tools.ts:78`).
3. **Dashboard banner** — an explicit banner in `apps/dashboard` when `activationState !== 'active'` ("Your account is provisioning — real sending is not live yet; sends shown are sandbox previews"). Copy posture: **honest, no fake progress bars** — state the truth plainly (matches the concierge-caveat honesty boundary, `ROADMAP.md:18` "HONEST BOUNDARY"). `apps/dashboard/src/api/types.ts:161` `AccountSummary` mirror is edited by I3/I4 too.

**Copy posture (all surfaces).** Never imply sending is happening when it isn't. `pending_provisioning` = "paid, infrastructure being armed, sandbox previews only." `screening_hold` = "under review, we'll be in touch" (do NOT reveal an OFAC match — say "account review," per false-positive dignity). No countdown/ETA we can't honor (arming needs a founder session, `ROADMAP.md:18`).

**No new persistence** — G3 is pure derivation over columns G1/existing already own. Cheapest of the four; its only real cost is the shared `AccountSummary`/dashboard-types collision with I3/I4.

---

## G4 — Slot-capacity handling

**What the platform must know.** Current **account-wide** real-mailbox count vs the InboxKit plan's slot capacity (Professional = 10, `ROADMAP.md:45`). Real mailboxes live per-tenant in DO SQLite (`mailboxes` table, `provisioning.ts:59`), so the account-wide count needs the **same D1 counter** G2 introduces: `vendor_spend_ledger` gains `slots_used INTEGER`, incremented on each **real** mailbox provision (the §0 choke-point already fires there) and decremented on `mailbox.release` (`lifecycle.ts:161`). Plan capacity is a founder-tunable `INBOXKIT_PLAN_SLOTS` (default **10**).

**The upgrade decision point.** At a provision request needing slot N+1:
- **N+1 ≤ `INBOXKIT_PLAN_SLOTS`** and under the G2 ceiling → proceed normally.
- **N+1 > `INBOXKIT_PLAN_SLOTS`** → this is the capacity decision. Policy ruled **auto-upgrade under the ceiling, not waitlist** (`ROADMAP.md:18`). Reconciled with API reality:
  - InboxKit's documented endpoint categories (prewarm research §3: Domains, Mailboxes, Cloudflare, Webhooks, DNS, Tags, Inbox Placement, InfraGuard, Email Insights, Prewarm, Warmup) show **NO billing/subscription/plan-upgrade category** — there is likely **no programmatic plan-upgrade API**. So `POST /mailboxes/buy` for slot 11 either draws wallet overage (auto-scales, G2 ceiling contains the $) or hard-fails on capacity.
  - **v1 behavior:** *attempt the buy* (honoring "not waitlist" — nothing queues as long as we're under the G2 ceiling); the buy either succeeds (wallet overage — G2 is the real guard on runaway $) or returns a slot/capacity vendor error → fail gracefully into **`'capacity_pending'` + ops alert** ("slot 10/10 reached — upgrade the InboxKit plan and raise `INBOXKIT_PLAN_SLOTS`"), the founder's one dashboard click. The reconcile retries once capacity is raised.
  - **Seam for true auto-upgrade:** if an upgrade API is confirmed at arming, it becomes a config flip inside `withSpendCeiling`'s over-capacity branch (call upgrade → raise `INBOXKIT_PLAN_SLOTS` → retry) — but the v1 fallback ships without it.

⚠️ **UNVERIFIABLE without a live account** (arming-time check, like gate (e)): does `/mailboxes/buy` past 10 slots draw wallet overage or hard-fail, and is there any plan-upgrade endpoint? Resolve empirically at the arming session (the pilot's throwaway-mailbox step, `ROADMAP.md:45` gate e). The v1 design (attempt-then-capacity-pending) is correct **either way** — no founder decision needed, so this is an arming note, not a founder question.

**Accounting into G2.** Slot count and $ ceiling share the one D1 ledger row per period — a slot consumed is also `COST_MAILBOX_CENTS` reserved. One choke-point, two counters, one atomic UPDATE. The prewarm "Instant Start" SKU (prewarm research §5), if built, buys from InboxKit's *own inventory* (a different domain, not a slot on our plan) — it feeds the $ ledger but **not** `slots_used` (it's not one of our plan slots); design the choke-point `kind` param to distinguish `'mailbox' | 'prewarm' | 'domain'` so slot accounting only counts plan-slot mailboxes.

---

## G5 — Gate (a): domain-port arming decoupling (ADDED 2026-07-23, adversary B1)

**The hole (adversary-confirmed on both trees):** `factory.ts:137` welds the domain port to the mailbox `inboxKitConfig`, and the default `RealDomainPort` arm is a Porkbun stub (a registrar the founder DROPPED). So at the authorized autonomous arming, setting `INBOXKIT_API_KEY`/`INBOXKIT_WORKSPACE_ID` silently co-arms InboxKit-as-registrar for `domain.buy` — a money-out site — the exact posture the founder-ruled gate (a) (`ROADMAP.md:19`, registrarConfig decoupling) forbids. Zero `registrarConfig` exists in either tree.

**Design:** introduce a separate `registrarConfig` arming group — `REGISTRAR_PROVIDER` (`'cloudflare'`, the founder-ruled default registrar) + `CLOUDFLARE_REGISTRAR_API_TOKEN`, BOTH tagged spend-arming (extend `isRealSpendArmed` + the `spend-armed-env-coverage.test.ts` tripwire). The factory hands out a real domain port ONLY when `registrarConfig` is present; when absent, `domain.buy` is HARD-BLOCKED fail-closed — explicit `registrar_unarmed` error + ops alert + graceful `capacity_pending`-style surface, NEVER a silent sandbox fallthrough and NEVER an InboxKit fallback. Rewrite `RealDomainPort` for Cloudflare Registrar (replacing the Porkbun stub); InboxKit "Connect Existing Domain" remains the DNS-connect path for BYO domains (it is not a registrar).

**Guard (R3-1 style):** a test that `INBOXKIT_*` set + `registrarConfig` absent → the `domain.buy` path hard-blocks (RED on the old welded factory logic, proven by revert-fail-restore) + the env-coverage tripwire extension for the new registrar vars.

**Sequencing (load-bearing):** gate (a) **BLOCKS credential-push activation** (`ROADMAP.md:19`) — it must land BEFORE the arming step, i.e. as a **micro-lane immediately at the I3/I4 merge** (the ROADMAP's own alternative), NOT waiting for the full GA wave. Size **S**.

**Scope note (2026-07-23, at dispatch):** the micro-lane ships the arming-blocking half only — `registrarConfig` decoupling + fail-closed `domain.buy` hard-block + guards (adversary B1 explicitly allowed "or hard-block the domain-buy path"). The Cloudflare `RealDomainPort` rewrite is DEFERRED to the GA wave: whether Cloudflare Registrar supports NEW-domain purchase via public API is unverified (their API covers transfers/settings; purchase may be dashboard-only), and this codebase does not build dark adapters against unverified wire shapes. Until then the registrar seam fails loud `registrar_unarmed` — which is also the correct pilot posture (Mordy's shape is BYO connect, not domain purchase). Verify the CF purchase API (fallback: Namecheap, founder-ruled) before building the real adapter.

---

## Ordered build increments

Sizes: **S** ≤ ½ day · **M** ~1 day · **L** ~2 days. G0 is the shared foundation both G2 and G4 stand on; build it first.

| # | Increment | Size | Depends on | Parallel? |
|---|---|---|---|---|
| **G0** | Cross-tenant D1 accounting migration (`vendor_spend_ledger` + `vendor_spend_entries` + `slots_used`) + `withSpendCeiling` choke-point wrapper (sandbox no-op, atomic reserve/commit/release) + the enumerate-spend-sites failing-by-construction guard test. | **M** | I3/I4 merged (shares `provisioning.ts` spend loop) | foundational — G2/G4 build on it |
| **G2** | Wire `withSpendCeiling` into the 3 money-out sites (compose *inside* the I3/I4 idempotency wrapper); `'capacity_pending'` graceful-fail state + ops alert; `SPEND_CEILING_CENTS` + cost-table env (tagged non-spend-arming). | **M** | G0 | ‖ with G1 |
| **G1a** | OFAC list plumbing: D1 `sdn_entries`/`sdn_list_meta`, batched SDN.CSV fetch+parse+shadow-swap, once-daily refresh guard in `scheduled()`, fail-loud on parse error. | **M** | — | ‖ with G0/G2/G3 |
| **G1b** | Screening at activation: `tenant_profile.screening_status`/`list_version`/`screened_at` columns; real `screeningStatusStub`→column read; screen-at-checkout (both `billing.ts` write sites); D1 `screening_reviews` queue; `POST /admin/tenants/:id/screening` clear/reject (reuse `admin-ops.ts` pattern) + ops alert. | **M** | G1a | after G1a |
| **G3** | Derive `activationState`; add to `AccountSummary` + `account` MCP tool description + dashboard banner (honest copy). | **S** | G1b (reads `screening_status`) — or stub `'clear'` first | ‖ with G2 (both edit tenant-do/account) |
| **G4** | `slots_used` counter on provision/release; `INBOXKIT_PLAN_SLOTS`; over-capacity → attempt-then-`capacity_pending` + alert; `kind`-aware slot accounting. | **S** | G0, G2 (shares ledger + choke-point) | after G2 |
| **G5 (gate a)** | `registrarConfig` decoupling + Cloudflare `RealDomainPort` (replaces Porkbun stub) + `domain.buy` fail-closed hard-block + spend-arming tripwire extension + welded-factory RED-proof. | **S** | I3/I4 merged (edits `factory.ts`/`env.ts` that lane touches) | **micro-lane at I3/I4 merge — FIRST; BLOCKS arming** |

**Long pole: G1 (G1a + G1b), ~2 days combined.** It's the only gate that is net-new build with an external-data unknown (SDN.CSV size/parse-in-Worker-cron budget, list-version semantics) AND a new admin surface AND a schema change AND a review-queue. G2/G4 are mechanical once G0's ledger + choke-point exist; G3 is pure derivation (S). Everything else can proceed in parallel with G1.

**Critical path to public GA:** G0 → G2 → G4 (spend safety) can land independent of G1. G1 (real OFAC) is the hard gate that flips "stranger signup" from unsafe to safe, so it gates *opening signup*, but the build can parallelize it against the spend gates.

---

## Systemic guards (R3-1 style — a failing-by-construction check per gate)

- **G0/G2 (spend-bypass class):** `spend-ceiling-coverage.test.ts` — enumerate every `adapters.{mailbox.provision,mailbox.startWarmup,domain.buy}` (+ future prewarm) call site in `apps/platform/src`; assert each is lexically wrapped by `withSpendCeiling`. A new unwrapped spend site → RED. (Direct sibling of the I3/I4 `spend-armed-env-coverage.test.ts` the lane just shipped.) Plus a behavior test: two concurrent reserves that jointly exceed the ceiling → exactly one succeeds, one lands `capacity_pending` (proves the atomic UPDATE).
- **G1 (screening fail-open class):** a test that a `'review'` tenant's next `buildAdapters()` returns `SandboxEmailPort` even with engine+InboxKit armed (proves screening blocks activation, not just annotates it) — fails on any code that reads activation without the screening conjunct. Plus a fail-loud test: a corrupt/empty SDN fetch does NOT silently clear the list (keeps prior good version), mirroring F5.
- **G3 (confident-wrong class):** a test that a paid+active tenant with `engineConfig` UNSET reports `activationState:'pending_provisioning'` (not `'active'`) AND a test that a paid+active tenant with `engineConfig` SET but `inboxKitConfig` UNSET ALSO reports `'pending_provisioning'` (adversary B2 — the engine-armed/InboxKit-unbound arming window must not bless `'active'`) AND that `account()`/dashboard never claim `'active'` while `factory.ts` would hand out sandbox — the RED-on-old-code proof that the silent-sandbox confident-wrong is closed.
- **G4 (over-provision class):** a test that provisioning the (`INBOXKIT_PLAN_SLOTS`+1)th real mailbox under the ceiling attempts-then-lands `capacity_pending` + emits an alert (never a silent success or a hard crash), and that `mailbox.release` decrements `slots_used`.

Per CLAUDE.md Bug Response + Model Tiering: these are correctness/spend/security classes → each gate's build must ship its guard, and the whole wave gates on a **fresh-context adversary** re-attack (clean pass = the gate, not a green suite), not just the battery.

---

## Collision flags

**vs the in-flight I3/I4 lane** (`worktree-agent-a8f87cd1437a20f72`, changes vendors/engine/billing — merges *before* this wave per go-live wave 2 < wave 4). Design **against the post-I3/I4 tree**; integration points:

- **`provisioning.ts:46-48` — HARD collision.** I3/I4 wraps `mailbox.provision` in `withRequestIdempotency` and adds `maybePushProvisionedMailbox` after (verified in the worktree diff). G2's `withSpendCeiling` must compose *inside* that idempotency wrapper (§G2). Build G0/G2 on the merged tree, not `main`.
- **`env.ts` — moderate.** I3/I4 adds `INBOXKIT_API_KEY`/`INBOXKIT_WORKSPACE_ID`/`GMAIL_OAUTH_GRANTS` with `// spend-arming` markers enforced by `spend-armed-env-coverage.test.ts`. G2/G4's `SPEND_CEILING_CENTS`/cost-table/`INBOXKIT_PLAN_SLOTS` are **non-spend-arming** and must be added without the marker (or that coverage test fails demanding them in `isRealSpendArmed`).
- **`schema.ts` — additive merge hazard (not logical).** I3/I4 appends `mailbox_cred_pushes` to `TENANT_DO_SCHEMA`; G1 adds `tenant_profile` columns; both use `IF NOT EXISTS`/`ADD COLUMN`, so no logical conflict — but the same file merges. Same hazard the self-serve/warm-lead lanes already flagged (`selfserve-activation-design-review-2026-07-21.md:54`).
- **`mcp/tools.ts` — same-file.** I3/I4 edits the `infrastructure_status` description (`:78`, `vendor*` rename); G3 edits the `account` description (`:163`). Different tools, one file.
- **`apps/dashboard/src/api/types.ts` — collision.** I3/I4 renames `reputationScore`→`vendorReputationScore` in the `AccountSummary` mirror (`:161`); G3 adds `activationState` to the same interface. Coordinate the one merge.
- **`billing.ts` — light.** I3/I4 extends `isRealSpendArmed` with the InboxKit leg (`:37`); G1 adds a screen call at the two checkout-write sites (`:132`, `:229`). Adjacent, not overlapping.

**vs the signup-auth lane** (magic-link login + human signup + one-funnel site, `ROADMAP.md:19` — design doc not yet on disk, no `/login` route on `main` yet):
- **routes/ + `index.ts`:** signup-auth adds `/login`/magic-link routes + `AUTHED_PATH_PATTERNS` entries (`index.ts:84`); G1 adds an `/admin/tenants/:id/screening` route to the admin sub-app (`index.ts:67-71`). Different mount groups (admin vs authed/public) — low collision, but both touch `index.ts` route registration.
- **dashboard onboarding / site:** signup-auth's "connect-your-agent onboarding" + one-funnel site copy and G3's dashboard activation banner both touch `apps/dashboard` + `site/` surfaces — coordinate copy so the banner and the onboarding flow tell one honest story (sandbox-by-default until upgraded, `ROADMAP.md:19`). Sequence G3's banner after signup-auth's dashboard shell lands, or design the banner as an additive component.
- **No activation-gate collision:** signup-auth keeps sandbox-by-default and does not touch the activation gate (`ROADMAP.md:19` explicit) — G1/G3 read that gate but don't fight signup-auth on it.

---

## Founder-tunable knobs (proposed defaults)

| Knob | Default | Rationale |
|---|---|---|
| `SPEND_CEILING_CENTS` | **15000** ($150/mo) | ~2× the pilot's expected ~$70-90/mo (sub + ≤10 slots' warmup + a domain); caps runaway, comfortably clears Mordy. |
| `COST_MAILBOX_CENTS` | 690 | slot amortized ($39/10) + $3/mbx·mo warmup; overestimate-biased (credit→$ unverified, prewarm research §2). |
| `COST_DOMAIN_CENTS` | 1500 | .com registration ceiling (registrar-choice + prewarm §2 $15 transfer). |
| `COST_PREWARM_MAILBOX_CENTS` | 900 | prewarm top tier (8+wk $9, prewarm research §2) — only if the Instant-Start SKU ships. |
| `INBOXKIT_PLAN_SLOTS` | **10** | matches the purchased Professional plan (`ROADMAP.md:45`); founder raises it after a plan upgrade. |
| screening review notify address | reuse **`OPS_ALERT_EMAIL`** (jacob@epiphanymade.com, `env.ts:56`) | no new secret; the founder already receives watchtower/dunning here. |
| `OFAC_LIST_URL` | Treasury SDN.CSV public download | free, no provider; overridable if OFAC moves the endpoint. |
| ceiling alert threshold | 80% (warn) / 100% (block) | early ops warning before the hard block. |

---

## Founder questions (2)

1. **Spend-ceiling period & scope.** Is `SPEND_CEILING_CENTS` a **per-calendar-month** budget that resets on the 1st (or aligned to the InboxKit renewal on the 20th, `ROADMAP.md:45`), a rolling-30-day window, or a lifetime cumulative cap? And does the **base $39/mo InboxKit subscription** count against it, or only marginal per-call spend? *Recommendation: per-calendar-month, base sub included in the tally, default $150, warn at 80% / hard-block at 100%.*

2. **OFAC posture + pilot grandfathering.** Confirm the v1 posture: a screen **hit → `review` + block activation + ops-alert for manual clear, never auto-reject** (false-positive dignity; review copy says "account review," not "sanctions match"). And confirm **already-active pilot tenants (Mordy + any current) are grandfathered `clear`** — screened retroactively into the review queue if you want, but **not deactivated** on G1 arming — so turning screening on can never strand the live pilot. *Recommendation: yes to both; SDN list only for v1 (add the free Consolidated Sanctions list later if you want non-SDN programs).*

---

## Adversary round 1 — 2026-07-23 (verdict: SHIP-AFTER-FIXES, applied same day)

Frozen verdict: `docs/adversarial/ga-gates-design-review-2026-07-23.md`. Both BLOCKING findings fixed in this doc: **B1** → new §G5 (gate (a) registrarConfig decoupling, micro-lane at I3/I4 merge, blocks arming) · **B2** → `realSendPathLive` formula corrected to `engineConfig && inboxKitConfig` + G3 guard test extended.

Non-blocking dispositions (build lane MUST carry these):
1. **Brand re-screen at rewrite** — G1b screens the signup brand at checkout, but the operative brand is rewritten later at `setup_infrastructure` and never re-screened (evasion vector). Build: re-screen on brand change at `setup_infrastructure`; same review-queue path.
2. **`reserved_cents` crash/replay leak** — reserve fails CLOSED but a crash between reserve and commit/release leaks reservation → false `capacity_pending`. Build: a stale-reserve reaper/reconcile in `scheduled()` (sibling of the stale-'pending' idempotency-claim reclaim already on ACTIVATION Gate-2).
3. **SDN subset-token match false-positive flood** — accepted for v1 (review-queue absorbs it; founder Q2 covers posture), but the review queue MUST show match context so a human can clear fast; no refund/SLA promise on customer surfaces while held.
4. **Honesty statement** — add an explicit "what OFAC v1 does and does NOT catch" paragraph to the compliance page/legal inventory at build time; never claim "OFAC compliant," claim "SDN-screened."
