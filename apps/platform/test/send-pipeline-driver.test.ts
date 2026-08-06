import { afterEach, describe, expect, it, vi } from "vitest";
import { createExecutionContext, createScheduledController, env, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index.js";
import sdnValidCsv from "./fixtures/ofac/sdn-valid.csv?raw";
import {
  activatePaidPlan,
  api,
  failPayment,
  makeMailboxesSendEligible,
  mintTenant,
  postWebhook,
  seedBenignSdnList,
  tenantStub,
} from "./helpers.js";

// WAVE 2 Inc-D — the SEND PIPELINE DRIVER, tested at the REAL entry point.
//
// Every test below drives `worker.scheduled(...)`, i.e. the actual cron body
// (src/scheduled.ts -> runScheduledOpsSweep -> runSendPipelineAllTenants ->
// TenantDO.runScheduledPoll/runScheduledTick). Calling `runTick` directly would
// prove nothing about arming: the whole class of defect this wave exists to
// close is "the code is correct and nothing in production calls it".
//
// The engine is faked at the FETCH boundary rather than by swapping a port, so
// the RealEmailPort's own request shaping, error grading and idempotency-key
// construction are all exercised — a hand-built adapter would be structurally
// blind to those.

afterEach(() => vi.restoreAllMocks());

const ENGINE_BASE_URL = "https://engine.test";

interface ArmedEnv {
  ENGINE_BASE_URL?: string;
  ENGINE_AUTH_SECRET?: string;
  INBOXKIT_API_KEY?: string;
  INBOXKIT_WORKSPACE_ID?: string;
  AUTOSEND_DISABLED?: string;
}

/**
 * Arms the four bindings that make `realSendPathLive(env)` true — predicate
 * leg 4. Returns a restore function; every test MUST call it, because setting
 * these also arms `isRealSpendArmed` for every later test in the file
 * (test/helpers.ts's postDisputeWebhook documents the same hazard).
 */
function armRealSendPath(overrides: ArmedEnv = {}): () => void {
  const target = env as unknown as ArmedEnv;
  const saved: ArmedEnv = {
    ENGINE_BASE_URL: target.ENGINE_BASE_URL,
    ENGINE_AUTH_SECRET: target.ENGINE_AUTH_SECRET,
    INBOXKIT_API_KEY: target.INBOXKIT_API_KEY,
    INBOXKIT_WORKSPACE_ID: target.INBOXKIT_WORKSPACE_ID,
    AUTOSEND_DISABLED: target.AUTOSEND_DISABLED,
  };
  target.ENGINE_BASE_URL = ENGINE_BASE_URL;
  target.ENGINE_AUTH_SECRET = "engine-test-secret";
  target.INBOXKIT_API_KEY = "inboxkit-test-key";
  target.INBOXKIT_WORKSPACE_ID = "inboxkit-test-workspace";
  Object.assign(target, overrides);
  return () => Object.assign(target, saved);
}

interface FakeEngine {
  /** Every /v1/send call, in order, by idempotency key (repeats included). */
  calls: string[];
}

/**
 * The DISTINCT send keys belonging to ONE tenant. Scoping matters: the D1
 * tenants_index is shared across a file's tests, so a cron run drives every
 * tenant any earlier test created. An unscoped `expect(sendKeys).toEqual([])`
 * would be measuring the whole file, and an unscoped count would be measuring
 * the neighbours.
 */
function keysFor(engine: FakeEngine, tenantId: string): string[] {
  return [...new Set(engine.calls.filter((k) => k.startsWith(`send:${tenantId}:`)))];
}

function callsFor(engine: FakeEngine, tenantId: string): number {
  return engine.calls.filter((k) => k.startsWith(`send:${tenantId}:`)).length;
}

/**
 * Stubs `fetch` with a minimal but HONEST cold-engine: /v1/send is idempotent
 * on its key (a repeat returns the SAME messageId without a second wire send,
 * exactly like apps/engine's send cache), /v1/poll returns nothing, and any
 * other host (InboxKit, the OFAC list, the watchtower's engine /health probe)
 * answers benignly so the cron's other legs neither throw nor reach the network.
 */
function fakeEngine(): FakeEngine {
  const state: FakeEngine = { calls: [] };
  const cache = new Map<string, { messageId: string; sentAt: number }>();
  vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith(`${ENGINE_BASE_URL}/v1/send`)) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { idempotencyKey: string };
      state.calls.push(body.idempotencyKey);
      let cached = cache.get(body.idempotencyKey);
      if (!cached) {
        cached = { messageId: `<msg-${cache.size + 1}@engine.test>`, sentAt: Date.now() };
        cache.set(body.idempotencyKey, cached);
      }
      return new Response(JSON.stringify(cached), { status: 200 });
    }
    if (url.startsWith(`${ENGINE_BASE_URL}/v1/poll`)) {
      return new Response(JSON.stringify({ events: [], cursor: 0 }), { status: 200 });
    }
    if (url.includes("sdn") || url.endsWith(".csv") || url.includes("treasury")) {
      return new Response(sdnValidCsv, { status: 200 });
    }
    return new Response(JSON.stringify({ data: [], pages: 1 }), { status: 200 });
  }) as typeof fetch);
  return state;
}

async function runCron(): Promise<void> {
  const ctx = createExecutionContext();
  await worker.scheduled(createScheduledController(), env, ctx);
  await waitOnExecutionContext(ctx);
}

function setupBody(brand: string, domain: string) {
  return JSON.stringify({
    brand,
    primaryDomain: domain,
    domains: 1,
    inboxesEach: 1,
    persona: "Sender",
    physicalAddress: "1 Send St",
    senderIdentity: `Sender <s@${domain}>`,
  });
}

function campaignBody(name: string, leadEmails: string[]) {
  return JSON.stringify({
    name,
    offer: "x",
    leads: leadEmails.map((email, i) => ({ email, firstName: `L${i}`, company: "Co" })),
    sequence: [{ step: 1, subject: "Hi", body: "Hi", delayDays: 0 }],
  });
}

/**
 * A paid, activated tenant with real-looking mailboxes and a launched campaign
 * — everything the activation predicate needs EXCEPT the armed env, which each
 * test arms (or deliberately does not) for itself. Provisioning happens while
 * UNARMED on purpose: that is the real sequence (a customer sets up, then we
 * arm), and it is what leaves the sandbox-provider rows the wave-2 predicate
 * has to reason about.
 */
async function paidTenantWithDueSends(brand: string, domain: string, leads: string[]): Promise<{ tenantId: string; token: string }> {
  await seedBenignSdnList();
  const { tenantId, token } = await mintTenant(brand, "managed");
  await activatePaidPlan(tenantId, "managed");
  await api("/setup-infrastructure", { method: "POST", token, body: setupBody(brand, domain) });
  await makeMailboxesSendEligible(tenantId);
  await api("/campaigns", { method: "POST", token, body: campaignBody(`${brand} campaign`, leads) });
  return { tenantId, token };
}

function sendStatuses(tenantId: string): Promise<{ status: string; message_id: string | null }[]> {
  return runInDurableObject(tenantStub(tenantId), async (_i, state) =>
    state.storage.sql
      .exec<{ status: string; message_id: string | null }>(
        `SELECT status, message_id FROM scheduled_sends WHERE tenant_id = ? ORDER BY id`,
        tenantId,
      )
      .toArray(),
  );
}

describe("send pipeline driver — the cron actually sends", () => {
  it("an activated real-clock tenant's due rows go out through the real cron body", async () => {
    const { tenantId } = await paidTenantWithDueSends("Driver Co", "driver-co.test", ["lead@driver-leads.test"]);
    const engine = fakeEngine();
    const restore = armRealSendPath();
    try {
      await runCron();
    } finally {
      restore();
    }

    expect(keysFor(engine, tenantId)).toHaveLength(1);
    const rows = await sendStatuses(tenantId);
    expect(rows.map((r) => r.status)).toEqual(["sent"]);
    expect(rows[0]?.message_id).toMatch(/^<msg-\d+@engine\.test>$/);
  });
});

// --- Predicate: ONE case per leg. Each must send NOTHING. -----------------
//
// Every case follows the same three-step shape, and the FIRST step is what
// makes it a real test rather than coverage theater:
//   1. run the cron on a healthy fixture and assert the tenant DOES send —
//      proving the fixture is send-capable and the zero below is caused by the
//      leg under test and nothing incidental (a rejected setup, a missing
//      mailbox, an empty backlog);
//   2. queue a fresh due row and break exactly one leg;
//   3. run the cron again and assert NO new send for this tenant.
// On code without the predicate, step 3 sends — that is the RED.

/** Launches one more campaign, i.e. queues exactly one more due row. */
async function queueAnotherDueSend(token: string, brand: string, lead: string): Promise<void> {
  await api("/campaigns", { method: "POST", token, body: campaignBody(`${brand} follow-up`, [lead]) });
}

/**
 * Step 1+2 of the shape above: prove the fixture sends, then queue one more
 * row. Returns how many distinct keys the tenant had sent by then.
 */
async function proveSendCapableThenQueueAnother(
  engine: FakeEngine,
  tenantId: string,
  token: string,
  brand: string,
  lead: string,
): Promise<number> {
  const restore = armRealSendPath();
  try {
    await runCron();
  } finally {
    restore();
  }
  const sentSoFar = keysFor(engine, tenantId).length;
  expect(sentSoFar, "fixture must be send-capable before a leg is broken, or the zero below proves nothing").toBe(1);
  await queueAnotherDueSend(token, brand, lead);
  return sentSoFar;
}

describe("send pipeline driver — the activation predicate", () => {
  it("leg 1: a demo tenant is never driven (its rows are sendable — a direct tick proves it)", async () => {
    await seedBenignSdnList();
    const { tenantId, token } = await mintTenant("Demo Driver", "demo");
    await api("/setup-infrastructure", { method: "POST", token, body: setupBody("Demo Driver", "demo-driver.test") });
    await api("/campaigns", { method: "POST", token, body: campaignBody("Demo campaign", ["lead@demo-driver-leads.test"]) });
    const engine = fakeEngine();
    const restore = armRealSendPath();
    try {
      await runCron();
    } finally {
      restore();
    }
    expect(keysFor(engine, tenantId)).toEqual([]);
    expect((await sendStatuses(tenantId)).every((r) => r.status === "pending")).toBe(true);
    // Non-vacuity: the rows really were sendable — the DEMO path (a direct
    // tick against the sandbox bundle) drains them. Only the cron is gated.
    expect((await tenantStub(tenantId).tick()).sent).toBe(1);
  });

  it("leg 2: a paid tenant still on the virtual clock is never driven (the L4/L5 interlock)", async () => {
    const brand = "Virtual Clock Co";
    const { tenantId, token } = await paidTenantWithDueSends(brand, "virtual-clock.test", ["a@virtual-clock-leads.test"]);
    const engine = fakeEngine();
    const before = await proveSendCapableThenQueueAnother(engine, tenantId, token, brand, "b@virtual-clock-leads.test");

    // Back to the pre-migration state the interlock exists for.
    await runInDurableObject(tenantStub(tenantId), async (_i, state) => {
      state.storage.sql.exec(`UPDATE tenant_profile SET clock_mode = 'virtual' WHERE id = ?`, tenantId);
    });
    const restore = armRealSendPath();
    try {
      await runCron();
    } finally {
      restore();
    }
    expect(keysFor(engine, tenantId)).toHaveLength(before);
  });

  // 'past_due' and 'suspended' are driven through their REAL paths (the Stripe
  // webhook and the dunning sweep's own RPC). 'canceling'/'canceled'/'disputed'
  // are written directly: the real routes also tear the infrastructure down,
  // which would remove the mailboxes and make the resulting zero ambiguous.
  // The billing_state value IS the thing leg 3 reads, so writing it is exactly
  // the state under test with nothing else moving.
  const setBillingState = (billingState: string) => async (tenantId: string) => {
    await runInDurableObject(tenantStub(tenantId), async (_i, state) => {
      state.storage.sql.exec(`UPDATE tenant_profile SET billing_state = ? WHERE id = ?`, billingState, tenantId);
    });
  };

  it.each([
    ["pastdue", async (tenantId: string) => failPayment(tenantId)],
    [
      "suspended",
      async (tenantId: string) => {
        await failPayment(tenantId);
        await tenantStub(tenantId).suspendForDunning();
      },
    ],
    ["canceling", setBillingState("canceling")],
    ["canceled", setBillingState("canceled")],
    ["disputed", setBillingState("disputed")],
    [
      "screening",
      async (tenantId: string) => {
        await runInDurableObject(tenantStub(tenantId), async (_i, state) => {
          state.storage.sql.exec(`UPDATE tenant_profile SET screening_status = 'review' WHERE id = ?`, tenantId);
        });
      },
    ],
  ])("leg 3: a %s tenant is never driven", async (label, degrade) => {
    const brand = `Leg3 ${label} Co`;
    const domain = `leg3-${label}-co.test`;
    const { tenantId, token } = await paidTenantWithDueSends(brand, domain, [`a@${domain}`]);
    const engine = fakeEngine();
    const before = await proveSendCapableThenQueueAnother(engine, tenantId, token, brand, `b@${domain}`);

    await degrade(tenantId);
    const restore = armRealSendPath();
    try {
      await runCron();
    } finally {
      restore();
    }
    expect(keysFor(engine, tenantId)).toHaveLength(before);
    // The stronger half, and the one that actually catches a missing leg 3.
    // Every leg-3 state also flips `readActivationState().activated` to false,
    // which makes buildAdapters hand this tenant the SANDBOX bundle. So without
    // the predicate the row does not reach the wire — it is marked 'sent' by a
    // sandbox port, with a fabricated message id, for mail that never left the
    // building. Counting engine calls alone cannot see that; the row's own
    // status can. This is the G3 confident-wrong the platform already fights,
    // and the cron is what would have mass-produced it.
    const statuses = (await sendStatuses(tenantId)).map((r) => r.status).sort();
    expect(statuses).toEqual(["pending", "sent"]);
  });

  it("leg 4: an engine-unarmed tenant is never driven (no fake 'sent' events)", async () => {
    const { tenantId } = await paidTenantWithDueSends("Engine Dark Co", "engine-dark-co.test", ["lead@engine-dark-co.test"]);
    const engine = fakeEngine();
    const restore = armRealSendPath({ ENGINE_BASE_URL: undefined, ENGINE_AUTH_SECRET: undefined });
    try {
      await runCron();
    } finally {
      restore();
    }
    expect(keysFor(engine, tenantId)).toEqual([]);
    // The point of leg 4: without it the tenant would have got a SANDBOX
    // EmailPort and this row would read 'sent' having never left the building.
    expect((await sendStatuses(tenantId)).map((r) => r.status)).toEqual(["pending"]);

    // Non-vacuity: arm it and the very same row goes out.
    const restoreArmed = armRealSendPath();
    try {
      await runCron();
    } finally {
      restoreArmed();
    }
    expect(keysFor(engine, tenantId)).toHaveLength(1);
    expect((await sendStatuses(tenantId)).map((r) => r.status)).toEqual(["sent"]);
  });

  it("leg 4: an InboxKit-unarmed tenant is never driven", async () => {
    const { tenantId } = await paidTenantWithDueSends("IK Dark Co", "ik-dark-co.test", ["lead@ik-dark-co.test"]);
    const engine = fakeEngine();
    const restore = armRealSendPath({ INBOXKIT_API_KEY: undefined, INBOXKIT_WORKSPACE_ID: undefined });
    try {
      await runCron();
    } finally {
      restore();
    }
    expect(keysFor(engine, tenantId)).toEqual([]);
    expect((await sendStatuses(tenantId)).map((r) => r.status)).toEqual(["pending"]);

    const restoreArmed = armRealSendPath();
    try {
      await runCron();
    } finally {
      restoreArmed();
    }
    expect(keysFor(engine, tenantId)).toHaveLength(1);
  });

  it("leg 6: AUTOSEND_DISABLED stops the whole leg, and clearing it resumes", async () => {
    const { tenantId } = await paidTenantWithDueSends("Kill Switch Co", "kill-switch-co.test", ["lead@kill-switch-co.test"]);
    const engine = fakeEngine();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const restore = armRealSendPath({ AUTOSEND_DISABLED: "1" });
    try {
      await runCron();
    } finally {
      restore();
    }
    expect(keysFor(engine, tenantId)).toEqual([]);
    expect((await sendStatuses(tenantId)).map((r) => r.status)).toEqual(["pending"]);
    expect(warn.mock.calls.flat().join(" ")).toContain("AUTOSEND_DISABLED");

    const restoreArmed = armRealSendPath();
    try {
      await runCron();
    } finally {
      restoreArmed();
    }
    expect(keysFor(engine, tenantId)).toHaveLength(1);
  });
});

// --- Double-send battery -------------------------------------------------

describe("send pipeline driver — exactly-once at first arm", () => {
  it("two CONCURRENT sweeps over a due backlog produce exactly one wire send per row", async () => {
    const leads = ["a@concurrent-leads.test", "b@concurrent-leads.test", "c@concurrent-leads.test"];
    const { tenantId } = await paidTenantWithDueSends("Concurrent Co", "concurrent-co.test", leads);
    const engine = fakeEngine();
    const restore = armRealSendPath();
    try {
      // Both invocations race over the SAME backlog, exactly as two overlapping
      // cron cycles would. The tick's atomic pending->sending claim is what has
      // to hold here; the engine cache below it is the second layer.
      await Promise.all([runCron(), runCron()]);
    } finally {
      restore();
    }

    const rows = await sendStatuses(tenantId);
    expect(rows.map((r) => r.status)).toEqual(["sent", "sent", "sent"]);
    // Exactly one DISTINCT key per row — no row was dispatched twice, and none
    // was dispatched under two keys.
    expect(keysFor(engine, tenantId)).toHaveLength(3);
    expect(callsFor(engine, tenantId)).toBe(3);
    // Every row carries a distinct message id: no row silently reused another's.
    expect(new Set(rows.map((r) => r.message_id)).size).toBe(3);
  });

  it("a stuck-'sending' row is reclaimed and resolves through the engine's CACHE, never a second wire send", async () => {
    const { tenantId } = await paidTenantWithDueSends("Reclaim Co", "reclaim-co.test", ["lead@reclaim-leads.test"]);
    const engine = fakeEngine();
    const restore = armRealSendPath();
    try {
      await runCron();
      const messageIdBefore = (await sendStatuses(tenantId))[0]?.message_id;
      expect(messageIdBefore).toMatch(/^<msg-\d+@engine\.test>$/);
      const rowId = (
        await runInDurableObject(tenantStub(tenantId), async (_i, state) =>
          state.storage.sql.exec<{ id: string }>(`SELECT id FROM scheduled_sends WHERE tenant_id = ?`, tenantId).toArray(),
        )
      )[0]?.id as string;

      // Rewind the row to the exact shape a DO that died mid-send leaves: still
      // 'sending', claimed longer ago than the reclaim TTL. The engine already
      // holds this key, so a correct reclaim returns the SAME messageId.
      await runInDurableObject(tenantStub(tenantId), async (_i, state) => {
        state.storage.sql.exec(
          `UPDATE scheduled_sends SET status = 'sending', sending_since = ?, message_id = NULL, sent_at = NULL WHERE id = ?`,
          Date.now() - 10 * 60 * 1000,
          rowId,
        );
      });

      const callsBefore = callsFor(engine, tenantId);
      await runCron(); // reclaim -> 'pending'
      await runCron(); // re-send -> served from the engine's cache
      expect(callsFor(engine, tenantId)).toBeGreaterThan(callsBefore); // it really did re-dispatch
      // ...but no NEW key was ever created, i.e. no second message left the wire.
      expect(keysFor(engine, tenantId)).toHaveLength(1);
      const rows = await sendStatuses(tenantId);
      expect(rows[0]?.status).toBe("sent");
      expect(rows[0]?.message_id).toBe(messageIdBefore);
    } finally {
      restore();
    }
  });
});
