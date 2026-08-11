import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { insertSupportTicket } from "../src/admin/db.js";
import { runDeliverabilitySweepAllTenants } from "../src/admin/ops-sweep.js";
import { contactOperator } from "../src/engine/contact-operator.js";
import { EMAIL_THROTTLE_MS } from "../src/engine/contact-operator-guard.js";
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

    // Fault-inject the real path. The candidate lookup now goes through
    // env.DB.batch() (gate BLOCKING-1 fix), one round trip for a whole
    // tenant's chunks — a real D1 connection failure fails that WHOLE batch
    // call, not one statement inside it, so the injection has to fail at the
    // batch() layer rather than swapping out an individual statement's
    // .bind() return value for an incompatible stub (that shape mismatch
    // used to reach batch() and throw ITS OWN unrelated Zod parse error
    // instead of the intended simulated failure — same assertions passed,
    // wrong mechanism). Mirrors spend-ceiling.test.ts's per-row
    // fault-injection technique, adapted to a batched call: tag which bound
    // statements belong to the wedged tenant, then fail the whole batch if
    // any of them are in it.
    const originalPrepare = env.DB.prepare.bind(env.DB);
    const originalBatch = env.DB.batch.bind(env.DB);
    const poisonedStatements = new WeakSet<D1PreparedStatement>();
    (env.DB as any).prepare = (sql: string) => {
      const stmt = originalPrepare(sql);
      if (!sql.startsWith("SELECT id FROM support_tickets WHERE tenant_id")) return stmt;
      const originalBind = stmt.bind.bind(stmt);
      stmt.bind = (...args: unknown[]) => {
        const bound = originalBind(...args);
        if (args[0] === wedgedTenant) poisonedStatements.add(bound);
        return bound;
      };
      return stmt;
    };
    (env.DB as any).batch = (statements: D1PreparedStatement[]) => {
      if (statements.some((s) => poisonedStatements.has(s))) {
        return Promise.reject(new Error("simulated transient D1 read failure"));
      }
      return originalBatch(statements);
    };

    try {
      const summary = await runDeliverabilitySweepAllTenants(env);
      expect(summary.errors).toBeGreaterThanOrEqual(1);
    } finally {
      env.DB.prepare = originalPrepare;
      env.DB.batch = originalBatch;
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

// Gate BLOCKING-1 (docs/adversarial/inc5-reconcile-sweep-gate-2026-08-11.md):
// the candidate-ticket lookup built ONE D1 statement with 1 + candidates.length
// bound parameters, no chunk, no LIMIT — D1's real ceiling is 100 bound
// parameters per statement (ofac/sdn-list.ts:13-19, empirically confirmed),
// and the guard's own header documents ~120 rows as its steady-state max at
// 5 admissions/hour × 24h retention. 120 > 100, so the sweep died exactly
// when the log was largest — the storm state it exists to clean up after —
// and threw the whole tenant's deliverabilitySweep() down with it.
describe("chunking against the D1 100-bound-parameter ceiling (gate BLOCKING-1)", () => {
  it("reaps ALL of 150 orphans in one call — no D1_ERROR, no partial reap", async () => {
    const { tenantId } = await mintTenant("Reconcile Chunk150 Co", "managed");
    const now = Date.now();
    const old = now - ISOLATE_DEATH_REAP_TTL_MS - 60_000;
    await withTenantContext(tenantId, (ctx) => {
      for (let i = 0; i < 150; i++) seedLogRow(ctx.sql, tenantId, newId("sup"), old, null, `orphan body ${i}`);
    });

    const result = await withTenantContext(tenantId, (ctx) => reconcileOrphanedAdmissions(ctx, now));
    expect(result.reaped).toBe(150);
    expect(await withTenantContext(tenantId, (ctx) => logRowIds(ctx.sql, tenantId))).toHaveLength(0);
  });

  it.each([99, 100, 101])("chunk-boundary: reaps exactly %d orphans with no D1_ERROR", async (count) => {
    const { tenantId } = await mintTenant(`Reconcile Chunk${count} Co`, "managed");
    const now = Date.now();
    const old = now - ISOLATE_DEATH_REAP_TTL_MS - 60_000;
    await withTenantContext(tenantId, (ctx) => {
      for (let i = 0; i < count; i++) seedLogRow(ctx.sql, tenantId, newId("sup"), old, null, `boundary body ${i}`);
    });

    const result = await withTenantContext(tenantId, (ctx) => reconcileOrphanedAdmissions(ctx, now));
    expect(result.reaped).toBe(count);
    expect(await withTenantContext(tenantId, (ctx) => logRowIds(ctx.sql, tenantId))).toHaveLength(0);
  });

  it("a chunk boundary does not misclassify a ticketed row as orphaned (100+1 mixed set)", async () => {
    const { tenantId } = await mintTenant("Reconcile ChunkMixed Co", "managed");
    const now = Date.now();
    const old = now - ISOLATE_DEATH_REAP_TTL_MS - 60_000;
    const healthyIds: string[] = [];
    await withTenantContext(tenantId, async (ctx) => {
      // 100 orphans (no D1 ticket) straddling a chunk boundary, plus one
      // healthy ticketed row seeded LAST so it lands in whichever chunk the
      // boundary puts it in — proves chunking doesn't drop a real ticket's
      // "still exists" signal at the seam.
      for (let i = 0; i < 100; i++) seedLogRow(ctx.sql, tenantId, newId("sup"), old, null, `orphan ${i}`);
      const healthyId = newId("sup");
      healthyIds.push(healthyId);
      await insertSupportTicket(env, {
        id: healthyId,
        fromEmail: `agent:${tenantId}`,
        subject: "seed",
        body: "a real, completed call",
        tenantId,
        category: "other",
        draft: null,
        status: "escalated",
        createdAt: old,
        source: "agent",
      });
      seedLogRow(ctx.sql, tenantId, healthyId, old, null, "a real, completed call");
    });

    const result = await withTenantContext(tenantId, (ctx) => reconcileOrphanedAdmissions(ctx, now));
    expect(result.reaped).toBe(100);
    expect(await withTenantContext(tenantId, (ctx) => logRowIds(ctx.sql, tenantId))).toEqual(healthyIds);
  });
});

// Gate NON-BLOCKING-1 correction + "load-bearing, undocumented invariant"
// observation: the sender row that stamps a batch is always younger than
// ISOLATE_DEATH_REAP_TTL_MS (it is the call that just ran), so it is never a
// reap candidate and its emailed_at stamp survives — but ONLY as long as
// ISOLATE_DEATH_REAP_TTL_MS stays greater than EMAIL_THROTTLE_MS. If the reap
// TTL were ever lowered below the throttle window, a sender row could become
// reap-eligible before the throttle it anchors expires, and reconcile's
// held-claim release would null out a live throttle clock — a real bypass,
// not a cosmetic one. Mirrors this repo's R5 ordering-ladder pattern
// (test/send-pipeline-budget.test.ts) — an assertion, not just a comment,
// because a comment did not stop the ladder from breaking there either.
describe("R-inc5 — the reap-vs-throttle ordering ladder is internally coherent", () => {
  it("rung 1: the isolate-death reap TTL exceeds the ops-email throttle window", () => {
    expect(ISOLATE_DEATH_REAP_TTL_MS).toBeGreaterThan(EMAIL_THROTTLE_MS);
  });
});
