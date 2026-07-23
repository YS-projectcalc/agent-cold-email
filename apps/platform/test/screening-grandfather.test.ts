import { describe, expect, it } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import type { TenantDO } from "../src/tenant-do.js";
import { activatePaidPlan, mintTenant, tenantStub } from "./helpers.js";

// G1 grandfather migration (Founder Q2, ADOPTED under the autonomy grant:
// "already-active pilot tenants are grandfathered clear ... so turning
// screening on can never strand the live pilot"). tenant-do.ts's
// grandfatherActiveScreening() is self-applying (same idiom as
// ensureColumnMigrations/addColumnIfMissing) — this exercises it DIRECTLY via
// the DO instance (mirroring activation-gate.test.ts's own private-method
// test pattern) since a genuine DO reconstruction isn't reliably triggerable
// from a test.
interface TenantDOWithGrandfather {
  grandfatherActiveScreening(): void;
}

describe("tenant-do.ts grandfatherActiveScreening — never strands an already-active tenant", () => {
  it("a tenant that is ALREADY billing_state='active' with screening_list_version NULL gets stamped 'clear' + the grandfather sentinel version", async () => {
    const { tenantId } = await mintTenant("Grandfather Pilot Co", "launch");
    await activatePaidPlan(tenantId, "launch"); // billing_state -> 'active' (also screens it for real via G1b's checkout hook)

    // Simulate "this row predates G1's screen-at-checkout wiring": clear the
    // columns back to the pre-screen state a genuinely-old row would have had.
    await runInDurableObject(tenantStub(tenantId), async (_i, state) => {
      state.storage.sql.exec(
        `UPDATE tenant_profile SET screening_status = 'clear', screening_list_version = NULL, screened_at = NULL WHERE id = ?`,
        tenantId,
      );
    });

    await runInDurableObject(tenantStub(tenantId), async (instance, state) => {
      (instance as unknown as TenantDOWithGrandfather).grandfatherActiveScreening();
      const row = state.storage.sql
        .exec<{ screening_status: string; screening_list_version: string | null; screened_at: number | null }>(
          `SELECT screening_status, screening_list_version, screened_at FROM tenant_profile WHERE id = ?`,
          tenantId,
        )
        .one();
      expect(row.screening_status).toBe("clear");
      expect(row.screening_list_version).toBe("grandfathered-2026-07-23");
      expect(row.screened_at).not.toBeNull();
    });
  });

  it("is a no-op for a tenant NOT currently billing_state='active' (nothing to strand)", async () => {
    const { tenantId } = await mintTenant("Grandfather Demo Co", "demo"); // billing_state defaults 'none'
    await runInDurableObject(tenantStub(tenantId), async (instance, state) => {
      (instance as unknown as TenantDOWithGrandfather).grandfatherActiveScreening();
      const row = state.storage.sql
        .exec<{ screening_list_version: string | null }>(`SELECT screening_list_version FROM tenant_profile WHERE id = ?`, tenantId)
        .one();
      expect(row.screening_list_version).toBeNull(); // untouched — will be screened for real at its first checkout
    });
  });

  it("is a no-op (never re-stamps) once screening_list_version is ALREADY set — either by a real screen or a prior grandfather stamp", async () => {
    const { tenantId } = await mintTenant("Grandfather Already Screened Co", "launch");
    await runInDurableObject(tenantStub(tenantId), async (_i, state) => {
      state.storage.sql.exec(
        `UPDATE tenant_profile SET billing_state = 'active', screening_list_version = 'sdn-real-version-123' WHERE id = ?`,
        tenantId,
      );
    });
    await runInDurableObject(tenantStub(tenantId), async (instance, state) => {
      (instance as unknown as TenantDOWithGrandfather).grandfatherActiveScreening();
      const row = state.storage.sql
        .exec<{ screening_list_version: string | null }>(`SELECT screening_list_version FROM tenant_profile WHERE id = ?`, tenantId)
        .one();
      // Untouched — the real screen's version is never overwritten by the
      // grandfather sentinel.
      expect(row.screening_list_version).toBe("sdn-real-version-123");
    });
  });
});
