import { beforeEach, describe, expect, it } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { runWatchtower } from "../src/admin/watchtower.js";
import { watchtowerStub } from "../src/admin/watchtower-infra.js";
import { FAILURE_SIGNAL_WINDOW_MS } from "../src/admin/watchtower-grading.js";
import { SandboxOpsMailer } from "../src/ops-mail/sandbox-ops-mailer.js";
import { mintTenant, seedBenignSdnList, tenantStub } from "./helpers.js";

// AUDIT NB-1 — `failure_signals` flaps, and it arms with the paying customer.
//
// The check was healthy iff failed + complaints === 0 for events since the LAST
// SWEEP, so each 5-minute window was evaluated independently: an intermittent
// failure rate produced a genuine unhealthy -> healthy -> unhealthy transition
// every single cycle, and the 6h cooldown suppresses none of that (it only
// throttles unhealthy -> unhealthy). Executed against the old code: 24 emails
// in 2 simulated hours, strictly alternating UNHEALTHY/RECOVERED. That is the
// exact cry-wolf class ofac/sdn-alert.ts was written to fix, and its real cost
// is compound — a founder trained to ignore "[coldrig] ...: UNHEALTHY" is how
// every other finding in this audit becomes permanent.
//
// These tests drive the REAL path: real `events` rows in a real tenant DO,
// through runWatchtower, at the live 5-minute cadence.

const T0 = 1_800_000_000_000;
const SWEEP = 300_000;

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM watchtower_state").run();
  await env.DB.prepare("DELETE FROM watchtower_cursor").run();
  // The scan visits every indexed tenant, so leftovers from earlier files would
  // make the global counts non-deterministic. Files run serially.
  await env.DB.prepare("DELETE FROM tenants_index").run();
  await runInDurableObject(watchtowerStub(env), async (_instance, state) => {
    await state.storage.deleteAll();
    await state.storage.deleteAlarm();
  });
  await seedBenignSdnList();
});

/**
 * Events land BETWEEN sweeps, never exactly on a sweep boundary. This matters:
 * the old window was `ts >= previous sweep` INCLUSIVE, so an event stamped
 * exactly on a sweep boundary was counted by two consecutive windows and the
 * old code looked stable on a pattern that in reality flaps. One minute before
 * the sweep that should see it is what a real send does.
 */
const JUST_BEFORE = 60_000;

async function recordEvent(tenantId: string, type: "failed" | "complaint", ts: number): Promise<void> {
  await runInDurableObject(tenantStub(tenantId), (_instance, state) => {
    state.storage.sql.exec(
      `INSERT INTO events (id, tenant_id, campaign_id, lead_id, type, step, message_id, thread_id, ts, metadata_json)
       VALUES (?, ?, 'camp_flap', 'lead_flap', ?, 0, NULL, 'thr_flap', ?, '{}')`,
      crypto.randomUUID(),
      tenantId,
      type,
      ts,
    );
  });
}

function failureSubjects(mailer: SandboxOpsMailer): string[] {
  return mailer.sent.map((m) => m.subject).filter((s) => s.includes("Failure signals"));
}

describe("NB-1 — failure_signals no longer flaps", () => {
  it("one failed send every other sweep for 2h sends ONE email, not 24", async () => {
    const { tenantId } = await mintTenant("Flap Co", "managed");
    const mailer = new SandboxOpsMailer();

    for (let i = 0; i < 24; i++) {
      const now = T0 + i * SWEEP;
      if (i % 2 === 0) await recordEvent(tenantId, "failed", now - JUST_BEFORE);
      await runWatchtower(env, mailer, now);
    }

    expect(failureSubjects(mailer)).toEqual(["[coldrig] Failure signals: UNHEALTHY"]);
  }, 30_000);

  it("recovers exactly once, after a genuinely quiet window", async () => {
    const { tenantId } = await mintTenant("Recover Co", "managed");
    const mailer = new SandboxOpsMailer();

    for (let i = 0; i < 6; i++) {
      const now = T0 + i * SWEEP;
      await recordEvent(tenantId, "failed", now - JUST_BEFORE);
      await runWatchtower(env, mailer, now);
    }
    expect(failureSubjects(mailer)).toEqual(["[coldrig] Failure signals: UNHEALTHY"]);

    // Still inside the trailing window: the failures are old but still counted,
    // so nothing changes — this is the hysteresis that kills the flap.
    await runWatchtower(env, mailer, T0 + 5 * SWEEP + FAILURE_SIGNAL_WINDOW_MS - SWEEP);
    expect(failureSubjects(mailer)).toHaveLength(1);

    // Past it: the window is clean, so exactly one recovery.
    await runWatchtower(env, mailer, T0 + 5 * SWEEP + FAILURE_SIGNAL_WINDOW_MS + SWEEP);
    expect(failureSubjects(mailer)).toEqual([
      "[coldrig] Failure signals: UNHEALTHY",
      "[coldrig] Failure signals: RECOVERED",
    ]);
  }, 30_000);

  it("a single hard bounce is not an alert — that is the noise floor, not a fault", async () => {
    const { tenantId } = await mintTenant("Bounce Co", "managed");
    const mailer = new SandboxOpsMailer();

    await recordEvent(tenantId, "failed", T0 - JUST_BEFORE);
    for (let i = 0; i < 6; i++) await runWatchtower(env, mailer, T0 + i * SWEEP);

    expect(failureSubjects(mailer)).toEqual([]);
  }, 30_000);

  it("a SINGLE spam complaint still alerts — it is not damped like a bounce", async () => {
    const { tenantId } = await mintTenant("Complaint Co", "managed");
    const mailer = new SandboxOpsMailer();

    await recordEvent(tenantId, "complaint", T0 - JUST_BEFORE);
    await runWatchtower(env, mailer, T0);
    expect(failureSubjects(mailer)).toEqual(["[coldrig] Failure signals: UNHEALTHY"]);
    expect(mailer.sent[0]!.text).toContain("1 complaint(s)");

    // ...and the next sweep must NOT declare it recovered: on the old per-sweep
    // window the complaint fell out of scope 5 minutes later and produced an
    // immediate RECOVERED, which is the flap.
    await runWatchtower(env, mailer, T0 + SWEEP);
    expect(failureSubjects(mailer)).toEqual(["[coldrig] Failure signals: UNHEALTHY"]);
  });

  it("a SUSTAINED failure rate still alerts exactly once (the check was not simply muted)", async () => {
    const { tenantId } = await mintTenant("Sustained Co", "managed");
    const mailer = new SandboxOpsMailer();

    for (let i = 0; i < 24; i++) {
      const now = T0 + i * SWEEP;
      await recordEvent(tenantId, "failed", now - JUST_BEFORE);
      await runWatchtower(env, mailer, now);
    }

    expect(failureSubjects(mailer)).toEqual(["[coldrig] Failure signals: UNHEALTHY"]);
  }, 30_000);
});
