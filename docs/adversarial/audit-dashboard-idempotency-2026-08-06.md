# Boundary audit gap 5 — dashboard mutation idempotency

**Date:** 2026-08-06
**Auditor:** fresh-context adversary (no prior involvement in the dashboard/session/billing lanes)
**Ground ref:** worktree `/Users/yaakovscher/dev/coldstart-worktrees/audit-dash-idem`, branch `audit-scratch-dash-2026-08-06`, `git rev-parse HEAD` = **`2e86b68e41cb9be62f54e53c1d7c67dde928ce45`** ("ledger: freeze wave-2 combined gate verdict (NO-SHIP r1 -> SHIP r2)"). Clean tree apart from the probe files listed below.
**Method:** every verdict below is EXECUTED against the real Hono/DO surfaces via `@cloudflare/vitest-pool-workers` (`SELF.fetch` + `runInDurableObject`), not read off the source. Probe files (left in the worktree for reproduction, NOT for merge):

- `apps/platform/test/zz-audit-dash-idem-probe.test.ts` (rounds 1–8)
- `apps/platform/test/zz-audit-dash-idem-probe2.test.ts` (R2-*)
- `apps/platform/test/zz-audit-dash-idem-probe3.test.ts` (R3-*)
- `apps/platform/test/zz-audit-dash-idem-probe4.test.ts` (R4-*)
- `apps/platform/test/zz-audit-dash-idem-probe5.test.ts` (R5-*)

Run: `cd apps/platform && npx vitest run test/zz-audit-dash-idem-probe*.test.ts --reporter=verbose --disableConsoleIntercept`

---

## OVERALL VERDICT: **FAIL** — 3 BLOCKING

The surface is not uniformly broken. Request-level idempotency exists and is well built (`engine/idempotency.ts` claim-then-execute; `engine/provision-intents.ts` durable buy intents), the global CSRF guard holds on all 27 cookie-authed mutation paths, the layout rev-CAS holds under true concurrency, and teardown/cancel is properly claim-anchored. The failures are all in **which mutations were wired to that machinery** — and in one case (BLOCKING-1) the machinery itself makes retries *less* safe than not using it.

---

## Per-surface verdict table

| # | Mutation surface | Replay / retry | Concurrent conflict | Idempotency mechanism | Verdict |
|---|---|---|---|---|---|
| 1 | `POST /dashboard/session` (mint) | Every replay mints a NEW independent 30-day session | n/a | none; no cap, no rate limit, no expiry sweep | **FAIL** (B3) |
| 2 | `POST /login` + `/login/consume` | Link is single-use (atomic conditional UPDATE) | picker path consumes exactly once | `db.ts:207` `WHERE consumed_at IS NULL` + `changes===1` | PASS |
| 3 | `POST /dashboard/logout` | Idempotent (2nd call 401s, cookie already dead) | n/a | delete-by-hash | PASS |
| 4 | `POST /dashboard/views` (create) | Replay creates a 2nd view (`ops`, `ops-2`) | Concurrent creates both persist (`race`, `race-2`) | none | FAIL (N3) |
| 5 | `PUT /dashboard/views/:id` (layout/rename) | Exact replay of a SUCCEEDED write returns 409 | Exactly one winner (200/409) | rev-CAS | PASS w/ N4 |
| 6 | `POST /dashboard/views/:id/default` | Idempotent in effect | Both 200; single-default invariant holds | none (no CAS) | PASS |
| 7 | `DELETE /dashboard/views/:id` | Replay 404s | Stale tab deletes a rev-2 edit it never saw | none (no CAS) | FAIL (N3) |
| 8 | `POST /threads/:id/label` (`label_thread`) | Stale human replay CLOBBERS the agent's newer label | last-write-wins, no version | upsert only | FAIL (N5) |
| 9 | `POST /threads/:id/mark` | Idempotent | LWW, benign | upsert only | PASS |
| 10 | `POST /threads/:id/reply` | Keyed (`reply:<threadId>:<key>`) | serialized in DO | `withRequestIdempotency` | PASS |
| 11 | `POST /setup-infrastructure` | Unkeyed replay converges (1 domain / 2 mailboxes across 4 calls) | Concurrent unkeyed + concurrent same-key both converge | intent rows | **FAIL** (B1 — only when the key CHANGES) |
| 12 | `POST /campaigns` (`launch_campaign`) | Unkeyed replay creates a 2nd campaign; 4 calls → 4 identical campaigns | 2 concurrent → 2 campaigns | key optional, unused by any browser caller | FAIL (N2) |
| 13 | `POST /remove-mailboxes` | Replay releases another N; `Idempotency-Key` header accepted-and-IGNORED | Concurrent double-submit releases 2N | **none** | **FAIL** (B2) |
| 14 | `POST /cancel` (`immediate:true`) | 2nd call returns the recorded teardown | Concurrent: one `alreadyCanceled:true`, 6 mailboxes released ONCE | `teardown_records` anchor | PASS |
| 15 | `POST /cancel` (end-of-period) | Replay re-reports `alreadyCanceled:false` | converges | none needed | PASS w/ N7 |
| 16 | `POST /checkout` (simulated) | Same pending `sessionId` on all 4 calls | dedup holds | pending-session reuse | PASS |
| 16b | `POST /checkout` (**real Stripe**) | 4 calls → 4 distinct Checkout Sessions, `Idempotency-Key: null` on every POST | no dedup | **none** | FAIL (N1) |
| 17 | `GET /checkout/simulate` (completion) | Replay returns `upgraded:false` | — | state guard | PASS |
| 18 | `POST /token/rotate` | Each call rotates again | Concurrent: both 200, exactly one token survives, the other caller silently holds a dead token | single atomic UPDATE | PASS w/ caveat |
| 19 | `POST /webhook-subscriptions` | Replay registers a 2nd sub on the same URL | — | none | FAIL (N6) |
| 20 | `POST /leads/suppress` | Replay returns `alreadySuppressed:true` | — | PK dedupe | PASS |
| 21 | `POST /api/waitlist` | `INSERT OR IGNORE` on email PK | — | PK dedupe | PASS |
| 22 | CSRF guard on all of the above | — | — | `X-Coldstart-Client` on every cookie non-GET | PASS (27/27) |

---

## BLOCKING findings

### BLOCKING-1 — `setup_infrastructure`: a retry whose idempotency key DIFFERS from (or is newly present vs.) the first attempt buys a SECOND lookalike domain and duplicate mailboxes

**Lens:** 6 (attack the design) + 1 (spec-vs-code line-trace).

**Site:** `apps/platform/src/engine/provisioning.ts:500`

```ts
intentKey: `${setupKey ?? `tenant:${ctx.tenantId}`}#${domainIndex}`,
```

The durable buy-intent key — the thing that makes a retry *adopt* a prior purchase instead of re-buying (`engine/provision-intents.ts`, written after the 2026-08-05 incident that cost $12.50 and stranded a customer's domain) — is namespaced by the caller's **request idempotency key**. Omit the key and every attempt lands in the same `tenant:<id>#0` intent and converges. Supply a *different* key on a retry and you open a brand-new intent, which buys a brand-new domain.

The result is inverted from every reasonable expectation: **passing an idempotency key is less retry-safe than passing none.**

**Executed proof** (`zz-audit-dash-idem-probe5.test.ts`, R5-A / R5-B):

```
R5-A after UNKEYED call: {"domains":1,"mailboxes":2,"names":["tryr5mixed.com"]}
R5-A after KEYED retry:  {"domains":2,"mailboxes":4,"names":["tryr5mixed.com","getr5mixed.com"]}

R5-B after key k1: {"domains":1,"mailboxes":2,"names":["tryr5two.com"]}
R5-B after key k2: {"domains":2,"mailboxes":4,"names":["tryr5two.com","getr5two.com"]}
```

Control, same fixture shape, proving the convergent behavior it diverges from (`probe4`, R4-3 — four rapid unkeyed calls, and R4-1/R4-2 — concurrent unkeyed and concurrent same-key):

```
R4-3 call#1..#4: 202, counts stay {"domains":1,"mailboxes":2,"domainNames":["tryr4rapid.com"]}
R4-1 concurrent unkeyed  -> settled {"domains":1,"mailboxes":2}
R4-2 concurrent same-key -> both return the SAME jobId, settled {"domains":1,"mailboxes":2}
```

**Concrete repro (the reachable path, and it is exactly the brief's "agent + human simultaneously"):**
1. Setup is kicked off without a key — `SetupInfrastructureToolInput.idempotencyKey` is `.optional()` (`mcp/schemas.ts:44`) and the dashboard's `apiRequest` never sets the header (`apps/dashboard/src/api/client.ts` attaches only `Content-Type` + `X-Coldstart-Client`).
2. The response is lost (the intent takes up to ~156 sequential vendor round trips per `engine/idempotency.ts:12-26`; a browser/agent timeout in that window is ordinary).
3. The tenant's agent retries and, following the tool description's own advice, stamps an `idempotencyKey`.
4. A second lookalike domain is registered and `inboxesEach` more mailboxes are provisioned and become billable.

**Blast radius with one paying tenant:** real registrar spend on an unwanted domain (annual liability is booked at teardown, `engine/lifecycle.ts`), plus duplicate mailboxes on the $10/mailbox curve billed monthly, plus a second sending domain the customer never asked for. The spend ceiling bounds the loss but does not prevent it.

**Self-refutation attempted and failed:** (a) "maybe the second domain is intended additive behavior" — refuted by R4-3, where four unkeyed `domains:1` calls converge to one domain, so the design intent is clearly convergence; (b) "the key path is the only supported one so the mixed case is user error" — refuted by the key being `.optional()` on the MCP schema and absent from every dashboard call, which makes the unkeyed→keyed transition the *default* trajectory, not an edge case.

**Caveat to state plainly:** the vendor leg is UNVERIFIED here — the hermetic test env runs the sandbox domain port, so what I executed is the duplicate *intent row + duplicate local domain/mailbox rows + a second `buy()` dispatch*. Whether that second dispatch reaches the live registrar depends on `register_domains` opt-in + `REGISTRAR_PROVIDER`/`CLOUDFLARE_REGISTRAR_API_TOKEN` arming. The duplicate billable mailbox rows are unconditional.

---

### BLOCKING-2 — `POST /remove-mailboxes` is a RELATIVE operation with no idempotency, and it accepts-then-ignores an `Idempotency-Key`

**Lens:** 2 (would it actually run — RUN it) + 8 (destructive surface).

**Site:** `apps/platform/src/engine/billing.ts:925` → `releaseMailboxes(ctx, { limit: input.count })` (`engine/lifecycle.ts:151`). Route: `apps/platform/src/routes/checkout.ts:21` — the handler passes only the parsed body to the DO; no key is read, and `TenantDO.removeMailboxes` (`tenant-do.ts:890`) does not wrap in `withRequestIdempotency`.

The intent is "release N", not "be at N". Every replay releases another N. Release is irreversible through this API — the tool's own description says so ("irreversible-this-cycle", `mcp/tools.ts:178`) — and each release revokes engine credentials, tombstones the credential push, and marks `released_at`.

**Executed proof** (`zz-audit-dash-idem-probe.test.ts` PROBE 5 / 5b):

```
PROBE5 live before: 12
PROBE5 call#1:       200 {"releasedCount":3,...,"provisionedAfter":9}   live now: 9
PROBE5 REPLAY call#2:200 {"releasedCount":3,...,"provisionedAfter":6}   live now: 6

PROBE5b concurrent:  200 {"releasedCount":3} | 200 {"releasedCount":3}  live now: 6
```

And the retry contract the platform advertises does not help (`zz-audit-dash-idem-probe4.test.ts`, R4-5 — both calls carry the identical `Idempotency-Key: r4-remove-key`):

```
R4-5 counts after setup: {"domains":1,"mailboxes":2}
R4-5 keyed remove #1:     200 {"releasedCount":1,...,"provisionedAfter":1}
R4-5 keyed remove REPLAY: 200 {"releasedCount":1,...,"provisionedAfter":0}
R4-5 live mailboxes after two SAME-KEY removes: 0
```

That last line is the sharpest form of the defect: **a perfectly well-behaved client following the documented retry rule still destroys twice.** A header named `Idempotency-Key` that is silently ignored is worse than no header — it converts a correct client into a destructive one.

**Concrete repro:** the tenant's agent calls `remove_mailboxes {count: 3}`, the response is dropped, it retries with the same key per the schema's own guidance → 6 mailboxes released, warmup lost on all 6, re-provisioning required (new spend, new warmup ramp). With `count >= live`, the whole sending fleet goes.

**Fix shape (not implemented — I flag, I don't fix):** make it absolute (`targetCount`) as `setSubscriptionItemQuantity` already is on the Stripe side ("set-to-N, never increment, so a missed/duplicated push self-heals" — `billing/stripe-client.ts:290`), or wrap in `withRequestIdempotency` and honor the header. The codebase already ruled set-to-N correct for the money side of this exact operation; the mailbox side did not follow.

---

### BLOCKING-3 — a replayed session mint outlives the credential it was minted from: `POST /token/rotate` revokes NO dashboard session

**Lens:** 8 (what exactly is validated) + the brief's explicit "can a replayed session-mint mutate state?".

**Sites:** `apps/platform/src/routes/dashboard-session.ts:52` (mint — unauthenticated, no rate limit, no per-tenant cap); `apps/platform/src/require-auth.ts:79` (`resolveTenantFromDashboardSession` checks `expires_at` + `tenants_index.status` and never consults `api_token_hash`); `apps/platform/src/routes/token-rotate.ts:35` (rotation writes only `api_token_hash`); `apps/platform/src/db.ts:139` (`deleteDashboardSession` is per-hash — the only delete that exists anywhere).

`POST /dashboard/session` is a mutation whose replay is unbounded: one bearer token mints unlimited independent 30-day sessions, each a separate durable D1 row. Rotation — documented as "the ONLY recovery path for a lost bearer token" (`routes/token-rotate.ts:7-9`) — kills the token and nothing else.

**Executed proof** (`zz-audit-dash-idem-probe.test.ts` PROBE 1 / 1b):

```
PROBE1 mints: 5 distinct cookies: 5
PROBE1 rotate status: 200
PROBE1 OLD bearer after rotate: 401
PROBE1 session statuses after rotation: [200,200,200,200,200]
PROBE1 mutation from a session minted off the ROTATED token: 201 minted-from-dead-token
PROBE1 re-rotate from that same session: 200
PROBE1 logout: 200  s0 after logout: 401  s1 after logout: 200

PROBE1b dashboard_sessions rows before: 4  after 25 mints: 29
```

**Concrete repro:** a tenant's bearer token leaks (this product's token is pasted into an agent's config — leaking into logs, screenshots or a commit is the realistic failure). The holder POSTs it once to `/dashboard/session` and pockets a cookie. The tenant notices and rotates. The old bearer 401s; the cookie keeps full tenant authority for **30 days** — including `POST /cancel`, `POST /remove-mailboxes`, `POST /checkout`, and `POST /token/rotate` (locking the legitimate owner out of their own API). Logout only clears the browser's own session, so the owner has no revoke-all control at all.

**Precondition stated honestly:** this is a post-compromise containment failure, not a way in — it requires the token to leak first, and a leaked token already grants full API access. What it proves is that the *stated* remediation does not remediate. Graded BLOCKING on that basis; the team may reasonably override to non-blocking if it accepts "rotate then wait 30 days" as the recovery story, but the docstring must then stop claiming otherwise.

**Adjacent (same root, folded here, non-blocking on its own):** `dashboard_sessions` has no expiry sweep anywhere (`src/admin/`, `src/scheduled.ts` — grep confirms zero references), no per-tenant cap, and — unlike `POST /login`, which has four rate limiters (`routes/login.ts:22-28`) — no rate limit on the mint route. So the table grows monotonically and the unthrottled mint route also doubles as an unthrottled bearer-token oracle.

---

## Non-blocking findings

**N1 — real Stripe checkout has no dedup and sends no `Idempotency-Key`.** `billing/stripe-client.ts:87` `createStripeCheckoutSession` sets no `Idempotency-Key` header (contrast `setSubscriptionItemQuantity` at `:306`, which does), and `startCheckout` (`engine/billing.ts:161`) dedups only on the *simulated* branch ("Reuse an existing PENDING session…", `:180`). Executed (`probe3`, R3-1): four calls → `cs_live_1..4`, `Idempotency-Key headers sent on those POSTs: [null,null,null,null]`. The `billing_state === 'active'` guard at `:158` only closes the window *after* the first session completes. Reachable for sandbox/canceled/past_due/none tenants; two completed sessions = two subscriptions while the DO tracks one `stripe_subscription_id`, orphaning the first while it bills. Non-blocking today only because the single paying tenant is `active` and a human would have to pay twice.

**N2 — `launch_campaign` double-submit creates N identical campaigns.** Executed (`probe4`, R4-4): sequential replay + a concurrent pair → `R4-4 campaigns now: 4 ["Q3 Outbound","Q3 Outbound","Q3 Outbound","Q3 Outbound"]`. Each will send real mail to the same lead list — duplicate outreach to prospects, quota burn, and deliverability/reputation harm on a cold-email platform. Non-blocking because no browser surface launches campaigns and the agent surface does advertise the key; it becomes blocking the day a "Launch campaign" button ships.

**N3 — dashboard views: create/promote/delete have neither idempotency nor CAS, and the SPA does not disable those buttons while pending.** Executed (PROBE 2): `ops`+`ops-2` on sequential replay, `race`+`race-2` on a concurrent pair. Executed (`probe2`, R2-1b): tab A edits to rev 2 and renames; tab B, still holding rev 1, deletes → `200 {"deleted":true}` and the newer edit is gone (DELETE accepts no rev at all). In the UI, Save (`LayoutEditor.tsx:143`) and rename Save (`ViewSwitcher.tsx:180`) ARE `disabled={updateView.isPending}`, but Add (`ViewSwitcher.tsx:146`), "Set as default" (`:208`) and "Delete view" (`:213`) are not — so the duplicate-create is a plain double-click away, and delete has no confirm step either.

**N4 — an exact replay of a SUCCEEDED layout PUT reports a rev conflict.** Executed (`probe2`, R2-1): after the winning write lands at rev 2, resending the identical body → `409 … "was edited since rev 1 (current rev 2) — refetch and rebase your change"`. The user's change *did* save; they are told someone else edited it. `LayoutEditor.tsx:75` renders the conflict-resolution UI on that 409, so a dropped-response retry produces a confusing rebase prompt for a write that already succeeded. (The 409 body does carry `currentLayout`, so a client could compare and detect self-replay — nothing does.)

**N5 — thread labels are last-write-wins with no version; a stale retry clobbers a newer write.** This is the brief's stale-retry question answered in the affirmative, executed end-to-end (`probe2`, R2-6). Concurrent human (cookie) + agent (bearer) label writes both 200; durable state lands on `"label":"agent-label","labelSource":"api"`. The human's browser then retries its earlier request and durable state becomes `"label":"human-label","labelSource":"dashboard"` — a stale write silently overwriting a newer one. Non-blocking: labels are free-form triage chips, trivially reversible, and `engine/thread-labels.ts:34` is an honest upsert.

**N6 — webhook subscription create has no dedup.** Executed (`probe2`, R2-4): two identical POSTs → two subscription ids on the same URL, both active. Unlike the other duplicates this one is *permanent and ongoing* — every future event is delivered twice to the customer's endpoint until someone notices. `engine/webhooks.ts:175` `createWebhook` inserts unconditionally.

**N7 — `POST /cancel {immediate:false}` replay always reports `alreadyCanceled:false`.** Executed (PROBE 6b): both calls return `{"alreadyCanceled":false,"billingState":"canceling"}`. State converges (the second UPDATE is a no-op in effect), but the response tells a retrying client its cancel was the first one. Cosmetic; `engine/lifecycle.ts:341` only anchors on `teardown_records`, which the deferred path never writes.

**N8 — concurrent token rotation can hand a caller a dead token with a 200.** Executed (PROBE 7): two cookie-authed rotations (two tabs — cookie auth does not self-invalidate the way bearer auth does) both return 200; `tokenA alive: 401, tokenB alive: 200`. The caller shown token A was told success and holds a credential that never worked; the token is displayed exactly once and is unrecoverable. Non-blocking: `SettingsPage.tsx:97` disables the button while pending so the single-tab double-click is closed, and the tenant can always rotate again from the still-valid cookie.

---

## Attacks that FAILED (what makes the PASS rows meaningful)

1. **CSRF-bypass shape** — I hypothesized that Hono's wildcard patterns in `AUTHED_PATH_PATTERNS` (`index.ts:98`) would miss multi-segment paths, leaving `POST /dashboard/views/:id/default`, `/threads/:id/label`, `/byo-domains/:id/consent`, `/campaigns/:id/pause` etc. outside `csrfGuard`. Drove all 27 cookie-authed mutation paths without the header (PROBE 4): **27/27 → 403**, `NOT 403 (guard did not fire): (none)`. The wildcards do span slashes; the explicit-list discipline holds. HELD.
2. **Layout rev-CAS under true concurrency** — two `Promise.all` PUTs on the same rev (`probe2`, R2-1): `200` and `409`, final `rev 2` carrying the winner's widget `["wA"]`. Exactly one winner; no lost update. HELD.
3. **Single-default invariant under conflicting concurrent promotes** (`probe2`, R2-1b): both 200, `defaults after race: ["default"]` — exactly one. The synchronous demote+promote pair (`dashboard-views.ts:233-239`) really is uninterruptible by the DO input gate. HELD.
4. **`setup_infrastructure` double-click** — concurrent unkeyed, concurrent same-key, and four rapid sequential calls all converge to 1 domain / 2 mailboxes (R4-1/R4-2/R4-3). The provision-intent layer works as designed *within one key-space*; BLOCKING-1 is specifically the cross-key case. HELD.
5. **Concurrent immediate `/cancel` with real infra** (`probe3`, R3-2) — 6 mailboxes + 1 domain seeded; A returns `alreadyCanceled:false, mailboxesReleased:6`, B returns `alreadyCanceled:true` with the *same* recorded teardown; durable state `{"live":0,"released":6}`. I expected the release loop's per-mailbox `await` to reopen the input gate and let the sibling double-release. The `teardown_records` claim lands first. HELD.
6. **Simulated checkout replay** (PROBE 6) — four calls all return the identical pending `cs_…` id; replaying `GET /checkout/simulate` returns `upgraded:false` the second time. HELD.
7. **Magic-link consume replay** — `db.ts:207` is an atomic `UPDATE … WHERE consumed_at IS NULL` gated on `changes === 1`, and both consume sites check it (`routes/login.ts:138`, `:154`). No double-consume, and the multi-tenant picker path deliberately does not consume until the final pick. HELD.
8. **`leads/suppress` replay** (`probe2`, R2-5) — `{"suppressed":true,"alreadySuppressed":false}` then `{"suppressed":true,"alreadySuppressed":true}`. Honest and idempotent. HELD.
9. **`threads/:id/mark` replay** (`probe2`, R2-6) — both 200, state converges. HELD.
10. **Waitlist duplicate submission** — `INSERT OR IGNORE` on the email PK (`db.ts:218`); repeat submits are silent no-ops with no duplicated side effect. HELD.
11. **Cookie session cross-tenant selector** — no route takes a tenant id from the client on the cookie path; `requireAuth` resolves the stub from the session row only. HELD.

---

## UNVERIFIABLE (not folded into the verdict)

1. **Whether BLOCKING-1's duplicate `buy()` reaches the live registrar.** The hermetic test env runs sandbox ports (`INBOXKIT_*`/`REGISTRAR_*` neutralized by `test/hermetic-env.ts`). Duplicate intent rows, duplicate `buy()` dispatch and duplicate billable mailbox rows are executed facts; real vendor spend is inferred. **Resolves by:** a test-mode run with `REGISTRAR_PROVIDER` + `CLOUDFLARE_REGISTRAR_API_TOKEN` wired, or a grep of prod registrar invoices for two same-brand lookalikes on one tenant.
2. **Real Stripe behavior for N1.** `fetch` was stubbed. Stripe will not dedup two keyless `POST /checkout/sessions` — but "the customer can actually complete both and end up with two subscriptions" needs a live test-mode run. **Resolves by:** a Stripe test-mode double-checkout.
3. **Live-surface drive (lens 3).** No dev server or prod session was available in this worktree, so the SPA claims in N3/N8 (which buttons are `disabled` while pending) are read from `ViewSwitcher.tsx` / `LayoutEditor.tsx` / `SettingsPage.tsx` source, not driven in a browser. **Resolves by:** a Playwright pass against `/app` double-clicking Add / Set-as-default / Delete view.
4. **Whether the one paying tenant has already been hit by B1 or B2 in production.** No prod DB access. **Resolves by:** `SELECT COUNT(*) FROM domain_intents` and released-vs-live mailbox counts for that tenant's DO.

---

## NEW (out of scope, no verdict weight)

- `POST /dashboard/session` has no rate limit at all while `POST /login` has four (`routes/login.ts:22-28`). Both accept a secret in the body and both 401 on a bad one, so the mint route is an unthrottled offline-free oracle for guessing bearer tokens. Not an idempotency issue; noted because it sits on the same route file I audited.
- `ViewSwitcher.tsx:213` deletes a saved view with no confirmation step, and the server-side delete accepts no rev (N3). The combination means one stray click permanently discards an agent-authored layout.
- `engine/dashboard-views.ts:162` resolves slug collisions with an unbounded `while` loop of `SELECT COUNT(*)` probes. Harmless at today's view counts; it is O(n) queries per create and grows with every duplicate a double-click leaves behind.
