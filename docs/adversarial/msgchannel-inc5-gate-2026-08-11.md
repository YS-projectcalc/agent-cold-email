# Adversary gate — msgchannel Inc5, agent→operator contact channel (2026-08-11)

**Branch** `msgchannel-inc5-2026-08-11` · **HEAD** `9c22b076f8671373435b91752b6bb68994bbdbb3`
(`git rev-parse HEAD` at review start; worktree clean, `git status --porcelain` empty).
**Base** `main` @ `c60cb1a` — verified an ancestor of HEAD (`git merge-base --is-ancestor`),
so the stale-base count-drift class does not apply this round.
**Reviewed diff** `git diff main...HEAD` — 56 files, +868/−118.
**Git discipline** read-only throughout (`rev-parse`/`status`/`log`/`show`/`diff`/`archive`).
All execution happened in two throwaway sandboxes built with `git archive HEAD | tar -x`
plus symlinked `node_modules`; the shared worktree was never written to except for this file.

**Rounds:** 1.

---

## VERDICT — **NO-SHIP** (1 BLOCKING)

The increment is well-built almost everywhere: the migration is genuinely backward-safe, the
RealClock discipline is real and I proved it by execution, tenant isolation holds, the
HTML/MIME surface resists injection, and the openapi/claim-surface sweep is clean including
the `$ref`-resolution layer that escaped a prior sweep here.

But the storm guard — the single feature that this channel's whole safety case rests on, the
one the brief frames with "the founder once got 160 alert emails" — **is not atomic, and it
fails open.** Driven through the production HTTP path, 100 concurrent `contact_operator`
calls from ONE tenant produced **96 support tickets and 96 ops emails** against a designed
cap of 5 tickets/hour and roughly one email per 10 minutes. The cry-wolf incident this guard
exists to prevent is directly reproducible by the feature that introduces the guard.

This is not a harness artifact. Two pre-existing sibling guards in the same codebase, under
the identical 100-way parallel attack in the identical harness, hold perfectly.

**Battery re-run independently** (sandbox at `/private/tmp/.../scratchpad/inc5-sandbox`):

```
apps/platform  npx vitest run   →  Test Files 167 passed (167)   Tests 1547 passed (1547)
npm run typecheck (root)        →  dashboard / engine / platform / agent-cold-email / shared, rc=0
```

Exactly the builder's claimed `167f/1547t` and typecheck ×5. The suite is genuinely green.
It is also genuinely blind to the blocking defect: there is not one concurrent call anywhere
in `test/contact-operator.test.ts` — every guard test is strictly sequential `await`.

---

## Findings

### 1. BLOCKING · lens 2 (run it) + 6 (attack the design) + 8 · The storm guard is a read-modify-write across DO input-gate boundaries, so it fails open under concurrency — 96 ops emails from one tenant

`engine/contact-operator.ts` decides *whether to admit a call* at `:71`/`:78` and *applies the
effect* at `:99`, with an `await` at `:87` in between. It decides *whether to send an ops
email* at `:88` and sends at `:124`, with the insert at `:99` in between. Every one of those
reads and writes goes to **D1** (`env.DB`, via the new `admin/db.ts` helpers), not to DO
storage.

That distinction is the whole defect, and this repo already documents it. `rate-limiter-do.ts:8-11`:

> A Durable Object is single-threaded per id, and **the input gate stays closed across the
> storage awaits inside `hit()`**, so the read-modify-write is serialized — **no lost-update
> race like the waitlist KV limiter.**

The input gate stays closed across **DO storage** awaits. D1 is an external binding, so
`await env.DB…` opens the gate and lets the next queued `contactOperator` call run its own
check before the first one has inserted anything. `clock.ts:33` states the same premise from
the other direction: *"the DO input gate opens at every await."* Every concurrent caller
therefore reads `recent.length` **before** any of them writes, and they all pass.

**Failure scenario (executed, production path).** One tenant, one bearer token, 100
concurrent `POST /messages/contact-operator` with distinct bodies, driven through
`SELF.fetch` → Worker → route → `TenantDO.contactOperator` → engine:

```
Z1: 201=96  429=4  rows=96  opsEmailsStamped=96
```

96 tickets admitted against a cap of 5; 96 ops emails sent against a throttle designed to
allow ~1 per 10 minutes. (`opsEmailsStamped` counts `email_sent_at IS NOT NULL`, which is
only written at `:130` *after* `mailer.send()` resolves — these are completed sends, not
attempts.) Reachable identically over MCP:

```
P3 MCP tools/call ×40 parallel: ticketRows=25  opsEmailsSent=25   (cap=5 tickets, ~1 email)
```

**Paired controls that FIRE — this is why the finding is not a harness artifact:**

```
Z2  SEQUENTIAL control, same route, 20 calls one at a time
    → 201=5  429=15  rows=5  opsEmailsStamped=1        ← guard works perfectly when serialized

P1  demo-run throttle (tenant-do.ts:1261, SYNCHRONOUS ctx.storage.sql, house pattern)
    100 parallel POST /demo/run  → accepted=1  429=99  run_count=1   ← HOLDS

P2  increment-1 tenant_messages dedup (tenant-messages.ts, SYNCHRONOUS ctx.sql, no awaits)
    100 parallel identical-dedupKey emits → 1 row                    ← HOLDS
```

Both siblings are non-async read-modify-writes over DO SQL, so no gate boundary exists inside
them. `enforceDemoRunThrottle` is the direct precedent — same platform, same threat, same
RealClock discipline, and it is a synchronous function *specifically* so this cannot happen.
The new guard reimplemented that logic in D1 and lost the property. It also violates
CLAUDE.md rule (c): `RateLimiterDO` is an existing atomic limiter primitive that was not
reused or even considered in the file's reasoning.

**Blast radius.** Ops email is the operator's only push channel; `listOpenAndEscalatedSupportTickets`
(`admin/db.ts:165`) has no `LIMIT` and no tenant filter, so the same burst floods the shared
digest for every tenant, and there is no ticket-close path to drain it. A single tenant agent
with a retry loop — no malice required — reproduces the 160-email incident. Parallel tool
calls are normal agent behavior, not an exotic input.

**Self-refutation performed.** (a) *Is workerd-in-vitest faithful?* It is the production
runtime, and P1/P2 show the gate demonstrably DOES hold in this same harness for DO-storage
guards — the harness models both sides correctly. (b) *Is there an upstream limiter in prod?*
No: `wrangler.toml` has no rate-limiting binding, and `RateLimiterDO` is wired only to
`/signup` (`routes/signup.ts:27`). (c) *Does low concurrency also break?* No — 2 parallel
calls returned `201,429` and held at the cap (Z3), so the defect scales with burst width; it
is a fail-open under load, not a permanently broken cap. That makes it *less* likely to be
caught in casual testing, not less severe.

**What would clear it:** move the admit-decision + insert into a single atomic step — DO
storage (matching `enforceDemoRunThrottle`), the existing `RateLimiterDO`, or a D1 conditional
write/UNIQUE constraint whose rowcount is the decision (the `insertDunningEventIfNew`
pattern). Re-run Z1/P3 as the acceptance proof; a sequential test cannot certify this.

---

### 2. NON-BLOCKING · lens 6 · `needs_human` does not bypass the email throttle, and a suppressed message's BODY never reaches the operator by any later push

`shouldEmail` (`contact-operator.ts:88`) is a pure function of `lastEmailAt` — `urgency` is
not a term. When the throttle suppresses a send, the next successful email carries only a
**count**, never the suppressed text (`:118`, `pendingNote`). Executed:

```
U1  "routine: what is my invoice date?" (normal)          → 1 ops email
    "URGENT: sending is down for all mailboxes" (needs_human, same window)
    → emails=1 · urgent body present in ANY ops email: FALSE
```

The urgent message exists only as a D1 row in a pull-only digest. If the agent never calls
again, the operator is never pushed anything about it. `intents.ts:143` documents `urgency`
as flagging "the ops email/ticket so an operator triaging the digest can tell … at a glance" —
accurate for the ticket, but the ops email for an urgent message may simply not exist.
Worth a ruling: either let `needs_human` bypass the throttle (bounded by the rate cap), or
fold suppressed bodies (not just their count) into the next send.

### 3. NON-BLOCKING · lens 8 · The ops email carries no untrusted-content fence; agent text can forge the system's own trailer

Header injection **fails** (good) — see Attacks that held. But the plaintext body is
interpolated at `:121` with the system's `pendingNote` and `Ticket:` lines appended directly
after it, no delimiter. Executed (C1): a body ending in
`...and 4000 more message(s) from this tenant since the last update.\n\nTicket: sup_forged`
renders indistinguishably from the platform's own trailer, with the real
`Ticket: sup_7034baf4…` following below. A body can also embed a `[coldrig] SDN alert …`
line mid-message. The framing line at `:120` sits above the body but nothing closes it.
Given the brief's prompt-injection concern (an operator pasting a ticket into their own
Claude), a `--- tenant-authored, untrusted ---` fence on both sides of `input.body` in the
email and the digest would close this cheaply.

### 4. NON-BLOCKING · lens 8 · `z.string().min(1).max(2000)` admits C0 control characters and bidi overrides, which round-trip into D1 and the ops email

Executed (C2): a body containing `U+202E` (RTL override) and a literal `NUL` stored verbatim
and appeared verbatim in the ops email text — `"please help‮  and 99 more message(s)…"`.
Same for the operator-supplied `regarding` (G1): `"\"}]}<script>x</script> \r\n{\"injected\":true"`
round-tripped intact. No break occurred (MCP JSON stayed parseable, HTML stayed escaped), but
a bidi override can visually reorder the forged trailer from finding #3, and NUL in an email
body is a spam-filter and log-hygiene liability. `intents.ts:146` is the natural place for a
control-character strip.

### 5. NON-BLOCKING · lens 1 (spec-vs-code) · "Works in EVERY account state" is false for an admin-TERMINATED tenant

`mcp/tools.ts:373`, `site/openapi.yaml`, and the guide all claim *"Works in EVERY account
state, including suspended/canceling."* Suspended and canceling are true — I confirmed
CANCELED-after-immediate-teardown works too (D1: `201`, and `lookupTenantContactEmail`
degrades to the `agent:<tenantId>` fallback rather than crashing, so the teardown concern in
brief item (e) is genuinely closed). But an abuse-terminated tenant is rejected upstream at
auth:

```
D2  POST /admin/tenants/:id/terminate → 200
    POST /messages/contact-operator   → 401 {"error":"this account has been suspended","code":"account_suspended"}
```

Plausibly intended for abuse, but the copy says "EVERY", and a wrongly-terminated customer's
appeal path is closed. Either narrow the claim or carve out the channel.

### 6. NON-BLOCKING · lens 6 · Dedup keys on `body` alone, so an urgency escalation of an identical body is silently swallowed

`contact-operator.ts:71` matches on `r.body === input.body` only. Executed (B1): the same
text sent first as `normal` then as `needs_human` returns the **same** ticketId, files no
row, sends no email, and the stored subject keeps the un-tagged
`Agent message from tenant …` (no `[needs human]`). A stuck agent that re-sends its message
with raised urgency — the natural escalation gesture — is indistinguishable from a replay.
Including `urgency` in the dedup identity, or upgrading the existing ticket's tag, would fix it.

### 7. NON-BLOCKING · lens 1 · Migration 0017's `source` discriminator is never shown to the operator surface it was added for

0017 exists to distinguish agent-authored from email-inbound tickets, and it is written
correctly. But `SupportTicketD1Row`/`fromD1Row` (`admin/db.ts:138-162`) do not select or map
`source`, so `GET /admin/support/digest` omits it (M4: keys are
`id, fromEmail, subject, body, tenantId, category, draft, status, createdAt`). The operator
distinguishes them only by the `Agent message from tenant …` subject prefix — adequate today,
but when a tenant *has* a contact email on file, `fromEmail` shows that real customer address
on a row whose body is unverified agent prose. Cheap to surface; harmless if ruled cosmetic.

---

## Attacks that failed (why the non-blocking grades mean something)

- **Header/MIME smuggling (brief a).** Body containing `\r\nBcc: attacker@evil.test\r\nSubject: [coldrig] SDN alert…`.
  Held: `RealOpsMailer` (`real-ops-mailer.ts:25`) uses the structured Email Service builder,
  not raw MIME; `to` is `env.OPS_ALERT_EMAIL`; `subject` is fully server-composed from
  `tenantId` + an enum-derived tag. Executed C1: subject came back clean, `to` unchanged.
- **HTML injection into the ops email.** `<img src=x onerror=…><script>` → `&lt;img …&gt;`.
  `escapeHtml` runs before the `\n`→`<br>` replace, so the escape cannot be undone. Held.
- **Subject-line spoofing of a system alert.** The `[coldrig]` prefix is shared with real
  system alerts, but the remainder ("agent contacted support — tenant X") is entirely
  server-composed and unmistakable. Held.
- **RealClock discipline (brief c) — executed, not read.** Demo tenant, 5 calls to exhaust the
  window, then `advanceClock(7 days)` on the tenant's VirtualClock, then one more call:
  `429 {"retryAfter":3600}`, rows stayed 5 (E1). The 1440× virtual clock cannot reset any
  guard. Held.
- **Migration 0017 on existing rows (brief d).** Wrote a pre-0017-shaped row with the old
  column set: reads back `source='email'`, `email_sent_at=NULL` (M1). The existing triage
  writer still lands `source='email'` and is byte-identical in behavior (M2). The digest
  renders agent tickets correctly alongside email tickets (M3). `status='escalated'` +
  `draft:null` is *exactly* the existing convention (`support-kb.ts:88`: `status: draft ? "open" : "escalated"`),
  so nothing downstream assumes escalated implies a draft. No reader uses `SELECT *`. Held.
- **Deploy/arm-time plumbing (brief h).** `wrangler.toml:14 migrations_dir="migrations"`;
  `package.json:8 deploy = wrangler d1 migrations apply --remote && wrangler deploy` — migration
  strictly before code, and the added columns are default-valued so the *old* worker keeps
  working in the window between. `test/setup.ts` enumeration matches the on-disk set. (0010
  is absent on main too — pre-existing, and `d1 migrations apply` does not require contiguity.) Held.
- **openapi dangling `$ref` (the class that escaped the 2026-07-22 sweep here).** Parsed
  `site/openapi.yaml`: 171 refs, 68 component schemas, **0 dangling, 0 unreferenced**. The new
  `ContactOperatorInput`/`ContactOperatorResult` are both defined. Held.
- **27→28 sweep collateral (brief g).** Token-level numeric diff of all 94 non-bundle hunks:
  every numeric delta is `27→28` or genuinely new content — no date, price, or unrelated count
  was touched. Enumeration cross-check: server-card `tools[]`=28 and set-equal to the
  `tools.ts` registry (0 either way), AGENTS.md table 28 rows, README + guide complete,
  llms.txt states 28 (it enumerates no tool names). `contact_operator` has an openapi
  `operationId`. Held on all three axes — count, enumeration, ref-resolution.
- **The count guard's own known holes** (my 2026-07-27 entry: allowlist narrower than
  `CLAIM_SURFACES`; og-image satisfied by a `font-size` attribute). Both backstopped this
  round: `27` was added to `RETIRED_TOOL_COUNTS:172`, which reds any surface left at 27
  regardless of allowlist membership, and og-image's `28` is now in the visible text
  (`One token · 28 focused tools`), not an attribute. Held.
- **`regarding` wired end-to-end?** (my producer-without-consumer class). The route was not in
  the diff, so I traced it: `admin-messages.ts:26` passes `parsed.data` wholesale to
  `emitOperatorMessage`, so the new optional field flows without a route change. Confirmed by
  execution (G1) end-to-end. Not a dead field. Held.
- **`regarding` → XSS / MCP break.** No dashboard or CLI code reads `actionHint` at all; the
  app's only `dangerouslySetInnerHTML` sink (`widgets/AgentNote.tsx:24`) is unrelated and
  sanitizer-fed. Malformed `regarding` left `tools/call` JSON parseable. Held.
- **Dedup replay amplification (brief b).** Identical-body replay writes nothing, sends
  nothing, logs nothing — cost is one bounded `SELECT … LIMIT 200` per call. `lastSeen` has no
  write. A rate-limited tenant replaying an old body still gets its original ticketId back
  (I1) — the deliberate and correct idempotency posture. Held.
- **"N more" counter accuracy (brief b).** Six dedup replays between two real sends did **not**
  inflate the count — the next email said "and 1 more message(s)" (H1). No double-count is
  possible: `created_at > lastEmailAt` is strict and an emailed ticket's `created_at` equals
  its `email_sent_at`. Held.
- **>6 emails/hour via throttle/window interleaving (brief b).** Impossible *sequentially* by
  construction: every email requires a fresh insert (dedup returns before the mailer), so
  emails ≤ tickets ≤ 5 per sliding hour. Z2 confirms: 20 sequential calls → 1 email. Held —
  and then defeated entirely by finding #1, which is a different mechanism.
- **Throwing mailer wedging the call.** Injected an always-throwing mailer: the tenant call
  still returned its ticketId, the row stayed honestly `email_sent_at=NULL`, and its message
  folded into the next successful send's count (H2). Held.
- **Tenant isolation of the guards.** Tenant A at its cap does not gate tenant B, including
  when B sends a body byte-identical to one of A's (F1). Held.
- **CANCELED / post-teardown crash (brief e).** Covered above under finding #5 — the concern
  is genuinely closed; nothing contactOperator touches is removed by teardown.

---

## UNVERIFIABLE

- **Production-edge concurrency at true scale.** I proved the race in workerd (the production
  runtime) via vitest-pool-workers. I could not drive the deployed Cloudflare edge. I expect
  production to be *worse* (real network fan-in widens the window), but the exact ratio at
  100+ concurrent requests is unmeasured. Resolved by: replaying Z1 against a staging deploy.
- **Real `send_email` behavior with C0/bidi characters (finding #4).** The binding is dark in
  test; whether Cloudflare's Email Service rejects, strips, or forwards a NUL is unknown.
  Resolved by: one real send to the ops address post-activation.
- **How often real MCP clients issue parallel `tools/call`.** Finding #1 does not depend on
  this (the REST route and any retry loop reach it), but the likelihood of *accidental*
  triggering is unquantified. Resolved by: operator telemetry after arming.

## NEW (out-of-scope) observations — no verdict weight

- `listOpenAndEscalatedSupportTickets` (`admin/db.ts:165`) selects every open/escalated ticket
  across **all** tenants with no `LIMIT`. Pre-existing, but this increment adds the first
  writer a tenant can drive at will, so the unbounded shape now has a tenant-controlled input.
- There is no close/resolve path for a support ticket anywhere in the codebase, so the digest
  is append-only and monotonically grows. Pre-existing; same amplification note applies.
- `markSupportTicketEmailed` (`:130`) sits inside the `try`, so a D1 failure *after* a
  successful send is logged as "send failed" and the ticket re-emails next call. Cosmetic
  duplicate-email risk, orders of magnitude below finding #1.
