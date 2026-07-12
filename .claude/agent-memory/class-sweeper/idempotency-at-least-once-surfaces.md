---
name: idempotency-at-least-once-surfaces
description: Search-coverage ledger — surfaces that UNDER-COUNT when sweeping the "non-idempotent at-least-once external input" class in coldstart. Read FIRST, cover these before grepping.
metadata:
  type: reference
---

Sweep the "non-idempotent processing of at-least-once external inputs" class in `~/dev/coldstart`. Cover these surfaces FIRST — each hides members that `grep .poll(` / `grep INSERT INTO` alone miss:

1. **Activation-latent inputs** (exactly-once NOW, at-least-once at activation). The sandbox delivers exactly-once so the whole class is invisible in tests. The live members surface only by reading each adapter's REAL contract + activation wiring comment:
   - `SandboxEmailPort.poll` clears its queue on read (`set(email, [])`) → never redelivers; real IMAP is at-least-once (`packages/shared/src/vendor-ports.ts:126` "returns and clears"). The `events` table (`schema.ts`) has no dedupe key → confirmed bug.
   - `admin/support/triage` is operator-driven now, but its activation path is "Cloudflare Email Routing → this endpoint" (`routes/admin-support.ts:12`) = at-least-once inbound email, `insertSupportTicket` has no Message-ID dedupe.
   - `reportUsageRecord` (`billing/stripe-client.ts`) sends NO Stripe `Idempotency-Key` header + `action:increment` → double-bills at activation. Local ledger IS keyed (source_send_id); the Stripe mirror is NOT.

2. **Fake idempotency keys** — an idempotency key that embeds `:${now}` / a nonce LOOKS deduped but defeats itself. `threads.ts:137` `manual-reply:${tenantId}:${threadId}:${now}` → every retry = new key = double send. Must READ key construction, not just grep for the key.

3. **Client-retry variant ≠ vendor-redelivery variant.** Intent endpoints (`setup_infrastructure`, `launch_campaign`, `reply`) dedupe VENDOR spend (buy/provision/send keyed) + ledger (INSERT OR IGNORE source_send_id) but the DB row inserts (`domains`/`mailboxes`/`campaigns`/`leads`/`scheduled_sends`) use fresh `newId()` with no request-level idempotency key → retry double-inserts infra/campaign rows (launch_campaign retry = real duplicate sends). No `Idempotency-Key` header enforced at any route or in the MCP `tools/call` handler.

Well-guarded (OUT, don't re-flag): `webhook_events`/`disputes`/`dunning_events`/`enforcement_actions` (PK/UNIQUE dedupe), `ledger_entries` (source_send_id UNIQUE), `suppressions`/`thread_marks`/`waitlist` (PK upsert), `teardown_records` (existence anchor), tick 'sent' event (pending→sending claim), `evaluate()` deliverability actions (idempotent by construction, `deliverability.ts:126/144/156`), `initTenant` (`if(this.tenantId)return`).
