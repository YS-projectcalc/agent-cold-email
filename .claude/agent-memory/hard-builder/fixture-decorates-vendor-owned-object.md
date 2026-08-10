---
name: fixture-decorates-vendor-owned-object
description: "CLASS: a fixture that decorates a VENDOR-OWNED object with OUR field (metadata.tenantId on a Stripe Invoice/Dispute) shares the code's false premise, so the suite is green while the lane is dead in prod — build fixtures from the vendor's documented object shape, and add a tripwire that scans test sources."
metadata:
  type: project
---

⚠️ CLASS (ColdStart Stripe webhook audit 2026-08-06, 3 BLOCKING findings; two whole
billing lanes — dunning and D5 chargeback-freeze — were inert in LIVE production for
weeks behind a 1271-test green suite).

The mechanism: `extractStripeTenantId` read `data.object.metadata.tenantId`. We only
ever set that on objects WE create at checkout (the Session and the Subscription).
Stripe MINTS Invoices and Disputes itself: an Invoice's own `metadata` is `{}` (the
subscription's metadata surfaces under `subscription_details.metadata`), and a Dispute
has `metadata: {}`, no `client_reference_id`, and NO `customer` field at all. Every
in-repo fixture hand-placed `metadata: { tenantId }` on both — the fixture encoded the
same false premise as the code, so the tests could only ever confirm it. Real deliveries
answered `200 {"applied":false}` silently.

**Why:** a fixture is supposed to be an INDEPENDENT statement of what the outside world
sends. When the person writing the fixture is the person who wrote the parser, it stops
being independent and becomes a restatement of the parser's assumptions. Green then
means "self-consistent", not "correct". Same shape as
[[sandbox-port-masks-real-server-contract]] and [[half-a-vendor-contract-invoked-on-the-other-half]].

**How to apply:** when a fix touches parsing of a payload some VENDOR generates, first
ask *who mints this object* — us or them? For a them-minted object, do not trust any
in-repo fixture; rebuild it from the vendor's documented shape for the pinned API
version and delete fields the real object does not carry. Then centralize the builders
in ONE fixtures module and add a failing-by-construction tripwire that scans the test
sources (`import.meta.glob("./*.test.ts", {query:"?raw", eager:true})` works fine in
vitest-pool-workers) for the fake shape — the fix alone does not stop the next person.

Corollaries found the same day:
- Routing a them-minted object may need an EXTRA VENDOR READ, not just a better parse: a
  Dispute reaches a tenant only via `charge` -> `GET /v1/charges/{id}` -> `customer` -> a
  D1 customer index. Grade that read's errors — 429/5xx must THROW (webhook 500s, Stripe
  redelivers), any other non-2xx must resolve "unroutable" (200 + alert), because a 500
  loop on an unroutable event burns ~3 days of Stripe retries toward endpoint
  AUTO-DISABLE, which takes billing down for every tenant.
- Index customer->tenant in a TABLE, not a column: Checkout Sessions created without a
  `customer` param mint a NEW customer each time, so a re-subscribing tenant owns several
  and a late invoice/dispute can arrive against an old one.

**2026-08-06 follow-on — the extra vendor read applies to DECISION INPUTS too, with
the OPPOSITE error grading.** Same root cause one lane over: `readDeclineCode` parsed
the decline code off the `invoice.payment_failed` payload, where `charge` and
`payment_intent` are bare id STRINGS — so it returned null on every real delivery and
the permanent-decline fast path (lost_card/stolen_card/fraudulent -> immediate suspend)
had NEVER executed. Fix = `GET /v1/charges/{id}` (`outcome.reason` is where the issuer's
decline code lives; `failure_code` is the generic card error) or, when the invoice has
no charge, `GET /v1/payment_intents/{id}` (`last_payment_error.decline_code`). Grading:
a ROUTING read must THROW on transient (lose the read, lose the tenant); a read that
only REFINES a decision with a safe default must NEVER throw and must return null on
any failure — unknown stays transient, so a Stripe 503 can never suspend a paying
customer. Bound it (`AbortSignal.timeout`), because it now sits inside the webhook's
own response.
