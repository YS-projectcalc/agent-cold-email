import { beforeEach, describe, expect, it, vi } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { runWatchtower } from "../src/admin/watchtower.js";
import { watchtowerStub } from "../src/admin/watchtower-infra.js";
import { WATCHTOWER_COOLDOWN_MS } from "../src/admin/watchtower-alerts.js";
import { runScheduledOpsSweep } from "../src/scheduled.js";
import { SandboxOpsMailer } from "../src/ops-mail/sandbox-ops-mailer.js";
import { envWithDeadDb } from "./helpers.js";

// AUDIT BLOCKING-1 (docs/adversarial/audit-alerting-completeness-2026-08-06.md)
// — a sustained D1 outage used to be a TOTAL, SILENT alerting blackout. The
// `d1` check existed and was labelled "D1 database", but the code that would
// have delivered it read D1 twice more unguarded (listAllTenantIds,
// readReportedCheckNames) and then reconcileAlerts read watchtower_state before
// any send, so the one check named for a D1 outage could not report one. The
// probe that established this (executed against the old code) got 0 emails and
// 10 failed cron legs.
//
// The property these tests hold: with D1 down the founder IS emailed, exactly
// once, and the anti-storm guarantee still holds with no D1 to store it in.

const T0 = 1_800_000_000_000;

// The WatchtowerDO's storage is the whole point of this fix, and it is NOT
// rolled back between tests — clear it so each test drives its own timeline.
beforeEach(async () => {
  await runInDurableObject(watchtowerStub(env), async (_instance, state) => {
    await state.storage.deleteAll();
    await state.storage.deleteAlarm();
  });
  await env.DB.prepare("DELETE FROM watchtower_state").run();
  await env.DB.prepare("DELETE FROM watchtower_cursor").run();
});

describe("BLOCKING-1 — a D1 outage reaches the founder", () => {
  it("emails the founder that D1 is down, without reading D1 to decide it", async () => {
    const mailer = new SandboxOpsMailer();
    const outcomes = await runWatchtower(envWithDeadDb(), mailer, T0);

    expect(mailer.sent.map((m) => m.subject)).toEqual(["[coldrig] D1 database: UNHEALTHY"]);
    expect(mailer.sent[0]!.to).toBe(env.OPS_ALERT_EMAIL);
    expect(mailer.sent[0]!.text).toContain("D1 unreachable: D1_ERROR: Network connection lost.");
    expect(outcomes[0]).toEqual({ name: "d1", action: "alerted", emailSent: true });
  });

  it("does NOT storm: 24 sweeps across 2h of sustained outage send exactly one email", async () => {
    const mailer = new SandboxOpsMailer();
    const broken = envWithDeadDb();
    for (let i = 0; i < 24; i++) await runWatchtower(broken, mailer, T0 + i * 300_000);
    // 24 sweeps at the live 5-min cadence, all inside the 6h cooldown.
    expect(mailer.sent).toHaveLength(1);
  });

  it("re-alerts once at the 6h cooldown boundary, then reports RECOVERED when D1 returns", async () => {
    const mailer = new SandboxOpsMailer();
    const broken = envWithDeadDb();
    await runWatchtower(broken, mailer, T0);
    await runWatchtower(broken, mailer, T0 + WATCHTOWER_COOLDOWN_MS);
    expect(mailer.sent.map((m) => m.subject)).toEqual([
      "[coldrig] D1 database: UNHEALTHY",
      "[coldrig] D1 database: UNHEALTHY",
    ]);
    expect(mailer.sent[1]!.text).toContain("Still unhealthy since");

    // D1 comes back — the real binding, so the rest of the sweep runs too.
    await runWatchtower(env, mailer, T0 + WATCHTOWER_COOLDOWN_MS + 300_000);
    expect(mailer.sent.map((m) => m.subject)).toContain("[coldrig] D1 database: RECOVERED");
  });

  it("the WHOLE cron sweep emails the founder when D1 is dead (end to end, not just the leg)", async () => {
    const mailer = new SandboxOpsMailer();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await runScheduledOpsSweep(envWithDeadDb(), { mailer });

    errSpy.mockRestore();
    logSpy.mockRestore();
    warnSpy.mockRestore();
    // The old code produced ten console.error lines and zero emails.
    expect(mailer.sent.map((m) => m.subject)).toEqual(["[coldrig] D1 database: UNHEALTHY"]);
  });
});
