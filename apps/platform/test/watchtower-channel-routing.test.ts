import type { RecoveryBasis } from "@coldstart/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import {
  customerProgressAgentCheckName,
  customerProgressOperatorCheckName,
  type CheckResult,
} from "../src/admin/watchtower-alerts.js";
import { reconcileAlerts } from "../src/admin/watchtower.js";
import { watchtowerStub } from "../src/admin/watchtower-infra.js";
import { SandboxOpsMailer } from "../src/ops-mail/sandbox-ops-mailer.js";

// I13 — `AlertPolicy.channel` ("email" | "digest") + two new `DeliveryReason`
// members: `digest_only` (§7.11, Q3's blame-split ruling — a check routed to
// the digest can never send an email, whatever the transition) and
// `reclassified` (§7.17.3/N3 — a blame flip between the two customer_progress_*
// names is a RE-CLASSIFICATION, not a recovery, so the abandoned name's
// RECOVERY email must be withheld even though its state genuinely clears).
//
// `policyFor` stays the single routing authority — these tests drive it
// through the REAL check names, never a synthetic policy object.

const T0 = 1_800_000_000_000;
const SWEEP = 300_000;

function unhealthy(name: string, detail = "down"): CheckResult {
  return { name, healthy: false, detail };
}
function healthy(name: string, detail = "ok", basis: RecoveryBasis = "reobserved"): CheckResult {
  return { name, healthy: true, detail, basis };
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM watchtower_state").run();
  await env.DB.prepare("DELETE FROM watchtower_cursor").run();
  await runInDurableObject(watchtowerStub(env), async (_instance, state) => {
    await state.storage.deleteAll();
    await state.storage.deleteAlarm();
  });
});

describe("I13 — a digest-channel check never emails, whatever the transition", () => {
  const name = customerProgressAgentCheckName("ten_digest_x");

  it("an ALERTED transition on the digest channel sends no email and reports why:'digest_only'", async () => {
    const mailer = new SandboxOpsMailer();
    await reconcileAlerts(env, mailer, [unhealthy(name)], T0);
    const confirming = await reconcileAlerts(env, mailer, [unhealthy(name)], T0 + SWEEP);

    expect(confirming).toEqual([{ name, action: "alerted", emailSent: false, why: "digest_only" }]);
    expect(mailer.sent).toEqual([]);
  });

  it("a RECOVERED transition on the digest channel also sends no email", async () => {
    const mailer = new SandboxOpsMailer();
    await reconcileAlerts(env, mailer, [unhealthy(name)], T0);
    await reconcileAlerts(env, mailer, [unhealthy(name)], T0 + SWEEP);
    const recovered = await reconcileAlerts(env, mailer, [healthy(name)], T0 + 2 * SWEEP);

    expect(recovered).toEqual([{ name, action: "recovered", emailSent: false, why: "digest_only" }]);
    expect(mailer.sent).toEqual([]);
  });
});

describe("I13 — the email channel is byte-identical to existing checks", () => {
  const name = customerProgressOperatorCheckName("ten_email_x");

  it("alerts and recovers on the email channel exactly like any debounced check", async () => {
    const mailer = new SandboxOpsMailer();
    await reconcileAlerts(env, mailer, [unhealthy(name)], T0);
    const confirming = await reconcileAlerts(env, mailer, [unhealthy(name)], T0 + SWEEP);
    expect(confirming).toEqual([{ name, action: "alerted", emailSent: true, why: "sent" }]);

    const recovered = await reconcileAlerts(env, mailer, [healthy(name)], T0 + 2 * SWEEP);
    expect(recovered).toEqual([{ name, action: "recovered", emailSent: true, why: "sent" }]);
    expect(mailer.sent).toHaveLength(2);
  });
});

describe("I13 — N3: a blame flip is a RE-CLASSIFICATION, not a recovery", () => {
  const tenantId = "ten_flip_x";
  const operatorName = customerProgressOperatorCheckName(tenantId);
  const agentName = customerProgressAgentCheckName(tenantId);

  it("PART 1 — the flip emits NO recovery email for the abandoned (operator) name", async () => {
    const mailer = new SandboxOpsMailer();
    // Announce the operator-blamed episode for real (2 observations -> email).
    await reconcileAlerts(env, mailer, [unhealthy(operatorName)], T0);
    await reconcileAlerts(env, mailer, [unhealthy(operatorName)], T0 + SWEEP);
    expect(mailer.sent).toHaveLength(1);

    // THE FLIP, same pass: the agent name goes unhealthy for the first time
    // AND the operator name's mandatory cross-clear fires in the SAME results
    // batch (watchtower.ts's `reported` set already contains it).
    const flipped = await reconcileAlerts(
      env,
      mailer,
      [unhealthy(agentName), healthy(operatorName, "reclassified to agent", "no_longer_applicable")],
      T0 + 2 * SWEEP,
    );

    const operatorOutcome = flipped.find((o) => o.name === operatorName);
    expect(operatorOutcome).toEqual({ name: operatorName, action: "recovered", emailSent: false, why: "reclassified" });
    // Still exactly ONE email total — the original alert. No "resolved" email
    // about a tenant that is still stalled.
    expect(mailer.sent).toHaveLength(1);
  });

  it("PART 2 — the abandoned name's state genuinely CLEARS, so a later re-flip starts a BRAND NEW episode", async () => {
    const mailer = new SandboxOpsMailer();
    await reconcileAlerts(env, mailer, [unhealthy(operatorName)], T0);
    await reconcileAlerts(env, mailer, [unhealthy(operatorName)], T0 + SWEEP);
    await reconcileAlerts(
      env,
      mailer,
      [unhealthy(agentName), healthy(operatorName, "reclassified to agent", "no_longer_applicable")],
      T0 + 2 * SWEEP,
    );

    // Re-flip back to operator blame. If the state had merely been WITHHELD
    // (kept unhealthy, `withheldAlertState`'s ordinary "recovered" branch)
    // this would immediately read "suppressed" or "realerted" from the OLD
    // episode. A genuinely cleared state starts over: PENDING on its first
    // observation, exactly like a brand new stall.
    const reflip = await reconcileAlerts(env, mailer, [unhealthy(operatorName)], T0 + 3 * SWEEP);
    expect(reflip).toEqual([{ name: operatorName, action: "pending", emailSent: false, why: "pending_debounce" }]);
  });
});
