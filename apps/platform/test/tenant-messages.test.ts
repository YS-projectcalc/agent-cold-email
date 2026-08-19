import { describe, expect, it } from "vitest";
import type { TenantMessage } from "../src/engine/tenant-messages.js";
import {
  ackMessage,
  emitTenantMessage,
  listSurfacedTenantMessages,
  pruneTenantMessages,
  READ_RETENTION_MS,
} from "../src/engine/tenant-messages.js";
import { api, signup, withTenantContext } from "./helpers.js";

// Increment 1 of the system->agent message channel (founder-approved
// 2026-08-05): a DO-local mailbox our own system writes and the customer's
// agent reads via infrastructure_status. These tests exercise the emit
// helper + read surface + prune DIRECTLY (engine-level, like
// mailbox-credential-push.test.ts) — the two real wire points (retry_setup,
// credential_ready) are exercised end-to-end in provisioning-saga.test.ts /
// mailbox-credential-push.test.ts instead of duplicated here.

function rowCount(sql: SqlStorage, tenantId: string): number {
  return sql.exec<{ n: number }>(`SELECT COUNT(*) as n FROM tenant_messages WHERE tenant_id = ?`, tenantId).one().n;
}

describe("emitTenantMessage — scoped insert", () => {
  it("writes one row scoped to the calling tenant, source='system'", async () => {
    const { tenantId } = await signup("Msg Co", "founder@msgco.test");
    await withTenantContext(tenantId, (ctx) =>
      emitTenantMessage(ctx, { kind: "retry_setup", severity: "action_required", body: "retry setup_infrastructure" }),
    );
    const row = await withTenantContext(tenantId, (ctx) =>
      ctx.sql
        .exec<{ tenant_id: string; kind: string; severity: string; body: string; source: string; read_at: number | null }>(
          `SELECT tenant_id, kind, severity, body, source, read_at FROM tenant_messages WHERE tenant_id = ?`,
          tenantId,
        )
        .one(),
    );
    expect(row).toMatchObject({
      tenant_id: tenantId,
      kind: "retry_setup",
      severity: "action_required",
      body: "retry setup_infrastructure",
      source: "system",
      read_at: null,
    });
  });

  it("a second, DIFFERENT tenant's emit never lands in the first tenant's rows (tenant isolation)", async () => {
    const { tenantId: a } = await signup("Msg Iso A", "founder@msgisoa.test");
    const { tenantId: b } = await signup("Msg Iso B", "founder@msgisob.test");
    await withTenantContext(a, (ctx) => emitTenantMessage(ctx, { kind: "k", severity: "info", body: "for A" }));
    await withTenantContext(b, (ctx) => emitTenantMessage(ctx, { kind: "k", severity: "info", body: "for B" }));
    expect(await withTenantContext(a, (ctx) => rowCount(ctx.sql, a))).toBe(1);
    expect(await withTenantContext(b, (ctx) => rowCount(ctx.sql, b))).toBe(1);
  });
});

describe("GUARDRAIL A — dedup / no-spam", () => {
  it("a re-triggered emit with the SAME dedupKey does NOT insert a second row (refreshes instead)", async () => {
    const { tenantId } = await signup("Dedup Co", "founder@dedupco.test");
    await withTenantContext(tenantId, (ctx) =>
      emitTenantMessage(ctx, { kind: "retry_setup", severity: "action_required", body: "first", dedupKey: "acme.com" }),
    );
    await withTenantContext(tenantId, (ctx) =>
      emitTenantMessage(ctx, { kind: "retry_setup", severity: "action_required", body: "second", dedupKey: "acme.com" }),
    );
    // Still exactly ONE row — this is the unbounded-action-row class the
    // incident gate caught twice (ROADMAP PROVISIONING CLASS WAVE): a naive
    // insert-every-time on a re-triggered retry path is a REJECTED implementation.
    expect(await withTenantContext(tenantId, (ctx) => rowCount(ctx.sql, tenantId))).toBe(1);
    const row = await withTenantContext(tenantId, (ctx) =>
      ctx.sql.exec<{ body: string }>(`SELECT body FROM tenant_messages WHERE tenant_id = ?`, tenantId).one(),
    );
    // Refreshed, not stuck on the first call's stale text.
    expect(row.body).toBe("second");
  });

  it("a DIFFERENT dedupKey under the same kind inserts a SEPARATE row (dedup is per-key, not per-kind)", async () => {
    const { tenantId } = await signup("Dedup Multi Co", "founder@dedupmulti.test");
    await withTenantContext(tenantId, (ctx) =>
      emitTenantMessage(ctx, { kind: "retry_setup", severity: "action_required", body: "domain A", dedupKey: "a.com" }),
    );
    await withTenantContext(tenantId, (ctx) =>
      emitTenantMessage(ctx, { kind: "retry_setup", severity: "action_required", body: "domain B", dedupKey: "b.com" }),
    );
    expect(await withTenantContext(tenantId, (ctx) => rowCount(ctx.sql, tenantId))).toBe(2);
  });

  it("dedup does NOT apply once the prior row with that key has been marked READ (a new row is inserted)", async () => {
    const { tenantId } = await signup("Dedup Read Co", "founder@deduread.test");
    await withTenantContext(tenantId, (ctx) =>
      emitTenantMessage(ctx, { kind: "credential_ready", severity: "action_required", body: "first", dedupKey: "a@x.com" }),
    );
    // Simulate the (increment-2) ack — mark the existing row read.
    await withTenantContext(tenantId, (ctx) =>
      ctx.sql.exec(`UPDATE tenant_messages SET read_at = ? WHERE tenant_id = ?`, ctx.clock.now(), tenantId),
    );
    await withTenantContext(tenantId, (ctx) =>
      emitTenantMessage(ctx, { kind: "credential_ready", severity: "action_required", body: "second", dedupKey: "a@x.com" }),
    );
    expect(await withTenantContext(tenantId, (ctx) => rowCount(ctx.sql, tenantId))).toBe(2);
  });

  it("dedup does NOT apply once the prior row with that key has EXPIRED (a new row is inserted)", async () => {
    const { tenantId } = await signup("Dedup Expired Co", "founder@dedupexp.test");
    const past = await withTenantContext(tenantId, (ctx) => ctx.clock.now() - 1000);
    await withTenantContext(tenantId, (ctx) =>
      emitTenantMessage(ctx, { kind: "retry_setup", severity: "action_required", body: "first", dedupKey: "a.com", expiresAt: past }),
    );
    await withTenantContext(tenantId, (ctx) =>
      emitTenantMessage(ctx, { kind: "retry_setup", severity: "action_required", body: "second", dedupKey: "a.com" }),
    );
    expect(await withTenantContext(tenantId, (ctx) => rowCount(ctx.sql, tenantId))).toBe(2);
  });

  it("no dedupKey means every emit inserts its own row (dedup is opt-in)", async () => {
    const { tenantId } = await signup("No Dedup Co", "founder@nodedup.test");
    await withTenantContext(tenantId, (ctx) => emitTenantMessage(ctx, { kind: "k", severity: "info", body: "one" }));
    await withTenantContext(tenantId, (ctx) => emitTenantMessage(ctx, { kind: "k", severity: "info", body: "two" }));
    expect(await withTenantContext(tenantId, (ctx) => rowCount(ctx.sql, tenantId))).toBe(2);
  });
});

describe("listSurfacedTenantMessages — the infrastructure_status read surface", () => {
  it("a read is a PURE SELECT: calling it inserts no row and mutates nothing", async () => {
    const { tenantId } = await signup("Read Only Co", "founder@readonly.test");
    await withTenantContext(tenantId, (ctx) => emitTenantMessage(ctx, { kind: "k", severity: "info", body: "hi" }));
    const before = await withTenantContext(tenantId, (ctx) => rowCount(ctx.sql, tenantId));
    await withTenantContext(tenantId, (ctx) => listSurfacedTenantMessages(ctx));
    await withTenantContext(tenantId, (ctx) => listSurfacedTenantMessages(ctx));
    const after = await withTenantContext(tenantId, (ctx) => rowCount(ctx.sql, tenantId));
    expect(after).toBe(before);
  });

  it("returns newest-first, capped at 5 even when more exist", async () => {
    const { tenantId } = await signup("Cap Co", "founder@capco.test");
    for (let i = 0; i < 8; i++) {
      // eslint-disable-next-line no-await-in-loop
      await withTenantContext(tenantId, (ctx) => emitTenantMessage(ctx, { kind: "k", severity: "info", body: `msg-${i}` }));
    }
    const messages = await withTenantContext(tenantId, (ctx) => listSurfacedTenantMessages(ctx));
    expect(messages).toHaveLength(5);
    expect(messages[0]!.body).toBe("msg-7"); // newest first
  });

  it("filters out expired rows", async () => {
    const { tenantId } = await signup("Expiry Co", "founder@expiryco.test");
    const past = await withTenantContext(tenantId, (ctx) => ctx.clock.now() - 1000);
    const future = await withTenantContext(tenantId, (ctx) => ctx.clock.now() + 1_000_000);
    await withTenantContext(tenantId, (ctx) => emitTenantMessage(ctx, { kind: "k", severity: "info", body: "expired", expiresAt: past }));
    await withTenantContext(tenantId, (ctx) => emitTenantMessage(ctx, { kind: "k", severity: "info", body: "live", expiresAt: future }));
    const messages = await withTenantContext(tenantId, (ctx) => listSurfacedTenantMessages(ctx));
    expect(messages.map((m) => m.body)).toEqual(["live"]);
  });

  // Gate fix (msgchannel-inc23-gate-2026-08-06 F1): this preview is
  // UNACKED-ONLY, not merely unacked-sorted-first — a read row must never
  // surface here even when it is the newest row in the table. Acked history
  // is reachable via list_messages instead (test/messages.test.ts).
  it("excludes read (acked) rows entirely, even when the read one is newer", async () => {
    const { tenantId } = await signup("Unread First Co", "founder@unreadfirst.test");
    await withTenantContext(tenantId, (ctx) => emitTenantMessage(ctx, { kind: "k", severity: "info", body: "unread-old" }));
    await withTenantContext(tenantId, (ctx) =>
      ctx.sql.exec(`INSERT INTO tenant_messages (id, tenant_id, kind, severity, body, source, created_at, read_at) VALUES ('tmsg_readtest', ?, 'k', 'info', 'read-new', 'system', ?, ?)`, tenantId, ctx.clock.now() + 1, ctx.clock.now() + 1),
    );
    const messages = await withTenantContext(tenantId, (ctx) => listSurfacedTenantMessages(ctx));
    expect(messages.map((m) => m.body)).toEqual(["unread-old"]);
  });

  it("parses action_hint JSON back into an object, and is null when absent", async () => {
    const { tenantId } = await signup("Hint Co", "founder@hintco.test");
    await withTenantContext(tenantId, (ctx) =>
      emitTenantMessage(ctx, {
        kind: "retry_setup",
        severity: "action_required",
        body: "retry it",
        actionHint: { tool: "setup_infrastructure", idempotencyKey: "abc-123" },
      }),
    );
    await withTenantContext(tenantId, (ctx) => emitTenantMessage(ctx, { kind: "k", severity: "info", body: "no hint" }));
    const messages = await withTenantContext(tenantId, (ctx) => listSurfacedTenantMessages(ctx));
    const withHint = messages.find((m) => m.kind === "retry_setup")!;
    const withoutHint = messages.find((m) => m.kind === "k")!;
    expect(withHint.actionHint).toEqual({ tool: "setup_infrastructure", idempotencyKey: "abc-123" });
    expect(withoutHint.actionHint).toBeNull();
  });
});

describe("InfrastructureStatus.messages — the field is live on the real GET /infrastructure-status route", () => {
  it("surfaces emitted messages through the HTTP facade, unread-first and capped at 5", async () => {
    const res1 = await api<{ tenantId: string; token: string }>("/signup", {
      method: "POST",
      headers: { "CF-Connecting-IP": `test-ip-${crypto.randomUUID()}` },
      body: JSON.stringify({ brand: "Http Status Co", contactEmail: "founder@httpstatus.test" }),
    });
    const { tenantId, token } = res1.body as { tenantId: string; token: string };
    for (let i = 0; i < 6; i++) {
      // eslint-disable-next-line no-await-in-loop
      await withTenantContext(tenantId, (ctx) => emitTenantMessage(ctx, { kind: "k", severity: "info", body: `m-${i}` }));
    }

    const status = await api<{ messages: TenantMessage[] }>("/infrastructure-status", { token });
    expect(status.status).toBe(200);
    expect(status.body.messages).toHaveLength(5);
    expect(status.body.messages[0]!.body).toBe("m-5"); // newest-first among the unread set
  });

  // Gate fix (msgchannel-inc23-gate-2026-08-06 F1) — the gate's exact repro,
  // inverted: post a message, see it surface, ack it, then assert it stops
  // surfacing. Without the fix an acked `action_required` row (carrying an
  // actionHint an agent could act on twice) kept resurfacing here for the
  // full 30-day READ_RETENTION_MS window.
  it("a message stops surfacing here once acked", async () => {
    const res1 = await api<{ tenantId: string; token: string }>("/signup", {
      method: "POST",
      headers: { "CF-Connecting-IP": `test-ip-${crypto.randomUUID()}` },
      body: JSON.stringify({ brand: "Ack Surface Co", contactEmail: "founder@acksurfaceco.test" }),
    });
    const { tenantId, token } = res1.body as { tenantId: string; token: string };
    await withTenantContext(tenantId, (ctx) =>
      emitTenantMessage(ctx, { kind: "retry_setup", severity: "action_required", body: "retry it", actionHint: { tool: "setup_infrastructure" } }),
    );

    const before = await api<{ messages: TenantMessage[] }>("/infrastructure-status", { token });
    expect(before.body.messages).toHaveLength(1);
    const messageId = before.body.messages[0]!.id;

    await withTenantContext(tenantId, (ctx) => ackMessage(ctx, messageId));

    const after = await api<{ messages: TenantMessage[] }>("/infrastructure-status", { token });
    expect(after.body.messages).toEqual([]);
  });
});

describe("pruneTenantMessages — bounded, tenant-scoped cleanup", () => {
  // BOTH LEGS NOW CARRY THE SAME RETENTION (build gate r2, 2026-08-19). The
  // expired leg used to delete on the instant of expiry, so the platform's own
  // re-derived expiry (expireResolvedSystemMessages) destroyed a customer's
  // action item within one sweep and took the audit trail with it. The
  // deletion property is unchanged — it is the AGE that moved — so these
  // fixtures expire past the retention window rather than one second ago, and
  // the survivor below is the new half.
  it("deletes rows expired past the retention window", async () => {
    const { tenantId } = await signup("Prune Expired Co", "founder@pruneexp.test");
    const past = await withTenantContext(tenantId, (ctx) => ctx.clock.now() - READ_RETENTION_MS - 1000);
    await withTenantContext(tenantId, (ctx) => emitTenantMessage(ctx, { kind: "k", severity: "info", body: "expired", expiresAt: past }));
    await withTenantContext(tenantId, (ctx) => emitTenantMessage(ctx, { kind: "k", severity: "info", body: "live" }));
    await withTenantContext(tenantId, (ctx) => pruneTenantMessages(ctx));
    const remaining = await withTenantContext(tenantId, (ctx) =>
      ctx.sql.exec<{ body: string }>(`SELECT body FROM tenant_messages WHERE tenant_id = ?`, tenantId).toArray(),
    );
    expect(remaining.map((r) => r.body)).toEqual(["live"]);
  });

  it("KEEPS a recently-expired row — an expiry decision stays recoverable for as long as an ack does", async () => {
    const { tenantId } = await signup("Prune Expired Recent Co", "founder@pruneexprecent.test");
    const past = await withTenantContext(tenantId, (ctx) => ctx.clock.now() - 1000);
    await withTenantContext(tenantId, (ctx) =>
      emitTenantMessage(ctx, { kind: "k", severity: "info", body: "expired-just-now", expiresAt: past }),
    );
    await withTenantContext(tenantId, (ctx) => pruneTenantMessages(ctx));
    const remaining = await withTenantContext(tenantId, (ctx) =>
      ctx.sql.exec<{ body: string }>(`SELECT body FROM tenant_messages WHERE tenant_id = ?`, tenantId).toArray(),
    );
    expect(remaining.map((r) => r.body)).toEqual(["expired-just-now"]);
  });

  it("deletes READ rows older than the retention window, but keeps a recently-read row", async () => {
    const { tenantId } = await signup("Prune Read Co", "founder@pruneread.test");
    await withTenantContext(tenantId, (ctx) => {
      const now = ctx.clock.now();
      ctx.sql.exec(
        `INSERT INTO tenant_messages (id, tenant_id, kind, severity, body, source, created_at, read_at) VALUES ('tmsg_old', ?, 'k', 'info', 'old-read', 'system', ?, ?)`,
        tenantId,
        now - READ_RETENTION_MS - 1000,
        now - READ_RETENTION_MS - 1000,
      );
      ctx.sql.exec(
        `INSERT INTO tenant_messages (id, tenant_id, kind, severity, body, source, created_at, read_at) VALUES ('tmsg_recent', ?, 'k', 'info', 'recent-read', 'system', ?, ?)`,
        tenantId,
        now,
        now,
      );
    });
    await withTenantContext(tenantId, (ctx) => pruneTenantMessages(ctx));
    const remaining = await withTenantContext(tenantId, (ctx) =>
      ctx.sql.exec<{ body: string }>(`SELECT body FROM tenant_messages WHERE tenant_id = ?`, tenantId).toArray(),
    );
    expect(remaining.map((r) => r.body)).toEqual(["recent-read"]);
  });

  it("never touches another tenant's rows (tenant-scoped)", async () => {
    const { tenantId: a } = await signup("Prune Iso A", "founder@pruneisoa.test");
    const { tenantId: b } = await signup("Prune Iso B", "founder@pruneisob.test");
    const past = await withTenantContext(a, (ctx) => ctx.clock.now() - READ_RETENTION_MS - 1000);
    await withTenantContext(a, (ctx) => emitTenantMessage(ctx, { kind: "k", severity: "info", body: "a-expired", expiresAt: past }));
    await withTenantContext(b, (ctx) => emitTenantMessage(ctx, { kind: "k", severity: "info", body: "b-expired", expiresAt: past }));
    await withTenantContext(a, (ctx) => pruneTenantMessages(ctx));
    expect(await withTenantContext(a, (ctx) => rowCount(ctx.sql, a))).toBe(0);
    expect(await withTenantContext(b, (ctx) => rowCount(ctx.sql, b))).toBe(1); // untouched
  });
});
