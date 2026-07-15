import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import {
  reconcileAlerts,
  runWatchtower,
  WATCHTOWER_COOLDOWN_MS,
  type CheckResult,
} from "../src/admin/watchtower.js";
import { SandboxOpsMailer } from "../src/ops-mail/sandbox-ops-mailer.js";
import type { OpsMailer, OpsEmailMessage } from "../src/ops-mail/ops-mailer.js";
import { signup } from "./helpers.js";

// D2 monitoring — the alert state machine is the core correctness surface.
// Every case drives `reconcileAlerts` with SYNTHETIC CheckResult[] + a
// controlled `now`, so the machine is tested with zero dependence on a live
// probe. State persists in D1 (watchtower_state); each `it` starts clean
// (isolated per-test storage) and drives the whole timeline itself.

const T0 = 1_800_000_000_000; // fixed base ms

function unhealthy(name: string, detail = "down"): CheckResult {
  return { name, healthy: false, detail };
}
function healthy(name: string, detail = "ok"): CheckResult {
  return { name, healthy: true, detail };
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
  it("alerts once on healthy->unhealthy, with the [coldrig] <check>: UNHEALTHY subject + specifics", async () => {
    const mailer = new SandboxOpsMailer();
    const outcomes = await reconcileAlerts(env, mailer, [unhealthy("d1", "D1 unreachable: boom")], T0);

    expect(outcomes).toEqual([{ name: "d1", action: "alerted", emailSent: true }]);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]!.subject).toBe("[coldrig] D1 database: UNHEALTHY");
    expect(mailer.sent[0]!.to).toBe(env.OPS_ALERT_EMAIL);
    expect(mailer.sent[0]!.text).toContain("D1 unreachable: boom");
    // Always both bodies (spam-score + client compatibility).
    expect(mailer.sent[0]!.html).toContain("UNHEALTHY");
    expect(mailer.sent[0]!.text.length).toBeGreaterThan(0);

    const row = await stateOf("d1");
    expect(row?.status).toBe("unhealthy");
    expect(row?.since_ts).toBe(T0);
    expect(row?.last_alert_ts).toBe(T0);
  });

  it("SUPPRESSES a persisting unhealthy within the cooldown — never storms", async () => {
    const mailer = new SandboxOpsMailer();
    await reconcileAlerts(env, mailer, [unhealthy("d1")], T0); // 1 alert
    // Ten more sweeps well within the 6h cooldown -> zero further emails.
    for (let i = 1; i <= 10; i++) {
      const out = await reconcileAlerts(env, mailer, [unhealthy("d1")], T0 + i * 5 * 60_000);
      expect(out[0]!.action).toBe("suppressed");
      expect(out[0]!.emailSent).toBe(false);
    }
    expect(mailer.sent).toHaveLength(1);
  });

  it("re-alerts exactly once AT the cooldown boundary", async () => {
    const mailer = new SandboxOpsMailer();
    await reconcileAlerts(env, mailer, [unhealthy("d1")], T0);

    // Just before the boundary: suppressed.
    const before = await reconcileAlerts(env, mailer, [unhealthy("d1")], T0 + WATCHTOWER_COOLDOWN_MS - 1);
    expect(before[0]!.action).toBe("suppressed");
    expect(mailer.sent).toHaveLength(1);

    // At the boundary: one re-alert.
    const at = await reconcileAlerts(env, mailer, [unhealthy("d1")], T0 + WATCHTOWER_COOLDOWN_MS);
    expect(at[0]!.action).toBe("realerted");
    expect(mailer.sent).toHaveLength(2);
    expect(mailer.sent[1]!.subject).toBe("[coldrig] D1 database: UNHEALTHY");
    expect(mailer.sent[1]!.text).toContain("Still unhealthy since");

    // since_ts is preserved across the re-alert; last_alert_ts advances.
    const row = await stateOf("d1");
    expect(row?.since_ts).toBe(T0);
    expect(row?.last_alert_ts).toBe(T0 + WATCHTOWER_COOLDOWN_MS);
  });

  it("sends a RECOVERED email on unhealthy->healthy, then re-arms for a fresh flap", async () => {
    const mailer = new SandboxOpsMailer();
    await reconcileAlerts(env, mailer, [unhealthy("d1")], T0); // alert
    const rec = await reconcileAlerts(env, mailer, [healthy("d1", "D1 SELECT 1 ok")], T0 + 60_000);
    expect(rec[0]!.action).toBe("recovered");
    expect(mailer.sent).toHaveLength(2);
    expect(mailer.sent[1]!.subject).toBe("[coldrig] D1 database: RECOVERED");
    expect(mailer.sent[1]!.text).toContain("Was unhealthy for");
    expect((await stateOf("d1"))?.status).toBe("healthy");
    expect((await stateOf("d1"))?.last_alert_ts).toBeNull();

    // A brand-new unhealthy after recovery is a genuine transition -> alerts.
    const again = await reconcileAlerts(env, mailer, [unhealthy("d1")], T0 + 120_000);
    expect(again[0]!.action).toBe("alerted");
    expect(mailer.sent).toHaveLength(3);
  });

  it("handles multiple simultaneous checks independently (one recovers while others persist)", async () => {
    const mailer = new SandboxOpsMailer();
    // All three go unhealthy at once -> three alerts.
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

    // Next sweep (within cooldown): do_storage recovers, the other two persist.
    const second = await reconcileAlerts(
      env,
      mailer,
      [unhealthy("d1"), healthy("do_storage"), unhealthy("engine")],
      T0 + 5 * 60_000,
    );
    expect(second).toEqual([
      { name: "d1", action: "suppressed", emailSent: false },
      { name: "do_storage", action: "recovered", emailSent: true },
      { name: "engine", action: "suppressed", emailSent: false },
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

  it("a dark/failing OpsMailer never throws and still advances state (graceful degradation)", async () => {
    const throwing: OpsMailer = {
      async send(_msg: OpsEmailMessage) {
        throw new Error("E_SENDER_NOT_VERIFIED (dark)");
      },
    };
    // Must not reject.
    const out = await reconcileAlerts(env, throwing, [unhealthy("d1")], T0);
    expect(out[0]!.action).toBe("alerted");
    expect(out[0]!.emailSent).toBe(false);
    // State advanced despite the send failure -> next sweep suppresses (no
    // retry-storm) instead of re-attempting every tick.
    expect((await stateOf("d1"))?.status).toBe("unhealthy");
    const next = await reconcileAlerts(env, throwing, [unhealthy("d1")], T0 + 60_000);
    expect(next[0]!.action).toBe("suppressed");
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
