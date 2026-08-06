# Class sweep — vendor-identity leaks to customer/agent surfaces (2026-08-05)

**Ref** `0d48fbe` main (DIRTY tree — msgchannel Inc1 uncommitted; re-pin line numbers before fixing). Founder rule: customer/agent surfaces NEVER reveal the upstream vendor (InboxKit) — abstract "provider" only; vendor identity stays in internal logs/ops. Frozen by orchestrator from sweep-vendor-leak's read-only report.

## CONCLUSIONS
1. **The throw→response boundary is ALREADY CLOSED** (don't re-fix): REST `index.ts:151 onError` + MCP `mcp/handler.ts:175` both funnel named errors through `error-response.ts toErrorResponse`, which genericizes VendorError. Verified both transports.
2. **The LIVE class is narrower: a VendorError CAUGHT and written into a value a customer read-surface later returns** — bypassing the genericizing boundary. Every real/ adapter throw embeds literal "inboxkit" + endpoint path.
3. **NEW leak the brief missed — the guard file itself:** `error-response.ts CUSTOMER_SAFE_STEPS` IS InboxKit's endpoint-path taxonomy verbatim (`domains/register`, `mailboxes/buy`, `warmup/add`, `domains/nameservers`), shipped to the customer as `step`. `step:"domains/register"` → curl api.inboxkit.com to confirm the vendor. Class must include "vendor endpoint-path tokens emitted as a structured field," not only "vendor strings in an error body."
4. toErrorResponse's generic "an upstream provider failed" is SAFE but TOO generic — dropped the actionable step+retryability signal (Mordy's complaint). Restore it via an ABSTRACT step label.

## INVENTORY (most-critical first)
| surface file:line | leak | customer-reachable? | verdict |
|---|---|---|---|
| provisioning.ts:852,904 `vendorHealthError=err.message` | raw "inboxkit …" | YES — infrastructure_status (the polled tool) | IN |
| error-response.ts:45-59,131,155 CUSTOMER_SAFE_STEPS/`step` | InboxKit endpoint-path tokens as `step` | YES — REST+MCP bodies | IN (fingerprint; the guard file) |
| provisioning.ts:399-400 DOMAIN_DNS_PENDING {reason} | "inboxkit domains/nameservers …" | YES — activity + account.recentActions | IN |
| deliverability-actions.ts:220 REPLACE_DOMAIN_FAILED {error} | raw VendorError msg | YES — activity | IN |
| provisioning.ts:334-335 DOMAIN_ADOPT_LOOKUP_FAILED {reason} | "inboxkit domains/list …" | YES — activity | IN |
| provisioning.ts:936 MAILBOX_HEALTH_UNAVAILABLE {reason} | raw msg re-stored (2nd hop) | YES — activity | IN |
| warmup-cancel.ts:105,119,126 WARMUP_CANCEL_* {reason} | "inboxkit warmup/cancel …" | YES — activity | IN |
| tick.ts:419 failed-send event metadata_json {reason} | ENGINE_BASE_URL/internal host | YES — activity | IN (internal-host member) |
| mcp/handler.ts:180-181 raw err.message when name==="" | non-Error only | not on vendor path | UNCERTAIN (low; keep guard) |
| mailbox-credential-push.ts:146,152 last_error | engine push err | NO — never customer-SELECTed | OUT (confirm swallow total) |
| webhook last_error / bounce DSN / control-loop reasons / registrar-alert (ops email) / adapter throws / AGENTS.md,llms.txt,openapi,tool descriptions | — | no vendor identity / guarded / ops-only / ZERO vendor strings | OUT |

## SYSTEMIC GUARD (two parts)
1. **`customerSafeVendorFailure(err) → {step:<ABSTRACT label>, retryable}`** beside toErrorResponse. Map internal op → abstract: domains/register→"domain registration", mailboxes/buy→"mailbox purchase", warmup/add→"warmup enrollment", domains/nameservers→"domain DNS setup". `logAction`, the `vendorHealthError` field, and the tick failed-send event all store the ABSTRACT label, never err.message. Turn CUSTOMER_SAFE_STEPS from a passthrough Set of raw paths into this abstract-label MAP. Kills the err.message leak AND the endpoint-path fingerprint in one move.
2. **`?raw`-glob tripwire** (test/send-governance-coverage.test.ts style): no customer-surfaced literal contains /inboxkit/i, api.inboxkit, or a raw endpoint-path token; CUSTOMER_SAFE_STEPS holds no `/`-bearing token; vendor strings allowed ONLY in vendors/** + error-response.ts.

FAILING TEST: adapter.getHealth rejects VendorError("inboxkit mailboxes/… HTTP 500"); getInfrastructureStatus → JSON.stringify not /inboxkit/i, not /mailboxes\/|domains\/|warmup\//, vendorHealth==="unknown" (still names step+retryability). Fails today (raw field), passes on abstract label. + activity/account variants (DNS-pending, replace-failed, warmup-cancel).

## MESSAGES → customer-safe-but-specific (step-named + honest retryability)
- DOMAIN_DNS_PENDING → "domain DNS setup hasn't finished — retry to complete" (retryable).
- MAILBOX_HEALTH_UNAVAILABLE/vendorHealthError → "mailbox health check temporarily unavailable" (retryable); vendorHealth:"unknown".
- REPLACE_DOMAIN_FAILED → "automatic domain replacement is paused (provider issue)" (retryable).
- WARMUP_CANCEL_FAILED → "warmup cancellation is retrying"; GAVE_UP → "warmup cancellation needs operator attention" (non-retryable — honest, live recurring charge).
- tick failed-send → "delivery failed (retryable/permanent)" per grade.
- error-response VendorError body → keep generic prose BUT restore step via abstract label + retryable, not the raw path token.

## CONFIDENCE / 2nd-sweep todo
- PushOutcome.error: last_error not customer-SELECTed, but didn't trace every reconcile caller — confirm the swallow is total.
- site/ dashboard HTML not read — if it re-queries deliverability_actions/mailboxes directly (vs the getters), 2nd source of the same class.
- The `step` endpoint-path fingerprint classed IN (judgment call — they're InboxKit's literal routes); highest-value UNCERTAIN→IN for scope.
