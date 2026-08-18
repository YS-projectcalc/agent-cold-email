import { beforeEach, describe, expect, it, vi } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { collectLegSignals, reportSweepSignals } from "../src/admin/sweep-signals.js";
import type { OpsDigest } from "../src/admin/ops-sweep.js";
import { watchtowerStub } from "../src/admin/watchtower-infra.js";
import { LEG_ALERT_AFTER_SWEEPS, LEG_RECOVER_AFTER_SWEEPS } from "../src/admin/watchtower-grading.js";
import { runScheduledOpsSweep } from "../src/scheduled.js";
import { SandboxOpsMailer } from "../src/ops-mail/sandbox-ops-mailer.js";
import { TENANT_DO_SCHEMA } from "../src/schema.js";
import sdnValidCsv from "./fixtures/ofac/sdn-valid.csv?raw";
import { activatePaidPlan, mintTenant, seedBenignSdnList, tenantStub } from "./helpers.js";

// AUDIT NB-2 + NB-3 (+ failure-class table row 4) — signals the platform
// already computed and then threw away.
//
// NB-2: every leg returns an `errors` count (and the send pipeline also
// `budgetExpiries` / `skippedForLegDeadline`), and `runLeg` catches a leg-level
// throw — all of it ended in one console.log line with no reader. A tenant
// failing every cycle, or a wedged engine abandoning every tenant at its
// budget, incremented these forever with no threshold, no persistence and no
// alert.
//
// NB-3: the digest computes threshold-crossing `watchdogAlerts` every 5 minutes
// — including `gaveUpWarmupCancels`, whose own comment says "this is money
// leaking" (InboxKit subscriptions that may still be billing) — and the founder
// could only see them by manually calling GET /admin/ops/digest with the admin
// token. A pull-only alert on money leaking is not an alert.

const T0 = 1_800_000_000_000;

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM watchtower_state").run();
  await env.DB.prepare("DELETE FROM watchtower_cursor").run();
  await env.DB.prepare("DELETE FROM tenants_index").run();
  await runInDurableObject(watchtowerStub(env), async (_instance, state) => {
    await state.storage.deleteAll();
    await state.storage.deleteAlarm();
  });
});

function digestWith(fields: Partial<OpsDigest>): OpsDigest {
  return { windowHours: 24, gaveUpWarmupCancels: 0, ...fields } as OpsDigest;
}

function legSubjects(mailer: SandboxOpsMailer): string[] {
  return mailer.sent.map((m) => m.subject).filter((s) => s.includes("Ops sweep legs"));
}

describe("collectLegSignals", () => {
  it("counts a leg that threw (its runLeg fallback) and names it", () => {
    const signals = collectLegSignals({ dunning: null, digest: { errors: 0 } });
    expect(signals.legsThrew).toEqual(["dunning"]);
    expect(signals.detail).toContain("leg(s) that threw outright: dunning");
  });

  it("sums every counter across legs and names each one", () => {
    const signals = collectLegSignals({
      dunning: { errors: 2 },
      sendPipeline: { errors: 1, budgetExpiries: 3, skippedForLegDeadline: 4 },
    });
    expect(signals.counted).toBe(10);
    expect(signals.detail).toContain("dunning.errors=2");
    expect(signals.detail).toContain("sendPipeline.budgetExpiries=3");
    expect(signals.detail).toContain("sendPipeline.skippedForLegDeadline=4");
  });

  it("ignores legs that carry no counters (the watchtower returns an array)", () => {
    const signals = collectLegSignals({ watchtower: [{ name: "d1", action: "healthy", emailSent: false, why: "suppressed_cooldown" }] });
    expect(signals).toEqual({ legsThrew: [], counted: 0, detail: "" });
  });
});

describe("NB-2 — cron-leg failures reach the founder, damped", () => {
  const failingLegs = { dunning: { errors: 1 }, sendPipeline: { errors: 0, budgetExpiries: 2, skippedForLegDeadline: 0 } };

  it("stays quiet below the streak threshold, then alerts once", async () => {
    const mailer = new SandboxOpsMailer();
    for (let i = 0; i < LEG_ALERT_AFTER_SWEEPS - 1; i++) {
      await reportSweepSignals(env, mailer, { legs: failingLegs, digest: null }, T0 + i * 300_000);
    }
    expect(legSubjects(mailer)).toEqual([]);

    await reportSweepSignals(env, mailer, { legs: failingLegs, digest: null }, T0 + LEG_ALERT_AFTER_SWEEPS * 300_000);
    expect(legSubjects(mailer)).toEqual(["[coldrig] Ops sweep legs: UNHEALTHY"]);
    expect(mailer.sent[0]!.text).toContain("dunning.errors=1");
    expect(mailer.sent[0]!.text).toContain("sendPipeline.budgetExpiries=2");
  });

  it("an intermittent leg never produces an alternating alert/recovery pair", async () => {
    const mailer = new SandboxOpsMailer();
    // 24 ticks (2h), failing every other one — the NB-1 flap pattern, applied
    // to the leg counters instead.
    for (let i = 0; i < 24; i++) {
      const legs = i % 2 === 0 ? failingLegs : { dunning: { errors: 0 } };
      await reportSweepSignals(env, mailer, { legs, digest: null }, T0 + i * 300_000);
    }
    expect(legSubjects(mailer)).toEqual([]);
  });

  it("recovers only after consecutive clean ticks", async () => {
    const mailer = new SandboxOpsMailer();
    for (let i = 0; i < LEG_ALERT_AFTER_SWEEPS; i++) {
      await reportSweepSignals(env, mailer, { legs: failingLegs, digest: null }, T0 + i * 300_000);
    }
    expect(legSubjects(mailer)).toHaveLength(1);

    const clean = { dunning: { errors: 0 } };
    for (let i = 0; i < LEG_RECOVER_AFTER_SWEEPS - 1; i++) {
      await reportSweepSignals(env, mailer, { legs: clean, digest: null }, T0 + (10 + i) * 300_000);
    }
    expect(legSubjects(mailer)).toHaveLength(1);

    await reportSweepSignals(env, mailer, { legs: clean, digest: null }, T0 + 20 * 300_000);
    expect(legSubjects(mailer)).toEqual(["[coldrig] Ops sweep legs: UNHEALTHY", "[coldrig] Ops sweep legs: RECOVERED"]);
  });

  it("a leg that THREW counts as unhealthy — a null result is unknown, never zero", async () => {
    const mailer = new SandboxOpsMailer();
    for (let i = 0; i < LEG_ALERT_AFTER_SWEEPS; i++) {
      await reportSweepSignals(env, mailer, { legs: { deliverability: null }, digest: null }, T0 + i * 300_000);
    }
    expect(legSubjects(mailer)).toEqual(["[coldrig] Ops sweep legs: UNHEALTHY"]);
    expect(mailer.sent[0]!.text).toContain("leg(s) that threw outright: deliverability");
  });

  it("is wired into the real cron sweep: a wedged tenant surfaces after consecutive ticks", async () => {
    await seedBenignSdnList();
    const { tenantId } = await mintTenant("Leg Errors Co", "managed");
    await activatePaidPlan(tenantId, "managed");
    await runInDurableObject(tenantStub(tenantId), (_instance, state) => {
      state.storage.sql.exec(`DROP TABLE scheduled_sends`);
    });

    // Never touch the network from a test (the SDN refresh leg fetches).
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(sdnValidCsv, { status: 200 }));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const mailer = new SandboxOpsMailer();
    for (let i = 0; i < LEG_ALERT_AFTER_SWEEPS; i++) await runScheduledOpsSweep(env, { mailer });

    vi.restoreAllMocks();
    logSpy.mockRestore();
    errSpy.mockRestore();
    warnSpy.mockRestore();

    expect(legSubjects(mailer)).toEqual(["[coldrig] Ops sweep legs: UNHEALTHY"]);

    // Leave the tenant healthy for anything that runs after this file.
    await runInDurableObject(tenantStub(tenantId), (_instance, state) => {
      state.storage.sql.exec(TENANT_DO_SCHEMA);
    });
  }, 30_000);
});

describe("NB-3 — a warmup cancellation the platform gave up on reaches the founder", () => {
  it("alerts, naming the money that may still be billing", async () => {
    const mailer = new SandboxOpsMailer();
    // Two ticks: this check is derived from the 24h digest window and reported
    // on every sweep, so the founder's 2026-08-16 debounce costs it one cron
    // period and nothing else (the leak is already up to a day old).
    await reportSweepSignals(env, mailer, { legs: {}, digest: digestWith({ gaveUpWarmupCancels: 2 }) }, T0);
    expect(mailer.sent).toEqual([]);
    await reportSweepSignals(env, mailer, { legs: {}, digest: digestWith({ gaveUpWarmupCancels: 2 }) }, T0 + 300_000);

    expect(mailer.sent.map((m) => m.subject)).toEqual(["[coldrig] Warmup cancellations gave up: UNHEALTHY"]);
    expect(mailer.sent[0]!.text).toContain("may STILL BE BILLING");
    expect(mailer.sent[0]!.text).not.toMatch(/inboxkit/i); // operator alert, but the source tripwire owns this class
  });

  // The clear is NOT sold as a recovery any more (signal-inversion arm B).
  // `gaveUpWarmupCancels` is a count over the digest window and nothing
  // re-checks whether those subscriptions were ever cancelled — warmup-cancel.ts
  // guarantees the platform will never retry them — so the count reaching zero
  // means the window moved, not that the money stopped. The founder was
  // previously told "RECOVERED" a day after being told the subscriptions "may
  // STILL BE BILLING".
  it("throttles a persisting one, and the window clearing reports NO LONGER TRACKED rather than RECOVERED", async () => {
    const mailer = new SandboxOpsMailer();
    for (let i = 0; i < 12; i++) {
      await reportSweepSignals(env, mailer, { legs: {}, digest: digestWith({ gaveUpWarmupCancels: 2 }) }, T0 + i * 300_000);
    }
    expect(mailer.sent).toHaveLength(1);

    await reportSweepSignals(env, mailer, { legs: {}, digest: digestWith({ gaveUpWarmupCancels: 0 }) }, T0 + 12 * 300_000);
    expect(mailer.sent.map((m) => m.subject)).toEqual([
      "[coldrig] Warmup cancellations gave up: UNHEALTHY",
      "[coldrig] Warmup cancellations gave up: NO LONGER TRACKED",
    ]);
    // And the body must not repeat a fixed-it claim, whatever the producer wrote.
    expect(mailer.sent[1]!.text).toContain("NOT evidence that the condition was fixed");
    expect(mailer.sent[1]!.text).not.toContain("No warmup-pool cancellation has been abandoned");
  });

  it("reports NOTHING when the digest leg threw — unknown must not read as recovered", async () => {
    const mailer = new SandboxOpsMailer();
    await reportSweepSignals(env, mailer, { legs: {}, digest: digestWith({ gaveUpWarmupCancels: 2 }) }, T0);
    await reportSweepSignals(env, mailer, { legs: {}, digest: digestWith({ gaveUpWarmupCancels: 2 }) }, T0 + 300_000);
    expect(mailer.sent).toHaveLength(1);

    // The digest leg throws on the next tick: its counters are unknown. A
    // false RECOVERED here would clear an incident nobody fixed AND re-arm the
    // alert, which is how a dedup silently disarms itself.
    await reportSweepSignals(env, mailer, { legs: { digest: null }, digest: null }, T0 + 600_000);
    expect(mailer.sent).toHaveLength(1);
    const row = await env.DB.prepare(`SELECT status FROM watchtower_state WHERE check_name = 'warmup_cancel_gave_up'`).first<{ status: string }>();
    expect(row?.status).toBe("unhealthy");
  });
});
