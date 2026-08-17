# Class sweep — signal inversion / unverified clear-claims (2026-08-17)

**Ground ref:** `main` @ `9d3ec7e9021eb234c6f633540f0cca2aaa99cf2b`.
**Tree state at sweep time:** dirty — `M .claude/agent-memory/spec-builder/MEMORY.md`, `M docs/research/backlink-outreach-targets-2026-08-17.md`, `?? .claude/agent-memory/spec-builder/coldstart-rpc-record-unknown-second-occurrence-never.md`, `?? apps/platform/.claude/agent-memory/class-sweeper/`. No `src/` file dirty. A builder is fixing F3+F10 on `feat/channel-truth-2026-08-17`; this inventory is against `main` and does not reflect that branch.
**Seed members:** F3 (`engine/provisioning.ts:678`) and F10 (`admin/watchtower.ts:280-286`), from `docs/adversarial/agent-channel-product-audit-2026-08-17.md`.
**Scope:** READ-ONLY inventory. The main loop owns the scope decision.

---

## 1. Class definition (CORRECTED)

The brief's two arms are the same mechanism seen from two sides, and stating it as one changes what the sweep catches. I keep the A/B split because the FIX shapes differ, but the definition is unified:

> **PROXY-DECIDED SIGNAL.** A durable signal's *existence* (arm A) or the *claim in its body* (arm B) is decided by a proxy for the real state — an error attribute, a name allowlist, a transition flag, absence from a filtered query, a windowed count, or a side-effect that was *requested* but never confirmed — rather than by the state it asserts. The proxy's failure direction is always the same: the outcome that most needs a human produces the least signal, or a confident all-clear.

**Why the brief's narrower wording under-counts.** Stated only as *"emission gated on an attribute (retryable, severity, known-kind)"*, arm A misses two live shapes:

1. **The gate is a try/catch position, not an attribute** — `engine/mailbox-credential-push.ts` emits `credential_ready` inside the `try` and emits nothing in the `catch`. No attribute is consulted; the inversion is structural.
2. **The gate is the VOCABULARY, not the branch** — `site/openapi.yaml:2157` publishes `severity: enum [info, action_required]` and `engine/tenant-messages.ts:20` types it bare `string` with no DB constraint (audit F11). Even a correctly-emitted terminal message is byte-indistinguishable from "retry and it'll work". **Moving the F3 emit above the `retryable` gate without adding a terminal rung leaves the agent unable to branch — the class re-opens one layer up.**

And arm B stated as *"recovery/clear/success messages"* misses the largest sub-family found here, which contains no recovery message at all: **forward claims of a side-effect — "The operator has been notified" — composed by the code path that *requested* the notification, never by the one that *performed* it.** Seven sites; one of them (`NotActivatedError`) has no notifier anywhere in the tree.

---

## 2. Search coverage

### Lexical (every pattern run)

| Pattern | Surface |
|---|---|
| `emitTenantMessage\|emitOperatorMessage` | all tenant-channel emit sites (4 real + 2 RPC) |
| `\.retryable\|retryable:` | `apps/platform/src` + `packages/shared/src`, non-test |
| `function alert` / `alert[A-Z][a-zA-Z]*(` | 10 alert fn defs + 18 call sites |
| `reportCheck(` | the event-driven watchtower entry point |
| `healthy: true` | all 9 healthy-CheckResult producers |
| `now has\|again\.\|recovered\|is back\|resolved\|no longer\|cleared\|healthy again\|is working\|success` | recovery/clear phrasing, whole tree |
| `operator has been notified\|been notified\|has been alerted\|we have been notified` | `src/` + `site/` + `AGENTS.md` + `README.md` |
| `gave up\|give up\|abandon\|terminal\|permanent\|will not retry\|no further` | every terminal-outcome code site |
| `mailbox_cred_pushes` | every reader/writer incl. the `'revoked'` write |
| `capacity_pending`, `payment_succeeded\|reactivat` | marker set/clear + dunning recovery |
| `NotActivatedError`, `RegistrarUnarmedError` | all throw sites vs all alert wirings |
| `warmup_cancel_gave_up\|cron_legs\|LEG_ALERT_AFTER_SWEEPS` | sweep-signal producers |
| `retry_setup\|credential_ready\|operator_message\|action_required` | published message contract |
| `adapters\.domain\.` | vendor-port call sites vs alert coverage |

### Semantic (files read, not just grepped)

`engine/provisioning.ts` (600-699) · `admin/watchtower.ts` (all 542) · `admin/watchtower-alerts.ts` (all) · `admin/watchtower-policy.ts` (all) · `admin/sweep-signals.ts` (all) · `engine/ops-summary.ts` (60-120, 280-410) · `engine/mailbox-acquisition.ts` (140-278) · `engine/mailbox-provisioning.ts` (170-330) · `engine/mailbox-credential-push.ts` (140-207) · `engine/tick.ts` (380-460) · `engine/warmup-cancel.ts` (85-165) · `engine/deliverability-actions.ts` (140-280, 340-390 via grep) · `engine/lifecycle.ts` (300-340) · `engine/spend-ceiling.ts` (130-210, 295-330) · `engine/byo-intake.ts` (228-282) · `engine/webhook-delivery.ts` (150-215) · `engine/retry-setup-message.ts` (all) · `engine/activation.ts` (140-178) · `engine/registrar-alert.ts` (all) · `ofac/screening-alert.ts` (all) · `ofac/sdn-alert.ts` (all) · `ofac/sdn-refresh.ts` + `sdn-ingest.ts` (alert wiring) · `admin/ops-sweep.ts` (40-175, digest 500-640 via grep) · `error-response.ts` (70-150) · `engine/contact-operator-guard.ts` (via grep) · `scheduled.ts` (leg bag).

**Surfaces the ledger says under-count here, covered explicitly:** vendor-port error contract (`packages/shared/src/errors.ts`) · sandbox-vs-real adapter asymmetry (`vendors/real/*` throw sites) · cross-store D1↔DO sequences (`lifecycle.ts` teardown) · cron lanes (`scheduled.ts`, `admin/ops-sweep.ts`) · **migration SQL** (`migrations/0018_watchtower_debounce.sql` — read; its backfill is correct and is not a member) · **runtime DDL** (`tenant-do.ts` `addColumnIfMissing`) · **docs/claim surfaces** (`site/openapi.yaml`, `mcp/tools.ts`, `AGENTS.md`, `site/guide-*.html`) · **tests encoding the defect** (grepped `test/` for all four false-claim strings — **zero hits**; no test pins today's wording, so no test has to be deleted alongside the fix).

**Excluded:** `.claude/worktrees/agent-*/` (sibling-agent copies; they inflate repo-wide greps).

---

## 3. Inventory

### IN — arm A (emission)

| Site | Reason it exhibits the mechanism | Who is misled, concretely |
|---|---|---|
| `apps/platform/src/engine/provisioning.ts:678` | **F3 (confirmed).** Emit gated on `err instanceof VendorError && err.retryable`. The retryable branch AND the informational SUCCESS-PENDING branch (`:650`, `severity:"info"`) both emit; the terminal branch — `DomainDnsTerminalError`, `terminalMailboxError`, `abandonedPurchaseError`, `RegistrarUnarmedError` — emits nothing. | Agent calls `setup_infrastructure`, gets a 502/503 body, session ends. `list_messages` is empty. Nothing durable ever says the domain is dead; audit probe ARM C: `TENANT MESSAGES: []`. |
| `apps/platform/src/error-response.ts:126` | Body claims *"The operator has been notified."* for `NotActivatedError`. **No notifier exists for this error class anywhere** — all 12 throw sites (`vendors/real/{email,billing,reputation,dns-scan,metrics}-port.ts`, `inboxkit-client.ts:55`, `engine-mailbox-client.ts:85`) are unwrapped by any alert fn, and no watchtower check covers "a vendor seam is dark". | Customer's agent hits a dark seam, is told a human is on it, and stops escalating. Nobody was told. This is the error whose ONLY fix is operator arming. |
| `apps/platform/src/error-response.ts:88` | Same claim for `RegistrarUnarmedError`. `alertRegistrarUnarmed` is wired at exactly 3 catches (`provisioning.ts:486`, `:628`, `deliverability-actions.ts:242`) and itself early-returns when `OPS_ALERT_EMAIL` is unset (`registrar-alert.ts:23`) and swallows send failure (`:34-36`). Uncovered producer: `lifecycle.ts:308` `domain.release()` inside teardown → propagates out of `POST /cancel` → 503 with the claim, zero email. | A tenant cancelling gets "the operator has been notified" while their teardown aborted mid-loop and nobody knows. |
| `apps/platform/src/engine/mailbox-acquisition.ts:260` and `:273` | Same claim, composed at throw time. The notifier is `reportCheck` → `reconcileAlerts` → `decideAlert`, which returns `suppressed` for the same `mailbox_rebuy:<email>` inside `WATCHTOWER_COOLDOWN_MS` (6h), and `trySend` returns `false` on a dark channel — both swallowed, neither visible to the thrower. | Second terminal verdict for the same address within 6h: customer told the operator knows; the state machine sent nothing. |
| `apps/platform/src/engine/spend-ceiling.ts:199-200` (+ published at `site/openapi.yaml:1508`) | Same claim on `CapacityPendingError`. `alertCapacityPending` returns early with no `OPS_ALERT_EMAIL` (`:162`), swallows send failure (`:177`), and is gated on `transitioned` (`:188-189`), so only the FIRST rejection of an episode alerts. | Every 409 after the first — including one raised by a *different* gate reason while the marker is already set — asserts a notification that did not happen. |
| `apps/platform/src/engine/deliverability-actions.ts:173` (`REPLACE_DOMAIN_CAPPED`) and `:257-259` (`REPLACE_DOMAIN_TERMINAL` / `_FAILED`) | Terminal branches write only a `deliverability_actions` row, while the sibling `applyHardPauseDomain` (`:310`) sends a **dual customer + founder email**. The outcome meaning "automatic recovery has permanently stopped for this tenant" is the quietest one in the module. | Tenant's fleet shrinks by N mailboxes per burn with no replacement and no notice on either channel; only `account().recentActions` shows it. |
| `apps/platform/src/engine/mailbox-credential-push.ts:187` vs `:196-205` | Structural inversion (no attribute): success emits `credential_ready`; the catch writes `last_error` to the row and returns `{pushed:false}` — never a tenant message. There is no `credential_failed` kind. | An agent that provisioned a mailbox sees "sending is now enabled" or *nothing*, and cannot distinguish still-working from failed. Founder gets `cred_push_aging:` at 30 min; the customer channel never does. |
| `site/openapi.yaml:2157` + `apps/platform/src/engine/tenant-messages.ts:20` | **Vocabulary member.** `severity` is published as `enum [info, action_required]`, typed `string` in TS, unconstrained in `schema.ts`. There is no rung meaning "retrying will never help". | Even after F3 emits, an agent branching on `severity` reads a terminal setup failure identically to a retryable one. **The F3 fix is incomplete without this.** |

### IN — arm B (claim content)

| Site | Reason it exhibits the mechanism | Who is misled, concretely |
|---|---|---|
| `apps/platform/src/admin/watchtower.ts:285` | **F10 (confirmed).** `Domain X now has working mail DNS.` emitted whenever the domain leaves `agingPendingDomains`. That query also requires `status='active'` and `source='provisioned'` (`ops-summary.ts:373`); the ownership guard reads `provisionedDomainNames`, which is **not** status-filtered (`:396-399`). | A domain flipped to `'burning'`/`'released'` clears its own alert and sends the founder a RECOVERED email asserting working DNS on a domain that will never carry a mailbox. |
| `apps/platform/src/admin/watchtower.ts:307` | **Exact sibling, 22 lines below — same shape, missed by the audit.** `Mailbox X now has its engine credentials pushed.` fires when the mailbox leaves `agingPendingPushes` (`status='pending'`, `ops-summary.ts:340-341`). `lifecycle.ts:209` sets those rows to `'revoked'` on suspend/teardown, which removes them from the query. The ownership guard `summary.mailboxProvenance` (`ops-summary.ts:304-307`) selects **all** mailboxes with no `released_at` filter, so it passes for a released one. | Suspend or tear down a tenant with an aging push and the founder gets RECOVERED + "now has its engine credentials pushed" for a mailbox that never received credentials. |
| `apps/platform/src/admin/watchtower.ts:322` | `Tenant X has eligible mailboxes again.` emitted whenever `starved` goes false. `starved = activated && dueNonDemoPendingSends > 0 && eligibleMailboxes === 0` — so it also clears when the due sends drop to 0 (the tick marked them `'failed'`, campaign paused, leads exhausted) or the tenant de-activates, in both of which `eligibleMailboxes` is still **zero**. The module's own comment (`:236-240`) defends the CLEAR decision but not the CLAIM. | Founder is told send capacity is restored for a tenant that still has zero eligible mailboxes and simply ran out of due work. |
| `apps/platform/src/admin/sweep-signals.ts:126` | `warmup_cancel_gave_up` reports `healthy: gaveUp === 0` where `gaveUp` is a **24h-windowed count** (`ops-sweep.ts:537-538`, `:580`). Nothing re-checks whether the abandoned subscriptions were cancelled; `warmup-cancel.ts:127` guarantees the platform will never retry them. | 24h after the last give-up: RECOVERED + *"No warmup-pool cancellation has been abandoned in the digest window"* — while the unhealthy body the founder got a day earlier said *"those subscriptions may STILL BE BILLING"*. Real recurring vendor charges, self-cleared on a timer. |
| `apps/platform/src/mcp/tools.ts:171` + `engine/reporting.ts:205` + `engine/activation.ts:170-173` | `activationState: "active"` is documented as *"the HONEST send state — trust it over 'sent' counts: 'active' = real sending live"*, but `deriveActivationState` consults plan + `billing_state` + env arming + the capacity marker only. It never consults `countSendEligibleMailboxes` (`engine/mailbox-eligibility.ts`) — the predicate the platform already computes and pages the **founder** on via `send_starved:`. | The exact condition that pages the founder ("ZERO eligible mailboxes — nothing will go out") reads to the customer's agent as "real sending live". Same state, opposite claims, two audiences. |

### UNCERTAIN — never silently dropped

| Site | What is unresolved | What would settle it |
|---|---|---|
| `engine/spend-ceiling.ts:188-189` | `transitioned` is a single boolean marker with no `reason`, so a *second, different* gate (`slot_capacity` after `spend_ceiling`) alerts nobody while the customer's 409 names the new one. | Trace whether `clearCapacityPendingMarker` (`:144`, called on a committed spend `:313`) always runs between two different-reason gates in practice. If not, IN. |
| `engine/webhook-delivery.ts:201-210` | Auto-disable after `WEBHOOK_DISABLE_THRESHOLD` terminal failures writes only `webhook_subscriptions.status='disabled'`; no tenant message, no ops alert. Not an *emission inversion* (delivery success is equally silent) — but the disabled channel IS the tenant's push path. | Product ruling: is `tenant_messages` the carrier for account-level state changes, or only for provisioning wire points? Only 2 system kinds exist today. |
| `engine/byo-intake.ts:250-252` | The 7-day abandon writes `byo_status='abandoned'` with no `logAction`, no message, no alert — but the `pending_dns` branch (`:255`) is equally silent, so there is no inversion *within the site*. | Is `pollByoDomainDns` ever cron-driven? I found no cron caller (`scheduled.ts`'s 11 legs do not include it). If a sweep ever drives it, the terminal transition happens with no agent present and nothing announces it → IN. |
| `admin/sweep-signals.ts:110` | `cron_legs` healthy claims *"Every ops-sweep leg completed with zero errors on consecutive ticks"*, but `collectLegSignals` inspects only three field names (`LEG_COUNTERS`, `:31`). A leg whose summary names its failures differently reads as zero. | Enumerate all 11 leg return shapes in `admin/ops-sweep.ts` and confirm every failure counter is `errors` / `budgetExpiries` / `skippedForLegDeadline`. I verified `errors` on 6 of 11; `webhooks`, `spendReservations`, `sdnRefresh`, `sdnRecovery`, `provisioningReconcile` unverified. |

### OUT — with the reason each is immune

| Site | Why it is immune |
|---|---|
| `admin/watchtower.ts:199` `"is answering again"` | Re-verified at emission: emitted only inside the `try` where the `opsSummary` RPC actually returned. |
| `engine/mailbox-provisioning.ts:205` → `alertMailboxResolved` (`mailbox-acquisition.ts:179-193`) | **The compliant template for arm B.** The clear runs only AFTER `awaitMailboxReady` proves the mailbox at the vendor, and only for an address previously flagged (`readCheckStatus`). Its comment states the rule explicitly: "a re-buy the provider accepted and never fulfilled is the failure being recovered from, not a recovery." |
| `engine/mailbox-provisioning.ts:275-324` | **The compliant template for arm A.** Every terminal branch (`terminal`, at-cap `abandoned`, re-buy threw) alerts at least as loudly as the retryable one, each under its OWN check name so the stuck alert cannot dedup it away (`watchtower-alerts.ts:59-76`). |
| `engine/tick.ts:415-460` | Correct direction: retryable defers silently (row back to `'pending'`); permanent/at-cap writes a durable `events` row of type `'failed'` that the watchtower's failure-signal window reads. |
| `admin/ops-sweep.ts:89-92` (dunning) | Email sent only after `suspendForDunning()` returns `true`; `:93-98` documents exactly this re-verification (F3: "don't record a suspend event or email one that didn't occur"). Terminal outcome emails BOTH parties; lesser outcomes write an event row only. |
| `ofac/sdn-alert.ts:102-105`, `sdn-ingest.ts:132-138`, `sdn-refresh.ts:63` | The recovery claim rides an actual load attempt's outcome; the `unchanged` case carries "verified-fresh, no swap performed" rather than implying a swap. |
| `ofac/screening-alert.ts` (both fns) | Symmetric — hit and list-unavailable each get their own alert with distinct framing. |
| `engine/contact-operator-guard.ts:143` | Severity gate in the CORRECT direction: `needs_human` **bypasses** the throttle, and held bodies ride the next successful send (`:149-160`) with `releaseEmailClaim` putting them back on failure. |
| `engine/warmup-cancel.ts:119-155` | Give-up gets its OWN column (`warmup_cancel_gave_up_at`), its OWN action (`WARMUP_CANCEL_GAVE_UP`) and `retryable:false` forced regardless of the vendor's grade. (Its *downstream* self-clear is IN, at `sweep-signals.ts:126` — the emission is correct, the clear is not.) |
| `engine/deliverability-actions.ts` `PAUSE` / `THROTTLE` / `SOFT_FLAG_DOMAIN` | Uniform `deliverability_actions` durability across branches. |
| `admin/watchtower-policy.ts` + `watchtower-alerts.ts:134-157` (`policyFor`) | I attacked the exemption list for a one-shot check silenced forever by `confirmAfterObservations: 2`. All four un-exempted per-entity checks (`domain_dns_aging:`, `cred_push_aging:`, `send_starved:`, `tenant_do_wedged:`) are re-observed every 5-min sweep by `scanTenants`, and `warmup_cancel_gave_up` is re-observed across a 24h window. **No check is one-shot-and-debounced today** — but the default is debounce, so the next `reportCheck` caller is silently silenced. See guard A3. |
| `migrations/0018_watchtower_debounce.sql` | Backfill credits running episodes `alert_count = 2` from a non-NULL `last_alert_ts`, which is provably "was announced". Correct; not a member. |
| `test/**` | Grepped all four false-claim strings — zero hits. No test encodes today's wording, so nothing has to be deleted alongside the fix. |

**Counts: IN 13 (8 arm A, 5 arm B) · UNCERTAIN 4 · OUT 12 (named above).**

---

## 4. Systemic guards

### Arm A — make "did anyone actually get told" a VALUE, not a comment

**A1 — a `Notified` result every claim must cite.** `reportCheck` already returns `AlertOutcome | null` and `trySend` already returns `boolean`; the information exists and is thrown away at every call site. Give every notifier (`alertRegistrarUnarmed`, `alertCapacityPending`, `alertMailboxStuck/Resolved/RebuyFailed`, `alertScreeningHit/ListUnavailable`, `alertUnresolvedDomainConnectionType`, `alertUnroutableStripeEvent`) the return type `{ delivered: boolean; why: "sent" | "dark_channel" | "suppressed_cooldown" | "pending_debounce" | "send_failed" | "no_notifier" }`, and forbid composing the phrase *"the operator has been notified"* (or "has been alerted" / "we have been notified") in any file where such a value is not in scope and true.

**A2 — a terminal rung in the message vocabulary.** `TenantMessageSeverity` becomes `"info" | "action_required" | "terminal"`; add the `CHECK` constraint in `schema.ts` **and** the `tenant-do.ts` runtime backfill (two surfaces — ledger lesson), and extend `site/openapi.yaml:2157`'s enum + the `list_messages` description at `mcp/tools.ts:350` and the `AGENTS.md` row. Without this, F3's fix ships a message an agent cannot branch on.

**A3 — a structural rule on `policyFor`.** `watchtower-policy.test.ts` already fails when a new check name is added without a stated classification. Extend it: any check name produced by `reportCheck` (i.e. event-driven — never produced anywhere inside `evaluateHealthChecks`) that resolves to a policy with `confirmAfterObservations > 1` fails the test. That makes "one-shot + debounced = permanent silence" unwritable.

**Enforcement shape:** a source tripwire, in the same idiom the repo already uses for `test/vendor-identity-leak.ts`. **It must walk a glob, not a hand-listed `SOURCES` array** — `test/spend-ceiling-coverage.test.ts` parses exactly one file and pins `allSites.length === 3`, which is why a money-out call added elsewhere is invisible to it (coverage ledger). The new test imports `src/**/*.ts` as `?raw`.

### Arm B — a healthy CheckResult must carry the evidence it claims

Change the type in `admin/watchtower-alerts.ts`:

```ts
export type CheckResult =
  | { name: string; healthy: false; detail: string }
  | { name: string; healthy: true; detail: string; basis: "reobserved" | "no_longer_applicable" };
```

`reobserved` = the positive condition was checked at emission (`watchtower.ts:199`, `:100`, `:157`, `alertMailboxResolved`). `no_longer_applicable` = the entity merely left the query. Then `recoveryEmail` (`watchtower-alerts.ts:205-215`) renders `no_longer_applicable` as *"no longer being tracked — the entity left this check's scope"* and **ignores the producer's prose**, so a false cause cannot reach the founder even if someone writes one.

This does not compile against the three `watchtower.ts` clear sites or `sweep-signals.ts:126` without each one stating which it is — which is exactly the decision the current code makes implicitly. Applied honestly: `:285` → re-read `dns_status` (→ `reobserved`) or `no_longer_applicable`; `:307` → re-read `mailbox_cred_pushes.status = 'pushed'`; `:322` → gate the claim on `eligibleMailboxes > 0`; `sweep-signals.ts:126` → `no_longer_applicable` (the window moved; nothing was verified).

### Failing-test sketches (must FAIL on `main@9d3ec7e9`, pass on the fix)

```ts
// ARM B — fails on main today
test("a released domain does not clear its aging alert with a working-DNS claim", () => {
  const summary = opsSummaryFixture({
    agingPendingDomains: [],                    // left the query...
    provisionedDomainNames: ["burned.example"], // ...because status went 'burning', not 'ready'
    mailboxProvenance: [],
  });
  const results = sendPipelineChecks("ten_x", summary, new Set(["domain_dns_aging:burned.example"]));
  const clear = results.find((r) => r.name === "domain_dns_aging:burned.example");
  expect(clear?.detail).not.toMatch(/now has working mail DNS/);
});

// ARM B sibling — fails on main today
test("a revoked credential push does not clear as 'credentials pushed'", () => {
  // mailbox_cred_pushes row set to 'revoked' by revokeMailboxCredentials (lifecycle.ts:209);
  // the mailbox is still present in mailboxProvenance (released_at set, not filtered).
  const results = sendPipelineChecks("ten_x", summaryWithRevokedPush, new Set(["cred_push_aging:a@x.com"]));
  expect(results.find((r) => r.name === "cred_push_aging:a@x.com")?.detail)
    .not.toMatch(/now has its engine credentials pushed/);
});

// ARM A — fails on main today (list is [] and the enum has no rung)
test("a terminal setup failure emits a durable, terminally-graded tenant message", async () => {
  await expect(runSetupInfrastructure(ctx, input)).rejects.toThrow(DomainDnsTerminalError);
  const msgs = listMessages(ctx);
  expect(msgs.map((m) => m.kind)).toContain("setup_failed");
  expect(msgs[0].severity).toBe("terminal");
  expect(msgs[0].actionHint).toMatchObject({ tool: "contact_operator" });
});

// ARM A tripwire — fails on main today at error-response.ts:126
test("no source file claims the operator was notified without a delivered notification", () => {
  // glob src/**/*.ts as ?raw; for each hit on /operator has been notified/,
  // require a notifier result in scope. NotActivatedError has NO notifier at all.
});
```

Revert-fail-restore is available for all four: none of these strings appears in `test/` today, so the assertions are new, not edits to existing pins.

---

## 5. Confidence — what a second sweep should check

1. **`routes/*.ts` response bodies were not read exhaustively.** I covered the error-mapping chain (`error-response.ts`) and the MCP/openapi/AGENTS claim surfaces, but a second pass should read each route's success bodies for the same "we did X" shape.
2. **UNCERTAIN-4 is mechanical and unfinished** — 5 of 11 sweep-leg return shapes unverified against `LEG_COUNTERS`.
3. **Webhook delivery payload builders** (`packages/shared/src/webhooks.ts` + emission) were checked for the *event vocabulary* (no `operator_message` / `setup_failed` type — audit F8) but not for claim strings inside payloads.
4. **`spikes/` and the remaining `site/guide-*.html` pages** — I grepped two guides; the marketing surface may repeat the "operator has been notified" contract.
5. **`watchtower-do.ts` / `watchtower-infra.ts`** were read only through their call into `alertEmailFor`; the DO-backed store's own clear path deserves a direct read.
6. **Drift risk:** sibling agents mutate this tree. This inventory is `main@9d3ec7e9`; the F3+F10 builder is on `feat/channel-truth-2026-08-17`. Re-ground before acting on line numbers.
