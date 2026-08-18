import { beforeEach, describe, expect, it } from "vitest";
import { env, listDurableObjectIds, runInDurableObject } from "cloudflare:test";
import { evaluateHealthChecks, runWatchtower } from "../src/admin/watchtower.js";
import { watchtowerStub } from "../src/admin/watchtower-infra.js";
import { TENANT_DO_SCHEMA } from "../src/schema.js";
import { SandboxOpsMailer } from "../src/ops-mail/sandbox-ops-mailer.js";
import type { Env } from "../src/env.js";
import { activatePaidPlan, mintTenant, seedBenignSdnList, tenantStub } from "./helpers.js";

// AUDIT BLOCKING-3 — a wedged tenant DO made that tenant invisible to every
// check while the DO health probe reported healthy.
//
// The per-tenant loop caught, logged and continued, so ONE throw silently
// dropped that tenant's failure signals, its cred_push_aging checks and its
// send_starved check in a single pass — and the same tenant is skipped by the
// dunning, deliverability, digest and send-pipeline sweeps too, each with its
// own errors++ catch. Meanwhile `do_storage` pinged a RateLimiterDO canary, a
// DIFFERENT class holding no customer state, and reported "DO storage probe
// ok" while every TenantDO threw. Executed against the old code: no email named
// the tenant, and do_storage came back healthy.
//
// The shape is not hypothetical — this repo has shipped a TenantDO that 500s at
// CONSTRUCTION twice (a mid-wave table re-key; a UNIQUE-constraint throw).

const T0 = 1_800_000_000_000;
const CANARY = "__watchtower_probe__";

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM watchtower_state").run();
  await env.DB.prepare("DELETE FROM watchtower_cursor").run();
  await runInDurableObject(watchtowerStub(env), async (_instance, state) => {
    await state.storage.deleteAll();
    await state.storage.deleteAlarm();
  });
});

/** Wedge a real, paid, activated tenant the way the incidents did: its storage
 * no longer matches what its code reads, so every opsSummary RPC throws. */
async function wedgedTenant(brand: string): Promise<string> {
  await seedBenignSdnList();
  const { tenantId } = await mintTenant(brand, "managed");
  await activatePaidPlan(tenantId, "managed");
  await runInDurableObject(tenantStub(tenantId), (_instance, state) => {
    state.storage.sql.exec(`DROP TABLE scheduled_sends`);
  });
  return tenantId;
}

describe("BLOCKING-3 — a wedged tenant DO surfaces by name", () => {
  it("alerts the founder, naming the tenant and what it means", async () => {
    const tenantId = await wedgedTenant("Wedged Co");

    const mailer = new SandboxOpsMailer();
    // Two consecutive sweeps: a tenant DO that is wedged (rather than one
    // Cloudflare transient) is still wedged 5 minutes later, which is exactly
    // the distinction the 2026-08-16 debounce draws — see
    // watchtower-debounce.test.ts for the flap side of it.
    await runWatchtower(env, mailer, T0);
    await runWatchtower(env, mailer, T0 + 300_000);

    const named = mailer.sent.filter((m) => m.subject.includes(tenantId));
    expect(named.map((m) => m.subject)).toEqual([`[coldrig] Tenant state unreachable ${tenantId}: UNHEALTHY`]);
    expect(named[0]!.text).toContain("no such table: scheduled_sends");
    expect(named[0]!.text).toContain("invisible to EVERY health check");
  });

  it("does not storm on a tenant that stays wedged, and reports RECOVERED when it answers again", async () => {
    const tenantId = await wedgedTenant("Wedged Twice Co");
    const mailer = new SandboxOpsMailer();

    // Four sweeps (20 min at the live cadence), all inside the 6h cooldown.
    for (let i = 0; i < 4; i++) await runWatchtower(env, mailer, T0 + i * 300_000);
    expect(mailer.sent.filter((m) => m.subject.includes(tenantId))).toHaveLength(1);

    // Re-applying the DO schema is what the constructor does on its next start
    // — the real-world equivalent of shipping the fix. (Note for anyone
    // extending this: `evictDurableObject` HANGS on a DO in this state, so it
    // cannot be used to force the restart.)
    await runInDurableObject(tenantStub(tenantId), (_instance, state) => {
      state.storage.sql.exec(TENANT_DO_SCHEMA);
    });
    await runWatchtower(env, mailer, T0 + 4 * 300_000);

    expect(mailer.sent.filter((m) => m.subject.includes(tenantId)).map((m) => m.subject)).toEqual([
      `[coldrig] Tenant state unreachable ${tenantId}: UNHEALTHY`,
      `[coldrig] Tenant state unreachable ${tenantId}: RECOVERED`,
    ]);
    // Every sweep above scans every tenant and each wedged RPC throw is slow —
    // the default 5s budget is not about correctness here.
  }, 30_000);

  it("stays silent about tenants that are answering (no healthy row per tenant)", async () => {
    await seedBenignSdnList();
    const { tenantId } = await mintTenant("Healthy Co", "managed");
    await activatePaidPlan(tenantId, "managed");

    const mailer = new SandboxOpsMailer();
    await runWatchtower(env, mailer, T0);

    expect(mailer.sent.filter((m) => m.subject.includes(tenantId))).toEqual([]);
    const row = await env.DB.prepare(`SELECT check_name FROM watchtower_state WHERE check_name = ?`)
      .bind(`tenant_do_wedged:${tenantId}`)
      .first();
    expect(row).toBeNull();
  });
});

describe("BLOCKING-3 — the DO probe covers the class that holds tenant state", () => {
  it("reports UNHEALTHY when the TenantDO class itself is broken", async () => {
    // The incident shape: a schema change makes every TenantDO throw. The old
    // probe pinged only RateLimiterDO, which is untouched by this, and reported
    // "DO storage probe ok" straight through it.
    const brokenTenantNamespace = {
      idFromName: (name: string) => name,
      get: () => ({
        ping: async () => {
          throw new Error("no such column: lane");
        },
      }),
    } as unknown as Env["TENANT"];

    const results = await evaluateHealthChecks({ ...env, TENANT: brokenTenantNamespace } as unknown as Env, T0);

    const doStorage = results.find((r) => r.name === "do_storage");
    expect(doStorage?.healthy).toBe(false);
    expect(doStorage?.detail).toContain("TenantDO canary probe failed");
    expect(doStorage?.detail).toContain("no such column: lane");
  });

  it("really constructs the TenantDO canary on the healthy path, and never files it as a tenant", async () => {
    const results = await evaluateHealthChecks(env, T0);
    expect(results.find((r) => r.name === "do_storage")).toEqual({
      name: "do_storage",
      healthy: true,
      // The probe just ran, so the healthy claim is a current measurement — not
      // an entity dropping out of a filtered query (watchtower-alerts.ts's basis).
      basis: "reobserved",
      detail: "DO storage probe ok (RateLimiterDO + TenantDO canary)",
    });

    // The canary DO exists (the class constructed and read its storage)...
    const canaryId = env.TENANT.idFromName(CANARY).toString();
    expect((await listDurableObjectIds(env.TENANT)).map((id) => id.toString())).toContain(canaryId);
    // ...and is NOT in the tenant index, so no sweep ever visits it.
    expect(await env.DB.prepare(`SELECT id FROM tenants_index WHERE id = ?`).bind(CANARY).first()).toBeNull();
  });
});
