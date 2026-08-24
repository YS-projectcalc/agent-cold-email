import { beforeEach, describe, expect, it, vi } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import {
  collectLegSignals,
  reportSweepSignals,
  reportSweepSignalsHealth,
} from "../src/admin/sweep-signals.js";
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

// `complete: true` by default and DELIBERATELY: every assertion below about the
// warmup check clearing is an assertion about a COMPLETE pass. The cron now
// builds this digest over a bounded tenant slice (scale audit S1), and a
// partial pass may not clear a money alert — see the partial-scan test at the
// bottom of this describe, which is what would red if this default were
// silently doing the work.
function digestWith(fields: Partial<OpsDigest>): OpsDigest {
  return { windowHours: 24, gaveUpWarmupCancels: 0, complete: true, ...fields } as OpsDigest;
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
      await reportSweepSignals(env, mailer, { legs: deferring, digest: null, coverage: { total: 40, covered: 40, handed: 40, allowed: 40 } }, T0 + i * 300_000);
    }
    expect(legSubjects(mailer)).toEqual([]);
  });

  // N6 (wave-b1 gate) — the deferral arm is THRESHOLDED now. It used to trip on
  // `deferred > 0`: one tenant clipped on one leg, on three consecutive ticks,
  // firing the same check whose sibling arm waits for a full rotation to take
  // an hour. And because `decideAlert` suppresses inside an announced episode,
  // the noisy arm kept the quiet one — the one that means "go build the
  // read-model" — from ever producing its own alert.
  it("ignores a handful of deferred leg-visits — the rotation reaches them next tick", async () => {
    const mailer = new SandboxOpsMailer();
    const barelyDeferring = { sendPipeline: { errors: 0, budgetExpiries: 0, skippedForLegDeadline: 1 } };
    for (let i = 0; i < LEG_ALERT_AFTER_SWEEPS + 2; i++) {
      await reportSweepSignals(
        env,
        mailer,
        { legs: barelyDeferring, digest: null, coverage: { total: 40, covered: 40, handed: 40, allowed: 40 } },
        T0 + i * 300_000,
      );
    }
    // REDS on the unthresholded arm, which alerted here.
    expect(subjectsFor(mailer, "Ops sweep coverage").filter((s) => s.includes("UNHEALTHY"))).toEqual([]);
  });

  it("reports the deferral under its OWN name, with the rotation arithmetic", async () => {
    const mailer = new SandboxOpsMailer();
    const deferring = { sendPipeline: { errors: 0, budgetExpiries: 0, skippedForLegDeadline: 9 } };
    // N5 — EXACTLY the same tick count as cron_legs (3 = 15 min). This check is
    // damped upstream by gradeSweepStreak and then EXEMPT from the transition
    // debounce, so it does not page at 20 min. Reds on the debounced policy.
    for (let i = 0; i < LEG_ALERT_AFTER_SWEEPS; i++) {
      await reportSweepSignals(env, mailer, { legs: deferring, digest: null, coverage: { total: 40, covered: 1, handed: 40, allowed: 40 } }, T0 + i * 300_000);
    }
    expect(subjectsFor(mailer, "Ops sweep coverage")).toEqual(["[coldrig] Ops sweep coverage: UNHEALTHY"]);
    expect(mailer.sent[0]!.text).toContain("NOTHING IS FAILING");
    // The deferral counters are still REPORTED — they are what an operator needs
    // to see WHICH leg is losing work. They just no longer decide the grade.
    expect(mailer.sent[0]!.text).toContain("sendPipeline.skippedForLegDeadline=9");
  });

  it("fires on rotation length alone, with no deferral and no error anywhere", async () => {
    const mailer = new SandboxOpsMailer();
    const slow = { total: 5_000, covered: 37, handed: 37, allowed: 37 };
    for (let i = 0; i < LEG_ALERT_AFTER_SWEEPS; i++) {
      await reportSweepSignals(env, mailer, { legs: CLEAN, digest: null, coverage: slow }, T0 + i * 300_000);
    }
    expect(subjectsFor(mailer, "Ops sweep coverage")).toEqual(["[coldrig] Ops sweep coverage: UNHEALTHY"]);
    const body = mailer.sent[0]!.text;
    // The remedy the operator is sent to. Case-insensitive because the body
    // shouts it; the point is that the alert names a NEXT ACTION at all.
    expect(body.toLowerCase()).toContain("read-model");
    // ...and it must no longer send them after the thing that is already built.
    // A deleted mechanism that leaves its prose behind is its own defect class:
    // this alert told the operator for four days that bounded-concurrency
    // fan-out was "unevaluated" and the cheap thing to try next.
    expect(body.toLowerCase()).not.toContain("unevaluated");
    expect(body.toLowerCase()).not.toContain("has not been tried");
    // The rollback lever is the first thing to check, because setting it to 1
    // reproduces this alert by design.
    expect(body).toContain("SWEEP_FANOUT_CONCURRENCY");
  });

  it("stays quiet while the rotation is short and nothing is deferred", async () => {
    const mailer = new SandboxOpsMailer();
    for (let i = 0; i < 6; i++) {
      await reportSweepSignals(env, mailer, { legs: CLEAN, digest: null, coverage: { total: 3, covered: 3, handed: 3, allowed: 3 } }, T0 + i * 300_000);
    }
    expect(subjectsFor(mailer, "Ops sweep coverage").filter((s) => s.includes("UNHEALTHY"))).toEqual([]);
  });
});

// THE LIVE-SIGNAL CALIBRATION FIX (2026-08-20). Measured on prod worker
// 133fc911 at 63 tenants, two consecutive ticks captured whole via `wrangler
// tail`. The shipped check was wrong in BOTH directions at once, and the two
// defects are the same root cause: the check reported the slice it INTENDED
// rather than the coverage it ACHIEVED.
describe("coverage is graded and reported on ACHIEVED rotation progress, not the intended slice", () => {
  // Verbatim from the live tick's own log line. `deliverability` (leg 1, one RPC
  // per tenant) consumed the whole 15s fan-out deadline on its own, so every
  // trailing leg attempted its first tenant and deferred the other 36.
  const LIVE_TICK = {
    deliverability: { tenantsSwept: 37, errors: 0, deferred: 0 },
    dunning: { errors: 0, deferred: 36 },
    warmupCancel: { errors: 0, deferred: 36 },
    webhooks: { errors: 0, deferred: 36 },
  };
  const NOTHING_DEFERRED = { deliverability: { tenantsSwept: 3, errors: 0, deferred: 0 } };

  it("publishes the TRUE rotation length — the cursor advances by the least-covered leg, not by the slice", async () => {
    const mailer = new SandboxOpsMailer();
    // `commitSweepCursor` advances by `fanout.leastVisited`, which was 1: the
    // rotation is 63 ticks (~315 min), not the 2 ticks (~10 min) the shipped
    // detail string told the founder while it was paging them about latency.
    for (let i = 0; i < LEG_ALERT_AFTER_SWEEPS; i++) {
      await reportSweepSignals(env, mailer, { legs: LIVE_TICK, digest: null, coverage: { total: 63, covered: 1, handed: 37, allowed: 37 } }, T0 + i * 300_000);
    }
    expect(subjectsFor(mailer, "Ops sweep coverage")).toEqual(["[coldrig] Ops sweep coverage: UNHEALTHY"]);
    const text = mailer.sent[0]!.text;
    expect(text, "the alert must publish the achieved rotation length").toContain("every 63 tick(s)");
    expect(text).toContain("~315 min");
    // THE DEFECT, pinned: the shipped code printed the INTENDED slice here.
    expect(text, "the intended-slice figure must not be presented as the coverage latency").not.toContain("every 2 tick(s)");
  });

  it("does NOT alert merely because one shared deadline made three legs defer — that is the design working", async () => {
    const mailer = new SandboxOpsMailer();
    // N6's units defect, made concrete: ONE shared fan-out deadline clipped
    // three legs at the same tenant, and the old arm summed 3 x 13 = 39 against
    // a single slice. The rotation still completes in ceil(60/13) = 5 ticks,
    // well inside the published 12-tick bound, so nothing is owed to anyone.
    const sharedDeadlineClip = {
      dunning: { errors: 0, deferred: 13 },
      warmupCancel: { errors: 0, deferred: 13 },
      webhooks: { errors: 0, deferred: 13 },
    };
    for (let i = 0; i < LEG_ALERT_AFTER_SWEEPS + 2; i++) {
      await reportSweepSignals(
        env,
        mailer,
        { legs: sharedDeadlineClip, digest: null, coverage: { total: 60, covered: 13, handed: 26, allowed: 26 } },
        T0 + i * 300_000,
      );
    }
    expect(
      subjectsFor(mailer, "Ops sweep coverage").filter((s) => s.includes("UNHEALTHY")),
      "a bound sweep deferring inside its own slice, while still reaching every tenant inside the published " +
        "bound, is the designed behaviour — alerting on it is what pinned the check and suppressed the arm " +
        "that means 'go build the read-model'",
    ).toEqual([]);
  });

  // NB-3 (gate 2026-08-20). The gate ran this exact input against the shipped
  // producer and got: "30 tenant(s) ... = a full pass every 30 tick(s) (~150
  // min). The slice is sized at 3 tenant(s) per tick, so the shared fan-out
  // deadline is stopping the trailing legs partway through it" — a 3x
  // pessimistic figure AND a cause that did not happen. 63 % 3 == 0 today, so
  // tenant #64 is what makes this reachable.
  it("a SHORT-TAIL tick is not a clipped tick — it extrapolates from the window, not from the tail", async () => {
    const mailer = new SandboxOpsMailer();
    // The tail tick of a 30-tenant rotation at slice 3: handed 1, covered 1.
    // Nothing clipped — `covered === handed`. The true rotation is ceil(30/3).
    for (let i = 0; i < LEG_ALERT_AFTER_SWEEPS + 2; i++) {
      await reportSweepSignals(
        env,
        mailer,
        { legs: NOTHING_DEFERRED, digest: null, coverage: { total: 30, covered: 1, handed: 1, allowed: 3 } },
        T0 + i * 300_000,
      );
    }
    expect(
      subjectsFor(mailer, "Ops sweep coverage").filter((s) => s.includes("UNHEALTHY")),
      "a short tail is small because the tail is small; grading it as a clipped tick pages on 10-tick rotations",
    ).toEqual([]);
  });

  it("never blames the deadline on a tick the deadline did not touch", async () => {
    const mailer = new SandboxOpsMailer();
    // Same shape, but a tenant count that genuinely IS behind: the alert is
    // owed, and it must not carry the false cause.
    for (let i = 0; i < LEG_ALERT_AFTER_SWEEPS; i++) {
      await reportSweepSignals(
        env,
        mailer,
        { legs: NOTHING_DEFERRED, digest: null, coverage: { total: 300, covered: 2, handed: 2, allowed: 3 } },
        T0 + i * 300_000,
      );
    }
    expect(subjectsFor(mailer, "Ops sweep coverage")).toEqual(["[coldrig] Ops sweep coverage: UNHEALTHY"]);
    const text = mailer.sent[0]!.text;
    expect(text, "unclipped: the rotation is ceil(300/3), not ceil(300/2)").toContain("every 100 tick(s)");
    expect(text, "nothing was clipped, so the deadline must not be named as the cause").not.toContain(
      "stopping the trailing legs",
    );
  });

  // NB-4 (gate 2026-08-20) — this lane's own class at its maximum: `coverageTicks`
  // returns 0 for a non-positive advance, and `0 > 12` is false, so the shipped
  // code published `healthy` with "a full pass every 0 tick(s) (~0 min)".
  it("zero coverage is UNKNOWN, never a healthy 'a full pass every 0 tick(s)'", async () => {
    const mailer = new SandboxOpsMailer();
    for (let i = 0; i < LEG_ALERT_AFTER_SWEEPS + 2; i++) {
      await reportSweepSignals(
        env,
        mailer,
        { legs: NOTHING_DEFERRED, digest: null, coverage: { total: 63, covered: 0, handed: 3, allowed: 3 } },
        T0 + i * 300_000,
      );
    }
    // ASSERTED ON THE PERSISTED ROW, not on the mailer. A healthy grade from a
    // fresh streak sends no RECOVERED (there was no episode to recover from),
    // so an email-only assertion passes on the broken code too — which is how
    // the gate found this by reading `watchtower_state` directly.
    const row = await env.DB.prepare(
      `SELECT status, last_detail FROM watchtower_state WHERE check_name = 'sweep_coverage'`,
    ).first<{ status: string; last_detail: string | null }>();
    expect(row?.status, "zero coverage banked as healthy is this lane's own class at its maximum").not.toBe("healthy");
    expect(row?.last_detail ?? "").not.toContain("every 0 tick(s)");
  });

  it("reports NOTHING rather than a healthy claim when the tick cannot measure its own coverage", async () => {
    const mailer = new SandboxOpsMailer();
    // The tenantSlice leg threw: `covered` is unknown, not zero. The shipped
    // code still graded the arm and could emit a RECOVERED whose own detail
    // said "the tenant slice could not be read this tick" — a healthy claim
    // built on the absence of data. UNKNOWN IS NOT HEALTHY.
    for (let i = 0; i < LEG_ALERT_AFTER_SWEEPS + 2; i++) {
      await reportSweepSignals(env, mailer, { legs: NOTHING_DEFERRED, digest: null, coverage: null }, T0 + i * 300_000);
    }
    expect(subjectsFor(mailer, "Ops sweep coverage")).toEqual([]);
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
    // N5 — 3 ticks (15 min), not 4. "We could not reach you" is the worst check
    // in the platform to delay, and it is already streak-damped upstream.
    for (let i = 0; i < LEG_ALERT_AFTER_SWEEPS; i++) {
      await reportSweepSignals(env, mailer, { legs, digest: null, coverage: null }, T0 + i * 300_000);
    }
    expect(subjectsFor(mailer, "Founder alert delivery")).toEqual(["[coldrig] Founder alert delivery: UNHEALTHY"]);
    expect(mailer.sent[0]!.text).toContain("do_storage (send_failed)");
    expect(mailer.sent[0]!.text).toContain("GET /admin/ops/checks");
  });

  // THE FILTER IS AN ALLOWLIST AND MUST STAY ONE (alert-state design §7.2).
  // `alert_delivery` counts `dark_channel` / `send_failed` BY NAME, and the
  // alert-state increment adds three more non-delivery reasons —
  // `pending_recovery`, `suppressed_key_cap`, `suppressed_daily_budget`. If this
  // ever became a catch-all ("anything not sent"), the budget's own deliberate
  // withholding would read as a delivery FAILURE and page the founder about the
  // mechanism that exists to stop paging them.
  it("a SUPPRESSED or debounced alert is not an undelivered one", async () => {
    const mailer = new SandboxOpsMailer();
    const legs = {
      watchtower: [
        { name: "do_storage", action: "suppressed", emailSent: false, why: "suppressed_cooldown" },
        { name: "engine", action: "pending", emailSent: false, why: "pending_debounce" },
        { name: "customer_progress_agent:ten_x", action: "alerted", emailSent: false, why: "digest_only" },
        // The three the alert-state increment adds.
        { name: "vendor_wallet", action: "holding", emailSent: false, why: "pending_recovery" },
        { name: "tenant_do_wedged:ten_capped", action: "suppressed", emailSent: false, why: "suppressed_key_cap" },
        { name: "tenant_do_wedged:ten_budgeted", action: "alerted", emailSent: false, why: "suppressed_daily_budget" },
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
    // This check is DEBOUNCED on both sides (alert-state design §3.3): it is
    // reported once per tick with no upstream damping, so its recovery takes
    // `recoverAfterObservations` clean ticks exactly as its alert takes two bad
    // ones. The first two clean ticks are silent holds.
    for (let i = 2; i < 4; i++) await reportSweepSignalsHealth(env, mailer, true, T0 + i * 300_000);
    expect(subjectsFor(mailer, "Ops sweep signal reporting")).toEqual(["[coldrig] Ops sweep signal reporting: UNHEALTHY"]);

    await reportSweepSignalsHealth(env, mailer, true, T0 + 4 * 300_000);
    expect(subjectsFor(mailer, "Ops sweep signal reporting")).toEqual([
      "[coldrig] Ops sweep signal reporting: UNHEALTHY",
      "[coldrig] Ops sweep signal reporting: RECOVERED",
    ]);
  });
});
