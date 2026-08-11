import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { insertSupportTicket } from "../src/admin/db.js";
import { runDeliverabilitySweepAllTenants } from "../src/admin/ops-sweep.js";
import { contactOperator } from "../src/engine/contact-operator.js";
import { ISOLATE_DEATH_REAP_TTL_MS, reconcileOrphanedAdmissions } from "../src/engine/contact-operator-reconcile.js";
import { SandboxOpsMailer } from "../src/ops-mail/sandbox-ops-mailer.js";
import { newId } from "../src/schema.js";
import { mintTenant, tenantStub, withTenantContext } from "./helpers.js";

// msgchannel Inc5 fast-follow (ROADMAP.md 2026-08-11 "Inc5 reconcile-sweep
// for isolate-death"; docs/adversarial/msgchannel-inc5-gate-2026-08-11.md
// round 3's own residual correction, lines 563-568: this sweep closes
// isolate-death, NOT the concurrent-twin phantom, which self-heals to zero
// rows). Seeds the DO-local agent_contact_log row DIRECTLY (bypassing
// admitContactOperatorCall) to stand in for "an isolate died between the
// admission commit and the D1 support_tickets write it authorizes" — no
// in-request code is ever left running to call revokeAdmission for that
// call, so nothing but a sweep can ever clean it up.

function seedLogRow(sql: SqlStorage, tenantId: string, id: string, createdAt: number, emailedAt: number | null = null, body = "orphaned by an isolate death"): void {
  sql.exec(
    `INSERT INTO agent_contact_log (id, tenant_id, body, urgency, created_at, emailed_at) VALUES (?, ?, ?, ?, ?, ?)`,
    id,
    tenantId,
    body,
    "normal",
    createdAt,
    emailedAt,
  );
}

function logRowIds(sql: SqlStorage, tenantId: string): string[] {
  return sql.exec<{ id: string }>(`SELECT id FROM agent_contact_log WHERE tenant_id = ?`, tenantId).toArray().map((r) => r.id);
}

describe("reconcileOrphanedAdmissions — isolate-death fast-follow", () => {
  it("reaps an orphan older than the threshold: log row gone, rate slot freed, a later identical call files a REAL ticket", async () => {
    const { tenantId } = await mintTenant("Reconcile Orphan Co", "managed");
    const now = Date.now();
    const orphanId = newId("sup");
    // No matching D1 support_tickets row — the exact isolate-death shape.
    await withTenantContext(tenantId, (ctx) => seedLogRow(ctx.sql, tenantId, orphanId, now - ISOLATE_DEATH_REAP_TTL_MS - 60_000));

    const result = await withTenantContext(tenantId, (ctx) => reconcileOrphanedAdmissions(ctx, now));
    expect(result.reaped).toBe(1);
    expect(await withTenantContext(tenantId, (ctx) => logRowIds(ctx.sql, tenantId))).toHaveLength(0);

    // Rate slot freed + no phantom dedup hit: the SAME (body, urgency) the
    // orphan never actually recorded now files for real, not a replay.
    const mailer = new SandboxOpsMailer();
    const retry = await withTenantContext(tenantId, (ctx) => contactOperator(ctx, { body: "orphaned by an isolate death", urgency: "normal" }, mailer));
    expect(retry.ticketId).not.toBe(orphanId);
    const stored = await env.DB.prepare(`SELECT id FROM support_tickets WHERE id = ?`).bind(retry.ticketId).first<{ id: string }>();
    expect(stored?.id).toBe(retry.ticketId);
    expect(mailer.sent).toHaveLength(1);
  });

  it("does NOT reap an admission younger than the threshold — the in-flight case", async () => {
    const { tenantId } = await mintTenant("Reconcile Fresh Co", "managed");
    const now = Date.now();
    const freshId = newId("sup");
    // 1 minute old, no D1 ticket yet — indistinguishable from a call still
    // legitimately mid-flight in its own D1 write leg.
    await withTenantContext(tenantId, (ctx) => seedLogRow(ctx.sql, tenantId, freshId, now - 60_000));

    const result = await withTenantContext(tenantId, (ctx) => reconcileOrphanedAdmissions(ctx, now));
    expect(result.reaped).toBe(0);
    expect(await withTenantContext(tenantId, (ctx) => logRowIds(ctx.sql, tenantId))).toEqual([freshId]);
  });

  it("does NOT touch an admission that HAS a matching D1 ticket, even when old", async () => {
    const { tenantId } = await mintTenant("Reconcile Healthy Co", "managed");
    const now = Date.now();
    const id = newId("sup");
    const createdAt = now - ISOLATE_DEATH_REAP_TTL_MS - 60_000;
    await insertSupportTicket(env, {
      id,
      fromEmail: `agent:${tenantId}`,
      subject: "seed",
      body: "a real, completed call",
      tenantId,
      category: "other",
      draft: null,
      status: "escalated",
      createdAt,
      source: "agent",
    });
    await withTenantContext(tenantId, (ctx) => seedLogRow(ctx.sql, tenantId, id, createdAt, null, "a real, completed call"));

    const result = await withTenantContext(tenantId, (ctx) => reconcileOrphanedAdmissions(ctx, now));
    expect(result.reaped).toBe(0);
    expect(await withTenantContext(tenantId, (ctx) => logRowIds(ctx.sql, tenantId))).toEqual([id]);
  });

  it("releases held-claim rows the orphan had co-claimed for its email — their bodies ride the next real send", async () => {
    const { tenantId } = await mintTenant("Reconcile HeldClaim Co", "managed");
    const now = Date.now();
    const claimedAt = now - ISOLATE_DEATH_REAP_TTL_MS - 60_000;

    // A HEALTHY earlier message — has its own D1 ticket, and was co-claimed
    // (emailed_at stamped) by the SAME admission call that then isolate-died
    // before writing ITS OWN ticket.
    const healthyId = newId("sup");
    await insertSupportTicket(env, {
      id: healthyId,
      fromEmail: `agent:${tenantId}`,
      subject: "seed",
      body: "held earlier message",
      tenantId,
      category: "other",
      draft: null,
      status: "escalated",
      createdAt: claimedAt - 1000,
      source: "agent",
    });
    const orphanId = newId("sup");
    await withTenantContext(tenantId, (ctx) => {
      seedLogRow(ctx.sql, tenantId, healthyId, claimedAt - 1000, claimedAt, "held earlier message");
      seedLogRow(ctx.sql, tenantId, orphanId, claimedAt, claimedAt, "orphaned trigger message");
    });

    const result = await withTenantContext(tenantId, (ctx) => reconcileOrphanedAdmissions(ctx, now));
    expect(result.reaped).toBe(1);

    const healthyRow = await withTenantContext(tenantId, (ctx) =>
      ctx.sql.exec<{ emailed_at: number | null }>(`SELECT emailed_at FROM agent_contact_log WHERE id = ?`, healthyId).one(),
    );
    // Claim released — the email that would have carried its text never
    // actually went out, so it must never be stuck "permanently delivered".
    expect(healthyRow.emailed_at).toBeNull();
  });

  it("one tenant's D1 failure during reconcile does not stop the sweep from reaching the next tenant", async () => {
    const { tenantId: wedgedTenant } = await mintTenant("Reconcile Wedged Co", "managed");
    const { tenantId: healthyTenant } = await mintTenant("Reconcile Healthy Sibling Co", "managed");
    const now = Date.now();
    const old = now - ISOLATE_DEATH_REAP_TTL_MS - 60_000;
    const wedgedOrphan = newId("sup");
    const healthyOrphan = newId("sup");
    await withTenantContext(wedgedTenant, (ctx) => seedLogRow(ctx.sql, wedgedTenant, wedgedOrphan, old));
    await withTenantContext(healthyTenant, (ctx) => seedLogRow(ctx.sql, healthyTenant, healthyOrphan, old));

    // Fault-inject the real path: patch env.DB.prepare so the reconcile's
    // ticket lookup throws ONLY when bound to the wedged tenant's id —
    // mirrors spend-ceiling.test.ts's own per-row fault-injection technique.
    const originalPrepare = env.DB.prepare.bind(env.DB);
    (env.DB as any).prepare = (sql: string) => {
      const stmt = originalPrepare(sql);
      if (!sql.startsWith("SELECT id FROM support_tickets WHERE tenant_id")) return stmt;
      const originalBind = stmt.bind.bind(stmt);
      stmt.bind = (...args: unknown[]) => {
        if (args[0] === wedgedTenant) {
          return {
            all: async () => {
              throw new Error("simulated transient D1 read failure");
            },
          } as any;
        }
        return originalBind(...args);
      };
      return stmt;
    };

    try {
      const summary = await runDeliverabilitySweepAllTenants(env);
      expect(summary.errors).toBeGreaterThanOrEqual(1);
    } finally {
      env.DB.prepare = originalPrepare;
    }

    // The wedged tenant's orphan is untouched — its whole deliverabilitySweep
    // call threw and was caught by the per-tenant loop in
    // runDeliverabilitySweepAllTenants.
    expect(await withTenantContext(wedgedTenant, (ctx) => logRowIds(ctx.sql, wedgedTenant))).toEqual([wedgedOrphan]);
    // ...but the healthy tenant's orphan still got reconciled in the SAME run.
    expect(await withTenantContext(healthyTenant, (ctx) => logRowIds(ctx.sql, healthyTenant))).toHaveLength(0);
  });
});

describe("wired into TenantDO.deliverabilitySweep() — the existing cron leg", () => {
  it("the RPC the cron drives per tenant reconciles an isolate-death orphan end-to-end", async () => {
    const { tenantId } = await mintTenant("Reconcile Wiring Co", "managed");
    const now = Date.now();
    const orphanId = newId("sup");
    await withTenantContext(tenantId, (ctx) => seedLogRow(ctx.sql, tenantId, orphanId, now - ISOLATE_DEATH_REAP_TTL_MS - 60_000));

    await tenantStub(tenantId).deliverabilitySweep();

    expect(await withTenantContext(tenantId, (ctx) => logRowIds(ctx.sql, tenantId))).toHaveLength(0);
  });
});
