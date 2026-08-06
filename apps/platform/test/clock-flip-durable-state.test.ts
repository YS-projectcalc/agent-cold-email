import { describe, expect, it } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import { postWebhook, seedBenignSdnList, signup, tenantStub } from "./helpers.js";
import { checkoutSessionCompleted } from "./stripe-fixtures.js";

// INTEGRATION AUDIT FINDING 1 — the clock flip must gate on DURABLE state, not
// on a field of one call's result.
//
// THE DEFECT. Both checkout paths used to read the RESULT object
// (`result.upgraded` / `result.plan`) to decide whether to flip the tenant off
// the virtual clock. One real Stripe path writes the upgrade to disk without
// populating either: when a delivery FINISHES a previous attempt that died
// mid-handler, `applyStripeWebhookEvent` returns
// `{applied:false, duplicate:true, completed:true}` — no `plan` at all. So the
// customer is paid, their plan is committed, and their DO stays on the frozen
// virtual clock until something happens to evict and reconstruct it. With the
// wave-2 interlock in place that is not a cosmetic skew: `clock_mode` stays
// 'virtual', so the auto-send driver refuses the tenant and a paying customer
// sends NOTHING, for an unbounded time, with no error anywhere.

/**
 * Puts the tenant in the exact state a crashed webhook handler leaves behind:
 * the event id is CLAIMED (so a redelivery is a duplicate) and the in-flight
 * marker is still set (so the redelivery is a completion pass, not a no-op).
 */
async function simulateCrashedWebhookAttempt(tenantId: string, eventId: string): Promise<void> {
  await runInDurableObject(tenantStub(tenantId), async (_i, state) => {
    const now = Date.now();
    state.storage.sql.exec(`INSERT INTO webhook_events (event_id, type, ts) VALUES (?, 'checkout.session.completed', ?)`, eventId, now);
    state.storage.sql.exec(`INSERT INTO webhook_event_inflight (event_id, started_at) VALUES (?, ?)`, eventId, now);
  });
}

async function profileOf(tenantId: string): Promise<{ plan: string; clock_mode: string }> {
  return runInDurableObject(tenantStub(tenantId), async (_i, state) =>
    state.storage.sql.exec<{ plan: string; clock_mode: string }>(`SELECT plan, clock_mode FROM tenant_profile WHERE id = ?`, tenantId).one(),
  );
}

describe("finding 1 — a completion-pass webhook still flips the tenant onto the real clock", () => {
  it("crash -> redelivery finishes the upgrade -> clock_mode is 'real' with NO reconstruct", async () => {
    await seedBenignSdnList();
    // A real signup: every tenant starts 'demo' on the virtual clock.
    const { tenantId } = await signup("Completion Pass Co", "founder@completion-pass.test");
    expect(await profileOf(tenantId)).toMatchObject({ plan: "demo", clock_mode: "virtual" });

    const event = { ...checkoutSessionCompleted({ tenantId, plan: "managed" }), id: `evt_${crypto.randomUUID()}` };
    await simulateCrashedWebhookAttempt(tenantId, event.id);

    // The redelivery. This is the shape that used to leave the clock virtual:
    // the plan IS committed, and the result carries no `plan` to gate on.
    const res = await postWebhook<{ applied: boolean; duplicate: boolean; completed?: boolean; plan?: string }>(event);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ applied: false, duplicate: true, completed: true });
    expect(res.body.plan).toBeUndefined(); // ← exactly why gating on the result failed

    // Durable state: paid AND migrated, in the same request. No eviction, no
    // reconstruct, no second call.
    expect(await profileOf(tenantId)).toMatchObject({ plan: "managed", clock_mode: "real" });
  });

  it("the LIVE in-memory clock swapped too, not just the column", async () => {
    // The column alone would satisfy the driver's interlock while the DO kept
    // stamping virtual times into every row it wrote for the rest of its life.
    // `advanceClock` narrows through `requireVirtualClock`, so it throwing is a
    // direct observation that the instance's own clock is now a RealClock.
    await seedBenignSdnList();
    const { tenantId } = await signup("Live Clock Co", "founder@live-clock.test");
    await tenantStub(tenantId).advanceClock(1000); // demo tenant: fine

    const event = { ...checkoutSessionCompleted({ tenantId, plan: "managed" }), id: `evt_${crypto.randomUUID()}` };
    await simulateCrashedWebhookAttempt(tenantId, event.id);
    await postWebhook(event);

    // Called on the LIVE instance rather than through the stub: this is an
    // assertion about that object's own field, and an in-process call also
    // keeps the throw off the RPC boundary (where it would surface as an
    // uncaught exception whether or not a test caught it).
    await runInDurableObject(tenantStub(tenantId), async (instance) => {
      expect(() => instance.advanceClock(1000)).toThrow(/sandbox-only|real clock/);
    });
  });

  it("an ordinary duplicate redelivery changes nothing (no spurious migration)", async () => {
    await seedBenignSdnList();
    const { tenantId } = await signup("Plain Dup Co", "founder@plain-dup.test");
    const event = { ...checkoutSessionCompleted({ tenantId, plan: "managed" }), id: `evt_${crypto.randomUUID()}` };
    // Claimed but NOT in flight — a plain duplicate, whose effects already ran
    // and must not be re-run.
    await runInDurableObject(tenantStub(tenantId), async (_i, state) => {
      state.storage.sql.exec(
        `INSERT INTO webhook_events (event_id, type, ts) VALUES (?, 'checkout.session.completed', ?)`,
        event.id,
        Date.now(),
      );
    });

    const res = await postWebhook<{ applied: boolean; duplicate: boolean; completed?: boolean }>(event);
    expect(res.body).toMatchObject({ applied: false, duplicate: true });
    expect(res.body.completed).toBeUndefined();
    // Still demo: the reconcile reads DURABLE state, so it correctly declines to
    // migrate a tenant nothing actually upgraded.
    expect(await profileOf(tenantId)).toMatchObject({ plan: "demo", clock_mode: "virtual" });
  });
});
