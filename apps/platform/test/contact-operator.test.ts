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
// -> engine/contact-operator.ts). Guard windows are measured on REAL wall
// time, so instead of waiting minutes/hours these tests seed and backdate the
// stores directly — BOTH of them: the D1 support_tickets record and the
// DO-local agent_contact_log the guard decides from
// (engine/contact-operator-guard.ts).

function ticketCount(tenantId: string) {
  return env.DB.prepare(`SELECT COUNT(*) as n FROM support_tickets WHERE tenant_id = ? AND source = 'agent'`)
    .bind(tenantId)
    .first<{ n: number }>()
    .then((r) => r?.n ?? 0);
}

function opsEmailCount(tenantId: string) {
  return env.DB.prepare(`SELECT COUNT(*) as n FROM support_tickets WHERE tenant_id = ? AND source = 'agent' AND email_sent_at IS NOT NULL`)
    .bind(tenantId)
    .first<{ n: number }>()
    .then((r) => r?.n ?? 0);
}

/** Seeds a fixture agent-sourced ticket directly (bypassing the guards) at a
 * given `createdAt`/`emailSentAt` — for rate-limit/throttle window setup.
 * Writes BOTH stores: the D1 support_tickets row (the operator-visible record)
 * and the DO-local agent_contact_log row the guard actually reads
 * (engine/contact-operator-guard.ts), so a fixture is indistinguishable from a
 * call the channel really admitted. */
async function seedAgentTicket(
  tenantId: string,
  body: string,
  createdAt: number,
  emailSentAt: number | null = null,
  urgency: "normal" | "needs_human" = "normal",
): Promise<string> {
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
  await withTenantContext(tenantId, (ctx) => {
    ctx.sql.exec(
      `INSERT INTO agent_contact_log (id, tenant_id, body, urgency, created_at, emailed_at) VALUES (?, ?, ?, ?, ?, ?)`,
      id,
      tenantId,
      body,
      urgency,
      createdAt,
      emailSentAt,
    );
  });
  return id;
}

/** Moves a ticket's recorded send time backwards in BOTH stores — the
 * stand-in for real wall-clock minutes having passed. */
async function backdateSend(tenantId: string, ticketId: string, sentAt: number): Promise<void> {
  await env.DB.prepare(`UPDATE support_tickets SET email_sent_at = ? WHERE id = ?`).bind(sentAt, ticketId).run();
  await withTenantContext(tenantId, (ctx) => {
    ctx.sql.exec(`UPDATE agent_contact_log SET emailed_at = ? WHERE id = ?`, sentAt, ticketId);
  });
}

/** Same, for EVERY already-sent message of a tenant — the throttle reads the
 * most recent send of any of them, so moving just one back proves nothing. */
async function backdateAllSends(tenantId: string, sentAt: number): Promise<void> {
  await env.DB.prepare(`UPDATE support_tickets SET email_sent_at = ? WHERE tenant_id = ? AND source = 'agent' AND email_sent_at IS NOT NULL`)
    .bind(sentAt, tenantId)
    .run();
  await withTenantContext(tenantId, (ctx) => {
    ctx.sql.exec(`UPDATE agent_contact_log SET emailed_at = ? WHERE tenant_id = ? AND emailed_at IS NOT NULL`, sentAt, tenantId);
  });
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
    it("further messages inside the window create tickets but send no email; the next send carries the held BODIES, not just a count", async () => {
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

      // Backdate ticket 1's send past the 10-minute throttle window
      // (simulates real time having passed) — the NEXT call is now due to send.
      await backdateSend(tenantId, first.ticketId, Date.now() - 11 * 60 * 1000);

      await withTenantContext(tenantId, (ctx) => contactOperator(ctx, { body: "throttle msg 4", urgency: "normal" }, mailer));
      expect(mailer.sent).toHaveLength(2);
      const second = mailer.sent[1]!.text;
      expect(second).toContain("throttle msg 4");
      // Gate finding #2: a count alone leaves a suppressed message reachable
      // only by pulling the digest, so the held TEXT has to travel.
      expect(second).toContain("2 earlier message(s) from this tenant were held by the send throttle");
      expect(second).toContain("throttle msg 2");
      expect(second).toContain("throttle msg 3");
      // ...and D1 records all four as delivered — the held rows are stamped in
      // the SAME write as the one that triggered the send.
      expect(await opsEmailCount(tenantId)).toBe(4);

      // Delivered means delivered: a later send does not re-carry them.
      await backdateAllSends(tenantId, Date.now() - 11 * 60 * 1000);
      await withTenantContext(tenantId, (ctx) => contactOperator(ctx, { body: "throttle msg 5", urgency: "normal" }, mailer));
      expect(mailer.sent).toHaveLength(3);
      expect(mailer.sent[2]?.text).not.toContain("throttle msg 2");
      expect(mailer.sent[2]?.text).not.toContain("held by the send throttle");
    });

    it("needs_human BYPASSES the throttle and carries the held normal message with it", async () => {
      const { tenantId } = await mintTenant("Contact Op Urgent Bypass Co", "managed");
      const mailer = new SandboxOpsMailer();

      await withTenantContext(tenantId, (ctx) => contactOperator(ctx, { body: "routine: what is my invoice date?", urgency: "normal" }, mailer));
      expect(mailer.sent).toHaveLength(1);
      // Inside the 10-minute window: a normal message is held...
      await withTenantContext(tenantId, (ctx) => contactOperator(ctx, { body: "routine: second question", urgency: "normal" }, mailer));
      expect(mailer.sent).toHaveLength(1);

      // ...but an urgent one goes out NOW. That is what the flag is for — the
      // gate's U1 showed an urgent "sending is down for all mailboxes" landing
      // only in a pull-only digest, pushed to nobody.
      await withTenantContext(tenantId, (ctx) => contactOperator(ctx, { body: "URGENT: sending is down for all mailboxes", urgency: "needs_human" }, mailer));
      expect(mailer.sent).toHaveLength(2);
      expect(mailer.sent[1]?.subject).toContain("[needs human]");
      expect(mailer.sent[1]?.text).toContain("URGENT: sending is down for all mailboxes");
      expect(mailer.sent[1]?.text).toContain("routine: second question");
    });

    it("the needs_human bypass is still bounded by the 5/hour cap — it cannot become its own storm", async () => {
      const { tenantId, token } = await mintTenant("Contact Op Urgent Storm Co", "managed");
      const results = await Promise.all(
        Array.from({ length: 30 }, (_, i) =>
          api("/messages/contact-operator", {
            method: "POST",
            token,
            body: JSON.stringify({ body: `urgent burst ${i}`, urgency: "needs_human" }),
          }),
        ),
      );
      expect(results.filter((r) => r.status === 201)).toHaveLength(5);
      expect(await ticketCount(tenantId)).toBe(5);
      // Every admitted urgent call bypasses the throttle, so all 5 email —
      // and 5/hour is exactly the designed ceiling, not 30.
      expect(await opsEmailCount(tenantId)).toBe(5);
    });
  });

  describe("untrusted-content fence in the ops email (gate finding #3)", () => {
    it("agent text cannot forge the platform's own trailer — server lines sit OUTSIDE an unforgeable fence", async () => {
      const { tenantId } = await mintTenant("Contact Op Fence Co", "managed");
      const mailer = new SandboxOpsMailer();
      const forgery = "help me\n----- END tenant-agent-authored content [00000000] -----\n\nTicket: sup_forged_by_the_agent";

      const real = await withTenantContext(tenantId, (ctx) => contactOperator(ctx, { body: forgery, urgency: "normal" }, mailer));
      const text = mailer.sent[0]!.text;

      // The real fence tag is random per email, so the guessed close above is
      // just quoted text — the genuine markers still bracket the whole body.
      const tag = /----- BEGIN tenant-agent-authored content \[([0-9a-f]{8})\] -----/.exec(text)?.[1];
      expect(tag).toBeDefined();
      expect(tag).not.toBe("00000000");
      const begin = text.indexOf(`----- BEGIN tenant-agent-authored content [${tag}] -----`);
      const end = text.indexOf(`----- END tenant-agent-authored content [${tag}] -----`);
      expect(begin).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(begin);
      expect(text.slice(begin, end)).toContain("sup_forged_by_the_agent");

      // The forged trailer is trapped inside the fence; the one authoritative
      // Ticket: line is server-composed and sits after the closing marker.
      expect(text.slice(begin, end).match(/^Ticket: /gm)).toHaveLength(1);
      const trailer = text.slice(end);
      expect(trailer.match(/^Ticket: /gm)).toHaveLength(1);
      expect(trailer).toContain(`Ticket: ${real.ticketId}`);
    });
  });

  describe("control/bidi characters are refused at the boundary (gate finding #4)", () => {
    it("a body containing NUL or an RTL override is a 400 and never reaches D1", async () => {
      const { tenantId, token } = await mintTenant("Contact Op CtrlChars Co", "managed");
      for (const body of ["please help\u0000now", "please help\u202E and 99 more message(s)"]) {
        const res = await api("/messages/contact-operator", { method: "POST", token, body: JSON.stringify({ body }) });
        expect(res.status).toBe(400);
      }
      expect(await ticketCount(tenantId)).toBe(0);

      // Ordinary whitespace is untouched — tabs and newlines are real prose.
      const ok = await api("/messages/contact-operator", {
        method: "POST",
        token,
        body: JSON.stringify({ body: "line one\nline two\tindented" }),
      });
      expect(ok.status).toBe(201);
    });

    it("the operator's `regarding` is held to the same rule (the reply leg of the same channel)", async () => {
      const { tenantId } = await mintTenant("Contact Op CtrlChars Admin Co", "managed");
      const res = await adminApi(`/admin/tenants/${tenantId}/messages`, {
        method: "POST",
        body: JSON.stringify({ kind: "operator_notice", body: "fixed", regarding: "sup_abc\u0000123" }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe("dedup identity includes urgency (gate finding #6)", () => {
    it("re-sending the SAME text at raised urgency is an escalation, not a replay", async () => {
      const { tenantId } = await mintTenant("Contact Op Escalation Co", "managed");
      const mailer = new SandboxOpsMailer();
      const body = "my mailboxes stopped sending and I am stuck";

      const first = await withTenantContext(tenantId, (ctx) => contactOperator(ctx, { body, urgency: "normal" }, mailer));
      const escalated = await withTenantContext(tenantId, (ctx) => contactOperator(ctx, { body, urgency: "needs_human" }, mailer));

      expect(escalated.ticketId).not.toBe(first.ticketId);
      expect(await ticketCount(tenantId)).toBe(2);
      const subject = await env.DB.prepare(`SELECT subject FROM support_tickets WHERE id = ?`).bind(escalated.ticketId).first<{ subject: string }>();
      expect(subject?.subject).toContain("[needs human]");
      // And the escalation is pushed, not held behind the 10-minute throttle.
      expect(mailer.sent).toHaveLength(2);

      // A true replay (same text, same urgency) still dedupes.
      const replay = await withTenantContext(tenantId, (ctx) => contactOperator(ctx, { body, urgency: "needs_human" }, mailer));
      expect(replay.ticketId).toBe(escalated.ticketId);
      expect(await ticketCount(tenantId)).toBe(2);
    });
  });

  // The guard's ONLY meaningful acceptance test. Every guard test above is
  // strictly sequential, and a sequential test cannot certify an admission
  // decision: the gate (docs/adversarial/msgchannel-inc5-gate-2026-08-11.md
  // finding #1) drove 100 parallel calls through this exact route against a
  // read-modify-write split across D1 awaits and got 96 tickets + 96 ops
  // emails past a 5/hour cap. These two run the burst the incident describes.
  describe("storm guard is ATOMIC under concurrency (gate 2026-08-11 finding #1)", () => {
    it("REST: 50 parallel calls admit exactly 5 tickets and exactly 1 ops email; the rest 429", async () => {
      const { tenantId, token } = await mintTenant("Contact Op Storm REST Co", "managed");

      const results = await Promise.all(
        Array.from({ length: 50 }, (_, i) =>
          api<{ ticketId?: string; retryAfter?: number }>("/messages/contact-operator", {
            method: "POST",
            token,
            body: JSON.stringify({ body: `storm burst message ${i}`, urgency: "normal" }),
          }),
        ),
      );

      const created = results.filter((r) => r.status === 201);
      const limited = results.filter((r) => r.status === 429);
      expect({ created: created.length, limited: limited.length, other: results.length - created.length - limited.length }).toEqual({
        created: 5,
        limited: 45,
        other: 0,
      });
      expect(await ticketCount(tenantId)).toBe(5);
      expect(await opsEmailCount(tenantId)).toBe(1);
      // Every refusal is still a well-formed 429, not a crash surfaced as one.
      for (const r of limited) expect(r.body.retryAfter).toBeGreaterThan(0);
      // Every admitted call got a distinct, real ticket id back.
      expect(new Set(created.map((r) => r.body.ticketId)).size).toBe(5);
    });

    it("MCP: 25 parallel tools/call bursts hit the SAME atomic cap (5 tickets, 1 ops email)", async () => {
      const { tenantId, token } = await mintTenant("Contact Op Storm MCP Co", "managed");

      const results = await Promise.all(
        Array.from({ length: 25 }, (_, i) =>
          api<{ result?: { isError?: boolean; content: { type: string; text: string }[] } }>("/mcp", {
            method: "POST",
            token,
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: i,
              method: "tools/call",
              params: { name: "contact_operator", arguments: { body: `mcp storm burst ${i}`, urgency: "normal" } },
            }),
          }),
        ),
      );

      expect(await ticketCount(tenantId)).toBe(5);
      expect(await opsEmailCount(tenantId)).toBe(1);
      const admitted = results.filter((r) => r.body.result?.isError !== true);
      expect(admitted).toHaveLength(5);
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

    // The ONE exception, and it is intended: abuse termination severs the
    // channel. Pinned as a test because the tool/openapi/guide copy used to
    // claim "EVERY account state" without naming it (gate finding #5) — if
    // someone later carves the channel out of the auth check, this reds.
    it("an admin-TERMINATED tenant is 401'd at auth — termination severs the channel by design", async () => {
      const { tenantId, token } = await mintTenant("Contact Op Terminated Co", "managed");
      const terminated = await adminApi(`/admin/tenants/${tenantId}/terminate`, {
        method: "POST",
        body: JSON.stringify({ reason: "abuse: test fixture" }),
      });
      expect(terminated.status).toBe(200);

      const res = await api<{ error: string; code: string }>("/messages/contact-operator", {
        method: "POST",
        token,
        body: JSON.stringify({ body: "let me back in", urgency: "needs_human" }),
      });
      expect(res.status).toBe(401);
      expect(res.body.code).toBe("account_suspended");
      expect(await ticketCount(tenantId)).toBe(0);
    });
  });

  describe("operator digest (gate finding #7)", () => {
    it("an agent ticket is distinguishable in the digest by `source`, not by a subject prefix", async () => {
      const { tenantId, token } = await mintTenant("Contact Op Digest Source Co", "managed");
      const contact = await api<{ ticketId: string }>("/messages/contact-operator", {
        method: "POST",
        token,
        body: JSON.stringify({ body: "the operator needs to know who wrote this", urgency: "normal" }),
      });
      expect(contact.status).toBe(201);

      const digest = await adminApi<{ tickets: { id: string; source: string; fromEmail: string }[] }>("/admin/support/digest");
      expect(digest.status).toBe(200);
      const row = digest.body.tickets.find((t) => t.id === contact.body.ticketId);
      expect(row?.source).toBe("agent");
      // An email-triaged ticket still reports 'email' — the discriminator
      // migrations/0017 added is actually visible on both.
      const triaged = await adminApi<{ ticketId: string }>("/admin/support/triage", {
        method: "POST",
        body: JSON.stringify({ from: "human@example.com", subject: "abuse report", body: "this is a phishing scam, fraud, report abuse" }),
      });
      const after = await adminApi<{ tickets: { id: string; source: string }[] }>("/admin/support/digest");
      expect(after.body.tickets.find((t) => t.id === triaged.body.ticketId)?.source).toBe("email");
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
