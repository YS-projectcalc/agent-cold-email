# Class-sweep vendor-truth — consolidated inventories A–F + adversarial completeness pass

**Frozen record.** Ref `8c87c79646f007bdb62880cd39fa8a4bf76a4952` (verified at pass start AND end; working tree carried only bookkeeping/agent-memory edits, no source drift).
Date 2026-08-18. Inputs: three class-sweeper inventories (A+B money-grading, C+D monitor-reads, E+F adapter-contracts), all read-only at this ref.
This pass ATTACKS those inventories; it does not re-derive them. Read-only git throughout. Vendor probes were READS only (no writes, no spend).

**Verdicts at a glance**

| Class | Verdict | Headline correction |
|---|---|---|
| A — refusal graded permanent | GAPS-FOUND | HTTP 401/402/403 at the root grader is the widest member and is unlisted; the "nine branches hard-code `false`" count is wrong on 5 of 11 cited sites; the proposed shared-grader guard would REOPEN the vendor-verdict class at two `inconclusive` sites |
| B — vendor wallet unmodelled | GAPS-FOUND + one test PREMISE-WRONG | `GET /billing/wallet` EXISTS live but the sweep's field names are wrong (snake_case); `spendCostCents('warmup')>0` is the wrong test and would double-count the add-on |
| C — vendor-vs-platform divergence | GAPS-FOUND | C14 is a MIS-TAGGED OUT: direction B DOES overbill the customer, via `syncMailboxQuantity`; `release()` is non-idempotent and manufactures exactly those phantom rows |
| D — reads narrower than their name | GAPS-FOUND | D1 and D8 LIVE-CONFIRMED on production; two missed members outside the sweep's glob roots (`apps/dashboard`, `apps/engine`) |
| E — billed effect, no pre-check | GAPS-FOUND | E4 (`findAdoptableDomain`) is a MIS-TAGGED OUT — its inconclusive arm folds toward the buy; E10 settles OUT with a caveat |
| F — unenforced response model | GAPS-FOUND | An `undefined` body escapes `VendorError` grading entirely; oauth-mint step 1's response is discarded (F13 belongs IN, not UNCERTAIN). F1/F2 re-confirmed live; F7/F9/F11 OUT claims HELD |

---

## Part 1 — The consolidated inventories (carried forward as received)

### CLASS A — "a two-valued `retryable` boolean carries a three-valued question; every operator-clearable refusal collapses into permanent and is emitted as 'we have stopped forever'"

Three grade-producing surfaces (not one): `mapInboxKitError` (HTTP non-2xx only) · hand-written 200-`{error:true}` branches in `mailbox-port.ts` / `inboxkit-domain-port.ts` · `email-port.ts:149` (a different vendor).

IN (producers): `inboxkit-errors.ts:24` (root: `retryable = s>=500||s===429`) · `mailbox-port.ts:149` (Mordy's site, `/warmup/add`) · `inboxkit-domain-port.ts:246-251` (NAMES "operator-fixable (top up the InboxKit wallet)" in a comment, throws `false` anyway; green test `test/real-inboxkit-domain-port.test.ts:144` pins it) · `mailbox-port.ts:68` (`/mailboxes/buy`) · `inboxkit-domain-port.ts:243` (`/domains/register`) · errors doc block `:3-22` · `oauth-mint.ts:55,107` (non-funding operator-clearable arm).

UNCERTAIN: `inboxkit-domain-port.ts:253` (`payment_type !== "wallet"`).

IN (emission sites): `error-response.ts:156-169` esp `:164` ("check your inputs" — actively false) · `provisioning.ts:808-837` (terminal `setup_failed` row) · `retry-setup-message.ts:52-59` · `mailbox-acquisition.ts:279-288` `abandonedPurchaseError` (reached after two ZERO-COST refusals) · `provision-intents.ts:301-326` (dispatch counter burned by zero-cost refusals, `MAX_BUY_DISPATCHES=2`) · `deliverability-actions.ts:263-296` (`REPLACE_DOMAIN_FAILED` "provider issue", no operator alert) · `mailbox-provisioning.ts:508`, `:154-172` · `provisioning.ts:660-675` · `mailbox-provisioning.ts:445-450` · `mcp/handler.ts:184` · `mcp/tools.ts:86`, `:350` · `openapi.yaml:2184-2188`, `:1509-1527` · `test/real-inboxkit-client.test.ts:133`.

OUT (load-bearing, do not disturb): `setup-terminality.ts:19-40` · `email-port.ts:64-77` (`RETRYABLE_ENGINE_STATUSES`, the compliant template) · `errors.ts`'s four bespoke operator-clearable errors (`CapacityPendingError` wording = the honest-message template).

### CLASS B — "the vendor's prepaid credit wallet is a third resource (≠ our $ ceiling, ≠ plan slots) that no code path reads, models, or can express"

IN: `spend-ceiling.ts:82-99` warmup→0¢ · `:76-78` mailbox 690¢ + `:79` domain 1500¢ · `:301-314` slot reserve · `:248-257` `withSpendCeiling` (structural: no vendor read anywhere in the file) · watchtower: ZERO of 13 checks read vendor account state · `TenantOpsSummary` cannot hold a vendor balance (`ops-summary.ts:18-48`) · admin-ops routes cannot answer "can we afford the next purchase" · `vendor-ports.ts:160-261` has NO balance method · `ACTIVATION.md` has no wallet-funding step · `deliverability-actions.ts:241-262` (THREE money-out calls from cron, no alert on plain `VendorError`) · `mailbox-provisioning.ts:360-400` · `provisioning-reconcile.ts:169` · `quota.ts:32-76` · `test/spend-ceiling-coverage.test.ts:26-46,89` · `ga-gates-design` doc `:134-138` · sandbox ports contain ZERO throws.

### CLASS C — "every health signal derives from a platform ROW; vendor-vs-platform divergence is undetectable in BOTH directions"

Dir A = vendor holds, no platform row. Dir B = row claims what the vendor no longer holds.

IN: C1 `mailbox-provisioning.ts:231-241` (the incident) · C2 `provision-intents.ts:210-320` (mailbox intents read ONLY by their writer, ONLY by key — the `domain_intents` asymmetry) · C3 `vendor-ports.ts:214-262` (`MailboxPort` has no list method) · C4 `warmup-cancel.ts:73-82` · C5 `sweep-signals.ts:134-149` · C6 `provisioning.ts:138-174` · C7 `vendor-lifecycle.ts:54-63` + `domain-dns.ts:273` (no live domain is ever re-polled) · C8 `infrastructure-status.ts:126-132` · C9/C10 `lifecycle.ts:283-290` · C11 `spend-ceiling.ts:303` + `lifecycle.ts:273,309` · C12 migration 0011 `vendor_spend_entries` has NO resource identity · C13 `apps/engine` mailbox store.

OUT: C14 `billing.ts:870-909` · C15 prewarm · C16 wallet (= class B).
UNCERTAIN: C17 `provisioning-reconcile.ts:92-160` (dark remediator, not a detector).

### CLASS D — "the narrowing is invisible in the response"

IN: D1 `provisioning-state.ts:121-128` · D2 `test/admin-provisioning-state.test.ts:199-213` (the `toEqual([])` pin is DELIBERATE) · D3 `provisioning-state.ts:96,106,121` · D4 `admin-ops.ts:79-82` + `db.ts:297` · D5 `admin-screening.ts:20-23` · D6 `admin-support.ts:53-58` + `db.ts:155,163` · D7 `admin-ops.ts:67-76` · D8 `ops-sweep.ts:606` (`provisioningFailureCount: 0` hardcoded) · D9 `admin-messages.ts:47-48` · D10 `ops-sweep.ts:549-564`.

OUT: D11 `infrastructure-status` mailboxes count · D12 `tenant-messages.ts` (compliant template) · D13 `status.ts`.
UNCERTAIN: D14 `db.ts:212` `listAllTenantIds`.

### CLASS E — "billed non-idempotent effect; pre-check STRUCTURALLY UNAVAILABLE; marker after effect"

IN: E1 `mailbox-provisioning.ts:466-482` (P0 latent double-subscription) · E2 `:263-287` (snapshot-not-reread, the enabler) · E6 `provisioning-reconcile.ts:169`.
OUT (templates): E3 `dispatchBuy` · E4 `domain.buy` / `findAdoptableDomain` · E5 `REPLACE_DOMAIN` · E7 `cancelWarmup` · E8 releases · E9 Stripe `setSubscriptionItemQuantity` · E11 `findOrCreateProduct` · E13 prewarm.
UNCERTAIN: E10 `createStripeCheckoutSession` · E12 `oauth-mint.ts:94-114`.

### CLASS F — "`InboxKitClient.request<T>` ends `return body as T` (`inboxkit-client.ts:87`) — the compile-time model is UNENFORCED at all 15 call sites"

IN: F1 `mailbox-port.ts:118-141` `getHealth` · F2 `mailbox-port.ts:286-300` `showMailboxCredentials` · F3 `inboxkit-client.ts:87` (systemic root) · F4/F5 the two fixtures · F6 `mailbox-health-vendor-fields.test.ts:31-32` · F17/F18 Stripe.
OUT (live-verified clean): F7 `findExactMailbox` · F8 `listDomainRecords` · F9 `warmupSubscriptionState` · F10 `searchLookalikes` · F11 `startWarmup` response handling.
OUT (templates): F19–F24.
UNCERTAIN (all mutating, doc-only): F12–F16.

---

## Part 2 — Corrections, mis-tags and missed members (this pass)

Ordered most severe first. Each carries the verification method.

### FINDING 1 · C14 is a MIS-TAGGED OUT — direction B overbills the CUSTOMER, not just COGS

**Claim under attack:** "C14 `billing.ts:870-909` — billing follows platform rows, floors at max(5, provisioned); a vendor orphan does NOT overbill the customer; COGS only."

**Refuted.** The claim is true only for direction A. `syncMailboxQuantity` (`engine/billing.ts:874-908`) computes `desired = billableMailboxes(provisionedMailboxCount(ctx))` where `provisionedMailboxCount` is `SELECT COUNT(*) FROM mailboxes WHERE tenant_id = ? AND released_at IS NULL` (`billing.ts:842-845`), then SETS the Stripe mailbox line-item quantity to it. In direction B — a `mailboxes` row alive for a mailbox the vendor no longer holds — the phantom row is a **billed unit on the customer's invoice**, every month, until someone notices. Above the floor of 5 the mapping is 1 phantom row = 1 billed mailbox.

Reachable on an ACTIVE tenant from a cron path: `deliverability-actions.ts`'s `REPLACE_DOMAIN` releases the burning domain's mailboxes, provisions replacements, and calls `syncMailboxQuantity` in its `finally` ("§7.1 sync placement — the meter reflects reality in EVERY branch"). A release that fails leaves `released_at` NULL (see Finding 2) while the replacements are added, so the customer is billed for both.

**Verification:** traced `syncMailboxQuantity` → `provisionedMailboxCount` → `billableMailboxes`; read the `finally` block at `deliverability-actions.ts:295-300`.
**Disposition:** C14 moves OUT → IN, as the *consumer* that converts C's divergence into customer money. Rank C dir-B above dir-A for customer harm.

### FINDING 2 · `RealMailboxPort.release()` is NOT idempotent — it manufactures the phantom billable rows of Finding 1

`engine/lifecycle.ts:262` awaits `ctx.adapters.mailbox.release(...)`, then revokes credentials, then marks `released_at` (`:268-273`). The comment at `:265` states: *"Revoke BEFORE marking released_at (i3i4-r2): a crash in between leaves the row unmarked -> a retry re-attempts release + revoke (both idempotent)."*

**"Both idempotent" is FALSE for `release`.** A second `release()` for an already-released address runs `resolveMailboxUid` → `findExactMailbox` → the vendor no longer lists it → `{kind:"absent"}` → `throw new VendorError('inboxkit has no mailbox matching …', false)` (`mailbox-port.ts:319-321`) — **permanent**. `forEachIsolated`'s `onItemError` logs `MAILBOX_RELEASE_FAILED` and moves on; `released_at` is never written; `markMailboxIntentsReleased` deliberately skips failed addresses. The row is billable forever, with an activity row and no operator alert.

This is precisely the ambiguity `cancelWarmup` closed for itself (`mailbox-port.ts:191-206`: absence from `results.success` is AMBIGUOUS between "failed" and "already done", disambiguated by ASKING the vendor). `release()` is the sibling that never got the fix — and for a release, "the vendor has no such mailbox" IS the goal state.

**Verification:** traced `lifecycle.ts:216-296` against `mailbox-port.ts:264-273` and `:317-331`. Why every suite is green: `sandbox/mailbox-port.ts:63-68` returns unconditional success and contains ZERO throws, so no test can drive the second-release path.
**Disposition:** NEW member of C (dir B), of A (an operator/goal-state condition graded permanent), and it refutes E's ledger line "spend-stopping calls (`release`, `cancelWarmup`) are OUT by construction" — the axis that matters is *what a retry after a crash does*, not *whether this call spends*.

### FINDING 3 · Class A's widest member is unlisted: HTTP 401 / 402 / 403 at the root grader

`inboxkit-errors.ts:24` is `const retryable = status >= 500 || status === 429`. Every other status is permanent, including:
- **401** — an expired/rotated InboxKit JWT. The file's own doc comment cites the live shape `401 {"code":401,"message":"jwt malformed"}`. The API key IS a raw JWT (`inboxkit-client.ts:10-15`).
- **402 Payment Required** — the canonical funding refusal.
- **403** — a suspended/delinquent workspace.

Blast radius is the whole platform, not one tenant: one stale credential makes every InboxKit call throw permanent, which `error-response.ts:164` renders to every customer's agent as *"Retrying as-is will not help — check your inputs"* and `provisioning.ts:808-837` writes as terminal `setup_failed` rows. The sweep listed the funding arm and `oauth-mint.ts` but never the auth arm at the root.

**Verification:** read `inboxkit-errors.ts:23-27` and `error-response.ts:156-169`; executed nothing (pure static, unambiguous).
**Disposition:** ADD to A's IN list, at the top. Costs nothing to include in the same fix.

### FINDING 4 · E4 `findAdoptableDomain` is a MIS-TAGGED OUT — its inconclusive arm folds toward the billed effect

Cited by the sweep as a compliant template ("ask the vendor before buying"). It is the opposite. `engine/provisioning.ts:148-162`:

```
try { owned = await ctx.adapters.domain.listOwnedDomains(); }
catch (err) { …logAction("DOMAIN_ADOPT_LOOKUP_FAILED", …, "could not check existing domains — continuing with a new domain purchase"); return null; }
```

`return null` means "nothing to adopt", and the caller (`provisioning.ts:289-299`) proceeds straight to `domain.buy` — the registrar purchase. A pre-check that cannot complete authorizes the billed effect. This is the exact fold two sibling paths explicitly refuse: `warmupSubscriptionState` ("`inconclusive` is deliberately NOT folded into `absent`", `mailbox-port.ts:232-238`) and `confirmVendorOwnership` ("it cannot be asked → retry later, spend nothing", `mailbox-provisioning.ts:306-310`).

**Self-refutation applied:** the vendor may reject a duplicate registration ("already owned by your team" is named in `inboxkit-domain-port.ts:170-173`), in which case the outcome is not a double-charge but a *permanent* `domains/register` failure at `:244` — i.e. it lands in class A instead. Both directions are defects; which one occurs is vendor behaviour this pass could not test without spending.
**Disposition:** E4 moves OUT → IN. It must NOT be cited as a template. Whether it double-charges is UNVERIFIABLE (see Part 4).

### FINDING 5 · Class A's guard, as written, would REOPEN the vendor-verdict class

A's proposed guard: *"shared grader taking status+body, all 9 branches route through it."* Two problems.

**(a) The count is wrong.** Of the 11 cited sites, only 6 actually hard-code `retryable:false` from a 200-envelope read. The others:
- `mailbox-port.ts:212` — `cancelWarmup`'s success branch; its throw at `:218` is `retryable: **true**`.
- `mailbox-port.ts:250` — `warmupSubscriptionState`: `if (body.error) return "inconclusive"` — no throw at all.
- `mailbox-port.ts:357` — `findExactMailbox`: `if (body.error) return {kind:"inconclusive"}` — no throw at all.
- `inboxkit-domain-port.ts:197` — `listDomainRecords` throws `retryable: **true**`.

**(b) Routing (a)'s non-throwing sites through a throwing grader is the regression.** `mailbox-port.ts:333-352` documents at length why `findExactMailbox` returns `inconclusive` rather than throwing or reporting absence: `'absent'` is the ONE verdict that authorizes an automatic re-buy, and conflating it with a failed lookup buys a second paid mailbox. That is the vendor-verdict class, closed 2026-08-14. A mechanical "all branches route through the shared grader" pass reopens it.

**Verification:** read every cited line; compared against the class-fix rationale in `mailbox-port.ts:333-352` and `:224-238`.
**Disposition:** the A guard must be scoped to *throwing* branches only, and must carry an explicit exemption note for the two `inconclusive` returns and the two retryable throws.

### FINDING 6 · Class B: the endpoint EXISTS, the field names in the fix sketch do not

Live probe, read-only, `GET https://api.inboxkit.com/v1/api/billing/wallet` → HTTP 200:

```json
{"error":false,"message":"Wallet Details","total_credits":91,"credits_used":35,
 "credits_remaining":56,"auto_topup_enabled":true,"auto_topup_mode":"threshold",
 "auto_topup_trigger_drops_below":10,"auto_topup_add_credits":25}
```

The sweep's guard specified `{creditsRemaining, autoTopupEnabled}`. The live fields are **`credits_remaining` / `auto_topup_enabled`** (snake_case, like every other InboxKit payload). Shipping the camelCase reader against `return body as T` yields `undefined` — which is class F reproducing itself *inside* the fix for class B, silently (a `undefined < floor` comparison is `false`, so the wallet check would report healthy forever).

Also settled by the same probe: `/wallet`, `/wallet/balance`, `/billing/balance`, `/billing/credits`, `/credits` all 404 — `/billing/wallet` is the only path. The wallet is currently funded (56 credits) with auto-topup ON at a threshold of 10, which lowers B's *present* urgency without touching the class.

**Disposition:** B's guard is buildable; correct the field names and add `auto_topup_mode` / `auto_topup_trigger_drops_below` to the health predicate (a wallet at 12 credits with a trigger of 10 is healthy; one at 12 with auto-topup OFF is not).

### FINDING 7 · Class B's headline test is PREMISE-WRONG: `spendCostCents('warmup') > 0` double-counts

B proposes the RED test `spendCostCents('warmup')>0`. `DEFAULT_COST_MAILBOX_CENTS = 690` is documented as *"slot amortized ($39/10) + $3/mo warmup add-on"* (`spend-ceiling.ts:44`) = 390 + 300. The live warmup subscription confirms the price: `"price_per_month": 3`. So the warmup add-on is ALREADY inside the mailbox reserve, and the `0` at `:99` is deliberate and correct for our $ ceiling.

Making it non-zero without reducing `COST_MAILBOX_CENTS` reserves the add-on twice against the $150/month ceiling, shrinking real provisioning capacity by ~$3 per mailbox — an over-restriction that surfaces as spurious `capacity_pending` rejections. More to the point, it fixes nothing about class B, whose subject is the vendor's **credit wallet**, a resource `spendCostCents` cannot express at any value.

**Verification:** read `spend-ceiling.ts:43-101`; cross-checked the $3 against the live `/warmup/list` subscription object.
**Disposition:** DROP that test. B's real RED tests are the other three (checks contain `vendor_wallet`; wallet below floor → alert; money-out over cached balance refused before the vendor call).

### FINDING 8 · Class F: an `undefined` body escapes `VendorError` grading entirely

`inboxkit-client.ts:83` is `const body: unknown = await res.json().catch(() => undefined);` followed by `return body as T` at `:87`. A 200 whose body is empty, truncated, or non-JSON (a CDN/proxy interstitial) yields `undefined`. Every call site then evaluates `body.error` / `body.success` / `body.subscriptions` on `undefined` → **`TypeError`, not `VendorError`**.

That matters because the whole grading, terminality and customer-message machinery keys on `VendorError`: `error-response.ts` falls through to `{status:500, error:"internal error"}`; `setup-terminality.ts` never sees it; `vendor-failure.ts` cannot derive the abstract step. The sweep captured this shape for Stripe (F17, "TypeError not graded error") but not at the InboxKit seam, where it is systemic across all 15 call sites.

**Verification:** read `inboxkit-client.ts:53-88` and `error-response.ts:171`.
**Disposition:** ADD to F's IN list, adjacent to F3 — the schema-at-the-seam fix closes it only if the schema runs on `undefined` too (i.e. parse before the cast, not after a truthiness guard).

### FINDING 9 · F13 belongs IN, not UNCERTAIN: oauth-mint step 1's response is discarded

`oauth-mint.ts:96-98`:

```ts
await this.client.request("mintGmailGrant.clientIdRequest", "POST", CLIENT_ID_REQUEST_INITIATE, { body: {…} });
```

No type parameter, no assignment, no `body.error` check. InboxKit's app-level failures are 200-`{error:true}` (documented at `inboxkit-errors.ts:11-14`), so a *failed* client-id registration is indistinguishable from a successful one and step 2 proceeds regardless. The sweep filed this as UNCERTAIN because the field names are guesses — but the envelope-ignored half is certain *whatever* the field names turn out to be, and is provable statically.

**Disposition:** F13 moves UNCERTAIN → IN (the envelope check), retaining UNCERTAIN status only for the field mapping.

### FINDING 10 · Class D: two missed members outside the sweep's glob roots

D's proposed guard globs `routes/admin-*.ts`, `admin/*.ts`, `engine/{provisioning-state,tenant-messages,ops-summary}.ts`. Both members below sit outside it, so the tripwire would ship GREEN over them.

**(a) `apps/dashboard/src/pages/InboxPage.tsx:75` + `:191`.** `const unreadCount = useMemo(() => rows.filter(r => r.markStatus !== "read").length, [rows])`, rendered as `{unreadCount} unread`. `rows` is the accumulated pages of an *infinite* query, so the number is "unread among what has been fetched so far" presented as a total, with no scope marker — the D shape exactly, one layer up from the API.

**(b) `apps/engine/src/router.ts:60-63`.** `GET /v1/intents` returns `{ parked: engine.listParkedIntents() }`. The sibling `POST /v1/intents/resolve` resolves *"parked or dangling"* keys (`router.ts:70`, `engine.ts:335`) — so DANGLING intents (a transport accepted the send but the record was lost; the duplicate-send risk state) have **no read surface at all**. An operator must already know the key to resolve one.

**Verification:** read both files; cross-checked `listParkedIntents` vs `resolveIntent` in `engine.ts:326-336`.
**Disposition:** ADD both to D. Widen the guard's glob roots to `apps/dashboard/src/**` and `apps/engine/src/**` — `test/loop-isolation-coverage.test.ts:16-21` already demonstrates the three-root glob pattern to copy.

### FINDING 11 · D1 and D8 are LIVE-CONFIRMED on production (not merely code-read)

Driven against the live admin API with the `coldrig/admin-token` credential.

`GET /admin/tenants/ten_91aab24a-…/provisioning-state` → HTTP 200, and the response's `requestIdempotency` field is **`[]`** — for a tenant that demonstrably provisioned two mailboxes. That is D1 on the wire: the field name promises the tenant's idempotency claims, the query is `LIKE 'setup_infrastructure:%'` (`provisioning-state.ts:121-128`), and per-mailbox `provision:mbx:` claims are invisible. An operator reads "no claims exist."

`GET /admin/ops/digest` → HTTP 200 with **`"provisioningFailureCount": 0`**, concurrently with `GET /admin/ops/checks` reporting `domain_dns_aging:goauthorpitchdesk.com` UNHEALTHY for **525 hours** ("It was paid for and no mailbox will come up on it until it is replaced"). D8's hardcoded literal, serialized as a measurement, on production, today.

Third, from the same `checks` payload: the per-address check names include `mailbox_provisioning:mordytee11@theauthorpitchdesk.com` and **nothing for mordytee12** — while the vendor lists `mordytee12@theauthorpitchdesk.com` as `status:"active"` with `renewal_cycle:"monthly"`, `renewal_date:"2026-09-17"`. Class C direction A, live, billing, invisible to every check name the platform emits.

### FINDING 12 · C's completeness: `InfrastructureStatus` is a second dir-B consumer

`engine/infrastructure-status.ts:68-104` returns `domains: number` and `mailboxes: number` to the CUSTOMER's agent, both derived purely from platform rows (`SELECT COUNT(*) FROM domains WHERE tenant_id = ? AND status != 'released'` and `gatherMailboxHealth`'s local SQL). In direction B the customer's agent is told it holds infrastructure the vendor no longer holds, and acts on it. This is correctly OUT of class D (the field names match the platform-state scope), but it belongs in C's consumer list beside C14.

### FINDING 13 · A's "quintet" is a quartet, plus an unlisted fifth leg

Settled by reading `schema.ts:1091-1126`: `tenant_messages.severity` is `TEXT NOT NULL` with **no CHECK constraint** — the three rungs are a TypeScript union only, enforced at the emit helpers. So a new 4th severity rung needs **no migration**.

But the same schema comment names a leg the sweep's quintet omits: the operator admin route caps its own INPUT at `'info' | 'action_required'` via `admin/schemas.ts`'s `AdminOperatorMessageInput`, deliberately, so a human cannot assert `terminal` through a free-text surface. A new rung must make an explicit ruling about whether that input cap admits it.

**Disposition:** the moving set is `TenantMessageSeverity` (TS) + `openapi.yaml:2184-2188` + `mcp/tools.ts:86` + `:350` + `AdminOperatorMessageInput`. No DDL.

---

## Part 3 — Settlements of the cross-sweep unsettled list

**#3 — E10 `createStripeCheckoutSession` caller → OUT, with a caveat.** `engine/billing.ts:161-183`'s `startCheckout` rejects with a `ValidationError` when `billingState === "active"`, so the already-paying double-subscription (adversary NB#3) is closed. A Checkout *Session* is not itself a charge — an uncompleted session expires costing nothing — so it fails class E's "billed effect" test. **Caveat:** the guard only covers the already-active state; a tenant in `none`/`canceled`/`past_due` that POSTs `/checkout` twice receives two live session URLs, and `applyStripeEventEffects`'s `checkout.session.completed` branch (`billing.ts:642-656`) uses `stripe_subscription_id = COALESCE(?, stripe_subscription_id)`, so a *second* completion keeps the FIRST subscription id while the second subscription bills unreferenced. Reachable only if two sessions are both paid. Record as a NON-BLOCKING NEW observation, not a class E member.

**#5 — dmhadvisor.com → SETTLED (and it exposes a bigger gap).** Vendor side (`POST /domains/list`): `{"name":"dmhadvisor.com","status":"scheduled_for_deletion","connection_type":"connected","assigned_mailboxes":0,"price":0}`. Platform side: `GET /admin/tenants/ten_91aab24a-…/provisioning-state` returns rows for `theauthorpitchdesk.com` and `goauthorpitchdesk.com` **only** — the pilot tenant does NOT claim dmhadvisor.com.

Whether some *other* tenant claims it is **operationally unanswerable**: the admin surface exposes exactly twelve paths and none of them lists tenants (`/admin/ops/{checks,digest,dunning-sweep,waitlist}`, `/admin/screening/reviews`, `/admin/sdn/ingest`, `/admin/support/{digest,triage}`, `/admin/tenants/:id/{messages,provisioning-state,screening,terminate}`). Every per-tenant read requires already knowing the id, and the digest reports **63 tenants**. That unanswerability is stronger evidence for C+D than the dmhadvisor instance itself would have been.

Separately settled: `scheduled_for_deletion` IS in `TERMINAL_TOKENS` (`vendor-lifecycle.ts:62`), so C7's gap is the missing *poll*, not a classification error. And `goauthorpitchdesk.com` is a live both-sides-agree stranding: vendor `active/purchased/assigned_mailboxes:0`, platform `status:"active", dnsStatus:"pending", dnsCheckCount:0, dnsFirstCheckedAt:null`, $12.50 registered 2026-08-04, renewing 2027-08-04, 525h unhealthy.

**#6 — `/mailboxes/list` workspace enumeration → SETTLED, C stage 2 is FEASIBLE.** `POST /mailboxes/list {"page":1}` with no keyword → HTTP 200 enumerating the workspace: `{error, message, current_page, mailboxes[], total, pages, limit}`, `total:2`, `pages:1`, **`limit:10` by default**. Each row carries `uid`, `username`, `domain_name`, `status`, plus vendor billing state (`renewal_date`, `renewal_cycle`, `renewal_status`, `prepaid_until`). So the bidirectional diff needs only a `listMailboxes()` port method over the existing client — no new endpoint, no new auth. **Two cautions for the builder:** pass an explicit `limit` (the default 10 would silently truncate a paged walk into a false "vendor holds nothing"), and model the walk on `inboxkit-domain-port.ts:191-213`, which THROWS at the page ceiling rather than under-reporting.

**#8 (bonus, settled by the same pass) — `data.status:"inactive"` on the health endpoint is ACTIVITY, not lifecycle.** Live: `GET /email-insights/mailbox/{uid}/health` returns `status:"inactive"` with `total_7d:0`, `total_30d:0`, `last_event_at:"0001-01-01T00:00:00Z"` for a mailbox whose `/mailboxes/list` `status` is `"active"`. A fix that feeds this field into `classifyVendorLifecycle` would be reading an idleness signal as a lifecycle verdict.

**#9 — `tenant_messages.severity` DB constraint → NONE.** See Finding 13.

**#10 — `vendor_spend_entries.kind` union → NO CHECK constraint.** `migrations/0011_vendor_spend_ledger.sql`: `kind TEXT NOT NULL` (and `status TEXT NOT NULL`), no enum, no CHECK. Adding a `SpendKind` arm needs no migration. Confirmed in the same read: C12 holds — the table's columns are `id, period_key, tenant_id, kind, est_cents, actual_cents, status, created_at, updated_at`, carrying **no resource identity** (no email, domain or vendor uid), so a D1-only spend-to-resource reconcile is unbuildable until a column is added.

---

## Part 4 — Consistency rulings across classes

**No two classes prescribe conflicting fixes at the same site.** The one apparent collision — A wanting a shared throwing grader at `mailbox-port.ts:250/:357` while the vendor-verdict class requires an `inconclusive` return there — is resolved in A's favour only if A's guard is narrowed to throwing branches (Finding 5). Written as-is, A loses.

**`?raw` tripwire collisions: fewer than feared, one hard pin.** The repo already carries ~25 `?raw` structural guards, not two. The new A/D/E tripwires do not overlap any of them by glob. The one hard interaction is `test/spend-ceiling-coverage.test.ts:87`: `expect(allSites.length).toBe(3)` pins the money-out site count, and that file's `SPEND_CALL_PATTERNS` + `SPEND_SOURCES` lists are hand-maintained. Any B or E fix that adds, moves or renames a money-out call turns it RED — intended, but it must move in the same commit. Note also that `test/loop-isolation-coverage.test.ts:16-21` already globs platform + engine + packages, so the three-root pattern D needs (Finding 10) exists to copy.

**B's cached-balance reserve vs. the just-shipped `abortedAt` / `capacity_pending` semantics — NOT a reopen, but the wording is wrong.** Routing a wallet refusal through `CapacityPendingError` is structurally right: `ecebd79` made `abortedAt` outrank `failures[0]` at both isolation loops precisely so a ceiling breach surfaces as `capacity_pending` instead of being masked, and a wallet refusal is the same shape. But `rejectCapacity` (`spend-ceiling.ts:192-220`) takes `reason: "spend_ceiling" | "slot_capacity"` and emits, to the founder, *"raise SPEND_CEILING_CENTS or upgrade InboxKit"* and, to the customer, *"this account has reached its monthly provisioning limit"* — both false for a vendor wallet shortfall. B's fix needs a **third `reason` arm with its own two sentences**, not a reuse of either existing one.

**Direction-of-error warning on B's pre-flight refusal.** A cached balance refusing a purchase *before* the vendor call writes a PERSISTED tenant state (`provisioning_state='capacity_pending'`, `spend-ceiling.ts:133-142`) and fires a founder alert. The live wallet has `auto_topup_enabled:true` with a trigger at 10 credits, so a stale cache can easily say "3 credits" when the vendor has already refilled to 28 — an over-block into a persisted sink, which is not fail-safe. The cached balance must be treated as a *floor with a staleness bound* (refuse only when the cached value is both below floor AND fresh), never as an authority.

**C stage-1's per-address check names do NOT collide with the alert-policy debounce.** Attacked and held: `watchtower_state` is already keyed by per-entity names in production (`domain_dns_aging:<domain>`, `mailbox_provisioning:<email>`, `tenant_do_wedged:<id>` all appear live), migration `0018_watchtower_debounce.sql` adds only two per-row counters, and `policyFor` falls through to the default 2-observation debounce for an unrecognised name — which is the correct policy for an orphan check. One scale note, not a collision: `GET /admin/ops/checks` returns every row unpaginated (13 today, 63 tenants), so per-address orphan checks across the fleet will grow that response without bound.

**No fix sketch reopens a closed class**, with the single exception in Finding 5.

---

## Part 5 — Attacks that FAILED (the OUT tags that held)

- **F7 `findExactMailbox` — HELD.** Live `POST /mailboxes/list` rows carry `uid`, `username`, `domain_name`, `status` — every field the adapter reads, all present.
- **F9 `warmupSubscriptionState` — HELD.** Live `POST /warmup/list` returns `subscriptions[]` with `mailbox.uid`, `mailbox_email`, `status`, plus `total`/`pages`/`current_page` — matching `ListWarmupSubscriptionsResponse` exactly.
- **F11 `startWarmup` non-finite guard — HELD.** `subscription.started_at ?? subscription.createdAt` → `Date.parse` → `!Number.isFinite` throws loud. Correct whatever the wire shape is, including when both fields are absent.
- **F1's *narrowed* blast radius — HELD.** `getHealth` has exactly one caller (`infrastructure-status.ts:127`); the deliverability loop uses `gatherMailboxHealth`, which is local SQL. Grepped all call sites.
- **E3 `dispatchBuy` as a template — HELD.** `claimBuyDispatch` (`provision-intents.ts:301-326`) increments and reads in one `RETURNING` statement before the vendor call. Genuinely compliant.
- **D12 `listMessagesForOperator` as a template — HELD.** `total` is computed over the same `where` and the same binds as the page. Genuinely compliant.
- **`apps/engine/src/graph.ts` (F's admitted gap) — HELD, genuinely OUT.** It reads no response fields: success is a bare 202 and the body is ignored. Its dependencies are compliant too — `oauth.ts:57` typeof-checks `access_token` and throws, `api-send.ts` branches on status only.
- **Vendor inventory beyond InboxKit/Stripe/engine — no new money-out vendor.** Enumerated every external host in source: InboxKit, Stripe, the cold-engine Worker, `graph.microsoft.com` + `login.microsoftonline.com`, `gmail.googleapis.com` + `oauth2.googleapis.com`, `challenges.cloudflare.com` (Turnstile), `treasury.gov` (OFAC SDN CSV). None is a money-out surface; the Google/Microsoft legs send mail on the customer's own grant.
- **"Free ops can't produce funds refusals" — no counterexample found.** `/warmup/cancel`, `/mailboxes/cancel`, `/domains/remove` are spend-stopping; `/mailboxes/list`, `/domains/list`, `/warmup/list`, `/domains/available`, `/email-insights/…/health`, `/domains/nameservers` are reads/config. The three wallet-drawing calls are exactly the three already inventoried (`use_wallet_balance:true` at `mailbox-port.ts:64` and `inboxkit-domain-port.ts:228`, plus credit-priced `/warmup/add` — live-confirmed at `price_per_month: 3`). The *related* hole is real but different, and is Finding 3.
- **`scheduled_for_deletion` classification — HELD.** Present in `TERMINAL_TOKENS`.
- **C's per-address check-name scheme vs. the debounce table — HELD** (see Part 4).

---

## Part 6 — UNVERIFIABLE (carried forward; never folded into a verdict)

1. **The funds-refusal wire shape on `/mailboxes/buy`** (non-2xx vs 200-`{error:true}`). Requires draining the wallet or a live capture during a founder top-up. The fix must handle both paths regardless. *(Unchanged from the sweeps.)*
2. **`/warmup/cancel` semantics under duplication** (E1). If two subscriptions exist for one mailbox, does one cancel clear both? Vendor question. Until answered, E1's remediation cannot be assumed self-cleaning.
3. **Whether a duplicate `/domains/register` double-charges or refuses** (Finding 4). Decides whether E4 is a money bug or an A-class false-permanent. Resolved by a vendor answer, or by a test-mode register of an owned domain if InboxKit offers one.
4. **What HTTP status a delinquent/suspended InboxKit workspace returns on READS** (Finding 3's 402/403 arm). Decides whether the auth arm is one-tenant or whole-fleet. Resolved by asking InboxKit support; do not induce it.
5. **`oauth-mint` endpoint reality** (E12/F13 field mapping). Both endpoints are documented-shape guesses; assume broken until a live mailbox confirms.
6. **Whether train-6 S1 bounds `listAllTenantIds`** (D14 guard ordering). Needs the train-6 spec, which is out of this pass's scope.
7. **Which tenant, if any, claims dmhadvisor.com.** No admin surface enumerates tenants (Part 3, #5). Resolved by a cross-tenant read surface — which is itself a D deliverable.
8. **A second `/warmup/add` for an already-enrolled mailbox** (E1's realized cost). Testing it costs $3/month recurring at the vendor; not attempted.

---

## Part 7 — NEW observations (out of scope, no verdict weight)

- **`api-send.ts:78` is class A INVERTED.** Every unrecovered provider failure — including a permanent 400 or a revoked-grant 403 — becomes `UpstreamTransientError` (HTTP 503), so the engine retries a permanently-broken send under its cap forever. Opposite direction to class A, same root question (a two-valued grade for a three-valued fact).
- **Double Checkout Sessions before first activation** — see Part 3, #3.
- **`GET /admin/ops/checks` is unpaginated** with no `total` — 13 rows today across 63 tenants; per-entity check names will grow it without bound.
- **`workspaces/list` reports `use_shared_billing: true`** on the single "Starter" workspace, meaning the wallet is shared across any future workspace. A per-workspace balance model would be wrong from day one.
- **`goauthorpitchdesk.com` has been stranded 525h** ($12.50 paid, renews 2027-08-04, zero mailboxes) and `mordytee12` is billing monthly with no warmup subscription and no platform check name. Both are live instances the fix wave can use as acceptance fixtures.
