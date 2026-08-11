import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { insertSupportTicket, markSupportTicketsEmailed } from "../src/admin/db.js";
import { releaseEmailClaim } from "../src/engine/contact-operator-guard.js";
import { newId } from "../src/schema.js";
import { mintTenant, withTenantContext } from "./helpers.js";

// Gate NON-BLOCKING-2 (docs/adversarial/inc5-reconcile-sweep-gate-2026-08-11.md):
// releaseEmailClaim builds a dynamic `IN (...)` over DO SqlStorage, which
// enforces the SAME 100-bound-parameter ceiling D1 does (gate measured: 99
// ids OK, 100 -> "too many SQL variables"). Not independently reachable
// today — MAX_HELD_BODIES_PER_EMAIL (<=10) in contact-operator-guard.ts
// bounds every real caller's `ids` array — but that bound lives in a
// DIFFERENT file from every exported caller of this function (contact-
// operator-reconcile.ts's reconcile sweep included), so the function's own
// safety was a remote invariant rather than something it enforces itself.
// Chunked the same way as the reconcile sweep so it is safe on its own
// terms regardless of what a future caller passes.

function seedRow(sql: SqlStorage, tenantId: string, id: string, emailedAt: number): void {
  sql.exec(
    `INSERT INTO agent_contact_log (id, tenant_id, body, urgency, created_at, emailed_at) VALUES (?, ?, ?, ?, ?, ?)`,
    id,
    tenantId,
    "seed body",
    "normal",
    emailedAt,
    emailedAt,
  );
}

function emailedAtOf(sql: SqlStorage, id: string): number | null {
  return sql.exec<{ emailed_at: number | null }>(`SELECT emailed_at FROM agent_contact_log WHERE id = ?`, id).one().emailed_at;
}

describe("releaseEmailClaim — chunking against the DO SqlStorage 100-bound-parameter ceiling (gate NON-BLOCKING-2)", () => {
  it("releases ALL of 150 claimed rows in one call — no 'too many SQL variables', no partial release", async () => {
    const { tenantId } = await mintTenant("GuardChunk150 Co", "managed");
    const now = Date.now();
    const ids = Array.from({ length: 150 }, () => newId("sup"));
    await withTenantContext(tenantId, (ctx) => {
      for (const id of ids) seedRow(ctx.sql, tenantId, id, now);
    });

    await withTenantContext(tenantId, (ctx) => releaseEmailClaim(ctx, ids));

    const remaining = await withTenantContext(tenantId, (ctx) => ids.map((id) => emailedAtOf(ctx.sql, id)));
    expect(remaining.every((v) => v === null)).toBe(true);
  });

  it.each([99, 100, 101])("chunk-boundary: releases exactly %d claimed rows with no error", async (count) => {
    const { tenantId } = await mintTenant(`GuardChunkBoundary${count} Co`, "managed");
    const now = Date.now();
    const ids = Array.from({ length: count }, () => newId("sup"));
    await withTenantContext(tenantId, (ctx) => {
      for (const id of ids) seedRow(ctx.sql, tenantId, id, now);
    });

    await withTenantContext(tenantId, (ctx) => releaseEmailClaim(ctx, ids));

    const remaining = await withTenantContext(tenantId, (ctx) => ids.map((id) => emailedAtOf(ctx.sql, id)));
    expect(remaining.every((v) => v === null)).toBe(true);
  });

  it("a chunk boundary does not touch a DIFFERENT tenant's rows sharing the same ids shape", async () => {
    const { tenantId: a } = await mintTenant("GuardChunkTenantA Co", "managed");
    const { tenantId: b } = await mintTenant("GuardChunkTenantB Co", "managed");
    const now = Date.now();
    const ids = Array.from({ length: 100 }, () => newId("sup"));
    await withTenantContext(a, (ctx) => {
      for (const id of ids) seedRow(ctx.sql, a, id, now);
    });
    await withTenantContext(b, (ctx) => {
      for (const id of ids) seedRow(ctx.sql, b, id, now);
    });

    await withTenantContext(a, (ctx) => releaseEmailClaim(ctx, ids));

    const aReleased = await withTenantContext(a, (ctx) => ids.map((id) => emailedAtOf(ctx.sql, id)));
    expect(aReleased.every((v) => v === null)).toBe(true);
    const bUntouched = await withTenantContext(b, (ctx) => ids.map((id) => emailedAtOf(ctx.sql, id)));
    expect(bUntouched.every((v) => v === now)).toBe(true);
  });
});

// Class sweep (gate NO-SHIP fix round): admin/db.ts's markSupportTicketsEmailed
// is the D1-side twin of releaseEmailClaim above — SAME dynamic `IN (...)`
// shape, SAME MAX_HELD_BODIES_PER_EMAIL-derived remote bound, in a THIRD file
// (admin/db.ts) from the constant it depends on. Not called out by name in
// the gate doc (which only reviewed the two files this lane's own diff
// touched), but it is the identical class, found by the sweep the fix round
// asked for. Chunked the same way as releaseEmailClaim.
describe("markSupportTicketsEmailed — chunking against D1's 100-bound-parameter ceiling (class sweep)", () => {
  async function seedTickets(tenantId: string, ids: string[], createdAt: number): Promise<void> {
    for (const id of ids) {
      await insertSupportTicket(env, {
        id,
        fromEmail: `agent:${tenantId}`,
        subject: "seed",
        body: "seed body",
        tenantId,
        category: "other",
        draft: null,
        status: "escalated",
        createdAt,
        source: "agent",
      });
    }
  }

  async function emailSentAtOf(ids: string[]): Promise<(number | null)[]> {
    const rows = await Promise.all(
      ids.map((id) => env.DB.prepare(`SELECT email_sent_at FROM support_tickets WHERE id = ?`).bind(id).first<{ email_sent_at: number | null }>()),
    );
    return rows.map((r) => r?.email_sent_at ?? null);
  }

  it("marks ALL of 150 tickets emailed in one call — no D1_ERROR, no partial write", async () => {
    const { tenantId } = await mintTenant("DbChunk150 Co", "managed");
    const now = Date.now();
    const ids = Array.from({ length: 150 }, () => newId("sup"));
    await seedTickets(tenantId, ids, now);

    await markSupportTicketsEmailed(env, tenantId, ids, now);

    expect((await emailSentAtOf(ids)).every((v) => v === now)).toBe(true);
  });

  it.each([99, 100, 101])("chunk-boundary: marks exactly %d tickets emailed with no error", async (count) => {
    const { tenantId } = await mintTenant(`DbChunkBoundary${count} Co`, "managed");
    const now = Date.now();
    const ids = Array.from({ length: count }, () => newId("sup"));
    await seedTickets(tenantId, ids, now);

    await markSupportTicketsEmailed(env, tenantId, ids, now);

    expect((await emailSentAtOf(ids)).every((v) => v === now)).toBe(true);
  });
});
