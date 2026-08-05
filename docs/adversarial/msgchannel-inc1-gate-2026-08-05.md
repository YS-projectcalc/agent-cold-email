# Adversary gate — msgchannel Increment 1 (system→agent message channel) (2026-08-05)

**Grounding.** HEAD `0fe2471` (main), uncommitted diff (`apps/platform/src/engine/{provisioning,mailbox-credential-push}.ts`, `mcp/tools.ts`, `schema.ts`, `tenant-do.ts` + new `engine/tenant-messages.ts` + 4 new test files). Reviewer ran the full suite: 133 files / 1215 tests passed / 0 skipped, tsc clean; probes ran in an isolated sandbox against the real compiled engine (execution, not static reading).

## VERDICT: SHIP-AFTER-FIXES — 1 BLOCKING, 1 NON-BLOCKING

## F1 — BLOCKING (guardrail A + wire-A correctness) · phantom-domain customer message on retry
On a genuine same-idempotency-key retry after a retryable DNS failure, `provisioning.ts:760` sets `inFlightDomain = usable[domainIndex]` to a FRESH candidate (look2) — `ownedDomainNames()` (`:715`) has already filtered the first-attempt domain (look1) out of `usable` because it now sits in the `domains` table. But the resume branch (`provisioning.ts:458-483`) actually re-drives `setDnsWithRetry` on look1 — the committed intent's `candidate_domain` — never on look2. So wire A (`provisioning.ts:798-807`) emits `dedupKey=look2` + body "Setup for look2.com has not finished yet…" — look2 was never bought.
- **Consequences:** (a) dedup does NOT collapse across a stuck domain — 2 `retry_setup` rows land per stuck domain instead of 1 (bounded, since the dedupKey alternates look1↔look2, not unbounded); (b) the customer-facing message is a FALSE claim about a nonexistent domain.
- **Live-reachable:** registrar armed.
- **RAN:** 3 same-idempotency-key runs against the real domain port → buys=["look1.com"] (no double-buy — intent-resume is correct on spend) but bodies=["Setup for look2.com…","Setup for look1.com…"] (the message text disagrees with itself run to run).
- **False-green cause (traced):** `retry-setup-message.test.ts:79`'s GUARDRAIL-A dedup test uses a SINGLE-candidate `DomainPort` (`searchLookalikes` always returns exactly `[tryretrysetup.com]`, `:16-34`) with `domains:1`. On retry, `ownedDomainNames()` excludes that one candidate, `usable` becomes `[]`, and `usable.length < input.domains` throws `ValidationError` (`:744-746`) BEFORE the wire-A `catch (err instanceof VendorError)` block is ever reached — the test never exercises Finding 1's path.
- **Fix direction:** source the message's domain + dedupKey from the domain the resume branch actually operates on (the intent-resolved name), OR dedup wire A on the stable setupKey/tenant rather than the volatile loop candidate; add a multi-candidate ≥2-retry test asserting BOTH row count and named domain (revert-fail-restore against the current code).

## F2 — NON-BLOCKING (wire B ↔ credstore) · no tenant-lifecycle gate
`credential_ready` ("sending is now enabled") fires with no tenant-lifecycle/billing check — `mailbox-credential-push.ts:183-197` (`reconcileMailboxCredentialPushes`) and `:108-142` (`pushRecordedMailbox`) never read tenant status.
- **RAN:** canceled tenant + a pending push in flight → false "sending is now enabled" message. Cleaner variant: a SUSPENDED (dunning) tenant's mailbox is never released, so a reconcile mid-suspension tells a frozen tenant its sending is enabled.
- **Fix:** gate wire B (or the reconcile selection) on lifecycle/billing state; dovetails with the credstore audit's F2 (mark `mailbox_cred_pushes` rows terminal on teardown) — `docs/adversarial/audit-credstore-2026-08-05.md`.

## Attacks that FAILED (why the rest of the surface holds)
- **Guardrail B (secret leak):** traced + ran leak fixtures on both wires — no `err.message`/IMAP creds/refresh token/internal host/IP/env text reaches `body` or `actionHint` on either wire; `actionHint.idempotencyKey` is the tenant's own key, JSON-escaped, single-tenant scoped.
- **Emit-on-read-path:** 5× `getInfrastructureStatus` calls, `tenant_messages` count 1→1 (confirmed pure SELECT).
- **Wire-A false-fire:** excluded on all `retryable:false` error classes and on success.
- **Tenant isolation:** `WHERE tenant_id=?` present on every message read/write path checked.
- **Regression:** 1215/1215 (reviewer's own re-run).

## UNVERIFIABLE
- Vendor `showMailboxCredentials` behavior on an already-released mailbox (shared with the credstore audit's F2).
- Live MCP-over-real-transport delivery of these messages (dark/uncommitted; no live client attached).

## NEW (out of scope, no verdict weight)
- `getInfrastructureStatus` writes a `deliverability_actions` `MAILBOX_HEALTH_UNAVAILABLE` row per degraded mailbox PER POLL — pre-existing write-on-read/rows-per-poll class, not introduced by this increment.
- Dashboard `InfrastructureStatus` DTO (`apps/dashboard/src/api/types.ts:164`) omits `messages[]` — a feature gap (the dashboard can't surface these yet), not a break.

_Increment 1 = wire A (retry_setup) + wire B (credential_ready) only; increments 2-4 (operator route, list_messages/ack_message tools, email mirror) NOT built. Source is UNCOMMITTED — not on main, not deployed. Frozen by the orchestrator from msgchannel-gate's verbatim report (read-only lane); probes ran against the real compiled engine in an isolated sandbox._
