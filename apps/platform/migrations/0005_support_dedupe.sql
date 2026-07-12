-- B4 (CLASS B) — inbound support-ticket idempotency. A support message arrives
-- from an at-least-once channel (Cloudflare Email Routing redelivery, a client
-- retry): dedupe on the source RFC 5322 Message-ID so the same inbound email
-- can't create two tickets. Scoped to (tenant_id, message_id), NOT message_id
-- alone: Message-IDs are only unique per SENDER, so a global unique index would
-- drop a SECOND tenant's ticket that happened to reuse the same Message-ID. The
-- support_tickets table is the SHARED control-plane table, so tenant-scoping the
-- index is mandatory (CLAUDE.md rule h). `message_id` is NULLABLE — operator/
-- console-created tickets have no source Message-ID, and SQLite treats NULLs as
-- DISTINCT in a unique index, so those never collide (only real inbound messages
-- with a resolved tenant dedupe; an unresolved-tenant inbound email — tenant_id
-- NULL — likewise stays distinct, an accepted trade for the cross-tenant fix).
ALTER TABLE support_tickets ADD COLUMN message_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_support_tickets_message_id ON support_tickets(tenant_id, message_id);
