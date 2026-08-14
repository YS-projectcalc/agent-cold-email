# Vendor-verdict class sweep — coldrig — 2026-08-14

Class-sweep inventory for the Bug Response fix wave ordered by `docs/adversarial/c3-postship-reattack-2026-08-14.md` Finding 1 (+ Finding 3 amplifier). Sweeper ran READ-ONLY at HEAD `18d4e65`; main-loop scope rulings appended (§5). This doc is the on-disk record of the class, the inventory, and the fix architecture.

## 1. The class (CORRECTED from the initial brief)

*A terminal vendor state graded as a transient not-yet, because (facet 1) the port collapses "the vendor says dead" and "the vendor says not yet" into one indistinguishable return value that no type forces it to discriminate, and (facet 2) nothing bounds the resulting durable pending state, so it never becomes a failure.*

The initial framing ("engine reads our local lifecycle column instead of the vendor") was too narrow: at the confirmed defect the vendor's verdict WAS consulted — `polledDomainIsReady` (`vendors/real/inboxkit-domain-port.ts:466`) reads the real vendor row and returns `false` for an expired registration. The terminal information is destroyed at the PORT, because `DnsRecordSet` is five booleans that cannot say "dead". `readDomainStatus` at `domain-dns.ts:257` is a genuine member (the guard pointed at the wrong side) but it is the second error, not the mechanism. A fix that only makes the engine re-ask the vendor gets the same all-false answer.

Facet 2 must bind to the DURABLE pending state's AGE, not to a call — per-call budgets (`SET_DNS_BACKOFF_MS`, `MAILBOX_READY_BACKOFF_MS`, `ABSENCE_RECHECK_BACKOFF_MS`) restart with every customer call.

**Load-bearing asymmetry (do NOT delete):** guessing not-ready costs a retry; guessing ready bills a customer for a dead mailbox. A fix that makes `polledDomainIsReady` return true for a non-active vendor status RE-OPENS the false-ready billing defect the 2026-08-06 combined-diff gate closed. The answer is a terminal verdict ALONGSIDE the asymmetry, never its deletion.

## 2. Inventory — IN-CLASS (15), most critical first

| file:line | reason |
|---|---|
| `vendors/real/inboxkit-domain-port.ts:466` | `polledDomainIsReady` → false for ANY non-`active` vendor status on a purchased domain; expired/suspended/cancelled byte-identical to mid-propagation. Origin of the collapse. |
| `vendors/real/inboxkit-domain-port.ts:248-263` | Not-yet-listed returns all-false; a never-listed FAILED registration indistinguishable from one accepted 2s ago. C3 widened this door. |
| `packages/shared/src/vendor-ports.ts:98` | `setDns(): Promise<DnsRecordSet>` — the type cannot express "terminal". THE ROOT. |
| `packages/shared/src/vendor-ports.ts:133` | `MailboxProvisioningState = "absent"\|"pending"\|"ready"` — same root, mailbox side. |
| `engine/domain-dns.ts:257` | THE CONFIRMED DEFECT: third conjunct reads our own lifecycle column (never vendor-written → `'active'` for a dead registration). |
| `engine/domain-dns.ts:87-92` | `readDomainStatus` exists solely to serve :257 — DELETE with the fix, don't correct. |
| `vendors/real/mailbox-port.ts:88-92` | `provisioningState` maps ANY non-active vendor status to `"pending"` — a suspended/cancelled/failed mailbox reads "still being created". Mailbox-side analogue. |
| `engine/mailbox-provisioning.ts:388-424` | `awaitMailboxReady` throws retryable "still being created" forever for a terminally-dead mailbox. Both facets. |
| `engine/mailbox-acquisition.ts:104` | `state !== "absent"` → "present": a cancelled mailbox is ADOPTED. `MAX_BUY_DISPATCHES` guards only the `absent` branch. (The `OwnershipVerdict` TYPE at :72-78 is right; only this mapping is wrong.) |
| `engine/provisioning.ts:642` | The 202 `provisioning:"pending"` customer surface — nothing caps recurrence (adversary proved 10/10). |
| `engine/provisioning-reconcile.ts:79-188` | Level-triggered loop, no ceiling/age/abandonment — re-drives a dead domain every pass forever (DARK today). |
| `engine/provisioning-reconcile.ts:114` | Sweep scope predicate is `status='active'` on OUR column → vendor-dead domains stay in scope permanently. |
| `engine/domain-dns.ts:229-240` | `DOMAIN_DNS_PENDING` logged with ZERO readers — the escalation edge that doesn't exist. |
| `engine/domain-dns.ts:117-150` | `resolveDomainConnectionType` already holds the vendor row (`listOwnedDomains` returns `status`) and throws the verdict away — cheapest detection point; same drop-the-discriminator shape as the 2026-08-05 root cause. |
| `engine/deliverability-actions.ts:195-236` | Burn-replacement: pending-error from a dead replacement caught as generic "provider issue"; `countReplacementsInWindow` counts only successes → infinite sweep retries, never hits `MAX_REPLACEMENTS_PER_WINDOW`. |

## 3. OUT (correctly scoped) + in-repo prior art

- Local-lifecycle readers where OUR column is the right source: `quota.ts:57` · `reporting.ts:138` · `deliverability.ts:402` · `lifecycle.ts:297,:335` · `byo-intake.ts:88` · `infrastructure-status.ts:100` · `legacy-domain-intent-keys.ts:130` · `clock-migration.ts:181` · `deliverability-actions.ts:127,:264` · `provisioning.ts:59/140/261`.
- Vendor-verdict readers already consulting the right side: `provisioning.ts:166` (`findAdoptableDomain` refuses non-active; fall-through fails VISIBLY) · `byo-mailbox-composition.ts:41,:99`.
- **Templates for the guard:** `mailbox-acquisition.ts:72-78` (`OwnershipVerdict` — "deliberately NOT collapsible into a boolean") · `mailbox-port.ts:216-238` (`warmupSubscriptionState` returns "inconclusive") · `inboxkit-domain-port.ts:179` (page overflow throws non-retryable rather than reading incomplete as absent).
- **Bounded-pending prior art (all four):** `byo-intake.ts:232-257` (`dns_check_count` + 7-day abandon) · `warmup-cancel.ts:34,:119-127` (`MAX_CANCEL_ATTEMPTS` + separate `warmup_cancel_gave_up_at` column + founder signal) · `provision-intents.ts:32` (`MAX_BUY_DISPATCHES`) · `tick.ts:35,:188` (`MAX_SEND_ATTEMPTS` + terminal 'failed' + visible event — most complete).

## 4. Timestamps for the bound (schema facts)

`domains` table at `apps/platform/src/schema.ts:138`. NO `created_at`.
- ⚠️ `purchased_at` (`schema.ts:143`): DO NOT anchor here — mixed clock domains (real buy stamps `Date.now()` at `inboxkit-domain-port.ts:225`; adopt/sandbox stamp `ctx.clock.now()`; NOT shifted by `clock-migration.ts` → can sit in the real future after virtual→real migration).
- ✅ `dns_first_checked_at` (`schema.ts:205`, back-migrated `tenant-do.ts:385`, shifted at `clock-migration.ts:242`): the correct anchor — coherent with `ctx.clock.now()` across migration. Currently written only by BYO intake.
- ✅ `dns_check_count` (`schema.ts:204`, back-migrated `tenant-do.ts:384`): the attempt-count half; already 0 everywhere.
- Anchor columns already exist on every row; the gave-up marker is a NEW column (`dns_gave_up_at`, via the DO's `addColumnIfMissing` idiom — tenant tables live in `schema.ts`/`tenant-do.ts`, NOT `migrations/`).

## 5. Main-loop scope rulings (2026-08-14)

- **UNCERTAIN `mailbox-credential-push.ts:246-260` → OUT.** Its `AGING_CRED_PUSH_MS` → watchtower escalation satisfies facet 2 (the class requirement is "becomes visible", not "becomes terminal"). It is the guard's template.
- **UNCERTAIN sandbox ports (`sandbox/domain-port.ts:70`, `sandbox/mailbox-port.ts:23`) → IN.** The port-contract test (guard D3) requires every implementation to express a terminal fixture; add a fault-injection seam following the existing `unavailable` Set precedent (`sandbox/domain-port.ts:27-34`).
- **UNCERTAIN `apps/engine/src/api-send.ts:10-11` → OUT** of this wave (bounded downstream by `MAX_SEND_ATTEMPTS` + terminal 'failed' row + visible event — it terminates). Grade-honesty-at-source noted, not built.
- **Finding 2 (reconcile wrapper guards) stays OUT** — that is the founder-gated (d) arm-gate wave. This wave touches the reconcile only where the class forces it (verdict handling at compile time + `dns_gave_up_at` exclusion in the scope predicate).
- **NO new auto-spend paths.** A terminal verdict NEVER converts into an automatic purchase/rebuy in this wave — it surfaces as a non-retryable visible error + watchtower signal. (Money asymmetry, §1.)
- **`apps/dashboard` unswept** — display-side member possible; the fix gate should spot-check how the dashboard renders provisioning state.
- **Unrecognized vendor status tokens → `inconclusive`, never `terminal`** (live vocabulary is UNVERIFIABLE #1 in the re-attack doc; a surprise token must not hard-fail a healthy domain).

## 6. Fix architecture (guards A–D)

**A — make the collapse impossible at the type boundary:** discriminated `VendorReadiness` union (`ready | not_yet | terminal{vendorState} | inconclusive{reason}`) per the repo's own `OwnershipVerdict`/`warmupSubscriptionState` idiom. `DomainPort.setDns` → `{verdict, records}`; `MailboxPort.provisioningState` → verdict. Engine benign branch narrows on `not_yet`/`inconclusive` and CANNOT be satisfied by `terminal`; `readDomainStatus` is deleted.

**B — bound the durable pending state:** stamp `dns_first_checked_at`/`dns_check_count` on provisioned-path not-ready observations (`ctx.clock.now()`); success-pending additionally requires `now − dns_first_checked_at < DNS_PENDING_MAX_MS`; past the bound stamp `dns_gave_up_at` (separate column — a new `dns_status` enum value would silently change every `dns_status !== 'ready'` reader) and throw NON-retryable with an actionable message.

**C — wire the escalation edge:** `agingPendingDomains` in `TenantOpsSummary.sendPipeline` (template at `ops-summary.ts:314`) + `domainDnsAgingCheckName` watchtower check (follow `credPushAgingCheckName`). Gives `DOMAIN_DNS_PENDING` its first reader. Reconcile-leg `errors` already auto-flows via `LEG_COUNTERS` (`sweep-signals.ts:31`).

**D — re-introduction gate:** (1) DELETE `dnsRecordSet(ready: boolean)` (`inboxkit-domain-port.ts:480`); (2) exhaustive `switch` + `never` fallthrough in every engine consumer; (3) a port-contract test that EVERY DomainPort/MailboxPort implementation — real (stubbed fetch), sandbox (fault seam), test fakes — answers a terminal-state fixture with `kind:"terminal"`.

## 7. Known costs / second-sweep notes

- EIGHT test files construct `DnsRecordSet`/`provisioningState` fakes and need updating: `provisioning-dns-gate`, `provisioning-saga`, `provisioning-reconcile`, `incident-gate-fixes`, `real-inboxkit-domain-port`, `mailbox-provisioning-gate`, `mailbox-rebuy-guard`, `domain-connection-type`.
- Adversary's executable RED tests (adapt, don't rewrite): session scratchpad `cs/apps/platform/test/zz-adversary-c3b-attack.test.ts`, `zz-adversary-c3d-freeze.test.ts`.
- Live vendor status vocabularies for `/domains/list` + `/mailboxes/list` remain unverified (hence the `inconclusive` default).
- Whether Mordy's tenant currently sits in fake-pending needs the founder-held ADMIN_TOKEN.
