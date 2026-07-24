import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { reconcileSdnAlert, SDN_ALERT_COOLDOWN_MS } from "../src/ofac/sdn-alert.js";
import { SandboxOpsMailer } from "../src/ops-mail/sandbox-ops-mailer.js";

// CLASS FIX (2026-07-24, founder-reported: 160 identical emails in one day) —
// mirrors test/watchtower.test.ts's style exactly: the alert state machine is
// the core correctness surface, so it is driven directly with SYNTHETIC
// outcomes + a controlled `now`, zero dependence on a live refresh/ingest
// call. State persists in D1 (sdn_alert_state) across `it()` blocks within
// this file — reset before every test.

const T0 = 1_800_000_000_000; // fixed base ms

beforeEach(async () => {
  await env.DB.prepare(`DELETE FROM sdn_alert_state`).run();
});

async function stateRow() {
  return env.DB.prepare(`SELECT failure_streak, last_alert_ts, last_detail FROM sdn_alert_state WHERE id = 1`).first<{
    failure_streak: number;
    last_alert_ts: number | null;
    last_detail: string;
  }>();
}

describe("reconcileSdnAlert — alert-storm throttle state machine", () => {
  it("a success with NO prior failure streak sends nothing (the normal case)", async () => {
    const mailer = new SandboxOpsMailer();
    const action = await reconcileSdnAlert(env, { success: true, detail: "ok" }, mailer, T0);

    expect(action).toBe("healthy");
    expect(mailer.sent).toHaveLength(0);
    const row = await stateRow();
    expect(row?.failure_streak).toBe(0);
  });

  it("alerts once on the FIRST failure of a new streak", async () => {
    const mailer = new SandboxOpsMailer();
    const action = await reconcileSdnAlert(env, { success: false, detail: "boom" }, mailer, T0);

    expect(action).toBe("alerted");
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]!.subject).toBe("[coldrig] SDN list load failing — kept prior good list");
    expect(mailer.sent[0]!.text).toContain("boom");
    expect(mailer.sent[0]!.text).toContain("FIRST failure of a new streak");
    const row = await stateRow();
    expect(row?.failure_streak).toBe(1);
    expect(row?.last_alert_ts).toBe(T0);
  });

  it("SUPPRESSES a persisting failure streak within the cooldown — never storms", async () => {
    const mailer = new SandboxOpsMailer();
    await reconcileSdnAlert(env, { success: false, detail: "boom" }, mailer, T0); // 1 alert

    // 20 more attempts well within the 6h cooldown -> zero further emails.
    for (let i = 1; i <= 20; i++) {
      const action = await reconcileSdnAlert(env, { success: false, detail: "boom" }, mailer, T0 + i * 5 * 60_000);
      expect(action).toBe("suppressed");
    }
    expect(mailer.sent).toHaveLength(1);
    const row = await stateRow();
    expect(row?.failure_streak).toBe(21); // still counted, just not alerted
  });

  it("re-alerts exactly once AT the cooldown boundary", async () => {
    const mailer = new SandboxOpsMailer();
    await reconcileSdnAlert(env, { success: false, detail: "boom" }, mailer, T0);

    const before = await reconcileSdnAlert(env, { success: false, detail: "boom" }, mailer, T0 + SDN_ALERT_COOLDOWN_MS - 1);
    expect(before).toBe("suppressed");
    expect(mailer.sent).toHaveLength(1);

    const at = await reconcileSdnAlert(env, { success: false, detail: "boom" }, mailer, T0 + SDN_ALERT_COOLDOWN_MS);
    expect(at).toBe("realerted");
    expect(mailer.sent).toHaveLength(2);
    expect(mailer.sent[1]!.subject).toBe("[coldrig] SDN list load failing (still) — kept prior good list");
    expect(mailer.sent[1]!.text).toContain("re-alerting after the 6h cooldown");
  });

  it("a success after a failure streak sends ONE recovery email and resets the streak", async () => {
    const mailer = new SandboxOpsMailer();
    await reconcileSdnAlert(env, { success: false, detail: "boom" }, mailer, T0);
    await reconcileSdnAlert(env, { success: false, detail: "boom" }, mailer, T0 + 60_000);
    await reconcileSdnAlert(env, { success: false, detail: "boom" }, mailer, T0 + 120_000);
    expect(mailer.sent).toHaveLength(1);

    const action = await reconcileSdnAlert(env, { success: true, detail: "back to normal" }, mailer, T0 + 180_000);

    expect(action).toBe("recovered");
    expect(mailer.sent).toHaveLength(2);
    expect(mailer.sent[1]!.subject).toBe("[coldrig] SDN list load RECOVERED");
    expect(mailer.sent[1]!.text).toContain("3 consecutive failed attempt(s)");
    const row = await stateRow();
    expect(row?.failure_streak).toBe(0);
    expect(row?.last_alert_ts).toBeNull();

    // A NEW failure right after recovery is treated as a brand-new streak —
    // alerts again immediately (does not inherit the old cooldown).
    const next = await reconcileSdnAlert(env, { success: false, detail: "broke again" }, mailer, T0 + 200_000);
    expect(next).toBe("alerted");
    expect(mailer.sent).toHaveLength(3);
  });
});
