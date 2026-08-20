import { beforeEach, describe, expect, it, vi } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { collectLegSignals, reportSweepSignals, reportSweepSignalsHealth, COVERAGE_TICKS_ALERT_AFTER } from "../src/admin/sweep-signals.js";
import type { OpsDigest } from "../src/admin/ops-sweep.js";
import type { TenantSlice } from "../src/admin/tenant-slice.js";
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

// `complete: true` by default and DELIBERATELY: every assertion below about the
// warmup check clearing is an assertion about a COMPLETE pass. The cron now
// builds this digest over a bounded tenant slice (scale audit S1), and a
// partial pass may not clear a money alert — see the partial-scan test at the
// bottom of this describe, which is what would red if this default were
// silently doing the work.
function digestWith(fields: Partial<OpsDigest>): OpsDigest {
  return { windowHours: 24, gaveUpWarmupCancels: 0, complete: true, ...fields } as OpsDigest;
}

function sliceWith(fields: Partial<TenantSlice>): TenantSlice {
  return { ids: [], total: 0, complete: true, coverageTicks: 0, ...fields };
}

function subjectsFor(mailer: SandboxOpsMailer, label: string): string[] {
  return mailer.sent.map((m) => m.subject).filter((s) => s.includes(label));
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

  // ASSERTION CHANGED, DELIBERATELY (scale audit S4). It used to expect
  // `counted === 10` — errors AND `budgetExpiries` AND `skippedForLegDeadline`
  // in ONE number that grades the tick unhealthy. `skippedForLegDeadline` is
  // set every cycle the rotation cannot reach every tenant, which is the
  // bounded sweep working exactly as designed, and at scale it is non-zero on
  // EVERY tick, permanently. So `cron_legs` pinned unhealthy forever, and once
  // an episode is announced `decideAlert` suppresses every subsequent tick —
  // meaning a genuinely dying leg produced NO NEW ALERT at all, just an edited
  // `detail` string on an already-suppressed row. Capacity is now its own
  // number and its own check.
  it("counts FAILURES, and keeps deferred work out of the failure number", () => {
    const signals = collectLegSignals({
      dunning: { errors: 2 },
      sendPipeline: { errors: 1, budgetExpiries: 3, skippedForLegDeadline: 4 },
    });
    expect(signals.counted).toBe(3);
    expect(signals.deferred).toBe(7);
    expect(signals.detail).toContain("dunning.errors=2");
    expect(signals.detail).not.toContain("budgetExpiries");
    expect(signals.deferralDetail).toContain("sendPipeline.budgetExpiries=3");
    expect(signals.deferralDetail).toContain("sendPipeline.skippedForLegDeadline=4");
  });

  it("reads the watchtower's OUTCOME ARRAY, which carries no counters at all (W-M1)", () => {
    const signals = collectLegSignals({
      watchtower: [
        { name: "d1", action: "healthy", emailSent: false, why: "suppressed_cooldown" },
        { name: "do_storage", action: "alerted", emailSent: false, why: "send_failed" },
        { name: "engine", action: "recovered", emailSent: false, why: "dark_channel" },
        { name: "failure_signals", action: "unreportable", emailSent: false, why: "send_failed" },
      ],
    });
    // The alert that was SUPPRESSED is not undelivered — nothing was owed.
    expect(signals.undeliveredAlerts.count).toBe(3);
    expect(signals.undeliveredAlerts.reasons).toContain("do_storage (send_failed)");
    expect(signals.undeliveredAlerts.reasons).toContain("engine (dark_channel)");
    // An `unreportable` check is a genuine leg failure: its store was unreachable.
    expect(signals.counted).toBe(1);
  });

  it("reads a leg that reports failure as a REASON STRING, not a counter (W-M2)", () => {
    const signals = collectLegSignals({ sdnRefresh: { refreshed: false, reason: "failed", error: "HTTP 503" } });
    expect(signals.counted).toBe(1);
    expect(signals.detail).toContain("sdnRefresh.reason=failed");
    expect(signals.detail).toContain("HTTP 503");
  });

  it("a leg it does not know how to read is a FAILURE, not a silent zero (W-M3)", () => {
    const signals = collectLegSignals({ somethingBrandNew: { failureCount: 7 } });
    expect(signals.unknownLegs).toEqual(["somethingBrandNew"]);
    expect(signals.detail).toContain("cannot read");
  });

  it("a leg with a declared no-signal shape contributes nothing", () => {
    const signals = collectLegSignals({ sweepCursor: { cursor: null } });
    expect(signals.counted).toBe(0);
    expect(signals.unknownLegs).toEqual([]);
  });
});

describe("NB-2 — cron-leg failures reach the founder, damped", () => {
  const failingLegs = { dunning: { errors: 1 }, sendPipeline: { errors: 0, budgetExpiries: 2, skippedForLegDeadline: 0 } };

  it("stays quiet below the streak threshold, then alerts once", async () => {
    const mailer = new SandboxOpsMailer();
    for (let i = 0; i < LEG_ALERT_AFTER_SWEEPS - 1; i++) {
      await reportSweepSignals(env, mailer, { legs: failingLegs, digest: null, coverage: null }, T0 + i * 300_000);
    }
    expect(legSubjects(mailer)).toEqual([]);

    await reportSweepSignals(env, mailer, { legs: failingLegs, digest: null, coverage: null }, T0 + LEG_ALERT_AFTER_SWEEPS * 300_000);
    expect(legSubjects(mailer)).toEqual(["[coldrig] Ops sweep legs: UNHEALTHY"]);
    expect(mailer.sent[0]!.text).toContain("dunning.errors=1");
    // S4 — `budgetExpiries` is CAPACITY and must not ride in the failure email.
    expect(mailer.sent[0]!.text).not.toContain("budgetExpiries");
  });

  // ASSERTION CHANGED, DELIBERATELY (IN-8, docs/adversarial/class-sweep-dedup-
  // semantics-2026-08-17.md; the sweep's failing-test sketch 5 predicted this
  // test would red-line). It used to assert ZERO emails here, which is not what
  // its name says and not what the anti-storm property requires — it was the
  // defect written down as spec.
  //
  // What is actually happening below: a cron sweep leg failing EVERY OTHER TICK
  // for two hours. That is 12 real failures. `gradeStreak` zeroed its unhealthy
  // tally on any good tick, so the leg never reached LEG_ALERT_AFTER_SWEEPS
  // CONSECUTIVE bad ticks, returned HOLD forever, and the founder was told
  // nothing — permanently, for a leg failing half the time. Asserting `[]` made
  // that silence the requirement.
  //
  // The property this test exists to protect is the NB-1 cry-wolf one: no
  // ALTERNATING alert/recovery pair (the pre-NB-1 code sent 24 emails in this
  // exact scenario). That is preserved and is asserted precisely below — ONE
  // unhealthy email, and no recovery email, because an intermittent leg never
  // assembles a full clean recovery run.
  it("an intermittent leg alerts ONCE and never produces an alternating alert/recovery pair", async () => {
    const mailer = new SandboxOpsMailer();
    // 24 ticks (2h), failing every other one — the NB-1 flap pattern, applied
    // to the leg counters instead.
    for (let i = 0; i < 24; i++) {
      const legs = i % 2 === 0 ? failingLegs : { dunning: { errors: 0 } };
      await reportSweepSignals(env, mailer, { legs, digest: null, coverage: null }, T0 + i * 300_000);
    }
    expect(legSubjects(mailer)).toEqual(["[coldrig] Ops sweep legs: UNHEALTHY"]);
    expect(legSubjects(mailer).filter((s) => s.includes("RECOVERED"))).toEqual([]);
  });

  it("recovers only after consecutive clean ticks", async () => {
    const mailer = new SandboxOpsMailer();
    for (let i = 0; i < LEG_ALERT_AFTER_SWEEPS; i++) {
      await reportSweepSignals(env, mailer, { legs: failingLegs, digest: null, coverage: null }, T0 + i * 300_000);
    }
    expect(legSubjects(mailer)).toHaveLength(1);

    const clean = { dunning: { errors: 0 } };
    for (let i = 0; i < LEG_RECOVER_AFTER_SWEEPS - 1; i++) {
      await reportSweepSignals(env, mailer, { legs: clean, digest: null, coverage: null }, T0 + (10 + i) * 300_000);
    }
    expect(legSubjects(mailer)).toHaveLength(1);

    await reportSweepSignals(env, mailer, { legs: clean, digest: null, coverage: null }, T0 + 20 * 300_000);
    expect(legSubjects(mailer)).toEqual(["[coldrig] Ops sweep legs: UNHEALTHY", "[coldrig] Ops sweep legs: RECOVERED"]);
  });

  it("a leg that THREW counts as unhealthy — a null result is unknown, never zero", async () => {
    const mailer = new SandboxOpsMailer();
    for (let i = 0; i < LEG_ALERT_AFTER_SWEEPS; i++) {
      await reportSweepSignals(env, mailer, { legs: { deliverability: null }, digest: null, coverage: null }, T0 + i * 300_000);
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
    await reportSweepSignals(env, mailer, { legs: {}, digest: digestWith({ gaveUpWarmupCancels: 2 }), coverage: null }, T0);
    expect(mailer.sent).toEqual([]);
    await reportSweepSignals(env, mailer, { legs: {}, digest: digestWith({ gaveUpWarmupCancels: 2 }), coverage: null }, T0 + 300_000);

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
      await reportSweepSignals(env, mailer, { legs: {}, digest: digestWith({ gaveUpWarmupCancels: 2 }), coverage: null }, T0 + i * 300_000);
    }
    expect(mailer.sent).toHaveLength(1);

    await reportSweepSignals(env, mailer, { legs: {}, digest: digestWith({ gaveUpWarmupCancels: 0 }), coverage: null }, T0 + 12 * 300_000);
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
    await reportSweepSignals(env, mailer, { legs: {}, digest: digestWith({ gaveUpWarmupCancels: 2 }), coverage: null }, T0);
    await reportSweepSignals(env, mailer, { legs: {}, digest: digestWith({ gaveUpWarmupCancels: 2 }), coverage: null }, T0 + 300_000);
    expect(mailer.sent).toHaveLength(1);

    // The digest leg throws on the next tick: its counters are unknown. A
    // false RECOVERED here would clear an incident nobody fixed AND re-arm the
    // alert, which is how a dedup silently disarms itself.
    await reportSweepSignals(env, mailer, { legs: { digest: null }, digest: null, coverage: null }, T0 + 600_000);
    expect(mailer.sent).toHaveLength(1);
    const row = await env.DB.prepare(`SELECT status FROM watchtower_state WHERE check_name = 'warmup_cancel_gave_up'`).first<{ status: string }>();
    expect(row?.status).toBe("unhealthy");
  });

  // The SAME rule, one level out (scale audit S1). The cron builds this digest
  // over a bounded tenant SLICE now, so `gaveUpWarmupCancels === 0` from a
  // partial pass means "none among the tenants this tick reached" — not "none".
  // Clearing on it would send NO LONGER TRACKED for money still leaking on a
  // tenant nobody looked at, and re-arm the alert for the next episode.
  it("a PARTIAL digest may not clear the money alert, only a complete one may", async () => {
    const mailer = new SandboxOpsMailer();
    for (let i = 0; i < 2; i++) {
      await reportSweepSignals(env, mailer, { legs: {}, digest: digestWith({ gaveUpWarmupCancels: 2 }), coverage: null }, T0 + i * 300_000);
    }
    expect(mailer.sent).toHaveLength(1);

    const partial = digestWith({ gaveUpWarmupCancels: 0, complete: false });
    await reportSweepSignals(env, mailer, { legs: {}, digest: partial, coverage: null }, T0 + 2 * 300_000);
    expect(mailer.sent).toHaveLength(1);
    expect(
      (await env.DB.prepare(`SELECT status FROM watchtower_state WHERE check_name = 'warmup_cancel_gave_up'`).first<{ status: string }>())?.status,
    ).toBe("unhealthy");

    // A COMPLETE pass reporting zero still clears it — the guard bounds the
    // claim, it does not disable the check.
    await reportSweepSignals(env, mailer, { legs: {}, digest: digestWith({ gaveUpWarmupCancels: 0 }), coverage: null }, T0 + 3 * 300_000);
    expect(mailer.sent.map((m) => m.subject)).toEqual([
      "[coldrig] Warmup cancellations gave up: UNHEALTHY",
      "[coldrig] Warmup cancellations gave up: NO LONGER TRACKED",
    ]);
  });

  // A partial pass reporting a NON-ZERO count is a real observation about real
  // tenants, and must still alert — the guard is asymmetric on purpose.
  it("a PARTIAL digest still ALERTS on a non-zero count", async () => {
    const mailer = new SandboxOpsMailer();
    const partial = digestWith({ gaveUpWarmupCancels: 3, complete: false });
    for (let i = 0; i < 2; i++) {
      await reportSweepSignals(env, mailer, { legs: {}, digest: partial, coverage: null }, T0 + i * 300_000);
    }
    expect(subjectsFor(mailer, "Warmup cancellations gave up")).toEqual(["[coldrig] Warmup cancellations gave up: UNHEALTHY"]);
  });
});

// SCALE AUDIT S4 + S11 — capacity is not failure, and it needs a name.
describe("sweep_coverage — the bounded sweep's own coverage latency", () => {
  const CLEAN = { deliverability: { tenantsSwept: 3, errors: 0, deferred: 0 } };

  it("does NOT make cron_legs unhealthy when the tick merely deferred work", async () => {
    const mailer = new SandboxOpsMailer();
    const deferring = { sendPipeline: { errors: 0, budgetExpiries: 0, skippedForLegDeadline: 40 } };
    for (let i = 0; i < LEG_ALERT_AFTER_SWEEPS + 1; i++) {
      await reportSweepSignals(env, mailer, { legs: deferring, digest: null, coverage: sliceWith({ total: 40 }) }, T0 + i * 300_000);
    }
    expect(legSubjects(mailer)).toEqual([]);
  });

  it("reports the deferral under its OWN name, with the rotation arithmetic", async () => {
    const mailer = new SandboxOpsMailer();
    const deferring = { sendPipeline: { errors: 0, budgetExpiries: 0, skippedForLegDeadline: 40 } };
    // LEG_ALERT_AFTER_SWEEPS damps the OBSERVATION; the check's own debounced
    // policy then needs a second REPORTED observation, so this is 4 ticks
    // (20 min) rather than cron_legs' 3. Deliberate — see watchtower-policy.test.ts.
    for (let i = 0; i < LEG_ALERT_AFTER_SWEEPS + 1; i++) {
      await reportSweepSignals(env, mailer, { legs: deferring, digest: null, coverage: sliceWith({ total: 40 }) }, T0 + i * 300_000);
    }
    expect(subjectsFor(mailer, "Ops sweep coverage")).toEqual(["[coldrig] Ops sweep coverage: UNHEALTHY"]);
    expect(mailer.sent[0]!.text).toContain("NOTHING IS FAILING");
    expect(mailer.sent[0]!.text).toContain("sendPipeline.skippedForLegDeadline=40");
  });

  it("fires on rotation length alone, with no deferral and no error anywhere", async () => {
    const mailer = new SandboxOpsMailer();
    const slow = sliceWith({ total: 5_000, coverageTicks: COVERAGE_TICKS_ALERT_AFTER + 1 });
    for (let i = 0; i < LEG_ALERT_AFTER_SWEEPS + 1; i++) {
      await reportSweepSignals(env, mailer, { legs: CLEAN, digest: null, coverage: slow }, T0 + i * 300_000);
    }
    expect(subjectsFor(mailer, "Ops sweep coverage")).toEqual(["[coldrig] Ops sweep coverage: UNHEALTHY"]);
    expect(mailer.sent[0]!.text).toContain("read-model");
  });

  it("stays quiet while the rotation is short and nothing is deferred", async () => {
    const mailer = new SandboxOpsMailer();
    for (let i = 0; i < 6; i++) {
      await reportSweepSignals(env, mailer, { legs: CLEAN, digest: null, coverage: sliceWith({ total: 3, coverageTicks: 1 }) }, T0 + i * 300_000);
    }
    expect(subjectsFor(mailer, "Ops sweep coverage").filter((s) => s.includes("UNHEALTHY"))).toEqual([]);
  });
});

// W-M1 — the founder is told the monitor is healthy on the exact tick the
// monitor could not reach them.
describe("alert_delivery — an alert that was OWED and did not arrive", () => {
  it("alerts when watchtower outcomes report undelivered alerts on consecutive ticks", async () => {
    const mailer = new SandboxOpsMailer();
    const legs = {
      watchtower: [
        { name: "do_storage", action: "alerted", emailSent: false, why: "send_failed" },
        { name: "engine", action: "realerted", emailSent: false, why: "send_failed" },
      ],
    };
    for (let i = 0; i < LEG_ALERT_AFTER_SWEEPS + 1; i++) {
      await reportSweepSignals(env, mailer, { legs, digest: null, coverage: null }, T0 + i * 300_000);
    }
    expect(subjectsFor(mailer, "Founder alert delivery")).toEqual(["[coldrig] Founder alert delivery: UNHEALTHY"]);
    expect(mailer.sent[0]!.text).toContain("do_storage (send_failed)");
    expect(mailer.sent[0]!.text).toContain("GET /admin/ops/checks");
  });

  it("a SUPPRESSED or debounced alert is not an undelivered one", async () => {
    const mailer = new SandboxOpsMailer();
    const legs = {
      watchtower: [
        { name: "do_storage", action: "suppressed", emailSent: false, why: "suppressed_cooldown" },
        { name: "engine", action: "pending", emailSent: false, why: "pending_debounce" },
        { name: "customer_progress_agent:ten_x", action: "alerted", emailSent: false, why: "digest_only" },
      ],
    };
    for (let i = 0; i < LEG_ALERT_AFTER_SWEEPS + 1; i++) {
      await reportSweepSignals(env, mailer, { legs, digest: null, coverage: null }, T0 + i * 300_000);
    }
    expect(subjectsFor(mailer, "Founder alert delivery").filter((s) => s.includes("UNHEALTHY"))).toEqual([]);
  });
});

// W-M4 — the alerting leg reporting on ITSELF. `reportSweepSignals` builds its
// observation from a bag constructed above it, so its own throw was swallowed
// by `runLeg`, reported by nothing, and the heartbeat below it kept the
// dead-man green: total, permanent, silent loss of every leg signal.
describe("sweep_signals — the alerting leg's own death", () => {
  it("alerts after the debounce when the signal leg threw", async () => {
    const mailer = new SandboxOpsMailer();
    await reportSweepSignalsHealth(env, mailer, false, T0);
    expect(mailer.sent).toEqual([]);
    await reportSweepSignalsHealth(env, mailer, false, T0 + 300_000);

    expect(subjectsFor(mailer, "Ops sweep signal reporting")).toEqual(["[coldrig] Ops sweep signal reporting: UNHEALTHY"]);
    expect(mailer.sent[0]!.text).toContain("the dead-man will stay quiet");
  });

  it("recovers when it runs again", async () => {
    const mailer = new SandboxOpsMailer();
    for (let i = 0; i < 2; i++) await reportSweepSignalsHealth(env, mailer, false, T0 + i * 300_000);
    await reportSweepSignalsHealth(env, mailer, true, T0 + 2 * 300_000);
    expect(subjectsFor(mailer, "Ops sweep signal reporting")).toEqual([
      "[coldrig] Ops sweep signal reporting: UNHEALTHY",
      "[coldrig] Ops sweep signal reporting: RECOVERED",
    ]);
  });
});
