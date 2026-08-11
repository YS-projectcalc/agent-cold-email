-- msgchannel Inc5 (founder-ratified 2026-08-11) — agent->operator direction.
-- Distinguishes an agent-authored support_tickets row (written by the new
-- contact_operator MCP tool / REST route, engine/contact-operator.ts) from
-- the existing email-inbound (support-inbound.ts) / console-triage
-- (routes/admin-support.ts) rows. DEFAULT 'email' keeps every existing row's
-- meaning unchanged — neither existing writer sets this column, so they stay
-- 'email' by default; 'agent' is written ONLY by engine/contact-operator.ts.
ALTER TABLE support_tickets ADD COLUMN source TEXT NOT NULL DEFAULT 'email';

-- The ops-email throttle anchor (CLAUDE.md's "cry-wolf" guard — at most one
-- ops email per tenant per 10 real-world minutes for agent-originated
-- tickets, engine/contact-operator.ts). Set to the real send time on the
-- ticket whose contact_operator call actually triggered an email; NULL means
-- this particular ticket did NOT itself trigger one (either the throttle
-- window was still open, or it was an identical-body dedup hit that never
-- inserted a new row at all). Only ever set for source='agent' rows.
ALTER TABLE support_tickets ADD COLUMN email_sent_at INTEGER;

-- The hot query shape engine/contact-operator.ts runs on every call: this
-- tenant's own agent-sourced tickets ordered by recency (dedup lookup, the
-- 1h/5-call rate window, and the email-throttle anchor all filter on
-- (tenant_id, source) then range over created_at).
CREATE INDEX IF NOT EXISTS idx_support_tickets_agent_tenant
  ON support_tickets(tenant_id, source, created_at);
