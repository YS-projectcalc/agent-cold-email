import { beforeEach, describe, expect, it, vi } from "vitest";
import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { recordSweepHeartbeat, watchtowerStub } from "../src/admin/watchtower-infra.js";
import { SWEEP_STALE_MS } from "../src/admin/watchtower-grading.js";
import { runScheduledOpsSweep } from "../src/scheduled.js";
import { SandboxOpsMailer } from "../src/ops-mail/sandbox-ops-mailer.js";
import type { OpsEmailMessage, OpsMailer } from "../src/ops-mail/ops-mailer.js";
import type { WatchtowerDO } from "../src/watchtower-do.js";
import { envWithDeadDb } from "./helpers.js";

// AUDIT BLOCKING-2 — nobody watched the watchtower. If `scheduled()` stopped
// being invoked (cron disabled, a deploy that drops [triggers], a Cloudflare
// cron incident, a Worker that fails to start) every alert in the platform went
// silent and silence was indistinguishable from health: `last_sweep_ts` was
// read only by the sweep itself, to set its own scan window.
//
// This is the IN-PLATFORM leg — a Durable Object alarm, which is delivered by
// the DO alarm scheduler rather than the Worker's cron trigger, so it keeps
// running when the cron does not. (The complementary leg is GET /status's sweep
// freshness — status.test.ts — which is what makes the founder's external
// prober a real dead-man.)
//
// Every assertion here is on an email the alarm ACTUALLY produced: the DO
// resolves its own OpsMailer (an alarm has no caller to hand it one), and these
// tests substitute a SandboxOpsMailer through that same seam.

async function reset(): Promise<void> {
  await runInDurableObject(watchtowerStub(env), async (_instance, state) => {
    await state.storage.deleteAll();
    await state.storage.deleteAlarm();
  });
}

/** Install a mailer on the DO instance the alarm will run on. */
async function installMailer(mailer: OpsMailer): Promise<void> {
  await runInDurableObject(watchtowerStub(env), (instance: WatchtowerDO) => {
    instance.mailer = mailer;
  });
}

/** Swap in a recording mailer and hand it back, so a test can read what the
 * alarm sent. The alarm runs on this same instance. */
async function captureAlarmMail(): Promise<SandboxOpsMailer> {
  const mailer = new SandboxOpsMailer();
  await installMailer(mailer);
  return mailer;
}

async function armedAlarm(): Promise<number | null> {
  return runInDurableObject(watchtowerStub(env), (_instance, state) => state.storage.getAlarm());
}

beforeEach(reset);

describe("BLOCKING-2 — the cron dead-man (DO alarm)", () => {
  it("a completed sweep arms the alarm", async () => {
    expect(await armedAlarm()).toBeNull();
    await recordSweepHeartbeat(env, Date.now());
    expect(await armedAlarm()).not.toBeNull();
  });

  it("emails the founder when no sweep has completed for longer than the staleness threshold", async () => {
    await recordSweepHeartbeat(env, Date.now() - (SWEEP_STALE_MS + 5 * 60_000));
    const mailer = await captureAlarmMail();

    expect(await runDurableObjectAlarm(watchtowerStub(env))).toBe(true);

    expect(mailer.sent.map((m) => m.subject)).toEqual(["[coldrig] Ops sweep (cron): UNHEALTHY"]);
    expect(mailer.sent[0]!.to).toBe(env.OPS_ALERT_EMAIL);
    expect(mailer.sent[0]!.text).toContain("The 5-minute Cron Trigger appears to have stopped");
  });

  it("re-arms itself after firing, so one missed cycle cannot end the watch", async () => {
    await recordSweepHeartbeat(env, Date.now() - (SWEEP_STALE_MS + 60_000));
    await captureAlarmMail();
    await runDurableObjectAlarm(watchtowerStub(env));
    expect(await armedAlarm()).not.toBeNull();
  });

  it("stays quiet while sweeps are landing", async () => {
    await recordSweepHeartbeat(env, Date.now());
    const mailer = await captureAlarmMail();
    expect(await runDurableObjectAlarm(watchtowerStub(env))).toBe(true);
    expect(mailer.sent).toEqual([]);
  });

  it("does not storm: the alarm re-fires every 5 min but a persistent stall emails once", async () => {
    await recordSweepHeartbeat(env, Date.now() - (SWEEP_STALE_MS + 60_000));
    const mailer = await captureAlarmMail();
    for (let i = 0; i < 12; i++) await runDurableObjectAlarm(watchtowerStub(env));
    expect(mailer.sent).toHaveLength(1);
  });

  it("reports RECOVERED once the cron starts landing sweeps again", async () => {
    await recordSweepHeartbeat(env, Date.now() - (SWEEP_STALE_MS + 60_000));
    const mailer = await captureAlarmMail();
    await runDurableObjectAlarm(watchtowerStub(env));

    await recordSweepHeartbeat(env, Date.now());
    await runDurableObjectAlarm(watchtowerStub(env));

    expect(mailer.sent.map((m) => m.subject)).toEqual([
      "[coldrig] Ops sweep (cron): UNHEALTHY",
      "[coldrig] Ops sweep (cron): RECOVERED",
    ]);
  });

  // CACHED-TERMINAL MEMBER 5 at the check of LAST RESORT (docs/adversarial/
  // class-sweep-cached-terminal-2026-08-17.md:90 — "same shape at
  // watchtower-do.ts:147"). The alarm persisted the transition and then threw
  // the send result away entirely, so a send that failed still stamped
  // `lastAlertTs`/`alertCount`: the next alarm read an announced episode and
  // went quiet for the full 6h re-alert gap. The condition it reports is
  // precisely the one where "no email" means nothing, so 6h of banked silence
  // is the worst possible failure direction for this check.
  it("re-attempts the dead-man alert once the channel comes back — an undelivered one is never banked", async () => {
    await recordSweepHeartbeat(env, Date.now() - (SWEEP_STALE_MS + 60_000));

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await installMailer({
      async send(_msg: OpsEmailMessage) {
        throw new Error("E_SENDER_NOT_VERIFIED (dark)");
      },
    } satisfies OpsMailer);
    expect(await runDurableObjectAlarm(watchtowerStub(env))).toBe(true);
    errSpy.mockRestore();

    // Channel restored, cron still dead: this alarm owes the founder the alert
    // the dark one never delivered.
    const mailer = await captureAlarmMail();
    await runDurableObjectAlarm(watchtowerStub(env));

    expect(mailer.sent.map((m) => m.subject)).toEqual(["[coldrig] Ops sweep (cron): UNHEALTHY"]);
  });

  it("a D1 outage does NOT fire the dead-man — the cron is firing, and BLOCKING-1 owns that incident", async () => {
    // Start from a stalled state, so a heartbeat that fails to land would be
    // visible as an alert rather than hidden by a fresh baseline.
    await recordSweepHeartbeat(env, Date.now() - (SWEEP_STALE_MS + 60_000));

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await runScheduledOpsSweep(envWithDeadDb(), { mailer: new SandboxOpsMailer() });
    errSpy.mockRestore();
    logSpy.mockRestore();
    warnSpy.mockRestore();

    const mailer = await captureAlarmMail();
    await runDurableObjectAlarm(watchtowerStub(env));
    // The heartbeat leg wrote to the DO before (and independently of) the D1
    // legs that failed, so the dead-man correctly reports nothing.
    expect(mailer.sent).toEqual([]);
  });
});
