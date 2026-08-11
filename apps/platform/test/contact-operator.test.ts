import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { RateLimitError } from "@coldstart/shared";
import { insertSupportTicket } from "../src/admin/db.js";
import { runDunningSweep } from "../src/admin/ops-sweep.js";
import { contactOperator } from "../src/engine/contact-operator.js";
import { emitOperatorMessage } from "../src/engine/tenant-messages.js";
import { SandboxOpsMailer } from "../src/ops-mail/sandbox-ops-mailer.js";
import { newId } from "../src/schema.js";
import { adminApi, api, failPayment, mintTenant, withTenantContext } from "./helpers.js";

// msgchannel Inc5 (founder-ratified 2026-08-11) — the agent->operator
// direction: MCP tool `contact_operator` (28th tool) + its REST parity route
// (POST /messages/contact-operator, both dispatching TenantDO.contactOperator
// -> engine/contact-operator.ts). Guards are best-effort/storm-guard grade
// (the brief's own "cry-wolf" framing), so these tests seed/backdate D1 rows
// directly rather than waiting real wall-clock minutes/hours.

function ticketCount(tenantId: string) {
  return env.DB.prepare(`SELECT COUNT(*) as n FROM support_tickets WHERE tenant_id = ? AND source = 'agent'`)
    .bind(tenantId)
    .first<{ n: number }>()
    .then((r) => r?.n ?? 0);
}

/** Seeds a fixture agent-sourced ticket directly (bypassing the guards) at a
 * given `createdAt`/`emailSentAt` — for rate-limit/throttle window setup. */
async function seedAgentTicket(tenantId: string, body: string, createdAt: number, emailSentAt: number | null = null): Promise<string> {
  const id = newId("sup");
  await insertSupportTicket(env, {
    id,
    fromEmail: `agent:${tenantId}`,
    subject: "seed",
    body,
    tenantId,
    category: "other",
    draft: null,
    status: "escalated",
    createdAt,
    source: "agent",
    emailSentAt,
  });
  return id;
}

describe("contact_operator (msgchannel Inc5) — the agent->operator direction", () => {
  describe("happy path", () => {
    it("engine: writes a source='agent' escalated ticket and fires exactly one ops email", async () => {
      const { tenantId } = await mintTenant("Contact Op Happy Co", "managed");
      const mailer = new SandboxOpsMailer();

      const result = await withTenantContext(tenantId, (ctx) => contactOperator(ctx, { body: "my mailboxes stopped sending", urgency: "normal" }, mailer));

      expect(result.ticketId).toMatch(/^sup_/);
      expect(result.note).toContain("list_messages");

      const row = await env.DB.prepare(
        `SELECT tenant_id, body, category, status, source, email_sent_at FROM support_tickets WHERE id = ?`,
      )
        .bind(result.ticketId)
        .first<{ tenant_id: string; body: string; category: string; status: string; source: string; email_sent_at: number | null }>();
      expect(row).toMatchObject({
        tenant_id: tenantId,
        body: "my mailboxes stopped sending",
        category: "other",
        status: "escalated",
        source: "agent",
      });
      expect(row?.email_sent_at).not.toBeNull();

      expect(mailer.sent).toHaveLength(1);
      expect(mailer.sent[0]?.to).toBe(env.OPS_ALERT_EMAIL);
      expect(mailer.sent[0]?.subject).toContain(tenantId);
      expect(mailer.sent[0]?.text).toContain("my mailboxes stopped sending");
    });

    it("REST: POST /messages/contact-operator persists the ticket and returns { ticketId, note }", async () => {
      const { tenantId, token } = await mintTenant("Contact Op REST Co", "managed");
      const res = await api<{ ticketId: string; note: string }>("/messages/contact-operator", {
        method: "POST",
        token,
        body: JSON.stringify({ body: "billing question", urgency: "normal" }),
      });
      expect(res.status).toBe(201);
      expect(res.body.ticketId).toMatch(/^sup_/);
      expect(res.body.note).toContain("list_messages");
      expect(await ticketCount(tenantId)).toBe(1);
    });

    it("MCP: tools/call contact_operator dispatches to the SAME TenantDO method as the REST route", async () => {
      const { tenantId, token } = await mintTenant("Contact Op MCP Co", "managed");
      const res = await api<{ jsonrpc: "2.0"; id: number; result: { content: { type: string; text: string }[] } }>("/mcp", {
        method: "POST",
        token,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "contact_operator", arguments: { body: "reachable via MCP too", urgency: "normal" } },
        }),
      });
      expect(res.status).toBe(200);
      const payload = JSON.parse(res.body.result.content[0]!.text) as { ticketId: string; note: string };
      expect(payload.ticketId).toMatch(/^sup_/);
      expect(await ticketCount(tenantId)).toBe(1);
    });

    it("rejects a body over the 2000-char bound at the boundary (never reaches the DO)", async () => {
      const { tenantId, token } = await mintTenant("Contact Op TooLong Co", "managed");
      const res = await api("/messages/contact-operator", {
        method: "POST",
        token,
        body: JSON.stringify({ body: "x".repeat(2001) }),
      });
      expect(res.status).toBe(400);
      expect(await ticketCount(tenantId)).toBe(0);
    });
  });

  describe("dedup — identical body within 1h", () => {
    it("returns the SAME ticketId and fires no second email; only one row is ever written", async () => {
      const { tenantId } = await mintTenant("Contact Op Dedup Co", "managed");
      const mailer = new SandboxOpsMailer();

      const first = await withTenantContext(tenantId, (ctx) => contactOperator(ctx, { body: "same message twice", urgency: "normal" }, mailer));
      expect(mailer.sent).toHaveLength(1);

      const second = await withTenantContext(tenantId, (ctx) => contactOperator(ctx, { body: "same message twice", urgency: "normal" }, mailer));
      expect(second.ticketId).toBe(first.ticketId);
      // No second send attempted at all — dedup returns before ever touching the mailer.
      expect(mailer.sent).toHaveLength(1);
      expect(await ticketCount(tenantId)).toBe(1);
    });

    it("a DIFFERENT body from the same tenant is NOT deduped (files its own ticket)", async () => {
      const { tenantId } = await mintTenant("Contact Op NoDedup Co", "managed");
      const mailer = new SandboxOpsMailer();
      const first = await withTenantContext(tenantId, (ctx) => contactOperator(ctx, { body: "message A", urgency: "normal" }, mailer));
      const second = await withTenantContext(tenantId, (ctx) => contactOperator(ctx, { body: "message B", urgency: "normal" }, mailer));
      expect(second.ticketId).not.toBe(first.ticketId);
      expect(await ticketCount(tenantId)).toBe(2);
    });
  });

  describe("rate limit — max 5 contact_operator calls/hour per tenant", () => {
    it("engine: the 6th distinct-body call throws RateLimitError with a positive retryAfter", async () => {
      const { tenantId } = await mintTenant("Contact Op RateLimit Co", "managed");
      const now = Date.now();
      for (let i = 0; i < 5; i++) {
        await seedAgentTicket(tenantId, `seed message ${i}`, now - 1000 * i);
      }
      expect(await ticketCount(tenantId)).toBe(5);

      const mailer = new SandboxOpsMailer();
      await expect(withTenantContext(tenantId, (ctx) => contactOperator(ctx, { body: "the sixth, different message", urgency: "normal" }, mailer))).rejects.toMatchObject({
        name: "RateLimitError",
      });
      // No 6th row landed, and no email was attempted for the refused call.
      expect(await ticketCount(tenantId)).toBe(5);
      expect(mailer.sent).toHaveLength(0);

      try {
        await withTenantContext(tenantId, (ctx) => contactOperator(ctx, { body: "the sixth, different message", urgency: "normal" }, mailer));
        expect.unreachable("expected a RateLimitError");
      } catch (err) {
        expect(err).toBeInstanceOf(RateLimitError);
        expect((err as RateLimitError).retryAfter).toBeGreaterThan(0);
        expect((err as RateLimitError).retryAfter).toBeLessThanOrEqual(3600);
      }
    });

    it("REST: a 429 names a structured retryAfter (seconds)", async () => {
      const { tenantId, token } = await mintTenant("Contact Op RateLimit REST Co", "managed");
      const now = Date.now();
      for (let i = 0; i < 5; i++) {
        await seedAgentTicket(tenantId, `rest seed ${i}`, now - 1000 * i);
      }
      const res = await api<{ error: string; retryAfter: number }>("/messages/contact-operator", {
        method: "POST",
        token,
        body: JSON.stringify({ body: "one too many", urgency: "normal" }),
      });
      expect(res.status).toBe(429);
      expect(typeof res.body.retryAfter).toBe("number");
      expect(res.body.retryAfter).toBeGreaterThan(0);
    });

    it("a call MORE than an hour old does not count against the window", async () => {
      const { tenantId } = await mintTenant("Contact Op OldWindow Co", "managed");
      const now = Date.now();
      // 5 tickets, but all outside the 1h window.
      for (let i = 0; i < 5; i++) {
        await seedAgentTicket(tenantId, `stale seed ${i}`, now - (60 * 60 * 1000 + 5000 + i));
      }
      const mailer = new SandboxOpsMailer();
      const result = await withTenantContext(tenantId, (ctx) => contactOperator(ctx, { body: "fresh call, old window doesn't count", urgency: "normal" }, mailer));
      expect(result.ticketId).toMatch(/^sup_/);
      expect(await ticketCount(tenantId)).toBe(6);
    });
  });

  describe("ops-email throttle — at most 1 email per tenant per 10 real minutes", () => {
    it("further messages inside the window create tickets but send no email; a send AFTER the window folds in an 'and N more' count", async () => {
      const { tenantId } = await mintTenant("Contact Op Throttle Co", "managed");
      const mailer = new SandboxOpsMailer();

      const first = await withTenantContext(tenantId, (ctx) => contactOperator(ctx, { body: "throttle msg 1", urgency: "normal" }, mailer));
      expect(mailer.sent).toHaveLength(1);

      // Two more, still inside the 10-minute throttle window (real time has
      // not moved) — both create tickets, neither sends.
      await withTenantContext(tenantId, (ctx) => contactOperator(ctx, { body: "throttle msg 2", urgency: "normal" }, mailer));
      await withTenantContext(tenantId, (ctx) => contactOperator(ctx, { body: "throttle msg 3", urgency: "normal" }, mailer));
      expect(mailer.sent).toHaveLength(1);
      expect(await ticketCount(tenantId)).toBe(3);

      // Backdate ticket 1's email_sent_at past the 10-minute throttle window
      // (simulates real time having passed) — the NEXT call is now due to send.
      await env.DB.prepare(`UPDATE support_tickets SET email_sent_at = ? WHERE id = ?`)
        .bind(Date.now() - 11 * 60 * 1000, first.ticketId)
        .run();

      await withTenantContext(tenantId, (ctx) => contactOperator(ctx, { body: "throttle msg 4", urgency: "normal" }, mailer));
      expect(mailer.sent).toHaveLength(2);
      // Folds in the 2 tickets (msg 2, msg 3) that were suppressed since the last real send.
      expect(mailer.sent[1]?.text).toContain("and 2 more message(s) from this tenant");
      expect(mailer.sent[1]?.text).toContain("throttle msg 4");
    });
  });

  describe("delivers in EVERY lifecycle state (mirrors emitOperatorMessage's F2 ruling)", () => {
    it("a CANCELING (end-of-period cancel) tenant's own bearer token can still contact_operator", async () => {
      const { tenantId, token } = await mintTenant("Contact Op Canceling Co", "managed");
      const cancel = await api("/cancel", { method: "POST", token, body: JSON.stringify({ immediate: false }) });
      expect(cancel.status).toBe(200);
      expect(cancel.body).toMatchObject({ billingState: "canceling" });

      const res = await api<{ ticketId: string }>("/messages/contact-operator", {
        method: "POST",
        token,
        body: JSON.stringify({ body: "why is my account canceling?", urgency: "normal" }),
      });
      expect(res.status).toBe(201);
      expect(await ticketCount(tenantId)).toBe(1);
    });

    it("a DUNNING-SUSPENDED tenant's own bearer token can still contact_operator — the canonical use case", async () => {
      const { tenantId, token } = await mintTenant("Contact Op Suspended Co", "managed");
      // Drive to suspend: 4 failed-invoice cycles + the dunning sweep that
      // actually actions the suspend (mirrors admin-dunning-email.test.ts's
      // driveToSuspend — failPayment alone only advances billing_state to
      // 'past_due'; runDunningSweep is what suspends after grace cycles).
      await failPayment(tenantId);
      await failPayment(tenantId);
      await failPayment(tenantId);
      await failPayment(tenantId);
      await runDunningSweep(env, Date.now());
      await withTenantContext(tenantId, (ctx) => expect(ctx.sql.exec<{ status: string }>(`SELECT status FROM tenant_profile WHERE id = ?`, tenantId).one().status).toBe("suspended"));

      const res = await api<{ ticketId: string }>("/messages/contact-operator", {
        method: "POST",
        token,
        body: JSON.stringify({ body: "my card failed, why am I suspended?", urgency: "needs_human" }),
      });
      expect(res.status).toBe(201);
      expect(await ticketCount(tenantId)).toBe(1);
    });
  });

  describe("regarding — round-trips verbatim to the agent's message", () => {
    it("an operator reply's `regarding` (e.g. a contact_operator ticket id) surfaces on actionHint.regarding via list_messages", async () => {
      const { tenantId, token } = await mintTenant("Contact Op Regarding Co", "managed");
      const contact = await api<{ ticketId: string }>("/messages/contact-operator", {
        method: "POST",
        token,
        body: JSON.stringify({ body: "my mailbox is stuck pending", urgency: "normal" }),
      });
      expect(contact.status).toBe(201);

      const opReply = await adminApi(`/admin/tenants/${tenantId}/messages`, {
        method: "POST",
        body: JSON.stringify({ kind: "operator_notice", body: "Fixed — retry now.", regarding: contact.body.ticketId }),
      });
      expect(opReply.status).toBe(201);

      const list = await api<{ messages: { body: string; actionHint: { regarding?: string } | null }[] }>("/messages", { token });
      expect(list.status).toBe(200);
      const reply = list.body.messages.find((m) => m.body === "Fixed — retry now.");
      expect(reply?.actionHint).toEqual({ regarding: contact.body.ticketId });
    });

    it("omitting `regarding` is byte-identical to today — actionHint stays null", async () => {
      const { tenantId, token } = await mintTenant("Contact Op NoRegarding Co", "managed");
      await adminApi(`/admin/tenants/${tenantId}/messages`, {
        method: "POST",
        body: JSON.stringify({ kind: "operator_notice", body: "plain notice, no ticket reference" }),
      });
      const list = await api<{ messages: { body: string; actionHint: unknown }[] }>("/messages", { token });
      const msg = list.body.messages.find((m) => m.body === "plain notice, no ticket reference");
      expect(msg?.actionHint).toBeNull();
    });

    // Direct engine-level pin of the same behavior, independent of the HTTP layer.
    it("engine: emitOperatorMessage sets actionHint.regarding only when regarding is supplied", async () => {
      const { tenantId } = await mintTenant("Contact Op Regarding Engine Co", "managed");
      await withTenantContext(tenantId, (ctx) => emitOperatorMessage(ctx, { kind: "operator_notice", severity: "info", body: "with ref", regarding: "sup_abc123" }));
      await withTenantContext(tenantId, (ctx) => emitOperatorMessage(ctx, { kind: "operator_notice", severity: "info", body: "without ref" }));

      const rows = await withTenantContext(tenantId, (ctx) =>
        ctx.sql.exec<{ body: string; action_hint: string | null }>(`SELECT body, action_hint FROM tenant_messages WHERE tenant_id = ? ORDER BY created_at`, tenantId).toArray(),
      );
      const withRef = rows.find((r) => r.body === "with ref");
      const withoutRef = rows.find((r) => r.body === "without ref");
      expect(JSON.parse(withRef!.action_hint!)).toEqual({ regarding: "sup_abc123" });
      expect(withoutRef!.action_hint).toBeNull();
    });
  });
});
