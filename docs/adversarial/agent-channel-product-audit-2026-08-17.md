# Agent-channel product-readiness audit — 2026-08-17

Founder-ordered adversarial audit of coldrig's operator↔customer-agent communication loop
and the stalled-domain recovery path.

**Verdict: `PRODUCT-READY: NO`.**

---

## Grounding

| Item | Value |
|---|---|
| Audited ref | `1e4c9732ff067b927efad1054c3b9237a453d52b` (main) |
| Deployed Worker | `a507f12a` = `a981163` |
| `git diff a981163..1e4c973 -- apps/platform/src apps/platform/migrations` | **empty** — the audited source is byte-identical to what is deployed |
| Worktree | clean for `apps/platform/src`; per-file `git hash-object` vs `git rev-parse HEAD:<path>` re-verified at audit close for all 7 finding-bearing files |
| Excluded | `feat/admin-messages-read-2026-08-17` (parallel builder), per brief |

Live probes were **GET-only** (`/admin/ops/checks`, `/admin/ops/digest`, `wrangler secret list`).
No state-changing call was made against production. Executable probes ran in a throwaway
clone at `/private/tmp/.../scratchpad/audit-clone`, driving the real production entry-point
composition (`withRequestIdempotency(ctx, "setup_infrastructure:<key>", () =>
runSetupInfrastructure(...))`, i.e. `tenant-do.ts:722-740`).

### Live ground truth (GET `/admin/ops/checks`, 2026-08-17)

```
unhealthyCount 2
domain_dns_aging:goauthorpitchdesk.com   healthy=false
  "Domain goauthorpitchdesk.com (tenant ten_91aab24a-...) has had un-ready mail DNS for 504h.
   It is past the point where propagation explains it. It was paid for and no mailbox will
   come up on it until it is replaced."
mailbox_provisioning:mordytee11@theauthorpitchdesk.com   healthy=false
  "a purchase is on record but the provider could not be asked what it holds — no re-buy
   authorized (1 dispatch(es) so far)"
domain_dns_aging:theauthorpitchdesk.com  healthy=TRUE
  "Domain theauthorpitchdesk.com (tenant ten_91aab24a-...) now has working mail DNS."
```

Two corrections to the brief's premise, both load-bearing:

1. **The two domains are NOT in the same state.** `theauthorpitchdesk.com`'s aging alert has
   been *cleared* — it left `agingPendingDomains` (`ops-summary.ts:370-383`, which requires
   `dns_status != 'ready'`), so its DNS is ready. What is stuck on it is the *mailbox*
   (`mordytee11@`, verdict `unconfirmed`/`lookup_failed`). Only `goauthorpitchdesk.com` is
   DNS-stalled.
2. **`gaveUp` is FALSE on `goauthorpitchdesk.com`.** `watchtower.ts:271-273` prints
   *"The platform has GIVEN UP on it"* when `dns_gave_up_at` is set; the live text is the
   other branch. So `dns_gave_up_at IS NULL`, and `dns_first_checked_at IS NULL` too — the
   504h figure can only come from the `purchased_at` fallback (`ops-summary.ts:392`), since
   the column was added by `addColumnIfMissing` (`tenant-do.ts:384-389`) as NULL on
   2026-08-14 and anything stamped since would read ≤72h.

---

## Q1 — what `setup_infrastructure` with key `apd-setup-a-2mbx` does TODAY

**Answer: (a) it resumes/attaches to the existing domains and keeps waiting — and in the
most likely live branch it does not even do that, it replays a cached HTTP 202 and performs
zero work. It never replaces anything.**

Traced path, per `file:line`:

1. `tenant-do.ts:722-740` — wraps the saga in
   `withRequestIdempotency(ctx, "setup_infrastructure:apd-setup-a-2mbx", …)`.
2. `idempotency.ts:78-81` — **if a row for that key exists with `status='done'`, the stored
   `response_json` is returned and `fn` is NEVER RUN.** Rows live 30 days
   (`REQUEST_IDEMPOTENCY_TTL_MS`, `idempotency.ts:9`); the domains are 21 days old, so a
   pre-fix `done` row is still inside the replay window.
3. If `fn` does run: `provisioning.ts:415` `planProvisioning` reads the ordinal-derived
   intents (`provision-intents.ts:136-138`). Both ordinals have `committed` intents resolving
   to live domain rows ⇒ `newDomains: 0`, so `assertWithinProvisioningCap` passes and no
   candidate is bought.
4. `provisioning.ts:590` — a satisfied ordinal uses its own recorded domain, never a fresh
   candidate.
5. `provisioning.ts:243-272` — `provisionDomainWithMailboxes` takes the RESUME branch:
   `dns_status !== 'ready'` ⇒ `setDnsWithRetry` (`:262`), and the throw there gates the
   mailbox buy on `:264`.
6. `domain-dns.ts:386` `recordDnsObservation` **COALESCEs `dns_first_checked_at` to NOW.**
   With the live NULL anchor, `pendingForMs` (`:405`) computes as **0**, so the 6h bound at
   `:406-419` does not fire.
7. `domain-dns.ts:451-453` — benign branch matches ⇒ `DomainPropagationPendingError`.
8. `provisioning.ts:642` — the 202 SUCCESS-PENDING branch requires
   `inFlightOrdinal === input.domains - 1`. `goauthorpitchdesk.com` is a non-terminal ordinal
   ⇒ falls through to `:678`, which emits an `action_required` `retry_setup` message and
   **throws**.

### Executed probe (5 arms, real entry point)

`scratchpad/audit-clone/apps/platform/test/zz-audit-q1-crux.test.ts`

| Arm | Seeded state | Outcome |
|---|---|---|
| **A** | key row `status='done'` | **RETURNED the cached `{provisioning:"pending", pendingDomain:"goauthorpitchdesk.com"}`. `domain.buy=[] setDns=[] mailbox.provision=[]`. `tenant_messages` = `[]`. `infrastructure_status` after = `{domains:2, mailboxes:0, sendReady:false, messages:[]}`.** Zero work, zero signal. |
| **B** | no key row, anchor NULL (the live shape) | THREW retryable `VendorError`: *"…DNS has not finished propagating yet… Nothing was lost — retry to finish it."* `dns_gave_up_at` still **NULL**; anchor stamped at NOW. `setDns=[D0,D0]`, `mailbox.provision=[]` — **ordinal 1 never reached.** |
| **B2** | second retry immediately after B | Identical retryable answer, `dns_check_count=2`, `dns_gave_up_at` still NULL. |
| **C** | anchor already 504h old | Correctly THREW non-retryable *"Retrying will not help — this domain needs to be replaced; contact support."* `dns_gave_up_at` stamped. **`tenant_messages` = `[]`.** |
| **D** | D0's DNS recovers | Progresses to the mailbox leg, then throws retryable on the stuck mailbox. |

**No arm buys a replacement domain. No arm produces a mailbox.**

---

## Q2 — is there a replacement path the customer's agent can invoke?

**Answer: NO. The product tells the customer a replacement is needed and offers no way to do it.**

- All 28 MCP tools enumerated at `mcp/tools.ts:71-378`. There is no `replace_domain`,
  no `release_domain`, and no replacement parameter on `setup_infrastructure`
  (`SetupInfrastructureToolInput`, `mcp/schemas.ts`).
- `setup_infrastructure` **cannot** replace: a `committed` intent at an ordinal always
  resolves to the existing domain (`provisioning.ts:243-272`); raising `domains` reaches a
  *higher, empty* ordinal and buys an ADDITIONAL domain — the dead one stays, and (see F1b)
  still blocks the loop.
- `REPLACE_DOMAIN` exists but is **unreachable from a DNS stall**: it fires only from the
  deliverability control loop's burn thresholds (`deliverability.ts:52-62`, `burnBounceRate`
  0.15 domain-wide), which require SENDS. A domain with 0 mailboxes has 0 sends.
- `remove_mailboxes` releases *mailboxes* (there are none). `configure_byo_domain` is for
  customer-owned domains.
- `domain-dns.ts:491` states the design intent explicitly: *"Deliberately NOT a re-buy: this
  wave adds no automatic spend path."*
- Discoverability: the only place the word "replaced" reaches a customer is the terminal
  error string (`domain-dns.ts:396,417`), which says **"contact support"** — and even that
  string is only produced in ARM C, which is not the live state. No `actionHint`, no tool
  description, and no `docs/for-agents` surface names a replacement action.

The **only** working recovery today is `contact_operator` → a human → a manual vendor-side
fix. That is not stated anywhere the agent will find it.

---

## Q3 — was our operator reply correct and useful?

**Answer: NO on both counts, and one of its two claims is factually wrong about the code.**

Our reply (2026-08-14) told the agent: *"retry the same idempotency key, it is spend-safe
— the vendor-verdict class fix (e5598da) made the idempotency key actually gate domain
generation."*

1. **The mechanism claim is false.** `tenant-do.ts:725-738` states the opposite in terms:
   *"The caller's key gates RESPONSE REPLAY ONLY. It has not seeded the durable domain-intent
   rows since `85f48af`… It deliberately has NO say in what gets bought."* Spend-safety comes
   from the ordinal-derived `domainIntentKey` (`provision-intents.ts:136-138`), which holds
   **whether or not a key is sent**. The tool description already says this correctly
   (`tools.ts:74`: *"The key controls response replay only and has no bearing on what is
   purchased"*).
2. **The advice is at best a no-op and at worst actively harmful.** Because the key gates
   *replay*, telling the agent to reuse the SAME key is the one instruction that can
   guarantee nothing happens (ARM A). Reusing a *different* key, or omitting it, is what
   would actually re-run the saga — the exact inverse of what we said.
3. **Even in the best case it makes no progress toward mailboxes** (ARM B): one retryable
   error, the anchor reset to zero, ordinal 1 never reached, 0 mailboxes.

### What the reply SHOULD have said, given main today

> `goauthorpitchdesk.com`'s registration never came up at our registrar and it will not
> recover on its own. Do **not** reuse `apd-setup-a-2mbx` — that key only replays your
> original response and performs no work. There is no self-serve way to replace the dead
> domain; we are replacing it by hand and will message this account when it is done.
> `theauthorpitchdesk.com`'s DNS is fine — its mailbox purchase is unresolved at the
> provider and is also on us. No further action from you, and nothing you do can be
> double-charged.

---

## Q4 — the 6h bounded-pending mechanism, and can the class bug recur?

**Answer: give-up has NOT fired, `infrastructure_status` reports nothing at all about it,
and yes — the original class bug recurs through the replay path.**

- **Has give-up fired?** No. `dns_gave_up_at IS NULL` (proven from the live watchtower text
  taking the non-`gaveUp` branch, `watchtower.ts:271-273`).
- **Can it fire on the next retry?** No. The anchor is NULL, and `recordDnsObservation`
  (`domain-dns.ts:467-481`) COALESCEs it to NOW, so `pendingForMs = 0` on the first
  post-deploy observation. The customer needs: retry → wait ≥6h → retry again, before the
  platform will tell the truth. Probe ARM B and ARM B2 confirm this over two calls.
- **The two surfaces disagree, right now, about the same domain.** `ops-summary.ts:370-383`
  deliberately added a `purchased_at` third disjunct so the *founder* alert covers the
  pre-deploy population — but `domain-dns.ts:405` has no equivalent fallback. Result:
  the watchtower says *"past the point where propagation explains it… needs replacing"*
  while `setup_infrastructure` tells the paying customer *"Nothing was lost — retry to
  finish it."*
- **What does `infrastructure_status` report?** `{ domains: 2, mailboxes: 0, sendReady:
  false, mailboxHealth: [], messages: [...] }`. `infrastructure-status.ts:98-103,167-176`
  returns a bare domain **count**. There is **no per-domain entry and no `dns` field at
  all** — so it can report neither "in progress" nor "terminal" about a specific domain. It
  is not lying; it is silent.
- **Does the class bug recur through this path? YES.** In ARM A the agent receives
  `provisioning: "pending"` — a SUCCESS — from a cached row, forever, with
  `infrastructure_status.messages` **empty**. That is precisely the shape the vendor-verdict
  wave was built to kill (`domain-dns.ts:24-34`: *"returned HTTP 202 `provisioning:"pending"`
  — a SUCCESS — on every subsequent call, forever. Paid domain, zero mailboxes"*). The wave
  closed it inside the saga and left it open in front of the saga.

---

## Findings

### BLOCKING-for-product

**F1 — `withRequestIdempotency` turns the system's own retry instruction into a guaranteed
no-op, resurrecting the eternal-"pending" class bug.**
`idempotency.ts:78-81` replays a `done` response without running `fn`. The 202 SUCCESS-PENDING
branch (`provisioning.ts:657-662`) RETURNS, so it records `done`. The `retry_setup` message
body it emits on the way out (`retry-setup-message.ts:24`) hard-codes *"retry
setup_infrastructure with the same idempotency key to finish it"* — the one action that
cannot work after that branch. **Failure scenario:** any tenant whose setup ended in a 202
pending follows the platform's own `actionHint` and receives a stale 202 with zero vendor
calls and an empty `messages[]`, indefinitely. **Verification:** probe ARM A, real entry
point — `domain.buy=[] setDns=[] mailbox.provision=[]`, `tenant_messages=[]`,
`infrastructure_status.messages=[]`.
*Live-state caveat:* whether tenant `ten_91aab24a`'s specific key row is `done` is not
readable from outside the DO (see UNVERIFIABLE-1). The contradiction is structural and holds
regardless.

**F1b — one un-completable domain permanently blocks every later ordinal, with no way to
skip it.** The provisioning loop is sequential (`provisioning.ts:585-613`) and each ordinal's
DNS throw gates the mailbox buy (`provisioning.ts:262-264`). **Failure scenario:** ordinal 0
= `goauthorpitchdesk.com` (dead) ⇒ ordinal 1's ready domain never gets its mailbox, forever.
Combined with Q2 (no replacement path), the tenant is permanently pinned at 0 mailboxes while
being billed. **Verification:** probe ARM B — `setDns=[D0,D0]`, `mailbox.provision=[]`,
D1 never touched.

**F2 — the product tells the customer a domain "needs to be replaced" and ships no
replacement path.** `watchtower.ts:274`, `domain-dns.ts:396,417`. All 28 tools enumerated
(`mcp/tools.ts:71-378`); `REPLACE_DOMAIN` requires burn thresholds that need sends
(`deliverability.ts:52-62`) which a 0-mailbox domain can never reach. **Verification:**
tool-surface enumeration + trigger trace; probe arms A-D never replace anything.

### MAJOR

**F3 — the terminal give-up is the ONE outcome that emits no tenant message.**
`provisioning.ts:678` gates the emit on `err.retryable`; `DomainDnsTerminalError` is
`retryable:false` (`errors.ts:115-119`). The only outcome requiring human action reaches the
agent solely as the HTTP body of that single call — nothing durable, and (F6) the operator
has no read-back either. **Verification:** probe ARM C — non-retryable throw,
`dns_gave_up_at` stamped, `TENANT MESSAGES: []`.

**F4 — `setup_infrastructure`'s tool description promises a field that does not exist.**
`tools.ts:74`: *"A domain whose DNS setup has not finished yet is still returned by
infrastructure_status with its dns state pending and can be completed by retrying — it is
never lost."* `infrastructure-status.ts:98-103,167-176` returns only `domains: <count>`;
there is no per-domain object and no `dns` field anywhere in `InfrastructureStatus`. The
second half is also false past the 6h bound (`domain-dns.ts:411-418`). **Verification:**
type + probe — `INFRASTRUCTURE_STATUS AFTER: {"domains":2,"mailboxes":0,...}`.

**F5 — the out-of-band reconcile that exists precisely to finish these domains is DARK in
production.** `provisioning-reconcile.ts:12-15` ships behind `PROVISIONING_RECONCILE_ENABLED`.
**Verification:** `wrangler secret list` returns 10 secrets, not including it, and it is
absent from `wrangler.toml`'s `[vars]`. Nothing finishes a stalled setup without the agent.

**F6 — no operator-facing read of `tenant_messages` exists on main.** `admin-messages.ts:17`
is `.post` only; a tree-wide grep for `tenant_messages` finds no other reader outside
`engine/tenant-messages.ts`. `ackMessage` writes `read_at` (`tenant-messages.ts:308`) and
nothing operator-side ever reads it. The operator cannot tell whether a reply was delivered,
read, or acted on — which is exactly why this audit needed a sandbox to answer Q1.

**F7 — a genuine `contact_operator` follow-up is silently swallowed as a duplicate.**
`contact-operator-guard.ts:126` dedups on exact `(body, urgency)` over a 1-hour window. Two
distinct asks with identical short text ("Any update?") 50 minutes apart collapse into one
ticket; the agent still receives `201` + *"Recorded for the operator. Their reply will
arrive…"* while the operator sees nothing. **Verification:** probe 2 — call 2 returned
`{"kind":"duplicate","ticketId":"sup_bdeaf511-…"}` (same id as call 1).

**F8 — the product assumes a polling daemon that customers do not run.** Webhook event types
are `reply|bounce|soft_bounce|complaint|unsubscribe` (`shared/src/webhooks.ts:21`) — there is
**no message/operator-message event**, so there is no push path for an operator reply. The
agent-facing docs (`AGENTS.md:85`, `site/for-agents.html`) say to poll
`infrastructure_status` "until ready" but never tell an agent to check for operator messages
after a run, and set no latency expectation. `contact_operator`'s own description
(`tools.ts:371`) says *"The operator's reply arrives as a message on THIS account (poll
list_messages / infrastructure_status.messages[])"* — addressed to an agent that, for
session-based customers, is not running when the reply lands. This is why our 2026-08-14
reply has sat unread for three days.

**F9 — an operator reply can be pushed out of `infrastructure_status`'s newest-5 preview by
system-message churn.** `tenant-messages.ts:194-209` orders by `created_at DESC LIMIT 5`, and
`emitTenantMessage`'s dedup branch (`:90-99`) **re-stamps `created_at = now`** on every
re-trigger. With ≥5 domains each refreshing a per-domain `retry_setup`, the operator's older
reply falls off the inline list — while `tools.ts:86` tells the agent *"poll this alongside
the mailbox fields so you never miss one."* **Verification:** probe 2 — with 6 domains the
inline list held 5 system messages and zero operator messages; `list_messages` still had it.
*Not reachable for `ten_91aab24a` at 2 domains; reachable at Scale tier (18-domain cap).*

### MINOR

**F10 — the aging-alert clear asserts "now has working mail DNS" unconditionally.**
`watchtower.ts:280-286` clears whenever the domain leaves `agingPendingDomains` for ANY
reason. That query also requires `status='active'` and `source='provisioned'`
(`ops-summary.ts:373`), while the ownership guard reads `provisionedDomainNames`, which is
**not** status-filtered (`ops-summary.ts:396-399`). A released/burning domain therefore
clears its own alert with a false claim. (For `theauthorpitchdesk.com` the claim appears to
be TRUE — `dns_status='ready'` — so this is latent, not live.)

**F11 — `severity` is undefined-by-convention.** `tenant-messages.ts:20`
(`type TenantMessageSeverity = string`) with no DB constraint; the comment claims *"Both real
emit points use 'action_required'"*, which `provisioning.ts:651` (`severity: "info"`) already
contradicts. An agent cannot safely branch on it.

---

## Attacks that FAILED (why the above list is not longer)

| Lens | Attack | Why it held |
|---|---|---|
| A1 expiry | *Can an unread operator reply silently expire out of both surfaces?* | No. `expires_at` is honoured by both readers (`:200`, `:250`) but **no emit site anywhere sets `expiresAt`** — grepped all 4 call sites (`provisioning.ts:650,680`, `mailbox-credential-push.ts:187`, `tenant-messages.ts:150`). `emitOperatorMessage` passes neither `expiresAt` nor `dedupKey`, so an operator reply always INSERTs a fresh, never-expiring row. |
| A1 prune | *Does `pruneTenantMessages` reap an unread operator message?* | No. `:321-327` deletes only expired rows or READ rows older than 30d. An unread, unexpired row is untouchable. |
| A2 hint | *Is the `actionHint` malformed / not machine-followable?* | It held: `{"tool":"setup_infrastructure","idempotencyKey":"apd-setup-a-2mbx"}` round-trips through `JSON.parse` (`:177`) and matches the `list_messages` description verbatim. The hint is *well-formed*; the defect is that following it doesn't work (F1). |
| A4 isolation | *Cross-tenant `ack_message` leak?* | No. `ackMessage:302-308` scopes by `id + tenant_id` in BOTH the existence check and the UPDATE; a foreign id raises the same `NotFoundError` as an unknown one — no existence oracle. |
| A4 idempotency | *Double-ack anomaly?* | No. Probe 2 — `ack1 {"acked":true,"alreadyAcked":false}`, `ack2 {"acked":true,"alreadyAcked":true}`, one `read_at`. |
| A3 truncation | *Can a long agent message be silently truncated?* | No. `ContactOperatorInput` caps body at 2000 chars via zod (rejects, never truncates) and the transport cap is `SMALL_BODY_MAX_BYTES` 8 KiB (`validate.ts:14`) — a 400, not a silent cut. |
| A3 storm | *Can the ops-email throttle drop a held message's text?* | No. Held bodies ride along on the next successful send (`contact-operator-guard.ts:149-160`) and `releaseEmailClaim` puts them back on send failure (`:227-237`). |
| Q1 spend | *Does the retry re-buy a domain (double-charge)?* | No, and this is genuinely solid. `planProvisioning` (`:90-123`) zeroes `newDomains` for satisfied ordinals; the resume branch (`:243-272`) skips `buy` entirely. Probe arms A-D: **`domain.buy` empty in every arm.** The "spend-safe" half of our operator reply is correct — just for a different reason than we gave. |
| Q1 ordinal | *Could a retry re-key onto a different domain?* | No. `domainIntentKey` is `tenant:<id>#<ordinal>` (`provision-intents.ts:136-138`), independent of the caller's key — verified against `legacy-domain-intent-keys.ts`'s rebind path. |
| Q4 schema | *Did the new DNS-bound columns fail to reach pre-existing DOs (which would explain the NULL anchor as a migration bug)?* | No — `tenant-do.ts:384-389` `addColumnIfMissing` runs on every DO boot. The NULL is correct-by-design, which is what makes F-Q4 a *design* gap, not a migration bug. |

---

## UNVERIFIABLE

1. **Whether `request_idempotency['setup_infrastructure:apd-setup-a-2mbx']` is `done` for
   `ten_91aab24a`** — i.e. whether F1 is live for this tenant today, or only the class-level
   defect. No admin endpoint reads DO storage (F6 is the same gap). **Resolution:** a
   read-only admin endpoint (or one `wrangler d1`-equivalent DO read) exposing
   `request_idempotency` + `domains` + `domain_intents` for one tenant. Both branches are
   broken (ARM A = silent no-op, ARM B = 6h of "retry to finish it"), so the verdict does not
   depend on it — but the *wording of the next operator reply* does.
2. **Which ordinal each domain occupies** (`tenant:<id>#0` vs `#1`). Same resolution. If
   `goauthorpitchdesk.com` is the LAST ordinal, the 202 SUCCESS-PENDING branch
   (`provisioning.ts:642`) becomes reachable and F1 fires on every future call by
   construction, not just from a stale row — which would raise F1 from likely to certain.
3. **Whether `theauthorpitchdesk.com`'s `dns_status` is genuinely `'ready'`** or whether its
   alert cleared through F10's false-claim path. Same resolution.

---

## Prioritized fix list

1. **Give the agent a way out of a dead domain** (closes F2, F1b). Cheapest honest shape: a
   `replace_domain` tool (or a `replaceDomains: [...]` parameter) that marks the ordinal's
   intent superseded so the next `setup_infrastructure` buys a fresh candidate at that
   ordinal. Until it exists, **name `contact_operator` explicitly in the terminal message
   body and in the `actionHint`** — that is a one-line change and is today's only real path.
2. **Stop telling agents to reuse a key that replays** (closes F1). Either (a) make the
   SUCCESS-PENDING branch NOT record `done` (leave the key reclaimable), or (b) change
   `retry-setup-message.ts:21,24` + `actionHint` to say *"retry with a NEW idempotency key"*.
   (a) is the root-cause fix; (b) is the same-day mitigation. Do not ship (b) alone.
3. **Make the 6h bound cover the NULL-anchor population** (closes the Q4 divergence): give
   `domain-dns.ts:405` the same `purchased_at` fallback `ops-summary.ts:377` already has, so
   the customer-facing verdict and the founder alert cannot disagree about the same domain.
4. **Emit a tenant message on terminal give-up** (closes F3) — move the emit in
   `provisioning.ts:678` above the `retryable` gate, with a `kind: "setup_failed"` /
   `severity: "action_required"` and an `actionHint` pointing at `contact_operator`.
5. **Put per-domain state in `infrastructure_status`** (closes F4): a `domains: [{domain,
   dnsStatus, gaveUp, mailboxes}]` array, or delete the tool description's claim.
6. **Arm `PROVISIONING_RECONCILE_ENABLED`** (closes F5), or state in the docs that stalled
   setups require an agent retry. Note the arming decision carries real spend
   (`provisioning-reconcile.ts:13-15`) and is founder-gated.
7. **Ship an operator read surface** (closes F6) — the parallel
   `feat/admin-messages-read-2026-08-17` branch addresses exactly this; also unblocks
   UNVERIFIABLE-1..3 if it exposes `domains`/`request_idempotency`.
8. **Push operator messages** (closes F8): add an `operator_message` webhook event type, and
   document a "check `list_messages` at session start" contract in `AGENTS.md` /
   `site/for-agents.html`.
9. **Loosen `contact_operator` dedup** (closes F7): key on `(body, urgency)` within ~5
   minutes rather than an hour, or return a distinguishable `note` when deduping so the agent
   knows its follow-up was collapsed.
10. **Sort the inline preview unread-operator-first** (closes F9), and re-check `dns_status`
    before printing "now has working mail DNS" (closes F10).

---

## Probe artifacts

- `scratchpad/audit-clone/apps/platform/test/zz-audit-q1-crux.test.ts` — Q1 five-arm probe.
- `scratchpad/audit-clone/apps/platform/test/zz-audit-channel.test.ts` — A1/A3/A4 probe.

Every probe assertion is written as the CORRECT behaviour, so each fails as the finding today
and will pass unmodified as the closure gate.
