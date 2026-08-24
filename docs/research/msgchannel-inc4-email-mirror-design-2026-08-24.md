# msgchannel Increment 4 — the email mirror. Build brief (2026-08-24)

DESIGN ONLY; this is the only file written. Register follows `docs/research/alert-state-design-2026-08-20.md`:
constraints numbered, decisions stated not hedged, every reference anchored on a NAME plus the behaviour asserted
(if the line moved, grep the name; if the BEHAVIOUR moved, that is a finding).

## Grounding

| Item | Value |
|---|---|
| Ref | `fbd4168` (`main`, clean). Migrations at `0021_watchtower_alert_state.sql`. Prod Worker `fca0c4d9`. |
| Authorization | Founder 2026-08-05, full channel incl. "an EMAIL opt-in mirror" (`archive/ROADMAP-done.md:258`). Inc1/2/3/5 shipped; Inc4 is the last unbuilt piece (`ROADMAP.md:17`). |
| Store | `tenant_messages` is **DO-LOCAL SqlStorage**, not D1 (`schema.ts:1127-1156`). `read_at` has ONE writer ever — `ackMessage` (`:409`); nothing in this increment writes it. |
| Emit inventory | 6 producers: `retry_setup` ×2 (`provisioning.ts:803` info, `:843` action_required), `setup_failed` (`provisioning.ts:883`, operator_pending\|terminal), `credential_ready` (`mailbox-credential-push.ts:188`), `send_blocked` (`tick.ts:286`), `continuity_nudge` (`continuity-nudge.ts:63`), plus arbitrary-kind operator rows (`routes/admin-messages.ts:27` → `emitOperatorMessage`). |
| Outbound channel | `OPS_EMAIL` Send Email binding, **UNRESTRICTED by design** — no `destination_address` (`wrangler.toml:70-79`), because dunning already mails arbitrary tenant contact addresses (`admin/ops-sweep.ts:sendDunningSuspendNotice`). |

## §1 Constraints — the things that decide the design

**C1 · There is no "verified recipient" list to fall back from.** The brief's premise ("CF Send Email
only delivers to verified addresses") is FALSE for this binding: Cloudflare Email Sending is DOMAIN-onboarded
(`coldrig.dev`, `ACTIVATION.md:93`), and the destination restriction exists only when `destination_address` is
declared, which it deliberately is not. Failure modes are (a) binding absent → `OpsMailNotConfiguredError`
(`ops-mailer.ts:64`), (b) domain un-onboarded → `E_SENDER_NOT_VERIFIED`,
(c) transient/rejected send. All three are already caught-and-logged by every existing caller; none is
a recipient-allowlist problem.

**C2 · Deliverability, not verification, is the binding risk — and it is measured BAD.** The one real
outbound send to an external Gmail (`login@coldrig.dev`, §1.7b gate) got `dkim=pass d=coldrig.dev` + `spf=pass` +
`dmarc=pass` under live `p=reject` **and landed in the SPAM folder** (`ROADMAP.md:73`). Reputation, not config. So:
the mirror is never the system of record, never claims delivery, and gets a pilot-tenant arming step before it goes
wide.

**C3 · `kind` is an open `string`; `severity` is a closed union.** `EmitTenantMessageInput.kind` is
untyped (`tenant-messages.ts:80`) while `TENANT_MESSAGE_SEVERITIES` is a runtime array watched by the doc-coverage
guard (`:59-66`). A kind-allowlist silently drops every future kind — this repo's unswept-consumer class. Select on
severity + source.

**C4 · The dedup branch REFRESHES a row in place** (`tenant-messages.ts:135-167`): same `id`, bumped
`last_occurred_at`, immutable `created_at`. Every provisioning retry hits it. A mirror keyed on recurrence would mail
on every retry; a mirror keyed on row identity mails once per condition.

**C5 · A later, more specific founder ruling forbids emailing the nudge.** Ruling Q1, 2026-08-18:
"in-product `tenant_messages` row ONLY. Exactly ONE per stall episode... **No email**"
(`docs/research/customer-continuity-design-2026-08-18.md:1139`, restated at `continuity-nudge.ts:5-7`).
It postdates the 2026-08-05 Inc4 authorization and is narrower. It governs until reversed.

**C6 · The cron sweep is slice-budgeted.** `SWEEP_RPCS_PER_TENANT = 11` drives `SWEEP_TENANT_SLICE`
against `SWEEP_SUBREQUEST_BUDGET = 1000 × 0.6` (`admin/sweep-budget.ts:70-360`). The file's own rule: "Any leg with
its own fan-out gets its own term below... `sweep-budget.test.ts` asserts that sum is closed." DO-local `ctx.sql` is
free; `ctx.env.DB` and `mailer.send` are subrequests.

**C7 · A DO's input gate opens at every `await`.** `contact-operator-guard.ts:5-13`: the first cut of
Inc5 kept its cap in D1 and sent 96 emails against a cap of 5. Any admission decision here must be synchronous over
`ctx.sql`, with the send strictly after it commits.

**C8 · The founder's alert budget is not a shared pool.** `MAX_ANNOUNCEMENT_EMAILS_PER_DAY = 20` with
a reserved 15/5 per-entity split (`admin/watchtower-budget.ts:42-62`) exists to stop per-entity storms starving global
alerts. A tenant-facing mirror drawing on it would invert exactly that priority.

**C9 · Legal basis, stated and bounded.** This is transactional/relationship mail to a tenant's own
signup address about that tenant's own account. It is outside CAN-SPAM's commercial-content test
(15 U.S.C. §7702(2)), so no unsubscribe is legally required, and the platform's RFC 8058 machinery
(`unsubscribe-token.ts`, `engine/tick.ts:281`) belongs to the CUSTOMER's cold email, not ours.
**The exemption survives only while the mail carries zero promotional content** — no upsell, no
cross-sell, no link but the account's own. That is a hard content rule, not a preference (§9 T15).

## §2 Decision 1 — WHAT is mirrored

| Row | Mirrored | Why |
|---|---|---|
| `source = 'operator'` (any severity) | **ALWAYS** | A human wrote it once and it cannot be regenerated — the same reason `listSurfacedTenantMessages` ranks operator rows above system rows (`tenant-messages.ts:282-291`). |
| `source = 'system'`, severity `action_required` \| `operator_pending` \| `terminal` | **YES** | Each means the account has stopped (`:32-47`). |
| `source = 'system'`, severity `info` | **NEVER** | "the condition resolves on its own; nothing is required" (`:31`). This excludes the highest-frequency emit in the platform, the propagation-wait `retry_setup` (`provisioning.ts:803`). |
| `kind = 'continuity_nudge'` | **NEVER** | C5. Named exclusion `MIRROR_EXCLUDED_KINDS`, with the ruling cited at the constant. |
| A dedup REFRESH of an already-mirrored row | **NEVER** | C4. Identity is the row, not the occurrence. |
| A row already `read_at`-acked or expired at drain time | **NEVER** | The condition resolved before the drain reached it. Drain reuses the exact predicate at `tenant-messages.ts:308`. |

An unrecognised severity resolves to `action_required` (`toSeverity`, `:253`) and therefore mirrors — the correct direction: over-mailing costs one email, under-mailing is the silent stall this channel exists to prevent.

## §3 Decision 2 — TO WHOM

`tenants_index.contact_email` in D1 — captured at signup, lowercased on write, indexed
(`migrations/0007_tenant_contact.sql:15`, `0009_login_links.sql:19-22`), read by the existing
`lookupTenantContactEmail(env, tenantId)` (`db.ts:34`), which `sendDunningSuspendNotice` and `contact-operator.ts`
already call.

- **NULL contact email → no mirror, ever, and no synthetic address.** `contact-operator.ts`'s `agent:${tenantId}`
  fallback is a ticket's `from_email`, never a send target (`:100-110`). Dunning's rule is the precedent: flag it, do
  not fake it (`admin/ops-sweep.ts:129-131`). Counted as `noContact`.
- **There is no fallback recipient.** Mailing the founder a tenant's notice is a cross-tenant leak of the kind
  CLAUDE.md rule h forbids. The agent-readable DO row IS the fallback.
- **Sender: `ops@coldrig.dev`** (`OPS_FROM_EMAIL`, `ops-mailer.ts:19`). Not a third identity: only two are sanctioned
  (`:19-29`), a third starts its reputation at zero (C2), and this is the dunning notice's operational sibling, which
  already sends from `ops@`.

## §4 Decision 3 — WHEN

**Rejected: immediate per-message.** `emitTenantMessage` is synchronous and returns `void`
(`tenant-messages.ts:118`), called from inside `runSetupInfrastructure`'s catch and the send tick.
Awaiting a network send there puts a round trip on the customer's own call and changes five call sites' error
semantics, for a notice that is not time-critical.

**Adopted: drain in the existing per-tenant sweep leg**, one line after `pruneTenantMessages(ctx)` inside
`TenantDO.deliverabilitySweep` (`tenant-do.ts:1450`) — the wiring Inc1's prune and Inc5's
`reconcileOrphanedAdmissions` (`:1457`) already use. No new cron, no new RPC, slice bound for free.
**Latency is therefore one slice rotation** — 63 tenants, a full pass every ~21 ticks ≈ 105 min
(`ROADMAP.md:20`). Stated, not hidden: this is a MIRROR, not a pager.

**Caps — per tenant, DO-local, NOT the watchtower's pool (C8):**

| Constant | Value | Reason |
|---|---|---|
| `MIRROR_MAX_PER_TICK` | 1 | Pins the per-tenant subrequest term at one send (C6). |
| `MIRROR_MAX_PER_DAY` | 3 | Rolling 24h. A stalling tenant's rows refresh rather than multiply (C4), so 3 covers a new blocker + an operator reply + a digest on the worst day. |
| `MIRROR_DIGEST_MAX` | 10 | Bodies folded into the overflow digest. |
| `MIRROR_WINDOW_MS` | 24h | Measured over a **bounded ring of send timestamps**, never `{windowStart, count}` — two fields express a TUMBLING window that permits 3 at T+23.9h and 3 more at T+24.1h (`watchtower-budget.ts:74-86`, ported verbatim). |

**Overflow is folded, never dropped.** Rows denied by the cap stay unmirrored; when the ring next
admits, ONE digest carries up to `MIRROR_DIGEST_MAX` withheld bodies and stamps them all — the held-body drain shape
of Inc5's throttle (`contact-operator.ts:83-93`, `composeOpsEmailText`).

## §5 Decision 4 — exactly-once

**`tenant_messages.mirrored_at INTEGER`** — NULL = never mirrored. One column, on the row whose
identity already survives dedup-refresh (C4), so re-emission of an ongoing condition is a no-op by construction rather
than by a second guard.

**Claim before send, compensate on failure** — Inc5's proven shape (`releaseEmailClaim`,
`contact-operator.ts:46`; `revokeAdmission`, `contact-operator-guard.ts:196`):

1. Synchronously over `ctx.sql` (no `await` — C7): select candidates, check ring + opt-out + flag,
   stamp `mirrored_at = now` on the batch, append the ring slot.
2. `await mailer.send(...)`.
3. On throw: `UPDATE ... SET mirrored_at = NULL` for exactly that batch, **leaving the ring slot
   consumed**, then log and continue.

**The ring slot is deliberately NOT released.** That closes the Inc5 sibling defect NEW-4 — "a revoked
call frees its own rate slot, so the cap is not enforced while EVERY call is failing: 30 sequential calls under a D1
outage produced 30 throws, uncapped" (`archive/ROADMAP-done.md:266`). Here a totally dark channel costs at most 3
attempts/tenant/day instead of one per tick forever.

**Backfill, so arming does not mail a backlog.** `addColumnIfMissing` is changed to RETURN whether it
performed the `ALTER` (`tenant-do.ts:673-680`, currently `void`); when it did, the same pass runs one local `UPDATE
tenant_messages SET mirrored_at = 0 WHERE mirrored_at IS NULL`, stamping every pre-column row "suppressed,
pre-mirror". Rows written after the column exists are NULL and eligible; a fresh DO takes the column from
`TENANT_DO_SCHEMA`, never ALTERs, and has no rows — correct either way. Without this, the first armed drain mails a
30-day backlog to every tenant at once.

**Accepted residual, ledgered not papered over:** an isolate death between claim and release loses that
one email (row stamped, nothing sent) — Inc5's isolate-death window in miniature, which needed a whole reconcile sweep
(`engine/contact-operator-reconcile.ts`). Not built here: one email about a row the agent can still read is not worth
a leg. TRUE closure if it bites is the two-phase confirmed flag
(`mirror_claimed_at` + `mirrored_at`) — the answer Inc5's own gate reached (`archive/ROADMAP-done.md:266`),
not a reconcile sweep.

## §6 Decision 5 — opt-out

Ship one even though C9 says none is required, because spam complaints, not law, are the binding risk.

- **State:** `tenant_profile.mirror_email_optout_at INTEGER` (DO-local; NULL = opted in).
- **Recipient-facing:** a signed link in every mirror email — `GET /messages/mirror/optout` → confirm page → `POST`
  performs. Two-step **because a GET that mutates is fired by every mail-scanner prefetch**, the exact reason
  `routes/unsubscribe.ts:60-72` is already built this way. Token is HMAC over `(tenantId, contactEmail)` via
  `deriveUnsubscribeKey(env.TOKEN_HASH_PEPPER)` (`unsubscribe-token.ts:51`), reused not re-invented (rule c).
  Forged/foreign token → the invalid-link page, never a distinguishable response. Idempotent.
- **Operator-facing:** `PATCH /admin/tenants/:id/mirror` beside the existing admin message routes
  (`routes/admin-messages.ts:47`), so an operator can honour a phoned-in request instantly.
- **NO new MCP tool.** The recipient is a human at the signup address, not the agent; a 29th tool costs four doc
  surfaces plus the tool-count claim guard for an actor that is not reading the mail. The agent SEES the state —
  `infrastructure_status` gains `messageEmailMirror: { enabled, optedOut }` (`engine/infrastructure-status.ts:197`).
- **Scope:** opting out suppresses the whole mirror — not dunning notices, magic-link auth mail, or the DO rows. The
  mail says so in one line.
- **Deferred, stated:** RFC 8058 `List-Unsubscribe`/`-Post` headers would help Gmail placement (C2), but
  `OpsEmailMessage` has no headers field (`ops-mailer.ts:31-44`) and this binding's custom-header support is unverified
  here. Out of scope for Inc4 — the one bounded follow-up spike, recorded so it is not rediscovered.

## §7 Decision 6 — failure handling

- Every send is wrapped best-effort and can never break the sweep leg — `trySendNotice`'s shape
  (`admin/ops-sweep.ts:180-186`), the standing rule for `registrar-alert.ts`/`support-inbound.ts`. Retry cadence IS
  the sweep cadence (claim released → next visit re-attempts): no backoff table, no in-request loop, bounded by the
  ring (§5). A permanently-failing row re-attempts ≤3×/day until it is acked, expires, or `pruneTenantMessages`
  reclaims it at 30 days (`tenant-messages.ts:102`).
- **One new watchtower family, `mirror_delivery`** — keys `send_failed` | `no_contact_email` | `dark_channel`; `scope:
  "global"`; `budget: "counted"`. Registered in `admin/watchtower-families.ts:90` (its test reds if a check declared
  in `watchtower-alerts.ts` has no row — `:12-14`) and labelled in `CHECK_LABELS` (`watchtower-alerts.ts:101`).
  **Global, never per-entity** — per-entity instances multiply with the tenant count, which is what the 15/5 reserved
  split exists to bound (`watchtower-budget.ts:44-62`). **DEBOUNCED, not IMMEDIATE**: it must NOT join
  `SWEEP_COVERAGE_CHECK`/`ALERT_DELIVERY_CHECK` at `watchtower-alerts.ts:311` — one bad tick is transient, and the
  mirror is not the channel that says "we cannot reach you".
- Produced ONCE per tick from `scheduled.ts` (beside `reportSweepSignals`, `:219`) over an aggregate —
  `deliverabilitySweep`'s return grows `mirror: { sent, failed, suppressed, noContact }`.

## §8 Decision 7 — schema, config, arming

**T1 · NO D1 MIGRATION. `0022` is not consumed.** The store, the claim column, the opt-out and the ring
are all DO-local; the only D1 touch is a READ of a column that has existed since `0007`. This is the single most
likely reflex error in this build.

**T2 · DO schema (`schema.ts` + `ensureColumnMigrations`, `tenant-do.ts:355`):**
`tenant_messages.mirrored_at INTEGER` (+ the one-shot ALTER-path backfill, §5) ·
`tenant_profile.mirror_email_optout_at INTEGER` · `tenant_profile.mirror_ring_json TEXT`.
**No new index** — the drain's predicate leads on `(tenant_id, read_at, …)`, which
`idx_tenant_messages_unread` (`schema.ts:1155`) already covers at this row count (rule i).

**T3 · New module `apps/platform/src/engine/message-mirror.ts`** — selection, claim/release, composition,
drain. NOT added to `tenant-messages.ts`, already 608 lines against CLAUDE.md rule b's ~300.

**T4 · env (`env.ts:265` block) + `wrangler.toml`:** `MESSAGE_EMAIL_MIRROR_ENABLED?: string` (the arming
flag) · `MESSAGE_MIRROR_TENANT_ALLOWLIST?: string` (comma-separated ids; empty = all) · `MESSAGE_MIRROR_MAX_PER_DAY?:
string` (default 3). The flag is parsed with the existing affirmative-value parser `provisioningReconcileArmed`'s
helper (`admin/ops-sweep.ts:271-273`), generalized rather than re-written (rule c) — empty/`""`/`"false"`/`"0"` are
all DARK.

**T5 · Budget model:** add `MIRROR_SUBREQUESTS_PER_TENANT = 2` (one contact-email D1 read on cache miss
+ one send, worst case) to `admin/sweep-budget.ts`'s per-tenant term and to `LEG_SUBREQUEST_COSTS`
(`:203,231`), so `sweep-budget.test.ts`'s closure assertion still holds. Steady state is 0 (no eligible
rows ⇒ a local SELECT and nothing else).

**T6 · DARK arming plan** — the flag is unset at merge; the drain returns before any I/O.
(1) Merge dark; a test asserts zero sends AND zero D1 reads with the flag unset. (2) Deploy — DO
columns apply on next DO construction, there is no `wrangler d1` step to run. (3) Arm NARROW:
`MESSAGE_MIRROR_TENANT_ALLOWLIST` = the pilot tenant, plus the flag. (4) **Verify live before widening** — one real
mirror, then read `Authentication-Results` AND folder placement by the droplet-IMAP method the §1.7b gate used
(`ROADMAP.md:73`); C2 says expect spam, and that result gates the widening, not the merge. (5) Clear the allowlist.
Only then does the ROADMAP item lose `[dark-unarmed]` — the arming step is part of the item.

## §9 Test list — every item RED on the old code, quoted in the build report

| # | Test | RED against |
|---|---|---|
| T1 | `info` never mirrors; `action_required`/`operator_pending`/`terminal` do; `source='operator'` always | no selector exists |
| T2 | **dedup refresh does not re-mirror**: emit(dedupKey) → drain (1 send) → re-emit same key → drain → 0 more sends, `mirrored_at` unchanged | a drain keyed on `last_occurred_at` |
| T3 | exactly-once: 5 drains in a row → 1 send | a drain with no claim |
| T4 | send throws → `mirrored_at` back to NULL, **ring slot still consumed**, 4th attempt in 24h refused | a release that also frees the slot (the Inc5 NEW-4 shape) |
| T5 | cap + digest: 5 eligible in one day → 3 mails + 1 digest carrying every withheld body, 0 dropped | any drop-on-overflow |
| T6 | ring vs tumbling: 3 sends at T+23.9h then 3 at T+24.1h do not both admit | `{windowStart,count}` |
| T7 | `continuity_nudge` never mirrors at `action_required` (test name cites ruling Q1) | a pure severity gate |
| T8 | NULL contact email → 0 sends, `noContact` counted, no synthetic address ever reaches `mailer.send` | the `agent:` fallback leaking into a send |
| T9 | opt-out set → 0 mirror sends, dunning notice still sends | an over-broad suppression |
| T10 | opt-out link: GET mutates nothing (prefetch-safe), POST performs, twice is idempotent, forged/foreign token → invalid-link page, no enumeration | a one-step GET |
| T11 | flag unset → 0 sends AND 0 D1 reads | a drain that reads before checking |
| T12 | a DO whose `tenant_messages` predates the column mails nothing on its first armed drain | missing backfill |
| T13 | `sweep-budget.test.ts` closure still holds with the new term | an unmodelled fan-out leg (the B1 class) |
| T14 | `watchtower-families.test.ts` covers `mirror_delivery`; policy is DEBOUNCED, not IMMEDIATE | an unregistered family |
| T15 | composer emits no promotional content and no link but the account's own + the opt-out (C9) | copy drift |
| T16 | HTML leg `escapeHtml`s every interpolated body | injection into the recipient's client |

No `fenceAgentContent` wrapper (`contact-operator.ts:64`), stated so its absence is not read as an omission: that
fence exists because TENANT-authored text flowed to an operator who might paste it into a coding agent. Here the content
is platform/operator-authored flowing to the tenant — `escapeHtml` is mandatory, the fence's threat model does not apply.

## §10 Files to touch

| File | Anchor | Change |
|---|---|---|
| `apps/platform/src/engine/message-mirror.ts` | NEW | selection, claim/release, ring, compose, drain |
| `apps/platform/src/engine/tenant-messages.ts` | `:226` `TenantMessageRow` | `mirrored_at` on the row type only — no logic |
| `apps/platform/src/schema.ts` | `:1127-1152`, `tenant_profile` block `:57-130` | 3 columns |
| `apps/platform/src/tenant-do.ts` | `:355` `ensureColumnMigrations`, `:673` `addColumnIfMissing`→`boolean`, `:1450` after `pruneTenantMessages`, `:1458` return shape | wiring |
| `apps/platform/src/ops-mail/ops-mailer.ts` | `:19` | reuse `OPS_FROM_EMAIL`; no new identity |
| `apps/platform/src/env.ts` | `:265` block | 3 optional vars |
| `apps/platform/src/admin/sweep-budget.ts` | `:203`, `:231` | per-tenant term |
| `apps/platform/src/admin/watchtower-alerts.ts` | `:101` labels, `:201` constants, `:311` policy | new check, DEBOUNCED |
| `apps/platform/src/admin/watchtower-families.ts` | `:90` | family row |
| `apps/platform/src/scheduled.ts` | `:219` | report the aggregate |
| `apps/platform/src/routes/unsubscribe.ts` | `:60-72` | pattern source for the new opt-out route |
| `apps/platform/src/routes/messages.ts` + `index.ts` | `:15` / mount | UNAUTHED opt-out GET/POST — must mount outside the tenant-authed group |
| `apps/platform/src/routes/admin-messages.ts` | `:47` | `PATCH /admin/tenants/:id/mirror` |
| `apps/platform/src/engine/infrastructure-status.ts` | `:197` | `messageEmailMirror` field |
| `README.md` (platform + engine), `ROADMAP.md`, `HANDOFF.md` | — | canonical docs only, no new doc |

⚠️ The channel's tool/API descriptions sit under the doc-coverage guard (G1, `tenant-messages.ts:59-64`) — enumerate which description surfaces mention the message channel before merge; an unupdated one reds the guard.

## §11 Non-goals

**No second cron leg or alarm** (the drain rides `deliverabilitySweep`; a new leg needs its own budget
term and dead-man reasoning) · **no reconcile sweep for the isolate-death window** (§5 — the residual is one email,
the cure is a leg) · **no inbound reply handling** (a reply to `ops@` lands in the existing `support@` path; the
mirror invents no second reply channel, Inc5's own rule at `contact-operator.ts:6-11`) · **no dashboard surface**
(operator visibility is `GET /admin/tenants/:id/messages` plus the new `mirror_delivery` check) · **no address but the
tenant's own signup contact** (§3).

## §12 Open questions — founder only

**Q1 · Does arming the mirror reverse ruling Q1 (2026-08-18) for `continuity_nudge`?** This design says
NO and excludes it (C5) — yet it is the single highest-value thing to mail: the nudge exists precisely for an ABSENT
agent, and a DO row cannot reach one. The continuity design says exactly that ("a `tenant_messages` row is not
sufficient on its own — an absent agent never reads it", `:501-503`), then the ruling took the email away. One word
flips it: one entry in `MIRROR_EXCLUDED_KINDS`.

**Q2 · RATIFY the blast radius in inbox units** (the §9.13 precedent). Per tenant per day: ≤3 mirror
emails + at most 1 overflow digest, from `ops@coldrig.dev`, worst-case latency one rotation (~105 min at
63 tenants). At 1 paying tenant that is ≤4/day; at 100 activated tenants ≤400/day spread across 100
different inboxes, never into one.

**Q3 · Arm despite measured spam placement?** The only real outbound send to an external Gmail landed in
SPAM with all authentication passing (C2). (a) Arm on the pilot tenant anyway, accepting that notices may sit in spam
while the DO row stays the real channel; or (b) hold Inc4 armed-dark until Postmaster registration + real volume
improve reputation. This design assumes (a), with §8 T6 step 4 as the checkpoint.
