# Customer-continuity design — 2026-08-18

Design for the founder's CUSTOMER-CONTINUITY [ORDER] (`ROADMAP.md` `## Open`, 2026-08-18):
*"change documentation as well as our own response system so 1. this never happens again
2. we keep making sure he and other customers can always be continuing along."*

Read-only study; no code changed. Built on the **post-vendor-truth** contract
(`feat/vendor-truth-2026-08-18`, diffed against `8c87c79`), which is about to merge:
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

Additive only. No response field is renamed, retyped, or removed. `readAt` stays `readAt` on
both agent-facing surfaces (the wave renamed it to `ackedAt` on the **operator** type only —
`tenant-messages.ts`'s `OperatorTenantMessage`). No new severity rung. No new error code. No
migration except the one column in §3.3.

---

## 3. P2 — stuck-customer detection

### 3.1 The check

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
