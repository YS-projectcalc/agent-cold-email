# Customer-continuity design — 2026-08-18

> **CURRENT: v3 final — DESIGN COMPLETE, ready for build.** §7 is binding; within it **§7.17
> (round-2 fold) → §7.18 (Q4 EMIT-branch fold) → §7.19 (final micro-fold) take precedence, in that
> order.** Four adversarial passes: round 1 returned 14 blocking + 9 non-blocking, round 2 (on the
> v2 fix code) 4 + 4, the Q4 emit-branch pass 1 + 1 + a severity upgrade, and the final pass 1 + 1.
> **All 20 blocking findings folded; all 4 founder questions ruled and closed; no open questions.**
>
> ⚠️ **Builders start at [§7.19](#719-wave-level-rule--every-anchor-is-clamped-to-real-wall-clock-x1)** —
> it carries the one rule that binds every increment (clamp every anchor to real wall-clock) and it
> is the rule whose omission fails *silently*.
>
> **v1 GATED SHIP-AFTER-FIXES → see [§7 DESIGN v2](#7-design-v2--2026-08-18-post-gate) for the
> binding design.** The adversarial design gate
> (`docs/adversarial/customer-continuity-design-gate-2026-08-18.md`, 3 rounds) returned 14 blocking
> deltas + 9 non-blocking notes. **The core mechanism survived every attack** — one derivation /
> three consumers / derive-don't-store, dry-run purity, the S1 subrequest math, and address
> determinism under a per-domain distribution — and is unchanged. What failed is the *contract
> shape* around it. §§1–6 below are kept verbatim as the v1 record because the gate cites them by
> section number; every section the gate contradicted carries an inline `SUPERSEDED` marker naming
> the finding and the §7 subsection that replaces it. **Where §§1–6 and §7 disagree, §7 wins.**

Design for the founder's CUSTOMER-CONTINUITY [ORDER] (`ROADMAP.md` `## Open`, 2026-08-18):
*"change documentation as well as our own response system so 1. this never happens again
2. we keep making sure he and other customers can always be continuing along."*

Read-only study; no code changed. Built on the **post-vendor-truth** contract
(`feat/vendor-truth-2026-08-18`, diffed against `8c87c79`) — **now MERGED to main at `a0fd314`**,
so everything below is grounded in shipped code rather than a pending branch:
`operator_pending` severity rung, `VendorError.operatorActionable`, the
`vendor_operator_blocked` error code, nullable `vendorReputationScore`/`vendorPlacementRate`,
the `mailbox_orphan:`/`domain_orphan:` watchtower checks, and the operator-side `ackedAt`
rename. Everything below is **additive to that contract**, never a revision of it.

---

## 1. Problem statement — the four benchmark failures

Today's incident is the acceptance test. Every step below required an operator message to a
paying customer's agent. The design's job is to make each one unnecessary.

**B1 — a terminal wall that was a fundable refusal.**
An empty InboxKit credit wallet 4xx'd `/warmup/add`; `mapInboxKitError` graded every non-429
4xx permanent; the agent was told *"Retrying as-is will not help — check your inputs"* and
correctly disabled its retry loop over a $19 top-up.
**Status: FIXED by the vendor-truth wave** (`error-response.ts:158-186`,
`retry-setup-message.ts:39-66`, `tenant-messages.ts`'s fourth rung). P1 must not regress it;
P1 extends the same honesty to SUCCESS paths.

**B2 — a completed `setup_infrastructure` that silently left half the paid capacity unbuilt.**
`domains`/`inboxesEach` are a TARGET over tenant ORDINALS, not a delta
(`provisioning.ts:91-124`). The address for (ordinal `d`, slot `i`) is
`` `${personaSlug}${d+1}${i+1}@${domain}` `` (`mailbox-provisioning.ts:107-114`). So the
customer's two calls — `{domains:1, inboxesEach:3}` then `{domains:1, inboxesEach:2}` — both
addressed **ordinal 0**: the second bought `mordytee12` (ordinal 0, slot 1) on the *same*
domain. Reaching ordinal 1 requires `domains:2`. A repeat call at the same `domains` provisions
nothing new once its ordinals are satisfied, and changing `persona` retargets every address.
None of that is in the tool description, the openapi description, or the response.
The response said `{jobId, billing}` — full success — and stayed silent about four paid,
unprovisioned mailbox seats.

**B3 — the agent could not read warmup state.**
Ticket `sup_71e8b4d1` needed an operator to explain four things the surfaces do not say:
(i) vendor-pool warmup traffic is invisible in our feed by design; (ii) `sendReady` is a
*fully-ramped* flag, not a send gate — `isSendReady(day) = day > WARMUP_RAMP_DAYS`
(`warmup.ts:29-31`); (iii) ramp caps permit capped sending from day 1
(`warmupDailyCap`: 5/15/25/35/40); (iv) the TOP-LEVEL `sendReady` is
`mailboxHealth.every(m => m.sendReady)` (`infrastructure-status.ts:173`) — one fresh mailbox
flips the whole account false, while each mailbox's own `sendReady` is what actually matters.

**B4 — nobody would have noticed a silently-stalled customer.**
`mordytee12` sat paid-and-unadopted 19h; `goauthorpitchdesk` sat ~500h.
**Partially fixed:** the vendor-truth wave's `mailbox_orphan:`/`domain_orphan:` checks
(`watchtower.ts:431-503`) catch a *vendor-side* orphan — an intent row stuck post-purchase with
no live row. They do **not** catch B2's shape: ordinal 1 has **no `domain_intents` row at all**,
because no call ever asked for it. Nothing catches an agent that simply stops calling.

**The common mechanism.** Every one of B2/B3/B4 is the same defect: *the platform knows the
answer and does not say it.* `planProvisioning` knows exactly which slots are unfilled.
`billableMailboxCount` vs `mailbox_qty_synced` knows exactly how many seats are paid and idle.
`isSendReady` knows exactly what the flag means. The state is there; only the *telling* is
missing.

---

## 2. P1 — self-guiding responses + docs

### 2.1 The core primitive: `deriveNextSteps(ctx)`

> **PARTLY SUPERSEDED — gate B3 + R7.** The mechanism stands (it survived the gate's purity
> attack). The `planFor` signature does not: persona must ride the TARGET, not the snapshot, and
> the snapshot is lossy. Replaced by §7.3.

One pure, read-only function over DO-local state. **Three consumers, one implementation**
(CLAUDE.md rule c): terminal responses embed it, the P2 watchtower check counts it, and the
phase-2 nudge renders from it. This single-sourcing is the whole answer to "how does it stay
TRUE by construction" — there is no second copy to drift.

**Anti-drift rule (the load-bearing one): a recommendation is a DRY RUN, not a sentence.**
The `setup_infrastructure` step does not *describe* what a call would do; it runs the actual
planner against candidate params and reports what the planner said. Concretely, increment 1
extracts the planner so both callers share it verbatim:

```ts
// engine/provisioning-plan.ts  (extracted from provisioning.ts:91-124, behaviour unchanged)
export interface ProvisioningSnapshot {          // ONE read of each table, no per-candidate SQL
  intentsByOrdinal: Map<number, { candidateDomain: string; liveDomain: string | null }>;
  liveMailboxAddresses: ReadonlySet<string>;     // released_at IS NULL
  personaSlug: string;
}
export function readProvisioningSnapshot(ctx: TenantContext): ProvisioningSnapshot;
export function planFor(snap: ProvisioningSnapshot, target: { domains: number; inboxesEach: number }): ProvisioningPlan;
```

`planProvisioning` becomes `planFor(readProvisioningSnapshot(ctx), input)` — the identical
function `runSetupInfrastructure` calls at `provisioning.ts:453`. `deriveNextSteps` takes ONE
snapshot and evaluates candidate targets **in memory** using `managedMailboxAddress`, the same
address deriver the saga uses. No SQL inside any candidate loop (this also keeps
`test/loop-isolation-coverage.test.ts` green — a new `for` body containing `ctx.sql.exec`
reddens the whole platform suite).

A recommended call that the planner says buys nothing is **not emitted**. That is what makes
the claim structurally unable to lie.

### 2.2 The contract shape

> **SUPERSEDED — gate B6, L1, non-blocking 4.** `call` cannot express a non-tool action (there is
> no checkout MCP tool), `waitingOn` has no customer-billing member, and `params` needs a sibling
> for fields the platform cannot know. Replaced by §7.2.

Types live in `packages/shared/src/next-steps.ts`. **Do not add a tenth hand-mirrored DTO copy**
in `apps/dashboard/src/api/types.ts` — import it (completeness-pass finding C-M1).

```ts
/** Closed union. The runtime array is the source of truth; the type is derived from it, so a
 *  new reason cannot be added without the doc-coverage guard seeing it. */
export const NEXT_STEP_REASONS = [
  "paid_seats_unprovisioned",
  "domain_dns_incomplete",
  "setup_operator_blocked",
  "message_action_required",
  "mailbox_credentials_pending",
  "ready_to_launch",
] as const;
export type NextStepReason = (typeof NEXT_STEP_REASONS)[number];

export interface NextStep {
  reason: NextStepReason;
  /** owed = the account will not progress until this happens.
   *  available = nothing is blocked; this is the next thing worth doing.
   *  Only `owed` steps feed the P2 stuck check and the phase-2 nudge. */
  kind: "owed" | "available";
  /** One customer-safe sentence. Vendor-blind (GUARDRAIL B): composed prose, never err.message. */
  why: string;
  /** The exact call to make. Nothing here is a template for the agent to fill in. */
  call: {
    /** An MCP tool name AND the openapi operationId — the two are the same string today. */
    tool: "setup_infrastructure" | "launch_campaign" | "contact_operator" | "ack_message";
    /** Literal, ready-to-send arguments. Complete: the call succeeds as written. */
    params: Record<string, unknown>;
    /** The key to REUSE, or null = mint a fresh one. Never a key we invented. */
    idempotencyKey: string | null;
  };
  /** Who must act before this can succeed. null = the agent can act right now. */
  waitingOn: "operator" | null;
  /** Do not repeat this call before `notBeforeMs` from now. This is the retry CADENCE as a
   *  machine field rather than prose — 0 means "now". */
  notBeforeMs: number;
  /** The billing consequence, from buildMailboxBilling — the SAME projection the response's
   *  own `billing` field uses. null when the step changes no billable count. */
  effect: MailboxBilling | null;
  /** How long this condition has existed, when an honest anchor exists; null when none does
   *  (see §3.2 — `paid_seats_unprovisioned` has no activation timestamp to age from). */
  sinceMs: number | null;
}

export interface NextSteps {
  /** EXPLICIT discriminator. An empty `steps` array must never be the only signal — a
   *  shape-only classifier cannot distinguish "nothing is owed" from "not computed". */
  status: "owed" | "none_owed";
  steps: NextStep[];
  computedAt: number;
}
```

**`status: "none_owed"` is the "nothing further owed" terminal form** the brief asks for. It is
a positive statement, emitted with `steps: []` or with `available`-only steps.

### 2.3 Which responses carry it

> **AMENDED — gate non-blocking 1 + B6.** The 502 row is DROPPED (`toErrorResponse` runs in the
> Worker with no `ctx.sql`); a lifecycle gate is added inside the primitive. See §7.4.

Additive field `nextSteps` only; no existing field changes type, name, or meaning.

| Surface | Where | Notes |
|---|---|---|
| `setup_infrastructure` 202 done | `SetupInfrastructureRunResult` (`provisioning.ts:394`) | closes **B2** |
| `setup_infrastructure` 202 `provisioning:"pending"` | same | the DNS-repeat step, with its cadence in `notBeforeMs` |
| `setup_infrastructure` 202 `provisioning:"capacity_pending"` | same | `waitingOn:"operator"` |
| `setup_infrastructure` 200 `quoteOnly` | same | preview carries the same guidance |
| `setup_infrastructure` 502 `vendor_operator_blocked` | `error-response.ts:158-186` | mirrors the wave's own wording; `idempotencyKey` = the caller's key |
| `remove_mailboxes` | `RemoveMailboxesResult` | a non-terminal `failedCount > 0` gets an owed retry step (`remove-mailboxes-terminality.ts:24-41`) |
| `launch_campaign` | its result | `available` steps only; never nags |
| `infrastructure_status` | `getInfrastructureStatus` (`infrastructure-status.ts:167`) | the poll surface — the one an agent hits repeatedly |

`SetupInfrastructureRunResult` gains an OPTIONAL `nextSteps`. Note the deliberate contract at
`provisioning.ts:380-393`: `provisioning`'s **presence** means "still owes work", and
`isSetupProvisioningIncomplete` tests presence rather than enumerating values. `nextSteps` must
NOT be read by that predicate and must not be spelled into that union — it is orthogonal
metadata, present on terminal and non-terminal outcomes alike.

### 2.4 Worked example — the incident's exact state

> **SUPERSEDED — gate B1 (CONFIRMED LIVE in prod, tickets `sup_dce385a8` / `sup_9d2c9a3a`) + L1 +
> founder ruling Q2.** Omitting `registerDomains` makes this exact call 503 and page the founder:
> the READ path is `optIn: input.registerDomains ?? false` (`tenant-do.ts:790`), so absent reads as
> opted OUT. The example is also no longer a 6-overshoot — Q2 rules that a per-domain distribution
> ships this wave. Replaced by §7.5.

Mordy's tenant after `{domains:1, inboxesEach:3}` + `{domains:1, inboxesEach:2}`: ordinal 0 has
a live domain with `mordytee11` + `mordytee12`; billable = 2; Stripe quantity floors at 5
(`billing.ts:95-97`, `MINIMUM_BILLABLE_MAILBOXES`). The response that said only
`{jobId, billing}` would instead say:

```json
{
  "jobId": "job_7c1f…",
  "billing": { "provisionedAfter": 2, "projectedMonthlyCents": 3960, "formula": "$49 platform + $10/mailbox, 5 minimum" },
  "nextSteps": {
    "status": "owed",
    "computedAt": 1755500000000,
    "steps": [
      {
        "reason": "paid_seats_unprovisioned",
        "kind": "owed",
        "why": "You are billed for 5 mailboxes and 2 are provisioned. Domain slot 0 (mordytee.com) holds 2 of its 3 mailbox slots; domain slot 1 has never been requested. `domains` and `inboxesEach` name the ordinals a call covers, so repeating domains:1 provisions nothing further — reaching slot 1 needs domains:2. Keep `persona` exactly as it is: mailbox addresses are derived from it, so changing it buys new addresses on slots that are already filled.",
        "call": {
          "tool": "setup_infrastructure",
          "params": {
            "brand": "Press Outreach",
            "primaryDomain": "authorpitchdesk.com",
            "domains": 2,
            "inboxesEach": 3,
            "persona": "Mordy Tee",
            "physicalAddress": "…",
            "senderIdentity": "…"
          },
          "idempotencyKey": null
        },
        "waitingOn": null,
        "notBeforeMs": 0,
        "effect": { "provisionedAfter": 6, "projectedMonthlyCents": 4360, "formula": "$49 platform + $10/mailbox, 5 minimum" },
        "sinceMs": null
      }
    ]
  }
}
```

Two things this example settles:

- **`params` omits `registerDomains` and `registrant` deliberately.** Omitting `registerDomains`
  leaves persisted consent unchanged (`intents.ts:86-101`, `provisioning.ts:542`), and
  `registrant` is required *only* when `registerDomains` is `true` in the input — the engine
  re-derives it from `tenant_profile` (`provisioning.ts:216`). So the call is valid as written
  **and** we never echo registrant PII into a status response.
- **`effect.provisionedAfter` is 6, not 5, and we say so.** `inboxesEach` is uniform across
  ordinals, so "5 mailboxes over 2 domains" is not expressible in this API. The step recommends
  the platform's own bundling ratio (`MAILBOXES_PER_DOMAIN = 3`) and states the real billing
  consequence from `buildMailboxBilling`. An overshoot the customer is *told about* is a
  product limitation; an overshoot discovered on the invoice is a defect. (Whether to make the
  shape expressible is open question Q2.)

  Both cent figures above are this tenant's real numbers, not placeholders:
  `monthlyRevenueCents(n, 60)` with `billableMailboxes(2) = 5` gives
  `round((4900 + 5×1000) × 0.4) = 3960` — the $39.60 actually invoiced — and
  `billableMailboxes(6) = 6` gives `round((4900 + 6×1000) × 0.4) = 4360`. The MORDYPILOT 60%
  coupon is folded in by `buildMailboxBilling` reading `tenant_profile.checkout_discount_pct`,
  so the step's `effect` is the price the customer will actually be charged, not list.

### 2.5 The doc surface

> **AMENDED — gate B7 + L2.** The "no background retry" claim is falsified by an env flip
> (`PROVISIONING_RECONCILE_ENABLED`) and needs a lockstep guard; the `registrar_unarmed` two-leg
> message split joins this surface. See §7.7 and §7.8.

| Surface | What it must teach |
|---|---|
| `mcp/tools.ts` `setup_infrastructure` | ordinals/slots; a repeat call at the same `domains` provisions nothing new; persona determinism (address = `persona`+ordinal+slot); key lifecycle (governs replay only, never purchase); DNS retry cadence + "there is no background retry"; that the response now carries `nextSteps` |
| `mcp/tools.ts` `infrastructure_status` | the B3 quartet: vendor-pool warmup is feed-invisible by design; `sendReady` = fully-ramped flag, not a send gate; ramp caps permit capped sending from day 1; top-level `sendReady` is the AND across mailboxes while the per-mailbox flag is the one that matters. Plus `nextSteps` |
| `mcp/tools.ts` `remove_mailboxes`, `launch_campaign` | `nextSteps` presence + the `status` discriminator |
| `site/openapi.yaml` | `/setup-infrastructure` + `/infrastructure-status` descriptions; replace both `additionalProperties: true` response schemas with a real `NextSteps` component + a `NextStepReason` enum; extend the `VendorError` prose already added by the wave |
| `AGENTS.md` | public tool table row updates (folded by the orchestrator, per `tools.ts:1-15`) |
| `admin/support-kb.ts` | the operator KB answers B2/B3 without a human composing them |
| `site/docs.html`, `site/for-agents.html` | the human/agent-readable narrative of slot semantics + warmup semantics |

### 2.6 The docs↔behaviour lockstep guard

> **SUPERSEDED — gate B2.** G5 as written runs on sandbox adapters, where `selectSetupDomainPort`
> returns early and `registerDomains` has no effect — so the guard is blind to the one field that
> breaks the recommendation. Its equality assertion also contradicts the platform's own documented
> partial-success paths. Replaced by §7.6.

The claim-guard idiom is `apps/platform/test/site-claim-surface-scope.test.ts`: whole-file
`?raw` imports (the workers pool has no filesystem), a surface table, assertions per surface.
That idiom catches *reintroduced prose*. It does not catch *behaviour that outgrew its prose* —
which is the failure mode here. So P1 pairs it with **vocabulary-coverage guards driven by
runtime arrays**:

- **G1 severity vocabulary.** Export `TENANT_MESSAGE_SEVERITIES` as a `const` array and derive
  `TenantMessageSeverity` from it. Assert: every member appears in every `MCP_TOOLS` description
  that mentions any member, and the `openapi.yaml` `TenantMessage.severity` enum equals the array
  exactly. *A fifth rung reddens this before it can ship undocumented — the vendor-truth wave had
  to hand-edit four descriptions to add `operator_pending`, and nothing would have caught a miss.*
- **G2 reason coverage.** Same technique over `NEXT_STEP_REASONS` against the openapi enum and
  the tool descriptions.
- **G3 tool names are real.** Every `NextStep.call.tool` producible must be in
  `MCP_TOOLS.map(t => t.name)` — the type union gives compile-time coverage; a runtime assertion
  over the state-fixture matrix covers the values actually emitted.
- **G4 slot-semantics claims.** Text assertions for the four B2 claims, each sitting in the same
  test file as the behavioural test that PROVES it (below), so the prose and its proof are read
  together.
- **G5 the convergence property (the real guard).** For each fixture tenant state: derive
  `nextSteps`, execute the emitted `call` verbatim through the real saga against sandbox
  adapters, re-derive — the step's `reason` must be gone, and `effect.provisionedAfter` must
  equal the observed post-call `billableMailboxCount`. This is what makes drift impossible: a
  recommendation that does not actually close its own condition fails.

### 2.7 Scope discipline

> **SUPERSEDED — gate B1/B5 + founder rulings Q1/Q2.** "Additive only, no input-contract change"
> is not survivable: B1 needs the zod `superRefine` relaxed and Q2 adds a per-domain distribution.
> The one-new-column budget is also retracted. Replaced by §7.9.

Additive only. No response field is renamed, retyped, or removed. `readAt` stays `readAt` on
both agent-facing surfaces (the wave renamed it to `ackedAt` on the **operator** type only —
`tenant-messages.ts`'s `OperatorTenantMessage`). No new severity rung. No new error code. No
migration except the one column in §3.3.

---

## 3. P2 — stuck-customer detection

### 3.1 The check

> **SUPERSEDED — founder ruling Q3 + gate R8.** One check name cannot carry a blame-split channel;
> "digest-only" is not an expressible state for a watchtower check today. Replaced by §7.11.

`customer_progress:<tenantId>` — a per-tenant watchtower check following the exact shape of the
wave's orphan checks (`watchtower.ts:431-503`): emitted by `sendPipelineChecks`, a PURE function
over the `opsSummary` the failure-signal scan **already fetched**. **No new subrequests, no new
vendor calls** — it rides the existing fan-out, which is what the S1 ceiling requires
(measured `subrequests(N) = 8.0N + 29`).

Naming follows the per-entity prefix convention (`MAILBOX_ORPHAN_CHECK` et al):
`export const CUSTOMER_PROGRESS_CHECK = "customer_progress:"`, with `labelFor` returning
`Customer progress <tenantId>`.

**Alert policy: `DEBOUNCED_ALERT_POLICY` — the default, no exemption.** This is re-sampled every
5 minutes by the cron, so it is exactly the shape the default was written for
(`watchtower-policy.ts:56-61`; `policyFor`'s own doc says the default is deliberate for
re-observed cron probes). `watchtower-policy.test.ts` enumerates every check name and fails if a
new one lands without a stated classification — the new name must be added there with its reason.
The alert-policy table stays the single cadence authority; nothing in P2 introduces a second one.

### 3.2 The signals

> **SUPERSEDED — gate B5 + non-blocking 2/3/5.** `unusedPaidSeats` is permanently non-zero for
> every tenant who wants fewer than 5 mailboxes — a legitimate steady state byte-identical to the
> incident. `owedNextSteps: NextStep[]` also over-widens the ops-summary payload. Replaced by §7.10.

All DO-local, all added to `SendPipelineSignals` (`ops-summary.ts:60-160`) alongside the wave's
`mailboxOrphans`/`domainOrphans`:

| Signal | Source | Meaning |
|---|---|---|
| `owedNextSteps` | `deriveNextSteps(ctx).steps.filter(kind === "owed")` | the SAME machinery as P1 — one definition of "has unfinished business" |
| `unusedPaidSeats` | `max(0, max(MINIMUM_BILLABLE_MAILBOXES, tenant_profile.mailbox_qty_synced) − billableMailboxCount(ctx))` | money paid for capacity that does not exist |
| `unackedBlockingMessages` | `tenant_messages` where `severity IN ('action_required','operator_pending')` AND `read_at IS NULL`, with each row's `created_at` | a held message nobody acted on |
| `lastAgentActivityAt` | the new stamp (§3.3) | when the tenant's agent last called us |
| `oldestOwedSinceMs` | `MIN(step.sinceMs)` over owed steps where non-null | how long the oldest *ageable* owed condition has run |

**Two honesty notes, both load-bearing.**

*(a) `unusedPaidSeats` is bounded by the floor, and the design says so rather than implying more.*
`syncMailboxQuantity` sets `mailbox_qty_synced` to `max(5, provisioned)`, so after any sync this
is non-zero **exactly when a paying tenant holds fewer than 5 live mailboxes** — i.e. it detects
the 5-seat-minimum gap, which is precisely Mordy's case, and nothing wider. `mailbox_qty_synced = 0`
means no real Stripe subscription (simulated / test-mode-unarmed tenant) → skip the tenant entirely.

*(b) `paid_seats_unprovisioned` has `sinceMs: null` and that is correct.* There is no honest
anchor: `mailboxes` has no `created_at` column, `domains.purchased_at` mixes clock domains by its
own schema comment (`schema.ts:224-229`) and can sit in the real future after a clock migration,
and `tenant_profile` carries no activation timestamp. Rather than stamp an anchor at the moment
we first read it — which measures ~0 forever for the existing population — the step reports
`null` and the check falls back to the agent-activity bound for that reason. Adding a
`first_activated_at` stamp is a follow-up, not this wave.

### 3.3 `lastAgentActivityAt` — the one new write

> **SUPERSEDED — gate B4 (now a PREREQUISITE for the Q1 nudge shipping at all).** The
> `"agent"|"internal"` discriminator is on the wrong axis: `infrastructureStatus()` serves two
> principals, and the cookie-authed dashboard SPA **polls it on a timer**, so any open browser tab
> defeats the signal. The platform already carries the right discriminator one layer up —
> `authVia`. Replaced by §7.10.2.

Nothing in the repo records when a tenant's agent last called (`/usr/bin/grep` for
`last_seen`/`last_call`/`lastActivityAt` across `apps/platform/src`, `migrations`, and
`packages/shared/src`: **no matches**). It has to be built.

**Where it must NOT go: `requireContext()` unconditionally.** That builder is the choke point for
*every* DO entry, including `opsSummary()` — which the cron calls on every tenant every 5 minutes.
Stamping there would make the signal refresh itself forever and the check could never fire: a
gate waiting on state the gated observer produces.

**Design:** `requireContext` gains a REQUIRED discriminator argument, mirroring the idiom this
codebase already chose for exactly this reason (`watchtower-policy.ts:10-16`: *"Making `policy` a
REQUIRED argument means a new call site has to state which rule it wants instead of silently
inheriting one"*).

```ts
private requireContext(caller: "agent" | "internal"): TenantContext
```

`"agent"` stamps; `"internal"` does not. A new RPC method does not compile until it classifies
itself, so the signal cannot silently rot.

- **Storage:** `tenant_profile.last_agent_activity_at INTEGER` via one more
  `addColumnIfMissing("tenant_profile", …)` line in `ensureColumnMigrations()`
  (`tenant-do.ts:324-336`) — the existing self-applying column-migration path the DO constructor
  already runs, so no operator step and no D1 migration. No D1 write, no subrequest.
- **Throttled:** write only when `now − stored >= AGENT_ACTIVITY_RESOLUTION_MS` (default 5 min).
  At most ~12 tiny writes/hour/tenant regardless of call volume, and 5-minute resolution is
  irrelevant against a 24h bound.
- **Timing shape preserved:** `requireContext` is synchronous and DO `ctx.storage.sql.exec` is
  synchronous, so **no `await` is introduced on any hot path**. This is deliberate — an
  entry-guard that grows a microtask tick has broken stream timing in this repo before, and
  targeted tests plus `tsc` did not catch it. The full suite must run, not the targeted slice.
- **Clock:** real wall-clock, not `ctx.clock` — a demo tenant's `VirtualClock` runs up to 1440×
  accelerated and would blow through a 24h bound in real minutes (the same rule
  `contact-operator-guard.ts:30-32` states for its own windows).

### 3.4 The rule

> **SUPERSEDED — gate B6 + R8.** The lifecycle filter names `terminated` (never a `billing_state`)
> and omits `status='suspended'` (the real predicate is `isLifecycleFrozen`). The one-name design
> also cannot carry Q3's blame-split channel. Replaced by §7.11.

For each tenant that is **activated**, on a **paid** plan, with `billingState` not in
`{canceled, canceling, disputed, terminated}` (never chase a customer who is leaving):

```
unhealthy  ⇔  owedNextSteps.length > 0
              AND ( now − lastAgentActivityAt > CUSTOMER_PROGRESS_STALL_MS      // agent absent
                    OR oldestOwedSinceMs > CUSTOMER_PROGRESS_OWED_MAX_MS )      // agent present, nothing moving
```

Defaults: `CUSTOMER_PROGRESS_STALL_MS = 24h`, `CUSTOMER_PROGRESS_OWED_MAX_MS = 48h`. Both
env-tunable, declared in `env.ts` next to `PROVISIONING_ORPHAN_GRACE_MS` with the same
"detection-timing bound, NOT spend-arming" reasoning the wave wrote for it.

**One check name, two diagnoses in the `detail`.** The disjunct that fired is named in the alert
body — `agent absent` vs `agent calling but nothing has advanced` — because they call for
opposite operator responses (nudge the customer vs. fix our own guidance). Sharing one name keeps
them deduped against each other, exactly the reasoning behind `mailbox_provisioning:` vs
`mailbox_rebuy:` being split *and* the orphan checks being unified.

`lastAgentActivityAt` NULL (a tenant that predates the column) is treated as "no activity
recorded" and the first disjunct is skipped for one bound's worth of time — a NULL must not
read as "silent since the epoch" and page on deploy day.

**Clearing.** `owedNextSteps.length === 0` → healthy with `basis: "reobserved"` (we re-ran the
actual predicate and it says nothing is owed — a positively checked fact, not an entity
dropping out of a filter). Tenant deactivated/suspended/canceled → healthy with
`basis: "no_longer_applicable"`, which makes `recoveryEmail` discard the prose rather than
announce a false cause.

**Digest line** in `buildOpsDigest` (`ops-sweep.ts:519+`), from the same summaries already
fetched — no new fan-out:

```
N customer(s) have unfinished setup and no agent progress past the bound —
see GET /admin/ops/checks for the named customer_progress: entries
```

### 3.5 Phase 2 — the automated nudge `[gated:founder]`

> **SUPERSEDED — founder ruling Q1 + gate R1/R2/R3/R4.** The founder ruled: in-product
> `tenant_messages` row ONLY, exactly ONE per stall episode, fired 1 day after onset — no email, no
> 1/day cadence, no give-up-after-3. That makes an episode onset + an emitted-once flag load-bearing
> (which §5 forbade), and the Inc5 set-identity dedup key becomes a self-re-arming loop because the
> nudge writes a row that joins the set keying it. Replaced by §7.12.

**Designed, not built in this wave.** It sends unsolicited outbound to a paying customer; that
is the founder's call.

**Content:** rendered from the SAME `NextStep[]` — one source of truth with P1. No
hand-written nudge copy exists anywhere.

**Channel:** a `tenant_messages` row is not sufficient on its own — an absent agent never reads
it. The nudge that matters goes to the tenant's signup contact email. Both are emitted; the
message row is the durable record, the email is the reach.

**Storm guards, modelled directly on the Inc5 admission guard (`engine/contact-operator-guard.ts`),
which exists because the first cut of `contact_operator` sent 96 emails against a cap of 5:**

- A DO-local `agent_nudge_log` table and a **synchronous** `admitNudge(ctx, …)` — decide-and-write
  in one uninterruptible step over `ctx.sql`. **That function must contain no `await`**, for the
  identical reason stated at `contact-operator-guard.ts:5-13`: a DO's input gate opens at every
  await, so a decision read from D1 loses the atomicity the cap depends on.
- **Cadence cap:** never more than 1 per 24h per tenant (`NUDGE_MIN_INTERVAL_MS`).
- **Give-up:** stop after `MAX_UNANSWERED_NUDGES = 3`. "Answered" = any agent activity after the
  nudge (`lastAgentActivityAt` advanced) **or** the owed set going empty. The counter resets on an
  answer — reset only on an independent positive signal, never on the act of nudging.
- **Dedup key = the sorted set of owed `reason`s.** A NEW owed reason re-arms the nudge even
  inside the give-up cap. This mirrors Inc5's ruling that an escalation must not be swallowed as
  a replay (gate finding #6): a customer who cleared one blocker and hit another is not the
  customer we already gave up on.
- **Claim-before-send + compensation:** the email slot is stamped before the send and released by
  `releaseNudgeClaim` if the send fails — never mark a dark channel as delivered.
- **Hard suppression (the cry-wolf rule):** never nudge when **every** owed step has
  `waitingOn: "operator"`. That is our blocker, not theirs; telling a customer to act on a wallet
  we have not funded is worse than silence. It routes to the operator digest only.
- Never nudge a non-activated, unpaid, or lifecycle-frozen tenant.

---

## 4. Build increments

> **SUPERSEDED — replaced by §7.13.** I1's characterization matrix cannot be green both before and
> after the move (gate B3), I2's RED assertion tests a persisted persona that does not exist, I6's
> test (a) asserts the exact behaviour B4 forbids, and I8 is rewritten by ruling Q1.

Ordered; each is independently mergeable and each names the test that must be RED first.

**I1 — extract the shared planner.** `engine/provisioning-plan.ts`:
`readProvisioningSnapshot` + `planFor`; `planProvisioning` becomes a two-line caller. Pure
refactor, zero behaviour change.
*RED first:* a characterization test asserting `planFor` returns byte-identical
`{satisfied, newDomains, newMailboxes}` to today's `planProvisioning` across a state matrix
(ordinal 0 satisfied/unsatisfied × persona changed/unchanged × partial slot fill). Written
against the CURRENT code so it is green before the move and must stay green after — the proof
the extraction changed nothing.

**I2 — `deriveNextSteps` + the shared types.** `packages/shared/src/next-steps.ts` +
`engine/next-steps.ts`. Not yet wired into any response.
*RED first:* `next-steps-derivation.test.ts` — a tenant with 2 live mailboxes on ordinal 0 and
`mailbox_qty_synced = 5` must yield exactly one `owed` step,
`reason: "paid_seats_unprovisioned"`, `call.params.domains === 2`, `call.params.persona ===`
the persisted persona verbatim, and `effect.provisionedAfter === 6`. Fails on today's code
because the module does not exist; fails on a half-built one because `effect` is computed by
`buildMailboxBilling` over the planner's own output.

**I3 — the convergence guard (G5).** The property test from §2.6.
*RED first:* deliberately mis-derive one candidate (e.g. recommend `domains: 1`) and confirm
the test fails; restore and confirm it passes. Revert-proof via `cp`, since this is the guard
everything else leans on.

**I4 — wire `nextSteps` into responses.** All eight surfaces in §2.3.
*RED first:* `next-steps-response-coverage.test.ts` — for each surface, a fixture in an
owed state must return `nextSteps.status === "owed"` with a non-empty `steps`, and a fixture in
a fully-provisioned state must return `nextSteps.status === "none_owed"`. Plus an
`isSetupProvisioningIncomplete` regression assertion: a terminal `{jobId, billing, nextSteps}`
must still classify as COMPLETE, so the replay layer is untouched.

**I5 — docs + the lockstep guards.** All surfaces in §2.5; guards G1–G4.
*RED first:* land G1 **before** touching any description — it must fail today, because no tool
description mentions all four severity rungs and the openapi enum is checked against the runtime
array. Then edit until green.

**I6 — `lastAgentActivityAt`.** The `requireContext(caller)` discriminator, the column
migration, the throttled stamp.
*RED first:* `agent-activity-stamp.test.ts` — (a) an `infrastructure_status` RPC advances the
column; (b) **an `opsSummary` RPC does NOT**; (c) two calls inside the resolution window produce
exactly one write. Test (b) is the one that matters: it fails on the naive
"stamp in `requireContext`" implementation, which is the implementation someone will reach for.
*Full-net run required, not the targeted slice* — this touches the entry path of every RPC.

**I7 — the `customer_progress` check.** The `SendPipelineSignals` additions, the check in
`sendPipelineChecks`, the `policyFor` classification, the digest line.
*RED first:* `customer-progress-check.test.ts` — (a) owed + agent silent past the bound → one
unhealthy result named `customer_progress:<id>`; (b) owed + agent active within the bound →
nothing; (c) owed set emptied → healthy with `basis: "reobserved"`; (d) tenant canceled →
healthy with `basis: "no_longer_applicable"`; (e) `watchtower-policy.test.ts:138-178` must FAIL
until the new name is classified. That existing failing-by-construction test parses
`watchtower-alerts.ts`'s own source for every declared check name and asserts each has an entry
in the test's `EXPECTED_CONFIRM_OBSERVATIONS` map, so declaring `CUSTOMER_PROGRESS_CHECK` reddens
it automatically — its red is the proof the classification was made deliberately rather than
inherited.

**I8 — phase 2 nudge.** Build only on the founder's go. `admitNudge` + `agent_nudge_log` +
renderer + the email leg.
*RED first:* `nudge-admission.test.ts` — 100 concurrent triggers admit exactly 1; a second
trigger inside 24h is refused; the 4th unanswered is refused; a NEW owed reason re-admits inside
the give-up cap; a send failure releases the claim; an all-`waitingOn:"operator"` owed set admits
ZERO. Plus a source scan asserting `contact-operator-guard.ts`'s no-`await` invariant holds for
the new file too.

---

## 5. Non-goals

> **THREE NON-GOALS RETRACTED — see §7.14 for the explicit retractions and what replaces them.**
> Keeping a retracted non-goal in force would make a builder satisfy the founder's rulings by
> quietly violating the doc (gate R1).

- **No breaking change to any existing response field.** Additive only.
- **No new severity rung, error code, or `provisioning` state.** The wave's quartet is the
  vocabulary.
- **No vendor calls anywhere in P1 or P2.** Every signal is DO-local SQL. The S1 subrequest
  ceiling is not moved, in either direction.
- **No second cadence authority.** `watchtower-policy.ts` remains the only place a cadence is
  decided; `customer_progress` takes the default and says so.
- **No persisted "last emitted nextSteps" row.** "Was a nextStep followed" is answered by
  re-deriving, not by remembering. Storing it would create a second truth that can drift from the
  first — the exact class this design exists to close.
- **No `first_activated_at` / `last_progress_at` stamp.** One new column is the budget; the
  honest `sinceMs: null` covers the gap for now.
- **No dashboard rendering of `nextSteps`.** The dashboard's operator-message blind spot is
  train 3's W-M5, not this wave's.
- **No autonomous retry on the customer's behalf.** The platform still never retries
  `setup_infrastructure` itself; it only tells the agent exactly what to call.

---

## 6. Open questions for the founder

> **ALL THREE ANSWERED — rulings recorded, and the gate's addendum re-attacked the design against
> them (R1–R8). Q1: in-product `tenant_messages` row ONLY, exactly one per stall episode, one day
> after onset — no email. Q2: the per-domain distribution WILL be built into `setup_infrastructure`
> as an additive contract change this wave, on its own gate. Q3: `customer_progress` splits channel
> by blame — `waitingOn:"operator"` → email, customer-side inaction → digest-only.** The design's
> response to each is §7.12, §7.5/§7.3, and §7.11. One new question is raised in §7.15.

**Q1 — Is the automated nudge authorized, and to which address?** Phase 2 sends unsolicited
outbound to a paying customer (email to the signup contact, plus a `tenant_messages` row). The
message-row half is safe and could ship now; the email half is the one that needs a ruling.
Everything else in P2 is operator-facing only and needs no permission.

**Q2 — `inboxesEach` is uniform across domains, so "5 mailboxes over 2 domains" cannot be
expressed.** Filling Mordy's 5 paid seats at the platform's own 3-per-domain ratio provisions 6
and bills 6. Options: (a) recommend the overshoot and state the billing consequence plainly
(this design's default); (b) recommend `{domains:1, inboxesEach:5}`, which fits exactly but
concentrates 5 mailboxes on one domain; (c) make the input express a per-domain distribution —
a real API change. Which?

**Q3 — Should `customer_progress` alert by email, or digest-only?** It is a *business* signal,
not an outage, and it fires on healthy infrastructure. Email at the default policy means one
alert per stalled customer plus a daily re-alert; digest-only means the founder sees it when he
reads the digest. At today's customer count either is fine; the answer sets the default before
the count grows.

---
---

# 7. DESIGN v2 — 2026-08-18 (post-gate)

Binding design. Folds all 14 blocking deltas and all 9 non-blocking notes from
`docs/adversarial/customer-continuity-design-gate-2026-08-18.md` (3 rounds), plus the founder's
Q1/Q2/Q3 rulings. Every gate cite in §§7.1–7.15 was independently re-verified against source
before being designed around; the two the gate could not check from its position are now resolved
by ledger facts (§7.1).

## 7.1 What changed at the root, and the prod facts the gate lacked

**The core mechanism is unchanged and is not re-litigated here.** One derivation, three consumers,
derive-don't-store; the dry-run planner; the S1 arithmetic; address determinism. The gate attacked
each and each held (its "ATTACKS THAT FAILED" section is the record). Everything below is contract
shape, signal honesty, and channel routing.

**Prod facts, now known (they were `UNVERIFIABLE` from the gate's position):**

- `REGISTRAR_PROVIDER=inboxkit` **IS armed in prod**, since 2026-07-29, and Mordy's
  `tenant_profile.register_domains` **is set** — his successful buys prove it. So B1's failing leg
  is the **per-request `optIn`**, not the env. That is the good direction: the recommendation is
  fixable by emitting one field rather than blocked until an operator arms something.
- `PROVISIONING_RECONCILE_ENABLED` is **UNSET** (arm-gate shut, now 4 blockers with R6 added). So
  B7's claim is true *today* and false *one env flip away* — exactly the shape that needs a guard
  rather than a rewording. **Nothing in this design depends on the reconciler**, and this wave
  neither arms it nor requires it.

## 7.2 The contract shape, revised (B6 · L1 · non-blocking 4)

> **AMENDED v3 — round-2 N6.** The empty-profile premise below is wrong about `brand` (captured at
> SIGNUP, `NOT NULL`). `paramsToSupply` must be computed per field by emptiness, never by a
> "never provisioned" population test. See §7.17.6.

Three changes: the action becomes a discriminated union so a non-tool next step is expressible, a
sibling names fields the platform cannot know, and `waitingOn` gains a customer-billing member.

```ts
export const NEXT_STEP_REASONS = [
  "paid_seats_unprovisioned",
  "seat_headroom_free",          // NEW (B5) — at the 5-seat floor, more mailboxes cost $0
  "domain_dns_incomplete",
  "setup_operator_blocked",
  "setup_capacity_held",         // NEW (non-blocking 4) — spend/slot hold ≠ operator-blocked
  "billed_quantity_drift",       // NEW (B5) — our Stripe push failed; ours to fix
  "account_frozen",              // NEW (B6) — lifecycle freeze; re-checkout is the way out
  "message_action_required",
  "mailbox_credentials_pending",
  "ready_to_launch",
] as const;

/** How the caller acts. A presence-tested discriminator, never a shape guess: `via` is always
 *  present, so "no action is possible" is a stated value rather than an empty object. */
export type NextStepAction =
  | {
      via: "mcp_tool";
      tool: "setup_infrastructure" | "launch_campaign" | "contact_operator" | "ack_message";
      /** Literal arguments, complete EXCEPT the names listed in `paramsToSupply`. */
      params: Record<string, unknown>;
      /** Fields the PLATFORM cannot know and the caller must add. Empty = send `params` verbatim.
       *  A sibling array, NEVER a magic sentinel inside `params` (gate L1): a placeholder string
       *  gets JSON-serialised and sent by an unattended agent, then fails zod — the same class of
       *  failure this wave exists to close. */
      paramsToSupply: string[];
      idempotencyKey: string | null;
    }
  /** No MCP tool exists for this action — verified: there is no `checkout` tool (`mcp/tools.ts`). */
  | { via: "http"; method: "POST"; path: string; note: string }
  /** Nothing the caller can do; the note says who acts and what unblocks it. */
  | { via: "none"; note: string };

export interface NextStep {
  reason: NextStepReason;
  kind: "owed" | "available";
  why: string;
  action: NextStepAction;
  waitingOn: "operator" | "customer_billing" | null;
  notBeforeMs: number;
  effect: MailboxBilling | null;
  sinceMs: number | null;
}
```

`NextSteps` (`status` / `steps` / `computedAt`) is unchanged — the explicit discriminator survived
the gate.

**`paramsToSupply` earns its place on the genuinely-unknown case, not as a PII dodge.** For a paid
tenant that has never called `setup_infrastructure`, `tenant_profile` holds no brand, persona,
physical address or sender identity — the platform cannot construct the call, and saying so
honestly beats emitting a call that 400s. Registrant PII stays out of responses by a different
route (§7.8): the zod refinement is relaxed so `registrant` is never needed in `params` at all.

## 7.3 The planner signature — one change for B3 and Q2 together (B3 · R7)

> **AMENDED v3 — round-2 N5.** R5's direction rule is well-formed but nothing actually LOWERS
> `inboxes_each` today. See §7.17.5.

Persona rides the **target**, not the snapshot. That preserves the spend-guard direction the code
comment at `provisioning.ts:106-109` calls "the one direction a spend guard must never be wrong
in": a persona-changing call must plan against the NEW addresses, or `newMailboxes` is understated
and both `assertWithinProvisioningCap` and the `quoteOnly` projection are sized too small.

Q2's distribution changes the same signature, so it is one change, not two (gate R7):

```ts
export interface ProvisioningSnapshot {
  /** Carries the domain row `id` — v1's `liveDomain: string|null` could not reconstruct
   *  `ProvisioningPlan.satisfied`'s `{id, domain}` (gate B3, lossy-snapshot half). */
  intentsByOrdinal: Map<number, { candidateDomain: string; live: { id: string; domain: string } | null }>;
  liveMailboxAddresses: ReadonlySet<string>;
  personaSlug: string | null;   // last-used, for RECOMMENDATION only — never for planning
}

/** ONE target type. Legacy `inboxesEach` is widened to a uniform distribution at the boundary,
 *  so there is no dual authority about what a call sending both would mean. */
export function planFor(
  snap: ProvisioningSnapshot,
  target: { persona: string; distribution: readonly number[] },
): ProvisioningPlan;
```

**Persona for the recommendation** comes from `domain_intents.persona_slug` (`schema.ts:952`) — the
only persistence, and it is the *slugified* form. Emitting the slug is address-equivalent
(`slugify` is idempotent on a slug), so the recommendation reproduces the same deterministic
addresses. v1's `"persona": "Mordy Tee"` claim is withdrawn: no raw persona is persisted anywhere
(verified across `schema.ts`). When `persona_slug` is NULL for every ordinal — the paid-but-never-
provisioned population — persona joins `paramsToSupply`.

Two validation classes arrive with the distribution (gate R7): length vs `domains`, and the sum
against `capFor`'s 60-mailbox / 20-domain cap (`quota.ts:32-37`), where today's per-element bound is
`inboxesEach: 1..10`.

**Recorded as safe (gate R7's failed attack):** address determinism holds under a distribution —
`managedMailboxAddress` is keyed on `(ordinal, slot)` and never on the per-domain count, so
narrowing ordinal 1 from 3 slots to 2 moves no surviving address. Narrowing is a silent no-op under
TARGET semantics; removal stays `remove_mailboxes`' job. **The emitted `why` must never imply that
a narrowed distribution releases anything.**

**R5 — the INSERT-only desired spec.** `domain_intents.inboxes_each` is INSERT-only by design
(`schema.ts:941-953`), and the dark reconciler re-drives toward it. A customer who narrows a
distribution would have ordinal 1's stored spec stay at the wider number, and an armed reconcile
would autonomously re-buy toward it — bill-raising on an unattended path, which the quantity-billing
arc ratified against. Resolution: the distribution lane makes the per-ordinal spec **updatable, with
direction as the consent rule** — LOWERING is always allowed (bill-neutral-or-lowering); RAISING is
written only by the customer's own call that raised it (the call *is* the consent). Guard:
`desired-spec-direction.test.ts` asserts no unattended path (reconcile, tick, sweep) ever raises
`inboxes_each`. **R6** (the reconcile's COUNT-based completeness test re-buying deliberately removed
mailboxes) is pre-existing, dark, and now ledgered as **arm-gate blocker #4** — out of this wave's
scope, and this wave does not depend on the flag.

## 7.4 Which responses carry it, revised (non-blocking 1 · B6 · non-blocking 3)

Seven surfaces, not eight. **The 502 row is dropped:** `toErrorResponse` runs in the Worker's
`app.onError` (`index.ts:160-165`) with only the error object and no `ctx.sql`, so structured
`nextSteps` there would require deriving at throw time deep inside the saga. Deferred with reason —
the `vendor_operator_blocked` body already states the next action in prose, which the vendor-truth
wave shipped and which is not regressed by this deferral.

**The lifecycle gate lives in the PRIMITIVE, not in each consumer** (B6 scenario 3 + non-blocking 3).
`deriveNextSteps` itself:

- returns `status:"none_owed"` with a single `account_frozen` step when
  `isLifecycleFrozen(status, billingState)` — the REAL predicate (`billing-state.ts:20-33`), read
  from source rather than hand-listed. v1's list named `terminated`, which is never a
  `billing_state` (it is `suspend_reason='terminate'` + a D1 status change), and omitted
  `status='suspended'`, which is half the real predicate. That step is
  `waitingOn:"customer_billing"`, `action: {via:"http", method:"POST", path:"/checkout", …}`;
- returns `status:"none_owed"` with no steps for demo / free / simulated tenants
  (`mailbox_qty_synced === 0`), so the `max(5,0) − 0 = 5` false billing sentence cannot reach a
  tenant who pays nothing.

## 7.5 The worked example, corrected (B1 · L1 · Q2)

> **EXAMPLE DATED — production has moved past this state; see §7.18.4 for the current one.** The
> `billable = 2` / owed example below is retained because its four numbered corrections ARE the
> closure record for B1, L1, B3 and Q2 — the state is stale, the corrections are not. Mordy's fleet
> completed 2026-08-18 (4 mailboxes across 2 domains, both DNS-ready, zero unhealthy), so his real
> step today is `seat_headroom_free`, not this one.

Mordy's tenant: `register_domains = 1` (persisted, prod-confirmed), ordinal 0 live with 2 mailboxes,
paying the 5-seat floor. Under Q2's distribution the fit is exact, and `registerDomains: true` is
present — a **re-affirmation** of consent the tenant already gave, which is what makes it safe:

```json
"nextSteps": {
  "status": "owed",
  "computedAt": 1755500000000,
  "steps": [{
    "reason": "paid_seats_unprovisioned",
    "kind": "owed",
    "why": "You are billed for 5 mailboxes and 2 are provisioned. Domain slot 0 (mordytee.com) holds 2 of its 3 mailbox slots; domain slot 1 has never been requested. `domains` and `distribution` name the ordinals a call covers, so repeating domains:1 provisions nothing further. Your account already consents to domain registration, so `registerDomains: true` re-states that — omitting it means NOT opted in for this request and the call is refused before anything is bought. Keep `persona` exactly as it is: mailbox addresses are derived from it.",
    "action": {
      "via": "mcp_tool",
      "tool": "setup_infrastructure",
      "params": {
        "brand": "Press Outreach", "primaryDomain": "authorpitchdesk.com",
        "domains": 2, "distribution": [3, 2], "persona": "mordytee",
        "physicalAddress": "…", "senderIdentity": "…",
        "registerDomains": true
      },
      "paramsToSupply": [],
      "idempotencyKey": null
    },
    "waitingOn": null,
    "notBeforeMs": 0,
    "effect": { "provisionedAfter": 5, "projectedMonthlyCents": 3960,
                "formula": "$49 platform + $10/mailbox, 5 minimum" },
    "sinceMs": 2419200000
  }]
}
```

Four corrections against v1's example, each traceable to a finding:

1. **`registerDomains: true` is present (B1, confirmed live).** The READ path is
   `optIn: input.registerDomains ?? false` (`tenant-do.ts:790`) → `selectRealDomainPort`
   (`factory.ts:194-201`) → `RegistrarUnarmedDomainPort`, which throws on `searchLookalikes`
   (`provisioning.ts:518`) — a call that runs **unconditionally, before any plan-shortfall
   branch**, so even a pure retry hits it. v1's justification cited only the WRITE path. Production
   reproduced this on a real customer (`sup_dce385a8`) and the retraction ticket
   (`sup_9d2c9a3a`) records the identical call succeeding with the field set.
2. **No `registrant`, and none needed** — resolved by relaxing the refinement (§7.8), not by a
   sentinel. `paramsToSupply` is empty: this call succeeds verbatim.
3. **`distribution: [3,2]` and `provisionedAfter: 5`** (Q2). The 6-overshoot and its `4360` are
   gone; the exact fit bills `3960` — unchanged from what he pays now, which is the honest and
   compelling sentence.
4. **`persona: "mordytee"`** — the persisted slug, address-equivalent, not the un-persisted raw
   string v1 claimed (B3).

**The consent branch (L1).** When `tenant_profile.register_domains = 0` or was never set, the
platform **must not** auto-emit `true` — that manufactures consent to real money spend inside a
recommendation an unattended agent executes verbatim. In that case the step is `kind:"available"`,
`params` **omits** `registerDomains`, and `paramsToSupply: ["registerDomains", "registrant"]` with
the consent decision stated in `why`. Consent is the customer's to give; the platform's job is to
say exactly what giving it requires.

## 7.6 G5 rebuilt: monotone progress on the real port selection (B2)

Two defects, two fixes.

**Real port selection, not the sandbox early-return.** `selectSetupDomainPort` returns early for a
non-real bundle (`tenant-do.ts:776`), so on sandbox fixtures `registerDomains` has **no effect at
all** — the one field whose omission breaks the recommendation is invisible to the guard meant to
make that impossible. G5's fixtures therefore run with `bundle.kind === "real"`: an `inboxKitConfig`
present and the registrar armed, with the vendor HTTP layer stubbed through the existing real-adapter
fixtures (`test/fixtures/inboxkit.ts`, the harness `real-inboxkit-*.test.ts` already use). At least
one fixture must assert the **negative**: an emitted step with `registerDomains` stripped must FAIL,
proving the guard can see the field.

**Monotone progress, not disappearance-and-equality.** Equality is contradicted by the platform's own
documented partial-success paths — `capacity_pending` reports what landed rather than the ask
(`billing.ts:954-961`), `forEachIsolated` deliberately completes some ordinals and fails others
(`provisioning.ts:633-658`), and `DomainPropagationPendingError` returns `provisioning:"pending"`. A
builder facing that either excludes partials from the fixture set — the 167-green-tests-on-the-happy-
path shape — or weakens the assertion at build time. The property becomes:

> After executing the emitted action: (a) the owed set did not GROW; (b) the step's own reason either
> cleared or its shortfall **strictly decreased**; (c) `effect.provisionedAfter` is an **upper bound**
> on the observed post-call `billableMailboxCount`; (d) no new reason appeared whose source is a row
> this wave writes.

(d) is the structural guard against the R2 self-re-arm class, stated as a property rather than a
convention.

## 7.7 Binding the no-background-retry claim to its flag (B7)

`runProvisioningReconcile` **is** a background provisioning retry, dark only behind
`PROVISIONING_RECONCILE_ENABLED` (`env.ts:235`, gate at `ops-sweep.ts:255-261`) — an env flip, not a
code change. G1–G4 are vocabulary guards and none binds this claim. This is verbatim the failure mode
§2.6 names ("it does not catch behaviour that outgrew its prose"), which makes it the most
instructive finding in the set.

Fix: **G6, a flag↔prose lockstep guard.** It asserts `provisioningReconcileArmed({})` is `false`
(the documented default, prod-confirmed UNSET) AND that the doc surfaces carry the unconditional
claim. Flipping the default reddens G6 and forces the prose to change in the same commit. Same
failing-by-construction shape as `spend-armed-env-coverage.test.ts`. The prose is additionally
worded to the flag's *meaning* rather than to an absolute: "the platform does not retry this for you
— completing it is the caller's job."

## 7.8 `registrar_unarmed`: relax the refinement, split the two legs (L1 · L2 · non-blocking 9)

**The refinement (L1(i), the gate's ranked recommendation).** `intents.ts:94-103`'s `superRefine`
rejects `registerDomains: true` without a body `registrant`. Relax it: the engine already re-derives
the registrant from `tenant_profile` (`readRegistrarOptInState` → `provisioning.ts:216`) and already
fails loud at the actual spend site via `assertCompleteRegistrant` → `IncompleteRegistrantError` → a
**400 naming the missing fields** (`error-response.ts:105-108`). The safety property is preserved at
the point that matters, the recommendation becomes emittable with zero PII in any response, and the
change is strictly widening — no existing caller's behaviour changes.

Honest cost, stated rather than buried: today a `registerDomains:true` with no registrant anywhere
fails at the zod boundary before any vendor touch; afterwards it fails at `assertCompleteRegistrant`,
which is at the buy call site — **still before any purchase**, but after `searchLookalikes` (a vendor
read). No spend, one wasted read.

**The two-leg split (L2).** `selectRealDomainPort` holds both booleans and throws both away
(`factory.ts:198-201` constructs `RegistrarUnarmedDomainPort()` with no argument);
`RegistrarUnarmedError`'s constructor takes only `op` (`errors.ts:107-115`). So one message serves
two very different conditions. For the **env** leg today's 503 is roughly right. For the **opt-in**
leg it is wrong twice: it says *account* when the truth is *this request*, and its
`operatorNotifiedClause(NOT_NOTIFIED)` routes an unattended agent to escalate to a human over
something its own next call fixes. The customer's retraction ticket said it themselves: *"'registerDomains
was not set on this request' would self-correct."*

This is the vendor-truth wave's class A surviving one seam over — a self-clearable refusal graded as
"no action of yours can work" — and the codebase grades it wrongly **in writing**:
`errors.ts:180-186` calls `RegistrarUnarmedError` "an operator-fixable arming gap" and contrasts it
with `IncompleteRegistrantError` as "a TENANT-fixable data gap". Production has now shown one leg of
the "operator-fixable" error is tenant-fixable in one field.

Fix: thread the failing leg factory → port → error
(`RegistrarUnarmedDomainPort(reason)` → `RegistrarUnarmedError(op, reason)`), then branch in
`error-response.ts`:

| Leg | Status | Code | Message shape |
|---|---|---|---|
| `opt_in` | **400** | `registrar_optin_missing` | names the field — "this request did not set `registerDomains: true`; no purchase was attempted. Resend the same call with it set." Modelled on `IncompleteRegistrantError`'s naming precedent. |
| `env` | 503 (unchanged) | `registrar_unarmed` | today's wording, untouched |

**Non-blocking 9, folded here since the file is open:** `RegistrarUnarmedError` carries
`operatorActionable: false` by omission (`super(message, false)`, `errors.ts:107-112`). Set it
honestly per leg — `true` on the env leg (an operator arming the env is precisely the clearer) and
`false` on the opt-in leg (the tenant clears it). Inert today because the name-branch precedes the
`VendorError` branch, but if that branch is ever removed the error takes the "check your inputs"
arm — B1's original defect, latent.

**The two-leg decouple guard is untouched:** both `armed` AND `optIn` still gate the real port; only
the message changes. Verified against the 21-test registrar-arming suite the gate ran.

## 7.9 Scope discipline, revised (B1 · B5 · Q2)

v1's "additive only, no input-contract change" is retracted — it is not survivable. This wave makes
**three** deliberate contract changes, each additive-or-widening and each gated:

1. **Relax the `registrant` refinement** (§7.8). Strictly widening; no caller changes behaviour.
2. **Add `distribution` to `SetupInfrastructureInput`** (Q2), with `inboxesEach` retained and widened
   to a uniform distribution at the boundary. Additive; own gate, per the ruling.
3. **Split `registrar_unarmed` into two statuses** (§7.8). A 503→400 change on one leg — the only
   behaviour change visible to an existing caller, and it converts an escalation into a
   self-correction.

**The one-new-column budget is retracted.** Three self-applying `tenant_profile` columns via
`addColumnIfMissing` (`tenant-do.ts:324-336`), no operator step, no D1 migration:
`last_agent_activity_at` (§7.10.2), `first_paid_at` (§7.10.1), `continuity_nudge_episode_ts`
(§7.12). Contorting the design to protect a budget I set myself would have produced exactly the
dishonest anchors §3.2(b) was written to avoid.

## 7.10 The signals, revised (B5 · B4 · non-blocking 2/3/5/6)

### 7.10.1 `paid_seats_unprovisioned` splits three ways (B5)

> **AMENDED v3 — round-2 N1, N4, N8 + founder ruling Q4.** The `billed_quantity_drift` arm
> false-fires permanently on a `past_due` tenant and emails the founder daily; `first_paid_at` has
> no backfill so B4 reopens for every existing paying tenant. See §7.17.1, §7.17.4, §7.17.8.

v1's `unusedPaidSeats` is permanently non-zero for every tenant who wants fewer than 5 mailboxes —
`syncMailboxQuantity` sets `mailbox_qty_synced = max(5, provisioned)`, so at the floor the gap never
closes. That population is byte-identical in state to the incident, and v1 would have given them a
permanently-`owed` step, a check that can never clear, and (under Q1) a nudge with no opt-out. The
split is by what the state can honestly support:

| Condition | Reason | `kind` | Rationale |
|---|---|---|---|
| paid, `billableMailboxCount == 0` | `paid_seats_unprovisioned` | **owed** | unambiguous: paying, nothing exists |
| `0 < billable < 5` (the floor gap) | `seat_headroom_free` | **available** | the customer receives exactly what they pay for; the platform cannot know they want more |
| `billable >= 5` AND `mailbox_qty_synced > billable` | `billed_quantity_drift` | **owed**, `waitingOn:"operator"` | the documented Stripe-push-failure window (`billing.ts:905-908`) — our bug, not theirs |

**No discriminator column is needed, and `seat_headroom_free` is the better product message anyway.**
Because `billableMailboxes` floors at 5, a tenant at 2 mailboxes pays exactly what a tenant at 5 pays
— so the honest sentence is *"you are already paying for 5 mailboxes; provisioning the remaining 3
adds $0 to your bill"*, and `effect.projectedMonthlyCents` proves it (3960 → 3960, unchanged). That is
worth saying once, in a response, and is never worth an alert or a nudge.

**This changes which reason carries the P2 benchmark, and that is an improvement.** Mordy's real stall
was ordinal 1 never requested, a DNS-stalled domain, and an operator-blocked warmup — i.e.
`domain_dns_incomplete` and `setup_operator_blocked`, both unambiguous AND both **ageable** from
existing anchors (`domains.dns_first_checked_at`, `tenant_messages.created_at`). The ambiguous signal
becomes advisory; the unambiguous ones carry the check. This is also what makes B4's disjunct 2
non-vacuous, which R3 identifies as the prerequisite for the Q1 nudge reaching anyone at all.

**`first_paid_at`** (column 2) closes the last hole: a paid tenant with `billable == 0` and no
`domain_intents` row has no anchor anywhere. Stamped once at `checkout.session.completed` — by the
money event itself, never at read time, so it does not measure ~0 forever for the existing population
the way a stamp-on-first-read would.

### 7.10.2 `lastAgentActivityAt` keys on `authVia`, bearer only (B4)

v1's `requireContext("agent"|"internal")` is on the wrong axis. `infrastructureStatus()`
(`tenant-do.ts:800`) is **one method serving two principals** — the agent's MCP tool and the
cookie-authed dashboard SPA, which **polls it on a timer** (`apps/dashboard/src/api/queries.ts:161-168`
via `pollingOptions`). So a single open browser tab keeps the signal fresh forever and the check never
fires on its own benchmark.

The platform already carries the right discriminator one layer up: `authVia: "bearer" | "cookie"`
(`require-auth.ts:24`, set at `:107`/`:121`), already mapped to a `source` provenance param for other
DO methods. So:

- **Stamp only when `authVia === "bearer"`.** An API credential is the agent; a session cookie is a
  human in the dashboard. Reads still count — a polling agent IS alive, and liveness is what this
  signal answers.
- Threaded as an explicit parameter on the RPC boundary, the same way `Provenance` already is
  (`routes/dashboard.ts:17-19`, `inbox.ts:53`, `leads.ts:45`), so no method infers its own principal.
- Everything else from v1 stands and was not challenged: throttled to a 5-minute resolution, real
  wall-clock (not `ctx.clock` — a demo tenant's `VirtualClock` runs up to 1440× accelerated), and
  **synchronous**, adding no `await` to any RPC entry path. The gate's own passed attack notes the
  no-`await` property is what keeps the derivation non-interleaving; §7.16 makes it a stated
  invariant rather than an accident.
- NULL (a tenant predating the column) is not "silent since the epoch": the first disjunct is skipped
  for one bound's worth of time so nothing pages on deploy day.

**The give-up-counter conflation is gone with the counter** (Q1 removes it). Under §7.12 the one-shot
is keyed on the episode's onset timestamp, so a customer opening a dashboard tab can no longer reset
anything — v1's unbounded 24h nudge loop is unreachable by construction rather than by rule.

### 7.10.3 Payload, scope and cap (non-blocking 2, 5, 6)

> **AMENDED v3 — round-2 N2.** `owedCount` is sourced from `deriveNextSteps`, which is exactly why
> the §7.12 exclusion must live there and not on `unackedBlockingMessages`. See §7.17.2.

- **Ops-summary payload minimised (2).** `SendPipelineSignals` gains
  `owedReasons: NextStepReason[]` + `owedCount` + `oldestOwedSinceMs` — **not** `NextStep[]`. Full
  `why` prose and profile fields never enter the RPC that feeds alert bodies and `buildOpsDigest`.
- **BYO tenants (5).** Suppress `paid_seats_unprovisioned` / `seat_headroom_free` when the tenant
  holds `domains.source='byo'` rows (`schema.ts:179`): recommending `setup_infrastructure` — a
  managed lookalike purchase — is the wrong product for that customer.
- **Cap-checked (6).** The dry run evaluates `capFor`'s domain/mailbox ceilings in memory before
  emitting, so "succeeds as written" is proven near the cap rather than assumed.
- **Non-blocking 7 is resolved by construction:** the set-identity re-arm key is gone (§7.12).
- **Non-blocking 8 deferred with reason:** `projectedMonthlyCents` is monthly for a
  `billing_interval='year'` subscriber. Pre-existing on the shipped `billing` field and merely
  inherited by `effect`; fixing it is a billing-surface change with its own blast radius. Ledgered,
  not folded.

## 7.11 The check: blame in the name, channel in the policy (Q3 · R8 · B6)

> **AMENDED v3 — round-2 N3.** The mandatory cross-clear is right, but a clear with
> `alertCount > 0` produces action `"recovered"`, which SENDS — so a blame flip emails "resolved"
> about a tenant that is still stalled. See §7.17.3.

Q3 ruled a blame-split channel. R8 proved it is not expressible today: `policyFor(checkName)` is
keyed by **name**, `AlertPolicy` carries only three cadence dials, and every alerted/realerted/
recovered transition renders and sends — **"digest-only" is not an expressible state for a watchtower
check**. The founder's axis is also per-OBSERVATION while policy is per-NAME. Option A is
implemented as the gate specified:

- **Two check names.** `customer_progress_operator:<tenantId>` and `customer_progress_agent:<tenantId>`.
  `policyFor` stays the single routing authority — no second one is introduced.
- **`AlertPolicy` gains `channel: "email" | "digest"`.** The routing decision lives in the one table
  that exists for exactly this purpose. `alertEmailFor` returns `null` for a digest-only policy, and
  `AlertOutcome.why` gains a `DeliveryReason` member `"digest_only"` — so the operator surface keeps
  telling "we chose not to" apart from "we could not tell you", which is that field's stated job
  (`packages/shared/src/provenance.ts:82-89`).
- **Mandatory cross-clear on blame flip.** v1's one-name rationale ("sharing one name keeps them
  deduped") is retracted, and its cost is the flip hazard: if blame changes and the check simply
  stops reporting the old name, that name never clears and re-alerts on the steady 24h step forever.
  So a blame flip **emits an explicit healthy result for the abandoned name in the same pass**, using
  the wave's own `for (const name of reported)` clear-loop pattern (`watchtower.ts`). Basis:
  `no_longer_applicable` — the condition no longer describes that name.
- **Mixed state — RATIFIED as the gate suggested: any operator-blamed owed step wins → email.** Our
  blocker is the one only we can clear, and the customer-side item is unactionable until it is.

**The rule**, with the real lifecycle predicate (B6):

```
scope      : activated AND paid AND NOT isLifecycleFrozen(status, billingState)
unhealthy  ⇔ owedCount > 0
             AND ( now − lastAgentActivityAt > CUSTOMER_PROGRESS_STALL_MS
                   OR oldestOwedSinceMs > CUSTOMER_PROGRESS_OWED_MAX_MS )
name       : any owed step with waitingOn === "operator"
               ? customer_progress_operator:<id>   (channel: email)
               : customer_progress_agent:<id>      (channel: digest)
```

Defaults 24h / 48h, env-tunable, declared beside `PROVISIONING_ORPHAN_GRACE_MS` with the same
"detection-timing bound, NOT spend-arming" reasoning. Clears: `owedCount === 0` → `reobserved`;
out of scope → `no_longer_applicable`.

## 7.12 The nudge, per ruling Q1 (R1 · R2 · R3 · R4)

> **AMENDED v3 — round-2 N2.** The containment exclusion below is wired to
> `unackedBlockingMessages`, which the unhealthy predicate does not read — so the nudge's own row
> sustains the check forever and **every future stall for that tenant is silently un-nudged**.
> The exclusion moves into `deriveNextSteps`. See §7.17.2.

**Ruling:** in-product `tenant_messages` row ONLY. Exactly ONE per stall episode, fired one day after
onset. No email, no 1/day cadence, no give-up-after-3.

**Episode identity comes from the machine that already exists.** `AlertState`
(`watchtower-policy.ts:104-121`) carries `status`, `sinceTs` (onset of the current status) and a
consecutive-unhealthy counter reset by any healthy observation — that is precisely "stall episode with
an onset". No parallel `agent_nudge_log` is built.

**Fire condition:** the check has been unhealthy for ≥ `NUDGE_DELAY_MS` (24h) measured from
`AlertState.sinceTs`, AND `sinceTs > tenant_profile.continuity_nudge_episode_ts`. On emit, stamp
`continuity_nudge_episode_ts = sinceTs`. Monotone: a new episode has a strictly later onset, so the
comparison alone gives exactly-one-per-episode with no counter.

**Why this key and not the reason set (R2).** The Inc5 dedup key was designed for a set the emitter
does not write. Here it does: the nudge writes a `tenant_messages` row → `unackedBlockingMessages`
selects it → `message_action_required` becomes a new owed reason → the set changes → the episode key
changes → the one-shot re-arms. A timestamp key breaks that loop structurally. Stated as a general
invariant, and guarded by §7.6(d):

> **No reason whose source is a row this wave writes may participate in the episode key, or sustain
> the check.**

So `unackedBlockingMessages` **excludes `kind = 'continuity_nudge'`**. Severity stays
`action_required` — which is *accurate* ("the account will not progress until someone acts, and the
actor is YOU") — rather than dodging to `info`, which would deprioritise it for a severity-branching
agent and is exactly the honesty trade the four-rung doc exists to stop. The gate offered `info` as a
cheap escape; it is declined deliberately, and the exclusion-by-kind achieves the same containment
without lying about urgency.

**Emit-on-transition, never re-derive-and-dedupe (R4).** `emitTenantMessage`'s dedup branch does not
skip — it **UPDATEs `severity, body, action_hint, created_at, expires_at`** (`tenant-messages.ts:129`).
Re-stamping `created_at` makes a re-emitted nudge look brand new on every poll and re-sort to the top
of the 5-row capped preview (`ORDER BY (source='operator') DESC, created_at DESC`, `:272`). So
"exactly one per episode" must be emit-once-on-transition. Two properties survive and are worth
keeping: an operator reply can never be displaced by a nudge (operator rows sort first), and no aging
logic may be built on a column a refresh re-stamps.

**Cost, named honestly (R1).** The episode state lives in the watchtower and the `tenant_messages`
write lands in the tenant DO, so this is **one cross-DO RPC on the transition only** — the first thing
in P2 that touches the S1 ceiling. Bounded at once per episode per tenant. §5's "the ceiling is not
moved, in either direction" is retracted for this one path (§7.14).

**R3, recorded as a consequence of the ruling, not a defect in it.** With email off, the disjunct-1
population (agent absent) cannot receive an in-product message by construction — that is what
"absent" means. The nudge's reachable population is disjunct 2 (agent present, nothing moving), which
§7.10.1 makes non-vacuous by giving the flagship reasons real anchors. **B4 is therefore a hard
prerequisite for Q1 shipping at all**, and §7.13 sequences it that way.

## 7.13 Build increments, revised

Fifteen, ordered. The B4 prerequisite and the Q2/L1/L2 contract changes reshape the sequence.

| # | Increment | RED-first test |
|---|---|---|
| **I1** | `planFor(snap, {persona, distribution})` + snapshot carrying the domain `id`; `inboxesEach` widened at the boundary | characterization matrix incl. **persona-changed** — must prove `newMailboxes` is NOT understated (v1's matrix could not be green both sides; this one pins the spend-guard direction) |
| **I2** | Relax the `registrant` refinement | a `registerDomains:true` + no body registrant + complete persisted registrant call must PASS zod and reach `assertCompleteRegistrant`; with NO persisted registrant it must 400 naming fields |
| **I3** | `registrar_unarmed` two-leg split + per-leg `operatorActionable` | opt-in leg → 400 `registrar_optin_missing` naming the field; env leg → 503 unchanged; both-legs-required guard still green |
| **I4** | `distribution` on the input + per-ordinal spec direction rule | length-vs-`domains` and sum-vs-cap rejections; `desired-spec-direction.test.ts`: no unattended path raises `inboxes_each` |
| **I5** | `deriveNextSteps` + shared types (`NextStepAction` union, `paramsToSupply`) | Mordy-state fixture yields the §7.5 step verbatim incl. `registerDomains:true`, `distribution:[3,2]`, `provisionedAfter:5`; `register_domains=0` fixture yields `available` + `paramsToSupply` and NEVER `registerDomains:true` |
| **I6** | Lifecycle + demo/BYO/cap gating **inside the primitive** | frozen tenant → `none_owed` + `account_frozen` with `via:"http"` `/checkout`; demo tenant → no billing sentence; BYO tenant → no managed-purchase step |
| **I7** | **G5 rebuilt** — monotone progress on real port selection | negative fixture: a step with `registerDomains` stripped must FAIL the guard (proves it can see the field); partial-success fixtures must PASS under monotone but FAIL under v1's equality |
| **I8** | Wire `nextSteps` into the **seven** responses | per-surface coverage; `isSetupProvisioningIncomplete` regression (terminal + `nextSteps` still classifies COMPLETE) |
| **I9** | Docs + guards G1–G4 | land G1 before editing any description — it must fail today |
| **I10** | **G6** flag↔prose lockstep | asserts `provisioningReconcileArmed({})` false + prose present; flipping the default reddens it |
| **I11** | `first_paid_at` + the three-way seat split | floor-gap tenant → `available`, never `owed`, never alerts; `billable==0` → `owed` with a real `sinceMs`; drift → `waitingOn:"operator"` |
| **I12** | **`lastAgentActivityAt` on `authVia`** — *prerequisite for I14/I15* | **the decisive negative: a COOKIE-authed `infrastructure_status` poll must NOT advance the column**, while a bearer call does; `opsSummary` must not either. FULL-NET run, not the targeted slice |
| **I13** | `AlertPolicy.channel` + `digest_only` DeliveryReason | a digest-policy check produces no email and reports `why:"digest_only"`; email-policy behaviour byte-identical |
| **I14** | The two `customer_progress_*` checks + blame flip | blame flip emits healthy for the ABANDONED name in the same pass; `watchtower-policy.test.ts:138-178` must fail until both names are classified |
| **I15** | The one-shot nudge (Q1) | one emit per episode across many ticks; a second episode re-arms; **the nudge's own row must not sustain the check or re-key the episode** (the R2 loop, asserted directly) |

## 7.14 Non-goals — explicit retractions

> **AMENDED v3 — round-2 N7.** Retraction 3's bound is per-tenant and does not bound one sweep.
> See §7.17.7.

Keeping a retracted non-goal in force invites a builder to satisfy the rulings by quietly violating
the doc (gate R1). Three are retracted; the rest of §5 stands.

1. **RETRACTED: "No persisted 'last emitted nextSteps' row."** Q1's exactly-one-per-episode needs an
   emitted-once flag. Replaced by the narrowest possible form: `continuity_nudge_episode_ts`, a single
   timestamp compared `>` — it records *which episode we spoke in*, never tenant state, so
   derive-don't-store still holds for everything the design reasons from.
2. **RETRACTED: "No `first_activated_at` stamp / one-column budget."** Three self-applying columns
   (§7.9). The honest anchor beats the small diff.
3. **RETRACTED (narrowly): "the S1 ceiling is not moved, in either direction."** True for every P1
   path and every P2 signal; false for the nudge's cross-DO write on episode transition (§7.12).
   Bounded at once per episode per tenant.

Unchanged: no breaking rename/retype of any shipped field; no new severity rung; no vendor calls in
any derivation or signal; no autonomous retry on the customer's behalf; no dashboard rendering; and
**no dependency on `PROVISIONING_RECONCILE_ENABLED`** — this wave neither arms it nor needs it.

## 7.15 New open question (one)

> **ANSWERED v3 — Q4 RULED: EMIT (founder-ratified; the gate concurred independently).** Conditions
> attached: keep the BYO suppression, and add N8's guard that `seat_headroom_free` can never be
> `owed`. See §7.17.8. No open questions remain.

**Q4 — should the `seat_headroom_free` step be emitted at all?** §7.10.1 demotes the floor-gap case
from `owed` to `available`, so it never alerts and never nudges. It still appears in every
`infrastructure_status` response for any paying tenant under 5 mailboxes, saying "the remaining N cost
$0." That is true, useful, and arguably the single highest-value sentence in the whole contract for a
customer at the floor — or it is a permanent upsell line in a status payload the agent polls
constantly. Suppressing it is one predicate; the design cannot decide the intent. **Recommendation:
emit it.** It is the only place the platform tells a customer they are leaving paid-for capacity on
the table, and it is `available`, so nothing chases them about it.

The three earlier questions are answered and closed (Q1/Q2/Q3 rulings, §6).

## 7.16 Invariants a builder must not silently drop

Collected because each was proven by an attack that PASSED, and a passing attack is exactly the
property most likely to be lost in the build.

1. **`deriveNextSteps` and every helper it calls stay synchronous.** No `await`. DO SQLite is
   synchronous and the input gate opens at every await; the derivation's non-interleaving with a live
   saga depends on it (the same property `contact-operator-guard.ts:1-25` documents).
2. **No `ctx.sql.exec` inside any candidate loop.** Snapshot once, evaluate in memory. Also keeps
   `test/loop-isolation-coverage.test.ts` green, which the gate confirmed genuinely fires.
3. **The dry run stays pure.** `planProvisioning` is SELECTs end to end and every guard runs *after*
   it (`provisioning.ts:444-456`) — a dry run cannot trip or mutate one. Do not move a guard inside.
4. **Real wall-clock for every bound**, never `ctx.clock` (1440× VirtualClock on demo tenants).
5. **The two-leg registrar decouple is inviolable** — §7.8 changes messages only, never the gate.

---

## 7.17 v3 amendments — round-2 gate fold (2026-08-18)

Round 2 verdict: SHIP-AFTER-FIXES, 4 blocking + 4 non-blocking, **all inside the round-1 fix code**
— eleven of fourteen round-1 blockers fully closed, three (B5, R2, R8) closed in substance with a
defect in their replacement. That is the expected residue shape, and it is where the round-2 fold
concentrates. Every cite below was re-verified against source; §7.17.4 records one delta the gate
did not have.

### 7.17.1 N1 — the drift arm inherits the sync's own eligibility conjunct

`syncMailboxQuantity` returns early on `billing_state !== "active"` **without advancing
`mailbox_qty_synced`** (`billing.ts:879-880`, *"Active-only (§7) — a teardown/freeze release never
reaches Stripe"*). A `past_due` tenant is not lifecycle-frozen (`FROZEN_BILLING_STATES` is
disputed/canceling/canceled only, `billing-state.ts:20-23`), so it stays in scope for §7.11 — and
§7.10.1 grades drift `waitingOn:"operator"`, which §7.11 routes to the **email** channel. A
`past_due` tenant whose domain burns has `billable` drop while `mailbox_qty_synced` holds, with no
path to clear for the whole dunning window: a daily founder email for documented, correct behaviour.

**Fix — the arm gains the identical conjunct the sync uses:**

```
billed_quantity_drift  ⇔  billing_state === 'active'
                          AND billable >= MINIMUM_BILLABLE_MAILBOXES
                          AND mailbox_qty_synced > billable
```

The principle generalises and is worth stating: **a check that reports "a push is overdue" must
carry the same eligibility predicate as the push.** Otherwise it reports on a push that was never
going to run. Read `billing_state` from `tenant_profile` at derivation time, never a cached copy.

Recorded from the gate's failed round-2 attack: the *transient* interleave (a concurrent
`opsSummary` observing `released_at` set before `mailbox_qty_synced` advances, across
`syncMailboxQuantity`'s Stripe await) does **not** alert — `confirmAfterObservations: 2` at a
5-minute cadence would need two consecutive samples inside a sub-second window. The debounce is
load-bearing here; do not exempt this check from it.

### 7.17.2 N2 — the exclusion moves into the primitive, where `owedCount` is actually sourced

§7.12 states the containment correctly and implements it in the wrong place: it excludes
`kind='continuity_nudge'` from `unackedBlockingMessages`, but §7.11's predicate is
`owedCount > 0`, and §7.10.3 sources `owedCount` from `deriveNextSteps` — not from that signal. So
the nudge's own `action_required` row still becomes a `message_action_required` owed step, the check
stays unhealthy, `AlertState.sinceTs` never advances, and `sinceTs > continuity_nudge_episode_ts` is
never true again: **every future stall for that tenant is silently un-nudged.** Worse than v1's
storm, because the un-nudged population is exactly the target one — an agent that is not acting is
also not calling `ack_message`.

**Fix — the exclusion lives in `deriveNextSteps`**, the shared primitive feeding both the response
and `owedCount`. The `message_action_required` reason is derived from `tenant_messages` rows
**excluding `kind = 'continuity_nudge'`**, at that one site. `unackedBlockingMessages` then needs no
special case at all: it inherits the primitive's view.

**This is the third instance on this project of one class — a caveat attached to one consumer of a
shared primitive rather than to the primitive.** (Round-1 non-blocking 3 was the same shape: the
demo-tenant skip written for the check while the primitive also feeds responses.) §7.6(d) already
states the right property — *no new reason appeared whose source is a row this wave writes* — so the
guard was correct and only the implementation site was wrong. Standing rule for the build:

> **Every suppression, skip, or exclusion in this wave goes in `deriveNextSteps`. If a consumer
> needs its own filter, that is the signal that the primitive is under-specified — fix it there.**

### 7.17.3 N3 — a blame flip is a re-classification, not a recovery

The cross-clear R8 requires is right, and the gate re-verified its timing holds
(`readReportedCheckNames` is read once before the tenant loop, `watchtower.ts:210`, so the abandoned
name IS in `reported` on the flip tick). But a clear on an episode with `alertCount > 0` yields
action `"recovered"` (`watchtower-policy.ts:188-196`), which renders and sends. So a blame flip
emails *"customer progress operator: resolved"* about a tenant that is still stalled.

The asymmetry makes it worse: a new name's first alert is **debounced**
(`confirmAfterObservations: 2`) while a recovery fires on the **first** healthy observation. An
oscillating blame therefore produces *more* "resolved" emails than alerts. And it genuinely
oscillates — blame is "any owed step with `waitingOn === 'operator'`", and `setup_operator_blocked`
tracks a vendor wallet that dips and refills with auto-topup live in prod.

**Fix — suppress the send, not the state transition.** When the sibling `customer_progress_*` name
goes unhealthy in the same pass, the abandoned name's state is cleared (so it cannot re-alert on the
24h step) and its **email is withheld**. The mechanism already exists and must be reused rather than
re-invented: `withheldAlertState` (`watchtower-policy.ts:256-264`) is precisely "this transition's
email was composed and NOT delivered", and `AlertOutcome.why` carries the reason so the operator
surface can still distinguish "we chose not to" from "we could not". A new `DeliveryReason` member
— `"reclassified"` — names it honestly.

Deliberately NOT chosen: giving `basis: "no_longer_applicable"` a blanket policy meaning of
"no email". Today the basis only changes prose, and overloading it would silence every
no-longer-applicable clear across the whole watchtower — a far wider blast radius than the two
checks this wave adds. The suppression is scoped to the flip pair.

### 7.17.4 N4 — backfill `first_paid_at`, and clamp it (one delta the gate did not have)

> **GENERALISED — the clamp below is now a WAVE-LEVEL RULE, stated once in §7.19 and binding on
> every anchor this wave ages from, not just this one.**

`addColumnIfMissing` is a plain `ALTER TABLE ADD COLUMN` with a **literal** definition
(`tenant-do.ts:572-579`) — it cannot compute. So `first_paid_at` lands NULL for every tenant already
paying and is stamped only at a future `checkout.session.completed`, which reopens B4 for exactly the
population the incident is about.

**Backfill, on the `grandfatherActiveScreening` precedent** (`tenant-do.ts:495-511` — a self-applying
one-shot UPDATE in the constructor, guarded by "already set → return"):

```sql
UPDATE tenant_profile
   SET first_paid_at = ?
 WHERE id = ? AND first_paid_at IS NULL
```

with the value from `SELECT MIN(ts) FROM webhook_events WHERE type = 'checkout.session.completed'`.
Verified: `webhook_events(event_id, type, ts)` lives in the tenant DO, is written `INSERT OR IGNORE`
for every processed Stripe event (`billing.ts:573-578`), and **has zero `DELETE` sites** in `src`.
So it is a real first-payment timestamp derived from the money event, not from read time.

**DELTA the round-2 gate did not have — the value must be CLAMPED, because `webhook_events.ts` is
stamped from `ctx.clock` and is NOT shifted by the clock migration.** `clock-migration.ts` shifts
`scheduled_sends`, `request_idempotency`, and the `domains` DNS/eligibility gates — I read its
UPDATE list; `webhook_events` is not among them. And the `checkout.session.completed` that *makes* a
tenant paid is processed while `plan` is still demo/free, i.e. under a **VirtualClock running up to
1440× ahead of real time** (the clock flips at the next construction, `selectClockOnRehydrate`). So
the derived value can sit in the real future, and `now − first_paid_at` would be negative.

Rule: `first_paid_at = MIN(derivedTs, realNow)`. A future-dated value is a virtual-domain timestamp
and clamps to backfill time, which **understates** the age — deliberately the safe direction, since
understating age delays an alert and can never fire one early. Same family as
`domains.purchased_at`'s documented clock-domain warning (`schema.ts:224-229`), and the reason the
backfill uses `new RealClock().now()` for the clamp exactly as `grandfatherActiveScreening` does for
its own stamp.

Simulated-checkout tenants have no such webhook row; they are already excluded by the
`mailbox_qty_synced === 0` gate (§7.4), so a NULL there is correct and inert.

### 7.17.5 N5 — the lowering-side writer, stated and bounded

R5's direction rule ("lowering always allowed, raising only by the customer's own call") is
well-formed, but **nothing lowers `inboxes_each` today**: `remove_mailboxes` operates on resolved
mailbox ids (`engine/remove-intents.ts`) and never touches the per-ordinal spec. The ordinal is
derivable (mailbox → `domain_id` → `domains.domain` → `domain_intents.candidate_domain`), so this is
buildable; it simply is not assigned.

Stated bound rather than silently carried: **harm is zero while `PROVISIONING_RECONCILE_ENABLED`
stays unset** (prod-confirmed unset; the ops ledger carries a standing "do NOT arm" note, now at 4
blockers). Nothing in this design depends on that flag. The lowering writer is therefore assigned to
the distribution lane (I4) as a **precondition of arming the reconcile**, not a precondition of this
wave — and `desired-spec-direction.test.ts` covers the direction rule either way.

### 7.17.6 N6 — `paramsToSupply` is computed per field, by emptiness

§7.2's premise is wrong about `brand`: it is captured at **signup** (`routes/signup.ts` →
`initTenant({brand})`) and `tenant_profile.brand` is `NOT NULL`. The genuinely-empty fields are
`primary_domain`, `physical_address`, `sender_identity` (all `DEFAULT ''`) and persona (no column at
all — only `domain_intents.persona_slug`).

**Fix:** `paramsToSupply` is built **field by field, testing the value for emptiness** — never from a
"this tenant never provisioned" population test. Asking an agent to re-supply a brand the platform
already holds is the mirror image of the defect this wave exists to fix: the platform knowing
something and not saying it, inverted into the platform knowing something and pretending not to.
Guard: a fixture with a signup-only tenant must yield `paramsToSupply` **excluding** `brand` and
including the four genuinely-absent fields.

### 7.17.7 N7 — the S1 retraction's bound restated at sweep level

§7.14's retraction 3 says "bounded at once per episode per tenant". True, and it does not bound a
single tick. A **correlated onset** — a deploy widening the check's scope, or a fleet-wide vendor
condition putting many tenants' 24h transitions in the same sweep — is the case that matters.

Restated bound: **worst case +1 subrequest per tenant on the measured `8.0N + 29`, i.e. `9.0N + 29`
in the pathological all-transition-same-tick sweep**, and `8.0N + 29` in every ordinary one. At the
S1 ceiling that moves the tenant bound from ~122 to ~109 in the worst tick only. Acceptable and
bounded, but stated at the level S1's arithmetic actually operates on. If the scale wave (train 6)
restructures the fan-out, this transition is one more leg it must account for.

### 7.17.8 N8 + Q4 — `seat_headroom_free` is EMITTED, and pinned to `available`

> **AMENDED v3-addendum — gate E1/E2/E3 on the settled EMIT branch.** The emission needs an
> `owedCount === 0` predicate, the BYO rule must suppress the ACTION rather than the FACT, and N8's
> guard is upgraded to a founder-ruling enforcement over the whole chain. See §7.18.

**Q4 is ruled: EMIT** (founder-ratified; the round-2 gate reached the same conclusion
independently). It is the only place the platform tells a customer they are leaving paid-for
capacity on the table, it is `available` so nothing chases them, and `effect.projectedMonthlyCents`
proves the $0 claim *inside the payload* (3960 → 3960) rather than asserting it in prose.

Both conditions attached to the ruling are carried:

1. **BYO suppression stays** (§7.10.3) — recommending a managed lookalike purchase to a BYO customer
   is the wrong product.
2. **N8's guard:** `seat_headroom_free` can never be `owed`. Its `kind` is load-bearing for two
   independent suppressions (no alert via `owedCount`, no nudge), so a one-line assertion over the
   whole fixture matrix pins it — the cheapest possible guard on the highest-leverage field.

### 7.17.9 Increment changes

Five increments gain or change their RED-first test; no new increment is added and the order is
unchanged.

| # | Change |
|---|---|
| **I4** | N5: the lowering-side writer for `inboxes_each` is assigned here, explicitly as a **precondition of arming the reconcile**, not of this wave. `desired-spec-direction.test.ts` unchanged. |
| **I5** | N6: RED gains a **signup-only tenant** fixture — `paramsToSupply` must EXCLUDE `brand` (NOT NULL, set at signup) and include `primaryDomain`/`physicalAddress`/`senderIdentity`/`persona`. Fails on any population-test implementation. |
| **I6** | N2: the `continuity_nudge` exclusion is built HERE, in the primitive, alongside the lifecycle/demo/BYO gates — not in I15. RED: a tenant whose ONLY unacked message is a `continuity_nudge` must derive `owedCount === 0`. This is the increment that makes I15 possible at all. |
| **I11** | N1: RED gains a `past_due` tenant with `mailbox_qty_synced > billable` → **no** `billed_quantity_drift` step and **no** email. N4: RED gains a tenant with a pre-existing `checkout.session.completed` webhook row and `first_paid_at IS NULL` → the constructor backfills it, **clamped to `MIN(derivedTs, realNow)`**, with a virtual-clock future-dated fixture proving the clamp. N8: the never-`owed` assertion over the fixture matrix. |
| **I13** | N3: `DeliveryReason` gains `"reclassified"` alongside `"digest_only"`. RED: a blame flip emits NO recovery email while still clearing the abandoned name's state (so it cannot re-alert on the 24h step), asserted via `withheldAlertState`'s existing mechanism rather than a new one. |
| **I15** | N2 moves the exclusion out of this increment; what remains is the one-shot itself. RED still asserts the R2 loop end-to-end — the nudge's own row must not sustain the check — but it now passes **because of I6**, which is the honest dependency. |

### 7.17.10 Status (superseded by §7.18.6)

All 18 blocking findings across both rounds are folded (14 round-1 + 4 round-2), all 13
non-blocking notes are folded or deferred with a stated reason, and **no open questions remain** —
Q1/Q2/Q3 ruled at round 1, Q4 ruled EMIT at round 2. The core mechanism is unchanged from v1 and has
now survived two full adversarial rounds: one derivation, three consumers, derive-don't-store; the
dry run through the real planner; DO-local signals riding existing fan-outs; address determinism
under a per-domain distribution.

---

## 7.18 v3 addendum — the Q4 EMIT-branch gate (E1 · E2 · E3)

The founder ruled EMIT, so the gate re-attacked the emit path as the live contract: 1 blocking, 1
non-blocking, 1 severity upgrade. **The ratified sentence itself survived its hardest attack** — the
"$0" claim is true on the *whole* bill, not just the mailbox line, because filling to 5 may require
buying a DOMAIN and domains are platform COGS, never customer-billed (`intents.ts:70`, already live
in the shipped tool description at `mcp/tools.ts:74`), and warmup sits inside the mailbox reserve.
With `billableMailboxes` flooring at 5, any fill to ≤ 5 is genuinely $0 on the invoice, and
`effect.projectedMonthlyCents` proves it in-payload rather than asserting it in prose.

### 7.18.1 E1 — emit only when nothing is owed

`seat_headroom_free` covers the whole band `0 < billable < 5`, and that band includes a tenant whose
remaining ordinals **hard-failed**. `forEachIsolated` completes the call after logging
`DOMAIN_ORDINAL_FAILED` per failed ordinal (`provisioning.ts:701-708`) — I re-read the site: it
writes a `deliverability_actions` row and nothing else. No `tenant_messages` row, no watchtower
check, and no member of the ten-reason list describes it. If the failure landed before the buy there
is no `domains` row either, so `domain_dns_incomplete` does not fire in its place.

So a tenant who asked for 2 domains × 3, got ordinal 0 and lost ordinal 1 to a permanent vendor
refusal, sits at `billable = 3` with **no reason describing the failure** — and would be told *"you
are already paying for 5 mailboxes; provisioning the remaining 2 adds $0 to your bill."* The
platform's most confident-sounding sentence delivered on its least healthy state, to an unattended
agent.

**Fix — one predicate:**

```
seat_headroom_free  ⇔  owedCount === 0
                       AND 0 < billableMailboxCount < MINIMUM_BILLABLE_MAILBOXES
```

This is deliberately **not** a fix that depends on having enumerated every gap in the reason list.
If anything at all is owed, the free-headroom line is noise at best and misdirection at worst; when
nothing is owed it is exactly the sentence the founder ratified. It stays correct as the reason list
grows, which is the property that matters more than the specific gap that exposed it.

### 7.18.2 The gap E1 found en passant — an eleventh reason

The `owedCount === 0` predicate closes E1 on its own. Separately and independently justified: the
reason list genuinely should describe a requested-but-incomplete ordinal, and the durable evidence
already exists.

New reason **`ordinal_incomplete`**, `kind: "owed"`, derived from state rather than from the log:

> a `domain_intents` row in status `'intent'` (written, buy not confirmed) or `'dangling'` (the buy
> leg threw — we MAY own it) with **no live `domains` row**, aged past the orphan grace bound.

This composes with the vendor-truth wave's checks rather than duplicating them: `domain_orphan:`
covers `status='committed'` with no `domains` row; this covers the two *earlier* statuses, which
nothing reads today. Its action is a same-key `setup_infrastructure` retry — safe and convergent
precisely because ordinals are independently completable (`provisioning.ts:667-676`).

⚠️ **Its anchor, `domain_intents.updated_at`, is CLOCK-UNSAFE and MUST be clamped per §7.19.** This
subsection's first draft called it "real wall-clock for the paid tenants in scope"; that is **wrong
and is retracted**. `updated_at` is stamped from `ctx.clock` (`provision-intents.ts:355`, `:382`)
and is NOT in `clock-migration.ts`'s shift list. A tenant that provisioned while on the demo/free
VirtualClock and later upgraded therefore carries a **future-dated** `updated_at`, so
`now − updated_at` is negative, the grace bound is never crossed, and **`ordinal_incomplete` silently
never fires** — the exact silent-disable this reason exists to prevent, on precisely the population
most likely to be carrying a half-finished setup. Read it as `MIN(updated_at, realNow)`.

**The `DOMAIN_ORDINAL_FAILED` activity row supplies the customer-safe `why` detail and its date; it
never supplies the predicate.** A log row is not state — a retry that succeeds does not delete it,
so predicating on the row would pin a healed tenant as broken forever. Corroboration that this gap
is real and known: the round-1 integration gate's highest-value follow-up already recorded that
`DOMAIN_ORDINAL_FAILED` / `MAILBOX_SLOT_FAILED` / `MAILBOX_RELEASE_FAILED` "reach no watchtower
check" (routed to train 5).

**Dependency note for the orchestrator:** E1 is closed by §7.18.1 alone. If this eleventh reason is
deferred to train 5 with the rest of that family, E1 stays closed — that is the whole point of
choosing the robust predicate.

### 7.18.3 E2 — suppress the ACTION, never the FACT

§7.10.3 suppresses **both** seat reasons for a tenant holding `domains.source='byo'` rows. That was
right for the ACTION and wrong for the MESSAGE: BYO tenants are the likeliest population to sit
under 5 seats — someone connecting two of their own mailboxes while paying the 5-seat floor has the
most free headroom and, under v3 as written, is told least about it.

The `NextStepAction` union makes the right shape expressible. `seat_headroom_free` is emitted for
BYO tenants with a BYO-appropriate action:

| Tenant composition | Action on `seat_headroom_free` |
|---|---|
| managed domains only | `setup_infrastructure` with the fill distribution (as today) |
| BYO only, ≥1 domain ACTIVE | `configure_byo_domain` with `{action:"request_managed_mailboxes", id, count}` — platform-provisioned mailboxes on an already-active BYO domain, and it carries the same `billing` projection (`mcp/tools.ts:289`) |
| BYO only, no ACTIVE domain | `via:"none"` with a note — the headroom is real, the fill waits on the domain |
| **mixed** | the managed action — they already run the managed path, so it is proven for them |

**The mixed case is the half E2 flags as a live defect:** a single `source='byo'` row suppressing the
managed side entirely for a tenant running both. The composition test is therefore over what the
tenant *holds*, never "does any BYO row exist". `NextStepAction.tool` gains
`configure_byo_domain` as a fifth member; G3 already asserts every emitted tool name is a real MCP
tool, so the addition is covered by an existing guard.

The `paid_seats_unprovisioned` **action** suppression for BYO-only tenants stands unchanged —
recommending a managed lookalike purchase to a BYO customer is still the wrong product.

### 7.18.4 §7.5 example, refreshed to current production

Mordy's fleet completed 2026-08-18: 4 mailboxes active across two domains (`mordytee11`/`12` on
theauthorpitchdesk = ordinal 0 slots 0-1, `mordytee21`/`22` on goauthorpitchdesk = ordinal 1 slots
0-1), both domains DNS-ready, zero unhealthy checks. He pays the 5-seat floor. So `owedCount === 0`
and `billable = 4` — the E1 predicate is satisfied and his real step today is the ratified sentence,
for exactly one free mailbox:

```json
"nextSteps": {
  "status": "none_owed",
  "computedAt": 1786600000000,
  "steps": [{
    "reason": "seat_headroom_free",
    "kind": "available",
    "why": "You are billed for a 5-mailbox minimum and 4 are provisioned, so one more mailbox costs nothing — your bill is unchanged at $39.60/mo. Domain slot 0 (theauthorpitchdesk.com) holds 2 of 3 mailbox slots, so `distribution: [3,2]` fills the fifth there. Nothing is blocked and nothing is required; this is only worth doing if you want the extra sending capacity.",
    "action": {
      "via": "mcp_tool",
      "tool": "setup_infrastructure",
      "params": {
        "brand": "Press Outreach", "primaryDomain": "authorpitchdesk.com",
        "domains": 2, "distribution": [3, 2], "persona": "mordytee",
        "physicalAddress": "…", "senderIdentity": "…",
        "registerDomains": true
      },
      "paramsToSupply": [],
      "idempotencyKey": null
    },
    "waitingOn": null,
    "notBeforeMs": 0,
    "effect": { "provisionedAfter": 5, "projectedMonthlyCents": 3960,
                "formula": "$49 platform + $10/mailbox, 5 minimum" },
    "sinceMs": null
  }]
}
```

Note `status: "none_owed"` alongside a non-empty `steps` array — precisely why the discriminator is
explicit rather than inferred from emptiness. And `effect.projectedMonthlyCents` equals the
`billing` field's current value (3960 → 3960), which is the $0 claim proving itself in-payload.

**I5's fixture must NOT be this state.** Production reached it while this design was being written,
and pinning a test to a live tenant's current shape is how the vendor-truth wave lost a round to a
stale example. The fixture is a **synthetic tenant production has never passed through** — e.g.
3 domains at `[2,2,1]` with a 6-seat paid quantity — hermetic, chosen so no real provisioning
sequence produces it, and therefore immune to prod moving again. The doc example above is
illustrative and dated in place; the test is hermetic. Those are different jobs and must not share a
fixture.

### 7.18.5 E3 — the guard enforces a founder ruling, over the whole chain

The ratification is "emit, **and nothing chases them**", which holds only while `kind` stays
`available`. A later change flipping it to `owed` would put it into `owedCount`, which sustains the
check (§7.11), which alerts and eventually nudges — B5's permanent cry-wolf re-created on a signal
ratified as *silent*, for every paying customer under 5 mailboxes.

So N8 is upgraded from a nice-to-have field assertion to a **required guard asserting the whole
chain**, over the full fixture matrix:

1. `seat_headroom_free` is never `kind: "owed"`;
2. it never appears in `owedReasons` / never contributes to `owedCount`;
3. it never causes a `customer_progress_*` check to be named;
4. it never fires a nudge.

Written as four assertions rather than one because each link is separately breakable, and because
the guard is enforcing a founder ruling — the comment should say so, so a future editor knows the
cost of relaxing it. The gate's own passed attack is the reason this is enough: "nothing chases
them" is a **structural** property today (`available` steps do not enter `owedCount`, the nudge
fires off the check, and the payload carries `owedReasons` only), conditional on exactly this guard
holding it there.

### 7.18.6 Increment changes, and final status

| # | Change |
|---|---|
| **I5** | E2: `NextStepAction.tool` gains `configure_byo_domain`; the BYO/mixed composition table drives the action. RED: a BYO-only tenant at the floor must RECEIVE `seat_headroom_free` (with the BYO action), and a MIXED tenant must receive the managed action — the current design would emit neither. |
| **I11** | E1: RED gains a tenant in the `0 < billable < 5` band **with an owed reason present** → `seat_headroom_free` must NOT be emitted. E3: the four-assertion chain guard replaces N8's single field assertion. **The fixture is synthetic (`[2,2,1]` / 6 paid seats), never a snapshot of a live tenant.** |
| **I6 or train 5** | §7.18.2's `ordinal_incomplete` reason, if taken. RED: a `domain_intents` row at `'intent'`/`'dangling'` with no live `domains` row past the grace bound yields an owed step; a healed ordinal yields none even though the `DOMAIN_ORDINAL_FAILED` log row still exists. Independent of E1's closure. |

**STATUS — superseded by §7.19.3.**

---

## 7.19 WAVE-LEVEL RULE — every anchor is clamped to real wall-clock (X1)

**THE RULE, stated once and binding on every increment in this wave:**

> **Any timestamp this wave ages from must be read as `MIN(anchorTs, realNow)`, where `realNow` is
> `new RealClock().now()`.** No exceptions, no per-anchor argument about whether a particular column
> "is real for the tenants in scope."

**Why it is a rule and not a per-site judgement.** `clock-migration.ts` shifts a *closed, short*
list — I read every `UPDATE` in the file, and the additive `+ delta` shifts are exactly six:
`scheduled_sends.send_at`, `scheduled_sends.sending_since`, `request_idempotency.created_at`,
`domains.first_send_eligible_at`, `domains.dns_first_checked_at`, `domains.dns_gave_up_at`. (The
file's other UPDATEs are provider backfill, `released_at` marking and demo terminalization — not
time shifts.) **Every other `ctx.clock`-stamped timestamp in the schema is virtual-domain forever**
for any tenant that lived on the demo/free VirtualClock — which runs up to 1440× ahead of real
time — before upgrading.

**And the migration route is closed, permanently.** `migrateTenantClockToReal` is one-shot per
tenant, guarded by `clock_mode != 'real'` and stamping `clock_mode='real'` on completion
(`clock-migration.ts:286`). It has **already run** for every paid tenant. So a column added by this
wave, or a column this wave newly starts reading, can never be shifted by it — adding a line to the
migration would do nothing for exactly the population that needs it. **The clamp is the only fix;
nobody should re-propose the migration route.**

**Failure signature to recognise:** a future-dated anchor makes `now − anchor` negative, so an age
bound is *never* crossed and the check **silently never fires**. It does not error, it does not
alert, and it looks identical to a healthy tenant. That is strictly worse than a false positive, and
it lands on the demo-era-then-upgraded population — disproportionately the tenants carrying
half-finished setups.

**Direction of the clamp is deliberate.** Clamping to `realNow` *understates* age, which delays an
alert and can never fire one early. Correct direction for a founder-facing alert channel.

**Anchors in scope today, each already carrying the rule at its own site:**

| Anchor | Used by | Shifted by the migration? |
|---|---|---|
| `webhook_events.ts` → `first_paid_at` | `paid_seats_unprovisioned` (§7.17.4) | **No** — clamp |
| `domain_intents.updated_at` | `ordinal_incomplete` (§7.18.2) | **No** — clamp |
| `tenant_messages.created_at` | `message_action_required` | **No** — clamp |
| `domains.dns_first_checked_at` | `domain_dns_incomplete` | Yes — clamp anyway, per the rule |
| `last_agent_activity_at` | the liveness disjunct (§7.10.2) | N/A — written from `RealClock` by design |

The fourth row is the point of making this a rule rather than a checklist: `dns_first_checked_at`
*is* shifted and does not strictly need the clamp, and it still gets it, so that no future reader has
to re-derive which columns are safe. **A new increment reaching for a new anchor applies the clamp
without asking.**

Guard: a single helper (`clampedAge(anchorTs, realNow)`) is the only way any age is computed in this
wave, plus a tripwire asserting no `NextStep.sinceMs` or check-age computation subtracts a raw column
value. One helper, so the rule cannot be half-applied.

### 7.19.1 X2 — I11 needs a SECOND hermetic fixture

The `[2,2,1]` / 6-paid-seat fixture named in §7.18.6 is `billable = 5`, `mailbox_qty_synced = 6` —
that is a **`billed_quantity_drift`** fixture (N1's arm), and it structurally cannot produce E1's
case, which requires `0 < billable < 5` *with something owed*. Two fixtures, two jobs:

- **Fixture A (drift, N1/N4):** `[2,2,1]` live, `mailbox_qty_synced = 6`, `billing_state` varied
  across `active` / `past_due` — proves the drift arm fires only when active.
- **Fixture B (E1):** ordinal 0 with **2 live mailboxes**, ordinal 1 carrying a `domain_intents` row
  at status `'intent'` with **no live `domains` row**, 5-seat paid quantity. That is
  `billable = 2` (in the band) with an owed reason present, so `seat_headroom_free` must NOT be
  emitted. It also doubles as the `ordinal_incomplete` fixture if §7.18.2 is taken, and — with its
  `updated_at` set future-dated — as the §7.19 clamp fixture.

Both are synthetic states no real provisioning sequence produces, per §7.18.4's rule: hermetic, so
production moving cannot rot them.

### 7.19.2 Gate self-corrections, recorded

Two, worth keeping in the record because they affect who to trust on a re-read:

1. **The gate's `provisioning.ts:660-670` cite for `DOMAIN_ORDINAL_FAILED` was stale**; the emit is
   at `:701-708` (verified by reading both ranges — `:655-676` is the ordinal-resolution loop and
   its HOL-blocking commentary). The gate's *finding* was correct and its line number was not.
2. **E3's four-assertion form was reinstated** after the gate initially considered it over-specified,
   on the argument that each link is separately breakable by an ordinary derivation edit — the guard
   is enforcing a founder ruling, not a design preference, so it asserts the chain rather than the
   field.

### 7.19.3 FINAL STATUS — design complete

**20 blocking findings folded across four gate passes** (14 round-1 + 4 round-2 + E1 + X1), 16
non-blocking folded or deferred with a stated reason, **4 founder questions ruled and closed**, zero
open questions.

The core mechanism is unchanged from v1 through all four passes and every attack made on it failed:
**one derivation, three consumers, derive-don't-store**; the recommendation as a **dry run through
the real planner**; DO-local signals riding **existing fan-outs** (S1 unmoved except the one named,
bounded nudge transition); and **address determinism** under a per-domain distribution.

Design complete — ready for build.
