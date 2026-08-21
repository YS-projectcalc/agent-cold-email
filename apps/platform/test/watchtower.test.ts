import type { RecoveryBasis } from "@coldstart/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { reconcileAlerts, runWatchtower } from "../src/admin/watchtower.js";
import type { CheckResult } from "../src/admin/watchtower-alerts.js";
import { WATCHTOWER_COOLDOWN_MS } from "../src/admin/watchtower-policy.js";
import { SandboxOpsMailer } from "../src/ops-mail/sandbox-ops-mailer.js";
import type { OpsMailer, OpsEmailMessage } from "../src/ops-mail/ops-mailer.js";
import { envWithFailingD1Statements, signup } from "./helpers.js";

// D2 monitoring — the alert state machine is the core correctness surface.
// Every case drives `reconcileAlerts` with SYNTHETIC CheckResult[] + a
// controlled `now`, so the machine is tested with zero dependence on a live
// probe. State persists in D1 (watchtower_state); each `it` starts clean
// (isolated per-test storage) and drives the whole timeline itself.
//
// Since the founder's 2026-08-16 ruling these checks are DEBOUNCED: the first
// email of an episode waits for a second consecutive unhealthy observation, so
// every timeline below opens the episode with two sweeps. The debounce itself
// (and what it must not delay) is watchtower-debounce.test.ts /
// watchtower-policy.test.ts; these cases hold the rest of the machine.

const T0 = 1_800_000_000_000; // fixed base ms
const SWEEP = 300_000; // the live cron cadence

function unhealthy(name: string, detail = "down", materiality = "down"): CheckResult {
  return { name, healthy: false, detail, materiality };
}
function healthy(name: string, detail = "ok", basis: RecoveryBasis = "reobserved"): CheckResult {
  return { name, healthy: true, detail, basis };
}

// The watchtower state machine persists in D1 (watchtower_state/cursor), which
// is NOT rolled back between tests in this pool — clear it so each test drives
// its own timeline from a known-empty baseline.
beforeEach(async () => {
  await env.DB.prepare("DELETE FROM watchtower_state").run();
  await env.DB.prepare("DELETE FROM watchtower_cursor").run();
});

async function stateOf(checkName: string) {
  return env.DB.prepare(
    `SELECT status, since_ts, last_alert_ts, last_detail FROM watchtower_state WHERE check_name = ?`,
  )
    .bind(checkName)
    .first<{ status: string; since_ts: number; last_alert_ts: number | null; last_detail: string }>();
}

describe("watchtower alert state machine (reconcileAlerts)", () => {
  it("alerts once on a CONFIRMED healthy->unhealthy, with the [coldrig] <check>: UNHEALTHY subject + specifics", async () => {
    const mailer = new SandboxOpsMailer();
    const pending = await reconcileAlerts(env, mailer, [unhealthy("d1", "D1 unreachable: boom")], T0);
    expect(pending).toEqual([{ name: "d1", action: "pending", emailSent: false, why: "pending_debounce" }]);

    const outcomes = await reconcileAlerts(env, mailer, [unhealthy("d1", "D1 unreachable: boom")], T0 + SWEEP);

    expect(outcomes).toEqual([{ name: "d1", action: "alerted", emailSent: true, why: "sent" }]);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]!.subject).toBe("[coldrig] D1 database: UNHEALTHY");
    expect(mailer.sent[0]!.to).toBe(env.OPS_ALERT_EMAIL);
    expect(mailer.sent[0]!.text).toContain("D1 unreachable: boom");
    // Always both bodies (spam-score + client compatibility).
    expect(mailer.sent[0]!.html).toContain("UNHEALTHY");
    expect(mailer.sent[0]!.text.length).toBeGreaterThan(0);

    const row = await stateOf("d1");
    expect(row?.status).toBe("unhealthy");
    // since_ts is when the check first went bad, NOT when the debounce
    // confirmed it — the founder is told how long it has really been down.
    expect(row?.since_ts).toBe(T0);
    expect(row?.last_alert_ts).toBe(T0 + SWEEP);
  });

  it("SUPPRESSES a persisting unhealthy within the cooldown — never storms", async () => {
    const mailer = new SandboxOpsMailer();
    await reconcileAlerts(env, mailer, [unhealthy("d1")], T0);
    await reconcileAlerts(env, mailer, [unhealthy("d1")], T0 + SWEEP); // 1 alert
    // Ten more sweeps well within the 6h cooldown -> zero further emails.
    for (let i = 2; i <= 11; i++) {
      const out = await reconcileAlerts(env, mailer, [unhealthy("d1")], T0 + i * SWEEP);
      expect(out[0]!.action).toBe("suppressed");
      expect(out[0]!.emailSent).toBe(false);
    }
    expect(mailer.sent).toHaveLength(1);
  });

  it("re-alerts exactly once AT the cooldown boundary, measured from the confirming alert", async () => {
    const mailer = new SandboxOpsMailer();
    await reconcileAlerts(env, mailer, [unhealthy("d1")], T0);
    await reconcileAlerts(env, mailer, [unhealthy("d1")], T0 + SWEEP);
    const confirmedAt = T0 + SWEEP;

    // Just before the boundary: suppressed.
    const before = await reconcileAlerts(env, mailer, [unhealthy("d1")], confirmedAt + WATCHTOWER_COOLDOWN_MS - 1);
    expect(before[0]!.action).toBe("suppressed");
    expect(mailer.sent).toHaveLength(1);

    // At the boundary: one re-alert.
    const at = await reconcileAlerts(env, mailer, [unhealthy("d1")], confirmedAt + WATCHTOWER_COOLDOWN_MS);
    expect(at[0]!.action).toBe("realerted");
    expect(mailer.sent).toHaveLength(2);
    expect(mailer.sent[1]!.subject).toBe("[coldrig] D1 database: UNHEALTHY");
    expect(mailer.sent[1]!.text).toContain("Still unhealthy since");

    // since_ts is preserved across the re-alert; last_alert_ts advances.
    const row = await stateOf("d1");
    expect(row?.since_ts).toBe(T0);
    expect(row?.last_alert_ts).toBe(confirmedAt + WATCHTOWER_COOLDOWN_MS);
  });

  it("sends a RECOVERED email on unhealthy->healthy, then re-arms (debounce included)", async () => {
    const mailer = new SandboxOpsMailer();
    await reconcileAlerts(env, mailer, [unhealthy("d1")], T0);
    await reconcileAlerts(env, mailer, [unhealthy("d1")], T0 + SWEEP); // alert
    // A `reobserved` clear now takes `recoverAfterObservations` observations to
    // close the episode (§3.1); the RECOVERED email itself is unchanged.
    await reconcileAlerts(env, mailer, [healthy("d1", "D1 SELECT 1 ok")], T0 + SWEEP + 20_000);
    await reconcileAlerts(env, mailer, [healthy("d1", "D1 SELECT 1 ok")], T0 + SWEEP + 40_000);
    const rec = await reconcileAlerts(env, mailer, [healthy("d1", "D1 SELECT 1 ok")], T0 + SWEEP + 60_000);
    expect(rec[0]!.action).toBe("recovered");
    expect(mailer.sent).toHaveLength(2);
    expect(mailer.sent[1]!.subject).toBe("[coldrig] D1 database: RECOVERED");
    expect(mailer.sent[1]!.text).toContain("Was unhealthy for");
    expect((await stateOf("d1"))?.status).toBe("healthy");
    expect((await stateOf("d1"))?.last_alert_ts).toBeNull();

    // A brand-new episode after recovery starts its OWN debounce: the recovery
    // must not leave the check armed to alert on a single observation.
    const again = await reconcileAlerts(env, mailer, [unhealthy("d1")], T0 + SWEEP + 120_000);
    expect(again[0]!.action).toBe("pending");
    expect(mailer.sent).toHaveLength(2);
    const confirmed = await reconcileAlerts(env, mailer, [unhealthy("d1")], T0 + 2 * SWEEP + 120_000);
    expect(confirmed[0]!.action).toBe("alerted");
    expect(mailer.sent).toHaveLength(3);
  });

  it("handles multiple simultaneous checks independently (one recovers while others persist)", async () => {
    const mailer = new SandboxOpsMailer();
    // All three go unhealthy at once. Each debounces on its OWN counter, so the
    // second consecutive sweep confirms all three.
    const pending = await reconcileAlerts(
      env,
      mailer,
      [unhealthy("d1"), unhealthy("do_storage"), unhealthy("engine")],
      T0 - SWEEP,
    );
    expect(pending.map((o) => o.action)).toEqual(["pending", "pending", "pending"]);
    expect(mailer.sent).toHaveLength(0);

    const first = await reconcileAlerts(
      env,
      mailer,
      [unhealthy("d1"), unhealthy("do_storage"), unhealthy("engine")],
      T0,
    );
    expect(first.map((o) => o.action)).toEqual(["alerted", "alerted", "alerted"]);
    expect(mailer.sent).toHaveLength(3);
    expect(new Set(mailer.sent.map((s) => s.subject))).toEqual(
      new Set([
        "[coldrig] D1 database: UNHEALTHY",
        "[coldrig] Durable Object storage: UNHEALTHY",
        "[coldrig] Engine /health: UNHEALTHY",
      ]),
    );

    // Next sweeps (within cooldown): do_storage recovers, the other two persist.
    // Its recovery takes three clean observations (§3.1) and stays INDEPENDENT
    // of the other two throughout, which is what this test is about.
    for (const at of [T0 + 5 * 60_000, T0 + 10 * 60_000]) {
      const holding = await reconcileAlerts(env, mailer, [unhealthy("d1"), healthy("do_storage"), unhealthy("engine")], at);
      expect(holding[1]).toEqual({ name: "do_storage", action: "holding", emailSent: false, why: "pending_recovery" });
      expect(mailer.sent).toHaveLength(3);
    }
    const second = await reconcileAlerts(
      env,
      mailer,
      [unhealthy("d1"), healthy("do_storage"), unhealthy("engine")],
      T0 + 15 * 60_000,
    );
    expect(second).toEqual([
      { name: "d1", action: "suppressed", emailSent: false, why: "suppressed_cooldown" },
      { name: "do_storage", action: "recovered", emailSent: true, why: "sent" },
      { name: "engine", action: "suppressed", emailSent: false, why: "suppressed_cooldown" },
    ]);
    // Exactly ONE new email — the recovery. No storm from the persisting two.
    expect(mailer.sent).toHaveLength(4);
    expect(mailer.sent[3]!.subject).toBe("[coldrig] Durable Object storage: RECOVERED");
  });

  it("first-ever-healthy records baseline state with no email", async () => {
    const mailer = new SandboxOpsMailer();
    const out = await reconcileAlerts(env, mailer, [healthy("d1")], T0);
    expect(out[0]!.action).toBe("healthy");
    expect(mailer.sent).toHaveLength(0);
    expect((await stateOf("d1"))?.status).toBe("healthy");
  });

  // CONTRACT CHANGED DELIBERATELY (docs/adversarial/
  // class-sweep-cached-terminal-2026-08-17.md member 5). This test used to
  // assert that a FAILED send still advanced the announcement counters, so the
  // next sweep suppressed. That is the defect: `last_alert_ts` is documented as
  // "last time an alert was actually SENT", the founder had been told nothing,
  // and on recovery they would receive a RECOVERED email for an incident that
  // was never announced. An undelivered alert is now re-attempted until it
  // lands. The anti-storm property is preserved in the sense that matters: at
  // most one send ATTEMPT per check per tick, and no further email once one
  // is delivered.
  it("a dark/failing OpsMailer never throws, never claims it announced, and keeps trying until it lands", async () => {
    const throwing: OpsMailer = {
      async send(_msg: OpsEmailMessage) {
        throw new Error("E_SENDER_NOT_VERIFIED (dark)");
      },
    };
    // Must not reject.
    await reconcileAlerts(env, throwing, [unhealthy("d1")], T0);
    const out = await reconcileAlerts(env, throwing, [unhealthy("d1")], T0 + SWEEP);
    expect(out[0]!.action).toBe("alerted");
    expect(out[0]!.emailSent).toBe(false);
    expect(out[0]!.why).toBe("send_failed");
    expect((await stateOf("d1"))?.status).toBe("unhealthy");
    // Nothing was announced, so nothing is suppressed: the next sweep tries again.
    const next = await reconcileAlerts(env, throwing, [unhealthy("d1")], T0 + SWEEP + 60_000);
    expect(next[0]!.action).toBe("alerted");
    expect(next[0]!.emailSent).toBe(false);
    // And when the channel comes back, the founder actually gets the alert.
    const working = new SandboxOpsMailer();
    const landed = await reconcileAlerts(env, working, [unhealthy("d1")], T0 + SWEEP + 120_000);
    expect(landed[0]!).toMatchObject({ action: "alerted", emailSent: true, why: "sent" });
    expect(working.sent).toHaveLength(1);
    // NOW it is announced, so the following sweep goes quiet.
    const quiet = await reconcileAlerts(env, working, [unhealthy("d1")], T0 + SWEEP + 180_000);
    expect(quiet[0]!.action).toBe("suppressed");
    expect(working.sent).toHaveLength(1);
  });

  // docs/adversarial/class-sweep-hol-blocking-2026-08-17.md. The loop body
  // touches D1 (read the prior state, write the new one) and the write can
  // throw on a partial D1 degradation — the shape most engine code can actually
  // observe (helpers.ts's dbFailingStatements). Before per-check isolation, the
  // FIRST check whose upsert failed rejected the whole call, so every check
  // ORDERED AFTER IT lost its alert too. The array is ordered, so the same
  // unlucky check shadowed the same tail on every tick: head-of-line blocking
  // on the one code path whose job is to tell a human something is broken.
  it("one check's D1 failure does not silence the checks after it", async () => {
    // Event-report checks: IMMEDIATE policy, so each alerts on its first
    // observation. That matters here — a debounced check needs its state
    // PERSISTED to reach a second observation, and the whole point of this
    // scenario is that persisting is what fails.
    const names = ["a@x.com", "b@x.com", "c@x.com"].map((e) => `mailbox_provisioning:${e}`);
    const broken = envWithFailingD1Statements(/INSERT INTO watchtower_state/);
    const mailer = new SandboxOpsMailer();

    // Must not reject, and must return one outcome per check.
    const outcomes = await reconcileAlerts(broken, mailer, names.map((n) => unhealthy(n, `${n} is stuck`)), T0);

    expect(outcomes.map((o) => o.name)).toEqual(names);
    // Each one's own failure, and nothing more: the state write is what broke,
    // and every check says so about itself.
    expect(outcomes.map((o) => o.action)).toEqual(["unreportable", "unreportable", "unreportable"]);
    // THE CLAIM UNDER TEST — all three founder emails were attempted. Today:
    // the call rejects after the first, and b@ and c@ are never even composed.
    expect(mailer.sent).toHaveLength(3);
    // Each names its own mailbox (subjects carry the human label, not the raw
    // check name), so this is three distinct alerts and not one repeated.
    expect(mailer.sent.map((m) => m.subject)).toEqual([
      "[coldrig] Mailbox provisioning a@x.com: UNHEALTHY",
      "[coldrig] Mailbox provisioning b@x.com: UNHEALTHY",
      "[coldrig] Mailbox provisioning c@x.com: UNHEALTHY",
    ]);
  });
});

describe("watchtower full sweep (runWatchtower)", () => {
  it("first sweep establishes a baseline with no spurious failure-signal alert", async () => {
    // A tenant with fresh state -> no failed/complaint events -> healthy.
    await signup("Watchtower Baseline Co", "wt-baseline@example.com");
    const mailer = new SandboxOpsMailer();
    const outcomes = await runWatchtower(env, mailer, T0);

    const failure = outcomes.find((o) => o.name === "failure_signals");
    expect(failure?.action).toBe("healthy");
    // Infra checks are healthy in the test env; nothing should alert.
    expect(mailer.sent).toHaveLength(0);

    // The cursor is now set — a second sweep still finds an empty window.
    const cursor = await env.DB.prepare(`SELECT last_sweep_ts FROM watchtower_cursor WHERE id = 1`).first<{ last_sweep_ts: number }>();
    expect(cursor?.last_sweep_ts).toBe(T0);
  });
});
