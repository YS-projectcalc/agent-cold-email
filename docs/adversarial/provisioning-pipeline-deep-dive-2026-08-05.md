# Adversarial deep-dive — the ENTIRE provisioning pipeline (2026-08-05)

**Grounding:** HEAD `5c9f58771cd0e15e0b366bba6b80f935abb89871` (branch `main`, clean except
untracked agent-memory files). Read-only review: `git status/log/show`, source trace,
one unauthenticated `GET https://api.coldrig.dev/status` → `{"status":"ok"}` (200), one
executable proof harness in the session scratchpad. No edits, no vendor calls, no live
mutations.

**Scope.** Everything in and around `setup_infrastructure` EXCEPT the five class-sweeper
lanes already running (vendor-stranding, idempotency, ledger coverage, error mapping,
partial-state). Where a finding touches those lanes it is cross-referenced, not
re-inventoried.

**Premise taken as true and confirmed:** this pipeline has never completed end-to-end in
production. The 2026-08-04 incident is one symptom; below are eleven more, three of which
are *guaranteed* to fire on Mordy's exact two planned calls.

**VERDICT: FAIL.** 5 BLOCKING findings survive self-refutation. Three (F1, F2, F5) are
reachable on Mordy's next two `setup_infrastructure` calls with certainty, not probability.

---

## F1 · BLOCKING · Mordy's second `setup_infrastructure` call is a guaranteed failure — lookalike generation is stateless and always returns the domain we already bought

**Lens 1 (spec-vs-code line trace) + 2 (run it) + 6 (attack the design).**

`RealInboxKitDomainPort.searchLookalikes` (`apps/platform/src/vendors/real/inboxkit-domain-port.ts:76-94`)
builds candidates from a hardcoded 5-element prefix list with no memory of what the tenant
already owns:

```ts
const prefixes = ["go", "the", "my", "get", "try"];
const candidates = prefixes.slice(0, Math.max(1, count)).map((prefix) => `${prefix}${slug}.com`);
```

`runSetupInfrastructure` (`apps/platform/src/engine/provisioning.ts:293-305`) consumes them
positionally and never checks the tenant's `domains` table:

```ts
const candidates = await ctx.adapters.domain.searchLookalikes(input.brand, input.primaryDomain, input.domains);
for (let domainIndex = 0; domainIndex < input.domains; domainIndex++) {
  const candidate = candidates[domainIndex % candidates.length];
  if (!candidate) continue;
  await provisionDomainWithMailboxes(ctx, { domain: candidate.domain, ... });
}
```

`packages/shared/src/intents.ts:57` makes `domains: z.number().int().min(1).max(20)` —
**there is no mailboxes-only call.** Mordy's plan (call 1 `domains:1, inboxesEach:3`, call 2
`inboxesEach:2`) forces `domains >= 1` on call 2, which regenerates `candidates[0]` =
`goauthorpitchdesk.com` — the domain call 1 already registered.

**Verification.** Executed a faithful transcription of both fragments
(`scratchpad/lookalike-proof.mjs`):

```
CALL 1  domains:1 inboxesEach:3 -> [ 'goauthorpitchdesk.com' ]
CALL 2  domains:1 inboxesEach:2 -> [ 'goauthorpitchdesk.com' ]
CALL 2' domains:2 (agent varies) -> [ 'goauthorpitchdesk.com', 'theauthorpitchdesk.com' ]
in-ONE-call wraparound, domains:8 -> [ go…, the…, my…, get…, try…, go…, the…, my… ]
duplicate names inside a single 8-domain call: 3
```

Call 1's output matches the domain actually registered live on 2026-08-04, which validates
the transcription against reality. Vendor-side behaviour is already established by the
incident itself ("retries deterministically hit vendor 'already owned'") — so call 2
reserves $15 at the ceiling, calls `POST /domains/register`, gets `body.error`, throws
`VendorError` (`inboxkit-domain-port.ts:118-120`), releases the reservation, and propagates
to `index.ts:198-199`'s opaque 500. **Zero mailboxes provisioned on call 2**, and the
failure repeats on every retry forever. Note `candidates[domainIndex % candidates.length]`
also buys duplicates *within one call* at `domains >= 6` (cap is 20).

**The class is already solved 100 lines away and was not swept.**
`pickReplacementDomain` (`apps/platform/src/engine/deliverability-actions.ts:100-115`) —
the burn-replacement picker — does exactly the right thing: reads `owned` from the
`domains` table, asks for `owned.size + 4` candidates, takes the first not-owned, and has a
deterministic exhaustion fallback. The primary provisioning path has none of it.

**Why the suites are green:** `SandboxDomainPort.buy` (`apps/platform/src/vendors/sandbox/domain-port.ts:28-32`)
returns unconditional success for any domain, so no fixture can express "already owned",
and **no test anywhere performs two successful `setup_infrastructure` calls on one tenant**
(`admin-terminate.test.ts:104` is the only second call and it asserts a 401).

---

## F2 · BLOCKING · Omitting `registerDomains`/`registrant` on a later call silently WIPES the tenant's persisted consent, permanently disabling burn-replacement

**Lens 4 (arm-time plumbing) + 7 (regression ring).**

`HANDOFF.md` already lists the every-call requirement as a landmine and grades it *"safe
direction: 503, zero buys — but surprising."* That grading is wrong. The profile UPDATE at
`apps/platform/src/engine/provisioning.ts:251-271` runs **before** the try block and
unconditionally overwrites both columns:

```ts
input.registerDomains ? 1 : 0,                                  // -> 0
input.registrant ? JSON.stringify(input.registrant) : null,     // -> NULL
```

zod defaults `registerDomains` to `false` (`intents.ts:78`), so a call that merely omits the
field wipes state. The 503 then comes from `RegistrarUnarmedDomainPort.searchLookalikes`
(`vendors/real/domain-port.ts:36-38`) — after the wipe has committed (the incident's
"brand half-written" is live evidence that these DO writes survive the thrown RPC).

**The damage is not the 503.** `buildAdapters()` (`tenant-do.ts:412`) reads *persisted*
`register_domains` for every other flow. Once wiped:

- The deliverability loop's `REPLACE_DOMAIN` retires the burning domain and releases its
  mailboxes **unconditionally first** (`deliverability-actions.ts:122-140`), then calls
  `pickReplacementDomain` → `searchLookalikes` → `RegistrarUnarmedError` → caught at
  `:207-218` → `REPLACE_DOMAIN_FAILED` logged, replacement withheld. The tenant permanently
  loses capacity with no replacement.
- The founder receives `alertRegistrarUnarmed` naming the env switch — which **is** armed.
  The alert points at the wrong cause and the real cause (a tenant column silently zeroed
  by a routine second setup call) is invisible.

Reachable on Mordy's call 2 the moment his agent doesn't re-send the registrant block.

---

## F3 · BLOCKING · Availability is paid for and then discarded; unavailable candidates are purchased anyway

**Lens 2 + 5 (fixture realism).**

`searchLookalikes` makes **one real `GET /domains/available` round trip per candidate**
(`inboxkit-domain-port.ts:87-92`) and records `{ domain, available }` — and no caller ever
reads `.available`. Not `runSetupInfrastructure` (`provisioning.ts:296-304`), not
`pickReplacementDomain` (`deliverability-actions.ts:107-109`, which filters only against
*our* owned set). So for any brand whose `go<slug>.com` is already registered by a third
party — the common case for a real business name — the very **first** provisioning call
spends latency on the availability probe, ignores the "no", and drives
`POST /domains/register` into a hard `VendorError` → opaque 500 → the customer's first
impression of the product is an internal error.

The sandbox port hardcodes `available: true` (`sandbox/domain-port.ts:20`), so no fixture
can express the unavailable branch. Mordy got lucky: `goauthorpitchdesk.com` was free.

---

## F4 · BLOCKING · `infrastructure_status` hard-500s on any single vendor hiccup, and reports "healthy / send-ready / active" for mailboxes that cannot send

**Lens 3 (live-surface drive) + 7 (truthfulness).**

`getInfrastructureStatus` (`provisioning.ts:386-411`) fans out an unguarded `Promise.all`,
one `getHealth` per mailbox, each of which is **two** live InboxKit calls
(`POST /mailboxes/list` then `GET /email-insights/mailbox/{uid}/health` — `mailbox-port.ts:65-88`):

```ts
const mailboxHealth = await Promise.all(signals.map(async (s) => {
  const vendor = await ctx.adapters.mailbox.getHealth(s.email);   // no try/catch
  ...
}));
```

Any single rejection blanks the whole response into a 500. `resolveMailboxUid`
(`mailbox-port.ts:243-259`) throws a **permanent** `VendorError` when the vendor has no
matching mailbox — so one local row without a vendor counterpart (exactly what a
half-failed saga leaves) makes `infrastructure_status` permanently 500 for that tenant, with
no API path to repair it. This is the one endpoint the tool description tells the agent to
poll.

What it reports when it *does* answer is also not the truth:

| Signal | Source | What it actually proves |
|---|---|---|
| `sendReady` | `isSendReady(day) = day > WARMUP_RAMP_DAYS` (`warmup.ts:22-24`) | Calendar age only. Nothing about DNS, credentials, or the engine. |
| `activationState: 'active'` | `deriveActivationState` (`activation.ts:110-132`) | Env vars set + billing active + no capacity marker. **Zero mailboxes still reads `active`.** |
| `domains` | `SELECT COUNT(*) … WHERE tenant_id = ?` (`provisioning.ts:381-383`) | No `status` filter — released/burning domains still counted (`quota.ts:57` does filter). |
| DNS propagation | *absent* | — |
| Credential-push state | *absent* | — |

---

## F5 · BLOCKING · The OAuth / credential-push leg cannot succeed on a first provisioning, by construction, and fails silently forever

**Lens 4 (deploy/arm-time plumbing) — the "trace the mechanism to a live trigger" class.**

`buildCredentialPushDeps` is the only production wiring
(`apps/platform/src/engine/mailbox-credential-push.ts:60-70`) and it hardcodes:

```ts
const minter: OAuthMinter = new ManualOAuthMinter(parseGrants(env.GMAIL_OAUTH_GRANTS));
```

`InboxKitOAuthMinter` — the "fleet path" HANDOFF says to watch live — has **zero production
construction sites**; grep finds it only in `oauth-mint.ts` itself and
`test/oauth-mint.test.ts`. The live path is therefore manual grants **keyed by mailbox
email** — and those emails (`sender11@goauthorpitchdesk.com`, …) do not exist until the
provisioning that needs them has already run. A first provisioning cannot have grants.

Every push therefore throws at mint time, is swallowed by design
(`maybePushProvisionedMailbox` → `pushRecordedMailbox`, `:107-137`), and the row stays
`pending`. Consequences:

- `mailbox_cred_pushes.status` is read by **nothing** except the reconcile sweep — not
  `infrastructure_status`, not `account`, not `sendReady`, not the tick. The customer sees
  healthy mailboxes that have no credentials on the engine.
- The reconcile has **no attempt cap and no alert** (`:166-180`). It re-runs on every 5-minute
  cron, each attempt burning ≥2 vendor calls per mailbox, indefinitely.
- `showMailboxCredentials` itself is self-documented as `⚠️ UNVERIFIED … a DOCUMENTED-SHAPE
  GUESS to confirm at the first live mailbox` (`mailbox-port.ts:210-211`), so the *other* half
  of the push is also unproven.

Answer to "blocks vs degrades": it degrades, invisibly, in the direction the customer cannot
detect.

---

## F6 · MONEY · Permanent plan-slot leak — the slot is committed before the row that records it exists

`withSpendCeiling(ctx, "mailbox", …)` increments `vendor_slot_state.slots_used` and
**commits** it the instant `mailbox.provision` returns (`spend-ceiling.ts:255-268, 281-300`).
The `slot_counted = 1` marker that teardown uses to give the slot back is only written
*after* two more steps that can throw: `startWarmup` (`provisioning.ts:79-81`) and the
`INSERT INTO mailboxes` (`:84-107`). A failure in between leaves the slot consumed with
nothing on record to release it — `releaseMailboxSlots` counts `slot_counted` rows
(`lifecycle.ts:155-173`), so the leak is permanent.

Compounding: `DEFAULT_INBOXKIT_PLAN_SLOTS = 10` with `slots_used` seeded to 0
(`spend-ceiling.ts:46, 234`) and **no reconciliation against actual InboxKit occupancy**
anywhere in the tree. If the shared workspace already holds mailboxes from testing, the
platform believes it has 10 free slots while the vendor has fewer, and the overshoot
surfaces as an opaque mid-saga vendor error rather than the graceful `capacity_pending`
back-pressure the design promises.

Same failure window strands the mailbox itself at the vendor (bought, warmup possibly
started, invisible to teardown) — cross-referenced to the vendor-stranding sweeper.

---

## F7 · MONEY · Cancel/teardown has no vendor-error isolation, and the retry runs against SANDBOX adapters

`teardownTenant` (`lifecycle.ts:209-245`) loops real vendor releases with no try/catch:
`ctx.adapters.domain.release(...)` at `:218` and `releaseMailboxes` → `ctx.adapters.mailbox.release(...)`
at `:159`. One failure aborts the whole teardown before `teardown_records` is written
(`:266`).

The retry is worse than the failure. `cancelTenant` (`lifecycle.ts:312-332`) flips
`billing_state` to `'canceled'` at `:323` **before** calling teardown at `:330`. That flip
makes `readActivationState` return `activated: false`, so the next `requireContext()` →
`buildAdapters()` hands back the **sandbox** bundle (`tenant-do.ts:389-390`). Sandbox
release succeeds unconditionally — so a second `POST /cancel` marks every domain
`status='released'` and every mailbox `released_at`, writes a `teardown_records` row
claiming N domains and M mailboxes reclaimed, and **never touches InboxKit**. The vendor
keeps billing; the audit record says it doesn't.

The authors knew about the frozen-tenant-reads-sandbox mechanism — `spend-ceiling.ts:376-379`
explicitly de-gates the *slot counter* on adapter kind for exactly this reason. The sibling
(the actual vendor release) was not swept.

Consequence for Mordy today: his tenant has 0 domain rows while `goauthorpitchdesk.com` is
registered on our wallet, so a cancel would release nothing, book
`annualDomainLiabilityCents = 0`, and renew the domain annually forever.

---

## F8 · MONEY/OPS · Nothing anywhere alarms on a failed provisioning

- `buildOpsDigest` returns a hardcoded literal `provisioningFailureCount: 0`
  (`admin/ops-sweep.ts:312`), with the comment at `:284-287` admitting *"'Stuck jobs'
  (provisioning sagas) has no signal to alert on yet … honestly 0 rather than fabricated."*
  A human reading the digest sees "0 provisioning failures" on the day one stranded $12.50.
- The watchtower's only tenant-level probe is `failure_signals` = terminal-failed **sends** +
  complaints (`admin/watchtower.ts:110-136`). A provisioning failure produces neither.
- The only alert paths out of `setup_infrastructure` are `alertRegistrarUnarmed`
  (registrar block only) and `alertCapacityPending` (ceiling/slot only). A `VendorError` —
  the actual incident — reaches `console.error` at `index.ts:198` and stops there.
- No `watchdogAlerts` branch covers `vendor_spend_entries` rows in `status='released'`.

The founder learned about the 2026-08-04 incident by watching, not by being told.

---

## F9 · SECURITY/COMPLIANCE · The sanctions re-screen runs and its verdict is discarded for the rest of the call

`provisioning.ts:272-283` documents its own purpose: *"a tenant could screen-clean at
checkout, then set a sanctioned brand at setup_infrastructure and evade G1 entirely."* The
code then does:

```ts
if (isPaidPlan(ctx.plan)) {
  await screenTenant(ctx, { trigger: "brand_change" });   // return value discarded
}
try {
  const candidates = await ctx.adapters.domain.searchLookalikes(...)   // adapters bound BEFORE the screen
```

`screenTenant` returns a verdict, never throws on a hit, and writes `screening_status`. The
adapter bundle was built in `requireContext()` before any of this, so a `'review'` verdict
does not stop the call: the sanctioned brand still gets domains registered and mailboxes
bought **in that same call**. The gate only bites on the *next* request. The same discard
also means a transient SDN-list outage (fail-closed to `'review'` — `ofac/screening.ts:107-114`;
this has fired live before, see the `OFAC_LIST_URL` HTTP-525 note in `wrangler.toml`) silently
drops the tenant to sandbox adapters on their following call, mid-provisioning-sequence.

---

## F10 · CONFUSION · `jobId`, HTTP 202, and "poll for progress" describe an async saga that does not exist

`newId("job")` at `provisioning.ts:318` and `:332` is never persisted; there is no `jobs`
table, no lookup route, no DO alarm. The function's own doc says so (`:213-216`: *"Runs
synchronously under the hood in B0 … the async resumable saga (DO alarms, retries) is B2
scope"*). Three surfaces contradict it:

- `mcp/tools.ts:67` — *"Async — returns { jobId, billing }; poll infrastructure_status for progress."*
- `routes/infrastructure.ts:15` — HTTP `202`.
- `site/openapi.yaml:88-97` — *"Provisioning started."*

An agent that believes this will poll `infrastructure_status`, see 0/0, and wait for work
that is not running — which is precisely the post-incident behaviour to expect. Meanwhile the
real call blocks for the entire vendor chain (for `domains:1, inboxesEach:3`: register +
2 nameserver calls + 3×(buy + list + warmup/add) + 3×credential-push lookups ≈ 15+ sequential
round trips) inside one Worker request, against Cloudflare's ~100s edge timeout.

---

## F11 · CONFUSION · `quoteOnly` validates none of the things that actually fail

The quote branch returns at `provisioning.ts:247-249`, before the profile write, before the
re-screen, and before `provisionDomainWithMailboxes` — which is where registrant
completeness (`assertCompleteRegistrant`, `:175-176`), registrar arming, the spend ceiling,
the slot counter, and every domain-name decision live. So a quote is unconditionally
optimistic:

```ts
if (input.quoteOnly) {
  return { quoteOnly: true, billing: buildMailboxBilling(ctx, liveProvisioned() + input.domains * input.inboxesEach) };
}
```

For Mordy's call 2 the quote will cheerfully project 5 mailboxes / $99 for a call that
cannot buy a single thing (F1). The tool text sells `quoteOnly` as the "no silent capacity
addition" safeguard; it is a pricing calculator, not a dry run.

---

## F12 · MONEY · Duplicate mailbox rows from an idempotency REPLAY — reachable today on the BYO path

`provisionMailboxesForDomain` inserts unconditionally *after* `withRequestIdempotency`
returns (`provisioning.ts:70-107`), and a replay returns the recorded `ProvisionedMailbox`
without a vendor call. There is **no UNIQUE constraint or index on `mailboxes.email`**
(`schema.ts:185-190`). So a replayed provision writes a second row for the same address, and
`provisionedMailboxCount` (`billing.ts:521-525`) counts rows, not mailboxes — so
`syncMailboxQuantity` pushes an inflated Stripe quantity.

The lookalike path is currently shielded from this only because the domain buy throws first
(F1). The BYO path is not: `requestManagedByoMailboxes`
(`byo-mailbox-composition.ts:52-60`) passes a **constant** `domainKey: byo:<domain>#<domainId>`
and `domainOrdinal: 0`, and local parts are `${personaSlug}${ordinal+1}${index+1}`
(`provisioning.ts:52`). Calling `request_managed_mailboxes` twice with the same count on the
same BYO domain produces identical local parts, identical idempotency keys, zero vendor
calls, N duplicate rows, and a Stripe quantity of 2N for N real mailboxes.

---

## Non-blocking

- **N1** `isRealSpendArmed` (`billing.ts:67`) ANDs `REGISTRAR_PROVIDER && CLOUDFLARE_REGISTRAR_API_TOKEN`,
  but `env.ts:77` documents the latter as *"reserved-but-inert"* and the real gate
  (`isInboxKitRegistrarArmed`) reads only `REGISTRAR_PROVIDER`. The registrar clause of the
  spend-armed guard is therefore dead in production; the guard holds today only via the
  InboxKit clause.
- **N2** `RegistrarUnarmedError`'s message (`packages/shared/src/errors.ts:69-75`) tells the
  operator to set `REGISTRAR_PROVIDER + CLOUDFLARE_REGISTRAR_API_TOKEN`. It is founder-facing
  in the ops alert and names a variable that has no effect — costly minutes during an incident.
- **N3** `scheduled.ts:5-7` says the cron trigger *"is commented-out in wrangler.toml"*.
  `apps/platform/wrangler.toml:108` has `crons = ["*/5 * * * *"]` armed. Stale comment in the
  file that documents the platform's only production driver.
- **N4** `setDns`'s return value is discarded (`provisioning.ts:187`) and no DNS state is ever
  persisted for a provisioned domain (`dns_mode` is documented NULL for them, `schema.ts:137-138`;
  `first_send_eligible_at` NULL means no gate). InboxKit's propagation check runs **once**,
  seconds after registration, when it can only be `false`. The BYO path has `pollByoDomainDns`
  with a 7-day idle timeout; the lookalike path has no poll, no timeout, no state, and no
  customer-visible signal — which is why the live `dns_propagation_status: "pending"` on
  `goauthorpitchdesk.com` is invisible to the platform.
- **N5** `runSetupInfrastructure` calls `syncMailboxQuantity` only on success (`:329`) and on
  `CapacityPendingError` (`:317`), not on the generic error path — unlike
  `applyReplaceDomain`, which uses `finally` (`deliverability-actions.ts:219-225`). Self-heals
  within 5 minutes via `deliverabilitySweep` (`tenant-do.ts:803`), so drift is bounded.
- **N6** Reserve-reap TTL is 15 min (`spend-ceiling.ts:54`) while the idempotency claim TTL is
  10 min (`idempotency.ts:26`), and `idempotency.ts:16-25` sizes the latter against *"up to
  ~156 sequential real vendor calls"*. A long-running saga can have its live reservation reaped
  underneath it; the later commit re-adds `committed_cents` but never re-increments
  `slots_used`, leaving the slot counter under-counted (over-provisioning direction).

---

## Attacks that FAILED (why a finding is not here)

- **Cron sweep racing a live saga into a spurious burn/pause.** `evaluate` skips every
  mailbox and domain below `thresholds.minSampleSends` (`deliverability.ts:191, 209`). A
  half-provisioned tenant has zero sends, so the loop is a no-op. Held.
- **Stripe billing left wrong after a failed provisioning.** `billableMailboxes` floors at 5
  and Mordy's plan totals 5, so `desired` never drifts on his path; and any drift is repaired
  by `syncMailboxQuantity` inside the 5-minute `deliverabilitySweep` (`tenant-do.ts:798-803`).
  Set-to-N is absolute, so a missed or duplicated push self-heals. Held (see N5 for the
  bounded window). Worth stating plainly though: the floor means a tenant who provisions
  **nothing** is still billed $99/mo, and no code path credits that.
- **`withSpendCeiling` double-reserve / TOCTOU under two concurrent provisions.** Both the $
  reserve (`:239-247`) and the slot reserve (`:256-259`) are single conditional UPDATEs with
  the predicate inside the statement; the slot-reject path rolls the $ reserve back
  (`:261-264`). Attacked, held.
- **`resolveMailboxUid` acting on the wrong mailbox.** Reconstructs `username@domain_name`
  and requires case-insensitive equality before returning a uid (`mailbox-port.ts:251-257`),
  so a fuzzy keyword match fails loud rather than releasing someone else's mailbox. Held.
- **Demo/free tenant reaching real spend through the quote or the registrar re-selection.**
  `createVendorAdapters` checks `isDemoOrFree` first and unconditionally
  (`factory.ts:150, 163`), and `selectSetupDomainPort` returns the bundle's own port
  untouched unless `bundle.kind === "real"` (`tenant-do.ts:489-501`). Held.
- **Two-leg registrar decouple bypassable from the request body.** `selectRealDomainPort`
  requires `armed && optIn` (`factory.ts:213-220`); the env leg is read from `env`, never from
  input. A call claiming `registerDomains: true` on an unarmed deployment still gets the hard
  block. Held.
- **`assertWithinProvisioningCap` bypass by repeated small calls.** It counts existing live
  rows and adds the request (`quota.ts:56-75`), so it is cumulative. Held.

---

## UNVERIFIABLE (needs credentials / a live vendor call this review was not authorised to make)

1. **Actual InboxKit slot occupancy vs `vendor_slot_state.slots_used`.** The brief's "~5 of 10
   used by nothing" cannot be confirmed from the repo. Resolve with a read-only
   `POST /mailboxes/list` count against workspace `c5188ced…` and compare to the D1 row.
2. **Whether `INBOXKIT_PLAN_SLOTS` is set in production.** Not in `wrangler.toml [vars]`, so
   the code default of 10 applies unless it is a secret. Resolve with `wrangler secret list`.
3. **Whether `/mailboxes/buy` succeeds on a domain whose nameservers have not propagated.**
   Determines whether F-N4 is cosmetic or a first-provisioning blocker. Resolve at the next
   live provisioning.
4. **`showMailboxCredentials`'s real endpoint path and response shape** — self-declared
   UNVERIFIED in the adapter. Resolve at the first live mailbox.
5. **The exact throw site of the 2026-08-04 incident.** Owned by the incident-diag lane; this
   review deliberately did not re-derive it.
*(Item 6 resolved during the review and moved out of this list — see the suite result below.)*

**Suite result (read-only, HEAD `5c9f587`):** `npx vitest run` → **125 files / 1157 tests
passed, 0 failed, 908.77s.** Every finding above is present at this commit. A fully green
1157-test suite is exactly the condition this review exists to distrust: the sandbox ports
return unconditional success for `domain.buy`, `available`, and `cancelWarmup`, and no test
performs two successful `setup_infrastructure` calls on one tenant, so the primary
provisioning path's central defects are unrepresentable in fixtures. The suite is not
evidence of pipeline health; it is evidence of fixture optimism.

---

## Leg-by-leg completeness

| Leg | Verdict |
|---|---|
| Quote path (`quoteOnly`) | **DEFECTIVE** — F11 |
| Lookalike generation / collision / exhaustion / second call | **DEFECTIVE** — F1, F3 |
| DNS / nameserver leg | **DEFECTIVE** — N4 |
| Mailbox buy + slot math + plan quota | **DEFECTIVE** — F6; quota guard itself held |
| Warmup add | **DEFECTIVE** — F6 (orphan warmup on a stranded mailbox); cancel-sweep path not re-attacked (shipped 2026-08-02) |
| OAuth / fleet mint | **DEFECTIVE** — F5 |
| `infrastructure_status` truthfulness | **DEFECTIVE** — F4 |
| Billing interplay | **SOUND with a caveat** — self-heals; the $99-for-nothing floor is a policy question, not a bug |
| Registrar opt-in semantics | **DEFECTIVE** — F2 |
| Concurrency (two calls, cron race, input gate) | **PARTLY DEFECTIVE** — cron race held; two keyless concurrent calls have zero protection (`idempotency.ts:69`) and collide via F1 |
| Alerting / observability | **DEFECTIVE** — F8 |
| Compliance re-screen | **DEFECTIVE** — F9 |
| Teardown / recovery | **DEFECTIVE** — F7 |
| Duplicate-row / over-billing | **DEFECTIVE** — F12 |

**Cleared as sound:** spend-ceiling atomicity, the two-leg registrar decouple,
demo/free structural exclusion, exact-match uid resolution, the provisioning cap's
cumulative arithmetic, and the deliverability sweep's minimum-sample guard.
