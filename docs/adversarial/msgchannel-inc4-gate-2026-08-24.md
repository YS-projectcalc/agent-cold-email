# msgchannel Inc4 (email mirror) — adversarial gate, 2026-08-24

| | |
|---|---|
| Ref reviewed | `47de55a75fa140b7e3c47eed9ce750578fc38148` (branch `feat/msgchannel-inc4-2026-08-24`, worktree `coldstart-wt-inc4`) |
| Merge base | `8d58f1e79a54425193cb91156ece10d4f92fc424` (`main`) |
| Commits | `0964a06` (design) .. `47de55a` (7 commits) |
| Design brief | `docs/research/msgchannel-inc4-email-mirror-design-2026-08-24.md` (read in full) |
| Git posture | READ-ONLY (`rev-parse` / `status` / `log` / `diff` only). Three scratch probe files were written under `apps/platform/test/zz-adversary-probe*.test.ts`, executed, and DELETED; `git status --porcelain` is empty at close. |
| **VERDICT** | **SHIP-AFTER-FIX — 2 BLOCKING, 8 non-blocking** |

## Verification actually run

- 14 targeted suites, **507/507 pass**: `tool-claim-binding`, `site-claim-surface-scope`, `site-tool-count-claims`,
  `sweep-budget`, `sweep-signal-coverage`, `watchtower-families`, `watchtower-policy`, `watchtower-key-reachability`,
  `monitoring-denominators`, `spend-armed-env-coverage`, `watchtower-retention`, `body-cap-coverage`,
  `message-mirror`, `mirror-optout-route`.
- `npm run typecheck` — **5/5 workspaces, exit 0** (dashboard, engine, platform, cli, shared).
- `apps/dashboard` `dtoParity.test.ts` — 18/18 pass.
- 11 purpose-built adversarial probes (PROBE 0-11) executed in-worktree; each negative result carries a paired
  positive control. Full suite NOT run (sibling lane battery in flight, per brief).

---

## BLOCKING

### B1 · The mirror opt-out accepts ANY `(tenant, email)` unsubscribe token — including the one in every cold email the tenant sends to a stranger

**Lens 8 (signed surface) + lens 6 (the design specified the reuse).**

`buildMirrorOptOutUrl` (`apps/platform/src/unsubscribe-token.ts:120-122`) reuses `buildTokenUrl` with the **same
derivation key** (`deriveUnsubscribeKey`, label `coldstart:unsubscribe-token-key:v1`, `:25`/`:51`) and the **same
signed payload** (`${tenantId}:${email}`, `:71`) as the lead-facing `buildUnsubscribeUrl` (`:109-111`). The two URLs
differ only in PATH, and the path is not signed. `mirrorOptOutRoute`'s POST
(`apps/platform/src/routes/messages.ts:109-119`) then verifies the triplet and calls `setMirrorEmailOptOut(true)`
**without ever comparing `email` to the tenant's actual `contact_email`.**

Failure scenario: `engine/tick.ts:85-87` mints `https://…/unsubscribe?tenant=ten_X&email=prospect@stranger.example&sig=S`
into every cold email tenant X sends. Any recipient of that mail — an arbitrary third party — swaps the path to
`/messages/mirror/optout`, POSTs, and permanently disables tenant X's operational mirror. The tenant is never
notified. The channel exists specifically to reach a customer whose agent is absent (design §12 Q1), so an
unauthenticated stranger can silently defeat its stated purpose.

VERIFIED BY EXECUTION (PROBE 1, three legs):
- sig minted for `(tenantId, "prospect@some-stranger.example")` → POST returns **200**, `mirror_email_optout_at` stamped.
- the next armed drain on that tenant returns `{"sent":0,...}` — the mirror is off.
- REVERSE also holds: a mirror-link sig POSTed to `/unsubscribe` returns 200.

Why the suite missed it: `apps/platform/test/mirror-optout-route.test.ts:66-74` tests a foreign **TENANT** (correctly
rejected — `tenantId` is inside the signed payload) but never a foreign **EMAIL** for the same tenant.

The repo already knows this pattern: `unsubscribe-token.ts:8-13` argues the derivation label makes this key
"cryptographically independent of `auth.ts`'s `hashApiToken` use of the same pepper." Domain separation was applied
between pepper *uses* and skipped between the two token *purposes*.

FIX (both halves):
1. Give the mirror token its own domain separation — a second derivation label (e.g.
   `coldstart:mirror-optout-token-key:v1`) or a payload prefix (`mirror-optout:${tenantId}:${email}`), with a
   matching `verifyMirrorOptOutToken`.
2. In the POST handler, resolve `lookupTenantContactEmail(c.env, tenant)` and reject (generic invalid-link page)
   unless it case-insensitively equals `email`.
3. Test: a sig valid for `(tenantId, someOtherEmail)` → 400 and `mirror_email_optout_at` unchanged.

### B2 · A transient D1 failure on the contact-email lookup is classified as `noContact`, keeps the claim, and permanently un-mirrors those rows

**Lens 1 (spec-vs-code) + lens 2 (executed) + brief attack #1 (suppressed vs failed vs retryable).**

`apps/platform/src/engine/message-mirror.ts:339-347` — the `catch` around `lookupTenantContactEmail` sets
`contactEmail = null` and falls into the same branch as a genuine NULL: `return { …, noContact: 1 }`, with the
`mirrored_at` stamp left **committed** and the ring slot spent. Design §7 states the opposite rule: "Retry cadence
IS the sweep cadence (claim released → next visit re-attempts)". A D1 read error is a retryable infrastructure
failure, not "this tenant has no contact email on file."

VERIFIED BY EXECUTION (PROBE 2, with control). Using the repo's own `dbFailingStatements(/contact_email FROM tenants_index/)`:
- fault: `{"sent":0,"failed":0,"suppressed":0,"noContact":1}`, `mirrored_at = 1787552483290`, `ring = {"sends":[1787552483290]}`
- D1 recovers, re-drain: `{"sent":0,...}`, `mailer.sent.length === 0` — **the message can never be mirrored again**
- CONTROL, same fixture, healthy D1: `{"sent":1,...}`

Second-order (misdirected alert): the tick reports `noContact`, so `mirrorDeliveryKey`
(`apps/platform/src/admin/watchtower-families.ts:329-335`) banks `no_contact_email` — the key its own docstring ranks
LOWEST, "a data-completeness gap, not a channel malfunction" — and `sweep-signals.ts:645` writes the detail
"skipped for no contact email on file." During a D1 degradation the on-call is pointed at a missing
`tenants_index.contact_email` that is in fact present.

Blast radius: every tenant visited in the faulting tick loses up to `MIRROR_DIGEST_MAX` (10) messages from the
channel, permanently and silently. Bounded only by the fact that the DO row remains the system of record.

FIX: separate the two causes in the catch.
- on THROW → `releaseMirrorClaim(ctx, ids)` and `return { …, failed: 1 }` (the ring slot correctly stays spent, per §5's NEW-4 rule);
- only a resolved `null` keeps the claim and counts `noContact`.
- Test: fault-inject the lookup → `mirrored_at` back to NULL, and a healthy re-drain sends.

---

## NON-BLOCKING

**NB1 · `MIRROR_CANDIDATE_SCAN_LIMIT` is applied BEFORE `isMirrorable`, so non-mirrorable rows can starve a
mirrorable one indefinitely.** `engine/message-mirror.ts:171-184` — the SQL `LIMIT 200` runs, then `.filter(isMirrorable)`.
PROVEN with a paired control (PROBE 11): 200 older `system/info` rows ahead of a `terminal` row →
`{"sent":0,...}`, 0 emails; delete ONE info row (199 ahead) → `{"sent":1,...}`, 1 email. Reachability is low
(needs 200 unread, unexpired, non-mirrorable rows created before the mirrorable one; `retry_setup` info dedups per
domain), but the design's own C3 names `info` as "the highest-frequency emit in the platform". Fix: push the
predicate into SQL (`AND (source='operator' OR severity IN (...)) AND kind NOT IN (...)`) so the LIMIT bounds
CANDIDATES, not raw rows.

**NB2 · The fan-out wall-clock model charges ZERO for the mirror's real in-RPC latency, and that exclusion is exactly
what keeps the headroom guard green.** `admin/sweep-budget.ts:287` subtracts `MIRROR_SUBREQUESTS_PER_TENANT` from
`SWEEP_FANOUT_RPCS_PER_TENANT`. Re-derived: folding it in gives `3 × 11 × 414 = 13,662ms` against
`sweep-budget.test.ts:113`'s `SWEEP_FANOUT_DEADLINE_MS * 0.85 = 12,750ms` → RED. The builder's stated reason (it is
not a new dispatch) is TRUE, but `MEASURED_DO_RPC_MS`'s own provenance ("THE COST IS DISPATCH, NOT WORK", cpuTime at
1-3% of wallTime) was measured on RPCs that issue no outbound subrequest inside the DO — the mirror is the first
per-tenant leg that does (a D1 read + a `send_email`). Mitigating, and re-derived rather than taken on trust: the
**slice is unchanged** (subrequest ceiling `floor((600-185)/11)=37 → floor((600-185)/13)=31`; wall ceiling
`floor(15000/(450·9))=3` both before and after; `min` = 3 either way), and `SWEEP_RPCS_PER_TENANT` correctly counts
the 2 subrequests. So nothing regresses today — but nothing will measure the added latency either. Suggest a named
in-RPC term charged at a measured send latency, or an explicit "not modelled — measure here" line at ARM-GATE step 4.

**NB3 · `dark_channel` cannot fire in the shipped config, and when it does fire it names the wrong condition.**
`admin/sweep-signals.ts:632` sets `darkChannel = !env.OPS_EMAIL`; `wrangler.toml:76-77` declares the `send_email`
binding, so `darkChannel` is false on every real deploy. Driven through the REAL producer and read from
`watchtower_state.announced_keys` (PROBE 7): BOUND+`failed=1`→`send_failed`; BOUND+`noContact=1`→`no_contact_email`;
BOUND+`sent=1`→no announcement; UNBOUND+`sent=1`→no announcement; UNBOUND+`noContact=1`→**`dark_channel`**;
UNBOUND+`suppressed`→no announcement. So `dark_channel` is bankable ONLY as a relabel of a no-contact condition on an
unbound binding, while the genuine dark mode the design names (C1: bound binding, un-onboarded domain →
`E_SENDER_NOT_VERIFIED` throw) banks `send_failed`.
*Self-refutation, stated because it changes the grade:* my first read was "dead declared key". That is FALSE across
the full env space — all three keys are producer-reachable, so `watchtower-key-reachability.test.ts` passes honestly
and is NOT vacuous. What survives is (a) unreachable in the shipped config and (b) mis-named when reachable. The new
probe being function-level with hand-written args (`mirrorDeliveryKey(true, 0, 0)`) is the layer that file's own
header warns "cannot see a producer that can never pass those args" — worth an end-to-end probe for this family too.
Sub-finding: with `OPS_EMAIL` unbound, `createOpsMailer` returns `SandboxOpsMailer`, which never throws — PROBE 7a
measured a drain reporting `{"sent":1,"failed":0,...}` for an email that never left the building, and
`mirror_delivery` then reports HEALTHY. Low reachability (wrangler.toml pins the binding) but it is the
"reports healthy while nothing is delivered" shape.

**NB4 · `MESSAGE_MIRROR_MAX_PER_DAY="0"` silently restores the default 3.** `engine/message-mirror.ts:104-107` —
`Number("0") > 0` is false, so it falls through to `MIRROR_MAX_PER_DAY`. PROVEN (PROBE 9): 3 sends. An operator
zeroing the cap to quiet the channel gets the full cap. Either accept `0` as a valid disable, or reject it loudly.

**NB5 · `mirror_delivery` is an always-on check that is absent from `expectedCheckRoster`.**
`admin/watchtower-roster.ts:44-52` does not list it, yet `scheduled.ts:224-229` reports it on every tick.
PROVEN (PROBE 8): while fully dark, a `status=healthy` row is filed each tick (`last_detail`: "…0 sent, 0 suppressed,
0 failed, 0 no-contact"), 0 emails. That file exists to close "absence is indistinguishable from health"; the new
always-on check did not join the denominator. Partly backstopped by `cron_legs`.

**NB6 · `mirrorDeliverySelfReport` is a POST-bag `runLeg`, so a throw in it is invisible to `cron_legs`.**
`scheduled.ts:224-229`. Its two post-bag siblings have structural reasons (`sweepSignalsSelfReport` reports ON the
leg bag; `heartbeat` is the dead-man and must be last); this one reports on `deliverability.mirror`, which IS in the
bag, so it inherits the exemption without inheriting the reasoning. Currently inert — `reportCheck` catches
internally and nothing on the path can throw — so this is a latent exemption, not a live break.

**NB7 · Unauthed write endpoint with no rate limiter.** `POST /messages/mirror/optout` sits behind no limiter (same
posture as `/unsubscribe`; `declaresOverCap` is a size check, not a rate check). The effect is idempotent and bounded
to one boolean per tenant, so the honest severity is low on its own — but combined with B1 it becomes an
unauthenticated, unlimited write against a tenant's configuration by anyone holding a cold-email URL. Fold into B1's fix.

**NB8 · Ledger overclaim + an under-specified arming step.** `ROADMAP.md:17` and `HANDOFF.md` state "All 16
design-brief §9 tests (T1-T16) RED-on-old-code → GREEN". T13 (`sweep-budget.test.ts` closure) and T14 (family/policy
registration) are pre-existing guards that were UPDATED, not new tests red on old code — T13 is trivially green on
old code. Separately, ARM-GATE step 3 says "arm NARROW via `MESSAGE_MIRROR_TENANT_ALLOWLIST` … + the flag" without
naming the mechanism. Deviation 5 (no `wrangler.toml` entry) is CORRECT — `PROVISIONING_RECONCILE_ENABLED` likewise
has none, and `ACTIVATION.md:84` documents `wrangler secret put` for `AUTOSEND_DISABLED` — but the runbook should
name the exact command so the operator does not have to infer it.

---

## Attacks that FAILED (why the SHIP-AFTER-FIX means something)

1. **Concurrent drains / exactly-once under the real dispatch.** 5 overlapping `deliverabilitySweep()` RPCs on one
   tenant → exactly ONE claim (`[{sent:1},{0},{0},{0},{0}]`), ring holds one slot (PROBE 4b). `claimMirrorBatch`
   (`message-mirror.ts:200-228`) is fully synchronous over `ctx.sql` with zero `await` — C7 respected, no Inc5 recurrence.
2. **Repeated drains.** 5 sequential drains of one claimed row → 1 send total (T3 re-derived).
3. **Crash between send and stamp.** The stamp PRECEDES the send, so the failure mode is at-most-once — which is
   exactly the brief's §5 choice, ledgered as an accepted residual. The code matches the stated choice.
4. **Backfill / replay after `ensureColumnMigrations`.** `ensureColumnMigrations()` runs in the DO **constructor**
   (`tenant-do.ts:206-209`) before any request; `addColumnIfMissing` returns `true` only on a real `ALTER`
   (`:686-698`); a fresh DO takes the column from `TENANT_DO_SCHEMA` and never ALTERs. No path where
   `getInfrastructureStatus`'s new `.one()` can hit a missing column.
5. **T11's dark-guard proof is NOT vacuous.** I planted the positive control the test lacks: the identical
   `state.storage.sql.exec` spy with the flag **ARMED** counts **4** exec calls (PROBE 3). So "0 exec calls when
   dark" is a real measurement, not a detached spy. Zero-D1 and zero-DO-exec both hold; the arming check is the
   literal first line.
6. **HTML injection through the REAL compose path.** T16's payload re-derived; `escapeHtml` covers `&<>"'`
   (`html-escape.ts:5-15`); the opt-out href is `escapeHtml(optOutUrl)` (`message-mirror.ts:315`); the confirm and
   success pages escape both the email and the action URL. No unescaped interpolation found in either leg.
7. **Sender identity.** The miniflare `send_email` log on the real binding path shows
   `From: "coldrig ops" <ops@coldrig.dev>`; `OpsEmailMessage` exposes no caller-settable From. Only the two
   sanctioned identities exist.
8. **Cross-tenant token leverage.** A sig valid for tenant A against tenant B → 400 (`tenantId` is inside the signed
   payload). Confirmed by the existing test and by construction.
9. **Enumeration / distinguishable responses.** GET never resolves a DO stub; both methods return the identical
   generic invalid-link page on any failure; a valid sig is unforgeable without `TOKEN_HASH_PEPPER`.
10. **Blast radius vs the ratified figure.** 50 eligible conditions in one day → exactly **3 emails × 10 bodies**,
    20 held, 0 dropped, 30/50 stamped (PROBE 6). Under §12 Q2's "≤3 mirror emails + at most 1 overflow digest",
    because the digest is one OF the 3 rather than additive. `MIRROR_MAX_PER_TICK=1` is genuinely structural — one
    claim, one send, no loop shape in which a second send could occur.
11. **Ring vs tumbling window, and the not-released slot.** `pruneMirrorRing` is a timestamp ring (T6 re-derived);
    T4's "3 failed attempts then the 4th is SUPPRESSED, not retried" re-derived. The Inc5 NEW-4 fix is correctly
    carried over.
12. **Clock discipline (my strongest failed hypothesis).** I expected the candidate predicate's `realNowMs()` to
    diverge from the read surface's `ctx.clock.now()` for a demo tenant's up-to-1440x VirtualClock. REFUTED:
    `expires_at` is stamped `realNowMs()` by `expireResolvedSystemMessages` (`tenant-messages.ts:470`) per the repo's
    own NB-2 rule ("EACH LEG IS AGED ON ITS OWN COLUMN'S CLOCK", `:585-604`), and no producer passes a future
    `expiresAt`. The mirror is on the RIGHT side of that rule.
13. **Hand-synced reader guards.** `InfrastructureStatus` is a NAMED exclusion in the dashboard's `dtoParity` guard
    ("deliberate narrower client view"), so the new `messageEmailMirror` field breaks nothing (18/18). The three
    claim-surface guards, `tool-claim-binding` (G1), `body-cap-coverage`, `watchtower-families`,
    `watchtower-policy`, `monitoring-denominators`, `spend-armed-env-coverage`, `watchtower-retention`,
    `sweep-signal-coverage` and `sweep-budget` are all green — 507/507.
14. **The `provisioningReconcileArmed` refactor.** `isAffirmativeEnvFlag` is behaviour-identical to the four-value
    check it replaced (same trim/lowercase, same `""`/`0`/`false`/`off`). No import cycle introduced
    (`engine/tick.ts` imports nothing from `admin/`).
15. **Cry-wolf on `noContact`.** PROBE 10: the condition self-clears on the very next tick (the claim consumes the
    row), so it is a one-tick blip — and `mirror_delivery` is DEBOUNCED (`watchtower-policy.test.ts:230`), so a
    one-tick blip never announces. The DEBOUNCED-not-IMMEDIATE choice is load-bearing and correct.

---

## UNVERIFIABLE here

| Attack | Blocker | What resolves it |
|---|---|---|
| Precise sizing of NB2 (real `send_email` latency inside a DO) | no production tail from this worktree | `wrangler tail` `wallTime` on `deliverabilitySweep` before/after arming — fold into ARM-GATE step 4 |
| Live deliverability / C2 / Q3 spam placement | needs a real pilot send | ARM-GATE step 4's droplet-IMAP `Authentication-Results` + folder check |
| Whether the flag is armed by the mechanism the runbook assumes | no prod access | `wrangler secret list` at arming time |
| Full-platform battery on the merged tree | sibling lane battery in flight (per brief) | run the full suite once on the integration branch before merge |

## NEW / out of scope (no verdict weight)

- `listSurfacedTenantMessages` (`tenant-messages.ts:311`) compares `expires_at` against `ctx.clock.now()` while
  `expires_at` is written with `realNowMs()` — the inverse of the NB-2 rule `pruneTenantMessages` follows two
  functions later. Currently inert (no producer sets a future `expiresAt`). Pre-existing, unrelated to Inc4.
- No timeout anywhere on `mailer.send` in the sweep (dunning included): a hung send has no bound short of the 300s
  cron period. Pre-existing class; the mirror joins it rather than creating it.
