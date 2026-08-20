import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { CapacityPendingError } from "@coldstart/shared";
import {
  periodKey,
  reapStaleReservations,
  releaseMailboxSlots,
  spendCeilingCents,
  withSpendCeiling,
} from "../src/engine/spend-ceiling.js";
import type { Env } from "../src/env.js";
import type { TenantContext } from "../src/tenant-context.js";
import { SandboxOpsMailer } from "../src/ops-mail/sandbox-ops-mailer.js";
import { mintTenant, withTenantContext } from "./helpers.js";

// GA gates G0/G2/G4 (ga-gates-design-2026-07-22.md §"Systemic guards") — the
// behavior guards for the spend choke-point. Each asserts a real state
// transition (not existence), and the two-concurrent-reserve + over-capacity
// tests are the design's named systemic guards.

// D1 is NOT rolled back between tests in this pool (repo MEMORY: direct env.DB
// writes persist), so reset the account-level vendor tables before each test.
beforeEach(async () => {
  await env.DB.prepare("DELETE FROM vendor_spend_entries").run();
  await env.DB.prepare("DELETE FROM vendor_spend_ledger").run();
  await env.DB.prepare("DELETE FROM vendor_slot_state").run();
});

/** withTenantContext, but forces the bundle kind to 'real' so the choke-point
 *  engages (a minted tenant is billing_state='none' → sandbox otherwise). Only
 *  `.kind` matters to withSpendCeiling; the (unused) real ports are never called
 *  because `fn` is a test double. */
function realCtx<T>(tenantId: string, fn: (ctx: TenantContext) => Promise<T>): Promise<T> {
  return withTenantContext(tenantId, (ctx) => fn({ ...ctx, adapters: { ...ctx.adapters, kind: "real" } }));
}

async function ledgerRow(pk: string) {
  return env.DB.prepare(
    `SELECT reserved_cents, committed_cents, ceiling_cents FROM vendor_spend_ledger WHERE period_key = ?`,
  )
    .bind(pk)
    .first<{ reserved_cents: number; committed_cents: number; ceiling_cents: number }>();
}

async function slotsUsed(): Promise<number> {
  const row = await env.DB.prepare(`SELECT slots_used FROM vendor_slot_state WHERE id = 1`).first<{ slots_used: number }>();
  return row?.slots_used ?? 0;
}

function readProvisioningState(ctx: TenantContext): string {
  return ctx.sql
    .exec<{ provisioning_state: string }>(`SELECT provisioning_state FROM tenant_profile WHERE id = ?`, ctx.tenantId)
    .one().provisioning_state;
}

describe("withSpendCeiling — sandbox tenants never touch the ceiling", () => {
  it("a sandbox bundle runs fn with NO reservation and NO ledger row (structural $0 guarantee)", async () => {
    const { tenantId } = await mintTenant("Sandbox Spend Co", "managed");
    // NOTE: NOT realCtx — the real minted tenant is sandbox (billing 'none').
    const ran = await withTenantContext(tenantId, async (ctx) => {
      let called = false;
      const out = await withSpendCeiling(ctx, "mailbox", async () => {
        called = true;
        return "ok";
      });
      expect(out).toBe("ok");
      const pk = periodKey(ctx.clock.now());
      expect(await ledgerRow(pk)).toBeNull(); // no reservation ever created
      return called;
    });
    expect(ran).toBe(true);
  });
});

describe("G2 — two concurrent reserves that jointly exceed the ceiling: exactly one succeeds", () => {
  it("the atomic conditional UPDATE serializes — one commits, one lands capacity_pending", async () => {
    const { tenantId } = await mintTenant("Ceiling Race Co", "managed");
    const { successes, rejections, committed, reserved, slots } = await realCtx(tenantId, async (baseCtx) => {
      const pk = periodKey(baseCtx.clock.now());
      // A ceiling that admits ONE mailbox (690) but not two (1380), declared in
      // BOTH places that now define it: the configured knob and the stored row.
      // The row alone is no longer sufficient — withSpendCeiling reconciles a
      // stored ceiling UP to the configured one so a mid-month raise takes
      // effect (see the raise-only UPDATE), which would lift a lone stale 1000
      // to the default bound and let both reserves through.
      const ctx = { ...baseCtx, env: { ...baseCtx.env, SPEND_CEILING_CENTS: "1000" } };
      await ctx.env.DB.prepare(
        `INSERT OR REPLACE INTO vendor_spend_ledger (period_key, reserved_cents, committed_cents, ceiling_cents, updated_at) VALUES (?, 0, 0, ?, ?)`,
      )
        .bind(pk, 1000, ctx.clock.now())
        .run();

      const attempt = () =>
        withSpendCeiling(ctx, "mailbox", async () => "bought").then(
          () => ({ ok: true as const }),
          (err) => ({ ok: false as const, err }),
        );
      const results = await Promise.all([attempt(), attempt()]);
      const row = await ledgerRow(pk);
      return {
        successes: results.filter((r) => r.ok).length,
        rejections: results.filter((r) => !r.ok && (r as { err: unknown }).err instanceof CapacityPendingError).length,
        committed: row?.committed_cents ?? -1,
        reserved: row?.reserved_cents ?? -1,
        slots: await slotsUsed(),
      };
    });
    expect(successes).toBe(1);
    expect(rejections).toBe(1);
    expect(committed).toBe(690); // the winner's spend, committed
    expect(reserved).toBe(0); // no reservation left dangling
    expect(slots).toBe(1); // only the winner consumed a slot
    // NOTE: the capacity_pending marker is intentionally NOT asserted here — it
    // is racy under concurrency (the winner's commit clears the marker the loser
    // set, or vice-versa; the final value is whichever ran last and self-corrects
    // on the next attempt). The DETERMINISTIC marker transitions are covered by
    // the single-reserve G4 over-capacity + commit-clears-marker tests below.
  });
});

describe("withSpendCeiling — commit and release move the ledger correctly", () => {
  it("a successful vendor call commits the reserve (reserved→committed, slot held) and clears the marker", async () => {
    const { tenantId } = await mintTenant("Commit Co", "managed");
    await realCtx(tenantId, async (ctx) => {
      const pk = periodKey(ctx.clock.now());
      // Pre-set the marker so we can prove a successful spend clears it.
      ctx.sql.exec(`UPDATE tenant_profile SET provisioning_state = 'capacity_pending' WHERE id = ?`, ctx.tenantId);
      await withSpendCeiling(ctx, "mailbox", async () => "bought");
      const row = await ledgerRow(pk);
      expect(row?.reserved_cents).toBe(0);
      expect(row?.committed_cents).toBe(690);
      expect(await slotsUsed()).toBe(1);
      expect(readProvisioningState(ctx)).toBe("ok");
      const entry = await ctx.env.DB.prepare(`SELECT status FROM vendor_spend_entries WHERE tenant_id = ?`)
        .bind(ctx.tenantId)
        .first<{ status: string }>();
      expect(entry?.status).toBe("committed");
    });
  });

  it("a failed vendor call RELEASES the reserve (reserved and slot back to 0) and re-throws", async () => {
    const { tenantId } = await mintTenant("Release Co", "managed");
    await realCtx(tenantId, async (ctx) => {
      const pk = periodKey(ctx.clock.now());
      await expect(
        withSpendCeiling(ctx, "mailbox", async () => {
          throw new Error("vendor blew up");
        }),
      ).rejects.toThrow("vendor blew up");
      const row = await ledgerRow(pk);
      expect(row?.reserved_cents).toBe(0);
      expect(row?.committed_cents).toBe(0);
      expect(await slotsUsed()).toBe(0);
      const entry = await ctx.env.DB.prepare(`SELECT status FROM vendor_spend_entries WHERE tenant_id = ?`)
        .bind(ctx.tenantId)
        .first<{ status: string }>();
      expect(entry?.status).toBe("released");
    });
  });
});

describe("G4 — provisioning the (plan+1)th mailbox: attempt-then-capacity_pending + alert, never silent success", () => {
  it("over plan-slot capacity → CapacityPendingError('slot_capacity'), fn NOT run, one founder alert, $ reserve rolled back", async () => {
    const { tenantId } = await mintTenant("Slot Cap Co", "managed");
    const mailer = new SandboxOpsMailer();
    // OPS_ALERT_EMAIL is a required binding (env.ts) — present in the test env,
    // so the alert path actually attempts a send into our sandbox mailer.
    await realCtx(tenantId, async (ctx) => {
      const pk = periodKey(ctx.clock.now());
      // Slots already at the default plan cap (10) — the next mailbox is slot 11.
      await ctx.env.DB.prepare(
        `INSERT OR REPLACE INTO vendor_slot_state (id, slots_used, updated_at) VALUES (1, 10, ?)`,
      )
        .bind(ctx.clock.now())
        .run();

      let fnRan = false;
      const err = await withSpendCeiling(
        ctx,
        "mailbox",
        async () => {
          fnRan = true;
          return "bought";
        },
        mailer,
      ).catch((e) => e);

      expect(fnRan).toBe(false); // never silently provisioned slot 11
      expect(err).toBeInstanceOf(CapacityPendingError);
      expect((err as CapacityPendingError).reason).toBe("slot_capacity");
      expect(readProvisioningState(ctx)).toBe("capacity_pending");
      expect(await slotsUsed()).toBe(10); // slot count unchanged (no over-provision)
      const row = await ledgerRow(pk);
      expect(row?.reserved_cents).toBe(0); // the $ reserve was rolled back
    });
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]?.subject).toContain("slot_capacity");
  });

  it("the alert fires ONCE per transition, not once per rejected mailbox (no storm)", async () => {
    const { tenantId } = await mintTenant("No Storm Co", "managed");
    const mailer = new SandboxOpsMailer();
    await realCtx(tenantId, async (ctx) => {
      await ctx.env.DB.prepare(`INSERT OR REPLACE INTO vendor_slot_state (id, slots_used, updated_at) VALUES (1, 10, ?)`)
        .bind(ctx.clock.now())
        .run();
      for (let i = 0; i < 3; i++) {
        await withSpendCeiling(ctx, "mailbox", async () => "bought", mailer).catch(() => undefined);
      }
    });
    expect(mailer.sent).toHaveLength(1); // marker already capacity_pending after the first → no re-alert
  });
});

describe("reapStaleReservations — reclaims reservations orphaned by a crash (design NB-2)", () => {
  it("releases a stale 'reserved' mailbox entry back into the ledger AND the slot counter", async () => {
    const now = Date.now();
    const pk = periodKey(now);
    const staleAt = now - 60 * 60 * 1000; // 1h old — well past the 15-min reap TTL
    await env.DB.prepare(
      `INSERT INTO vendor_spend_ledger (period_key, reserved_cents, committed_cents, ceiling_cents, updated_at) VALUES (?, 690, 0, 15000, ?)`,
    )
      .bind(pk, staleAt)
      .run();
    await env.DB.prepare(`INSERT OR REPLACE INTO vendor_slot_state (id, slots_used, updated_at) VALUES (1, 1, ?)`)
      .bind(staleAt)
      .run();
    await env.DB.prepare(
      `INSERT INTO vendor_spend_entries (id, period_key, tenant_id, kind, est_cents, actual_cents, status, created_at, updated_at)
       VALUES ('vsp_stale', ?, 'ten_x', 'mailbox', 690, NULL, 'reserved', ?, ?)`,
    )
      .bind(pk, staleAt, staleAt)
      .run();

    const result = await reapStaleReservations(env, now);
    expect(result.reaped).toBe(1);
    expect(result.releasedCents).toBe(690);

    const row = await ledgerRow(pk);
    expect(row?.reserved_cents).toBe(0); // reservation reclaimed
    expect(await slotsUsed()).toBe(0); // slot reclaimed too (kind='mailbox')
    const entry = await env.DB.prepare(`SELECT status FROM vendor_spend_entries WHERE id = 'vsp_stale'`).first<{ status: string }>();
    expect(entry?.status).toBe("released");
  });

  it("leaves a FRESH reservation (within the TTL) untouched", async () => {
    const now = Date.now();
    const pk = periodKey(now);
    await env.DB.prepare(
      `INSERT INTO vendor_spend_ledger (period_key, reserved_cents, committed_cents, ceiling_cents, updated_at) VALUES (?, 690, 0, 15000, ?)`,
    )
      .bind(pk, now)
      .run();
    await env.DB.prepare(
      `INSERT INTO vendor_spend_entries (id, period_key, tenant_id, kind, est_cents, actual_cents, status, created_at, updated_at)
       VALUES ('vsp_fresh', ?, 'ten_x', 'domain', 690, NULL, 'reserved', ?, ?)`,
    )
      .bind(pk, now, now)
      .run();
    const result = await reapStaleReservations(env, now);
    expect(result.reaped).toBe(0);
    expect((await ledgerRow(pk))?.reserved_cents).toBe(690); // still reserved
  });

  // Adversarial audit 2026-08-05 (docs/adversarial/audit-dunning-2026-08-05.md)
  // class-sweep sibling: the per-row loop had NO try/catch, so one row's
  // transient D1 write failure aborted reaping the rest of that tick's batch.
  it("one row's transient D1 write failure must not abort reaping a later stale row in the same batch", async () => {
    const now = Date.now();
    const pk = periodKey(now);
    const staleAt = now - 60 * 60 * 1000; // 1h old — well past the 15-min reap TTL

    await env.DB.prepare(
      `INSERT INTO vendor_spend_ledger (period_key, reserved_cents, committed_cents, ceiling_cents, updated_at) VALUES (?, 1380, 0, 15000, ?)`,
    )
      .bind(pk, staleAt)
      .run();
    await env.DB.prepare(
      `INSERT INTO vendor_spend_entries (id, period_key, tenant_id, kind, est_cents, actual_cents, status, created_at, updated_at)
       VALUES ('vsp_wedged', ?, 'ten_wedged', 'domain', 690, NULL, 'reserved', ?, ?)`,
    )
      .bind(pk, staleAt, staleAt)
      .run();
    await env.DB.prepare(
      `INSERT INTO vendor_spend_entries (id, period_key, tenant_id, kind, est_cents, actual_cents, status, created_at, updated_at)
       VALUES ('vsp_healthy', ?, 'ten_healthy', 'domain', 690, NULL, 'reserved', ?, ?)`,
    )
      .bind(pk, staleAt, staleAt)
      .run();

    // Fault-inject the real path: patch env.DB.prepare so the flip UPDATE
    // throws ONLY for the wedged row's bound id — everything else (including
    // the healthy row's own flip) goes through the real D1 binding untouched.
    const originalPrepare = env.DB.prepare.bind(env.DB);
    (env.DB as any).prepare = (sql: string) => {
      const stmt = originalPrepare(sql);
      if (!sql.startsWith(`UPDATE vendor_spend_entries SET status = 'released'`)) return stmt;
      const originalBind = stmt.bind.bind(stmt);
      stmt.bind = (...args: unknown[]) => {
        if (args[1] === "vsp_wedged") {
          return { run: async () => { throw new Error("simulated transient D1 write failure"); } } as any;
        }
        return originalBind(...args);
      };
      return stmt;
    };

    try {
      const result = await reapStaleReservations(env, now);
      expect(result.errors).toBe(1);
      expect(result.reaped).toBe(1); // the healthy row still reaped despite its sibling's failure
    } finally {
      env.DB.prepare = originalPrepare;
    }

    const wedged = await env.DB.prepare(`SELECT status FROM vendor_spend_entries WHERE id = 'vsp_wedged'`).first<{ status: string }>();
    expect(wedged?.status).toBe("reserved"); // untouched — retries on the next tick

    const healthy = await env.DB.prepare(`SELECT status FROM vendor_spend_entries WHERE id = 'vsp_healthy'`).first<{ status: string }>();
    expect(healthy?.status).toBe("released"); // reaped

    expect((await ledgerRow(pk))?.reserved_cents).toBe(690); // only the healthy row's 690 released, wedged's 690 stays reserved
  });
});

// S-remedy (founder ruling 2026-08-18, ROADMAP.md ## Open): the ceiling is the
// deliberate pilot blast-radius bound, and its remedy is to SCALE IT WITH
// PAYING-TENANT COUNT rather than leave a flat pilot dollar figure that caps the
// whole platform at ~21 mailboxes/month (scale-readiness-audit-2026-08-17.md S2).
//
// The concrete cents below are asserted deliberately rather than re-derived from
// the constants: this is a money guard, so a change to the blast-radius bound
// SHOULD redden a test and be read by a human, not silently track a refactor.
describe("spendCeilingCents — the blast-radius bound scales with paying tenants", () => {
  function envWith(overrides: Partial<Env>): Env {
    return overrides as Env;
  }

  it("defaults to the one-paying-tenant pilot bound", () => {
    expect(spendCeilingCents(envWith({}))).toBe(18000); // $60 platform base + 1 x $120
  });

  it("scales linearly with PAYING_TENANT_COUNT", () => {
    expect(spendCeilingCents(envWith({ PAYING_TENANT_COUNT: "10" }))).toBe(126000); // $60 + 10 x $120
    expect(spendCeilingCents(envWith({ PAYING_TENANT_COUNT: "100" }))).toBe(1206000);
  });

  it("still honors SPEND_CEILING_CENTS as an absolute override, whatever the count says", () => {
    expect(spendCeilingCents(envWith({ SPEND_CEILING_CENTS: "5000", PAYING_TENANT_COUNT: "100" }))).toBe(5000);
  });

  it("falls back to the pilot bound on an unparseable or absent count (never to an unbounded one)", () => {
    expect(spendCeilingCents(envWith({ PAYING_TENANT_COUNT: "" }))).toBe(18000);
    expect(spendCeilingCents(envWith({ PAYING_TENANT_COUNT: "not-a-number" }))).toBe(18000);
  });
});

// The reserve gates on the LEDGER ROW's ceiling_cents, which is seeded at the
// first spend of a calendar month — so raising the configured ceiling did
// nothing until the 1st. That made the ops alert's own instruction false:
// alertCapacityPending says "raise SPEND_CEILING_CENTS ... a retry will succeed
// once the limit is raised", and the retry hit the same stale stored number.
describe("a raised ceiling takes effect within the SAME calendar month", () => {
  it("lifts a stored ceiling that is BELOW the configured one, so the instructed retry succeeds", async () => {
    const { tenantId } = await mintTenant("Mid Month Raise Co", "managed");
    await realCtx(tenantId, async (ctx) => {
      const pk = periodKey(ctx.clock.now());
      // A row seeded earlier in the month, under a far lower configured ceiling:
      // admits ONE mailbox (690) but not two (1380).
      await ctx.env.DB.prepare(
        `INSERT OR REPLACE INTO vendor_spend_ledger (period_key, reserved_cents, committed_cents, ceiling_cents, updated_at) VALUES (?, 0, 0, ?, ?)`,
      )
        .bind(pk, 1000, ctx.clock.now())
        .run();

      await withSpendCeiling(ctx, "mailbox", async () => "bought");
      // The second one is what the stale stored ceiling used to refuse forever.
      await withSpendCeiling(ctx, "mailbox", async () => "bought");

      const row = await ledgerRow(pk);
      expect(row?.ceiling_cents).toBe(18000); // raised to the configured bound
      expect(row?.committed_cents).toBe(1380); // both spends landed
      expect(readProvisioningState(ctx)).toBe("ok");
    });
  });

  it("NEVER lowers a stored ceiling — a mid-month reduction must not strand live reserves", async () => {
    const { tenantId } = await mintTenant("No Lower Co", "managed");
    await realCtx(tenantId, async (ctx) => {
      const pk = periodKey(ctx.clock.now());
      await ctx.env.DB.prepare(
        `INSERT OR REPLACE INTO vendor_spend_ledger (period_key, reserved_cents, committed_cents, ceiling_cents, updated_at) VALUES (?, 0, 0, ?, ?)`,
      )
        .bind(pk, 50000, ctx.clock.now())
        .run();

      await withSpendCeiling(ctx, "mailbox", async () => "bought");

      const row = await ledgerRow(pk);
      expect(row?.ceiling_cents).toBe(50000); // the higher stored bound stands
    });
  });
});

describe("releaseMailboxSlots — teardown decrements the account slot counter", () => {
  it("decrements by the count of real slot-counted mailboxes released", async () => {
    const { tenantId } = await mintTenant("Teardown Slots Co", "managed");
    await realCtx(tenantId, async (ctx) => {
      await ctx.env.DB.prepare(`INSERT OR REPLACE INTO vendor_slot_state (id, slots_used, updated_at) VALUES (1, 3, ?)`)
        .bind(ctx.clock.now())
        .run();
      await releaseMailboxSlots(ctx, 2, ctx.clock.now());
      expect(await slotsUsed()).toBe(1);
      // Never below zero, even if the count over-reaches.
      await releaseMailboxSlots(ctx, 5, ctx.clock.now());
      expect(await slotsUsed()).toBe(0);
    });
  });
});
