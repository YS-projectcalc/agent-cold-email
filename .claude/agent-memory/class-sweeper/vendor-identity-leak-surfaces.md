---
name: vendor-identity-leak-surfaces
description: Where vendor-identity (inboxkit/endpoint-path/internal-host) leaks hide in ColdStart — the throw boundary is guarded, the stored-then-surfaced columns are not. Read before any vendor-abstraction / error-message sweep.
metadata:
  type: reference
---

Founder rule (2026-08-05): customer + their agent must NEVER learn the upstream vendor (InboxKit, Stripe-as-wallet, Cloudflare). Class = any customer/agent-reachable string revealing vendor identity OR internal impl (literal "inboxkit", endpoint paths `domains/register`|`mailboxes/buy`|`warmup/*`|`domains/nameservers`, `api.inboxkit.com`, `ENGINE_BASE_URL`/internal 10.x hosts, env-var names).

**The throw→response boundary IS guarded (don't re-flag it):** REST `index.ts:151 onError` and MCP `mcp/handler.ts` BOTH funnel every named error through `error-response.ts toErrorResponse`, which genericizes the `VendorError` message (H6/N2, 2026-08-05). All `VendorError` subclasses set their own `.name` → each has a safe case. MCP raw-message fallthrough only fires for a thrown non-Error (name==="") — low risk.

**The leak lives OFF the throw path — vendor errors CAUGHT and put into a value:**
1. **Stored-then-surfaced via `deliverability_actions.detail_json`** — written by `logAction` (deliverability-actions.ts:38), surfaced to the customer TWICE: `getActivityFeed` (activity.ts → `activity` tool) AND `getAccount().deliverability.recentActions` (reporting.ts → `account` tool). Any `logAction(..., { reason|error: err.message })` where err is a VendorError leaks. Sites: provisioning.ts DOMAIN_DNS_PENDING/DOMAIN_ADOPT_LOOKUP_FAILED/MAILBOX_HEALTH_UNAVAILABLE, deliverability-actions.ts REPLACE_DOMAIN_FAILED, warmup-cancel.ts WARMUP_CANCEL_FAILED/GAVE_UP.
2. **Returned in a success payload** — `getInfrastructureStatus().mailboxHealth[].vendorHealthError` (provisioning.ts). Field comment says "for the operator" but it ships in the `infrastructure_status` tool result — the one endpoint the agent is told to poll.
3. **`events.metadata_json`** — also surfaced by `getActivityFeed` (SELECT `metadata_json as detail_json`). tick.ts failed-send event stores `reason: err.message` (engine send error → `ENGINE_BASE_URL`). Bounce `reason` at reply-processor.ts is recipient DSN text, NOT vendor identity → OUT.

**The guard file itself leaks endpoint paths:** `error-response.ts CUSTOMER_SAFE_STEPS` is the InboxKit endpoint-path taxonomy verbatim (`domains/register`, `mailboxes/buy`, `warmup/add`, `domains/nameservers`…) and emits those tokens as the customer `step`. Fingerprint. Fix = map to abstract labels ("domain registration", "mailbox purchase", "warmup enrollment").

**Surfaces that look scary but are OUT:** `webhook_deliveries.last_error` (webhooks.ts:135) = the customer's OWN webhook endpoint error, no vendor identity. `mailbox_cred_pushes.last_error` = internal reconcile only (never SELECTed by a customer surface; ops-summary only COUNTs pending). `registrar-alert.ts` = founder ops email. `ops-summary.ts` = owner digest. Adapter throw strings in `vendors/real/*` = fine as long as toErrorResponse stays the only boundary.

**Docs are clean:** AGENTS.md (repo root), site/llms.txt, site/openapi.yaml, mcp/tools.ts descriptions — zero vendor strings (verified 0d48fbe). `.claude/worktrees/*` are stale agent copies — ignore.

**Guard-test model:** `test/send-governance-coverage.test.ts` — `import.meta.glob("../src/**/*.ts", { query:"?raw", eager:true })` lexical tripwire. Reuse for a customer-string vendor-name scan.
