import { describe, expect, it } from "vitest";
import { emitTenantMessage, READ_RETENTION_MS } from "../src/engine/tenant-messages.js";
import { signup, tenantStub, withTenantContext } from "./helpers.js";

// The prune leg (engine/tenant-messages.ts's pruneTenantMessages) is wired
// into TenantDO.deliverabilitySweep() — the SAME standalone RPC the cron
// (runDeliverabilitySweepAllTenants, called from scheduled.ts) drives per
// tenant, so no new cron is needed (brief: "reuse an existing cron leg").
//
// This file asserts the WIRING, not the retention policy — so the expired row
// is aged past READ_RETENTION_MS, which both legs of the prune now carry
// (build gate r2, 2026-08-19: an expiry the platform infers on its own has to
// stay recoverable for as long as an ack the customer performed). The policy
// itself lives in test/tenant-messages.test.ts and
// test/next-steps-slot-shortfall.test.ts.

function rowCount(sql: SqlStorage, tenantId: string): number {
  return sql.exec<{ n: number }>(`SELECT COUNT(*) as n FROM tenant_messages WHERE tenant_id = ?`, tenantId).one().n;
}

describe("deliverabilitySweep() prunes expired tenant_messages", () => {
  it("an expired message is gone after the sweep runs; a live one survives", async () => {
    const { tenantId } = await signup("Prune Wire Co", "founder@prunewire.test");
    const past = await withTenantContext(tenantId, (ctx) => ctx.clock.now() - READ_RETENTION_MS - 1000);
    await withTenantContext(tenantId, (ctx) => emitTenantMessage(ctx, { kind: "k", severity: "info", body: "expired", expiresAt: past }));
    await withTenantContext(tenantId, (ctx) => emitTenantMessage(ctx, { kind: "k", severity: "info", body: "live" }));
    expect(await withTenantContext(tenantId, (ctx) => rowCount(ctx.sql, tenantId))).toBe(2);

    await tenantStub(tenantId).deliverabilitySweep();

    const remaining = await withTenantContext(tenantId, (ctx) =>
      ctx.sql.exec<{ body: string }>(`SELECT body FROM tenant_messages WHERE tenant_id = ?`, tenantId).toArray(),
    );
    expect(remaining.map((r) => r.body)).toEqual(["live"]);
  });
});
