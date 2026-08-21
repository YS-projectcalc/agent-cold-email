import { beforeEach, describe, expect, it } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { evaluateHealthChecks, reconcileAlerts, sendPipelineChecks } from "../src/admin/watchtower.js";
import { watchtowerStub } from "../src/admin/watchtower-infra.js";
import { DEBOUNCED_ALERT_POLICY, decideAlert, type AlertAction, type AlertState } from "../src/admin/watchtower-policy.js";
import { FAILURE_SIGNALS_HOLD_STREAK, SUSTAINED_HOLD_TICKS } from "../src/admin/watchtower-grading.js";
import type { CheckResult } from "../src/admin/watchtower-alerts.js";
import { SandboxOpsMailer } from "../src/ops-mail/sandbox-ops-mailer.js";
import type { TenantOpsSummary } from "../src/engine/ops-summary.js";
import { mintTenant, seedBenignSdnList, tenantStub } from "./helpers.js";

// IN-9 AND U-2 — the two faults the suppression could not express (alert-state
// design §3 and §4, test-plan items 1, 2, 3, 12, 16).
//
// IN-9: `unhealthyObs` was zeroed by ANY healthy observation, so the confirm
// gate read "N CONSECUTIVE unhealthy observations" and a fault that alternated
// bad/good never assembled two in a row. Executed against HEAD: 24 alternating
// observations, ZERO emails, forever. The fix is the wording the sibling fix
// already uses one layer down in `gradeStreak` — "N unhealthy observations not
// yet answered by a full recovery run" — and it is ONE decision with the
// recovery confirmation, because a carried count without episode closure would
// page eventually on a once-a-month flake.
//
// U-2: `gradeFailureSignals` answers `null` (hold) for a window that is neither
// clean nor over threshold, so a tenant losing 1-2 sends an hour FOREVER was
// reported by nothing at all.

const T0 = 1_800_000_000_000;
const SWEEP = 300_000;

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM watchtower_state").run();
  // The tenant scan visits every indexed tenant, so leftovers would make the
  // global failure counts non-deterministic. Files run serially.
  await env.DB.prepare("DELETE FROM tenants_index").run();
  await runInDurableObject(watchtowerStub(env), async (_instance, state) => {
    await state.storage.deleteAll();
    await state.storage.deleteAlarm();
  });
});

const bad = (name: string, detail = "down"): CheckResult => ({ name, healthy: false, materiality: "down", detail });
const good = (name: string, detail = "ok"): CheckResult => ({ name, healthy: true, basis: "reobserved", detail });
const departed = (name: string): CheckResult => ({ name, healthy: true, basis: "no_longer_applicable", detail: "left this check's scope" });

describe("item 1 — the IN-9 alternation, on the real path", () => {
  it("24 alternating observations produce EXACTLY ONE alert, at t=10 min", async () => {
    const mailer = new SandboxOpsMailer();
    const alertedAt: number[] = [];
    for (let i = 0; i < 24; i++) {
      const at = T0 + i * SWEEP;
      const [outcome] = await reconcileAlerts(env, mailer, [i % 2 === 0 ? bad("do_storage") : good("do_storage")], at);
      if (outcome!.action === "alerted") alertedAt.push(at - T0);
    }

    // pending@0 -> holding@5min -> ALERTED@10min. On HEAD this loop emits zero.
    expect(alertedAt).toEqual([2 * SWEEP]);
    expect(alertedAt[0]).toBeLessThanOrEqual(15 * 60_000);
    expect(mailer.sent).toHaveLength(1);
  });

  it("...and it never announces a SECOND time for the same continuing fault", async () => {
    const mailer = new SandboxOpsMailer();
    for (let i = 0; i < 24; i++) {
      await reconcileAlerts(env, mailer, [i % 2 === 0 ? bad("do_storage") : good("do_storage")], T0 + i * SWEEP);
    }
    expect(mailer.sent).toHaveLength(1);
  });
});

describe("item 2 — recovery confirmation, in both directions", () => {
  it("[bad, good, good, good] is [pending, holding, holding, healthy] and ZERO emails", async () => {
    const mailer = new SandboxOpsMailer();
    const actions: AlertAction[] = [];
    for (const [i, result] of [bad("engine"), good("engine"), good("engine"), good("engine")].entries()) {
      const [outcome] = await reconcileAlerts(env, mailer, [result], T0 + i * SWEEP);
      actions.push(outcome!.action);
    }
    expect(actions).toEqual(["pending", "holding", "holding", "healthy"]);
    expect(mailer.sent).toEqual([]);

    const row = await env.DB.prepare(`SELECT status, unhealthy_obs, healthy_obs FROM watchtower_state WHERE check_name = 'engine'`).first<{
      status: string;
      unhealthy_obs: number;
      healthy_obs: number;
    }>();
    expect(row).toMatchObject({ status: "healthy", unhealthy_obs: 0, healthy_obs: 0 });
  });

  it("a once-a-month flake stays silent for 30 episodes — exact parity with today", () => {
    // The counterweight to item 1. A carried unhealthy count is only safe
    // BECAUSE the episode closes: one bad tick then a day of clean ones is a
    // flap, and 30 of them in a row must still cost nothing.
    let state: AlertState | null = null;
    let emails = 0;
    for (let month = 0; month < 30; month++) {
      const base = T0 + month * 30 * 24 * 3_600_000;
      const timeline: CheckResult[] = [bad("engine"), ...Array.from({ length: 288 }, () => good("engine"))];
      for (const [i, result] of timeline.entries()) {
        const observation = result.healthy ? ({ healthy: true, basis: "reobserved" } as const) : ({ healthy: false, materiality: "down" } as const);
        const transition = decideAlert(state, observation, base + i * SWEEP, DEBOUNCED_ALERT_POLICY);
        state = transition.next;
        if (transition.action === "alerted" || transition.action === "realerted" || transition.action === "recovered") emails++;
      }
    }
    expect(emails).toBe(0);
  });
});

describe("item 3 — `no_longer_applicable` closes in ONE observation", () => {
  // NOT NEGOTIABLE (§3.2). It is not a measurement of the condition, it says the
  // entity left the population — and a departed entity never produces another
  // observation, so requiring three would leave its episode open and re-alerting
  // on the 24h ladder forever. It is also what the continuity blame-flip
  // cross-clear depends on (N-3).
  it("a departed entity's episode closes on the first clear, not the third", async () => {
    const mailer = new SandboxOpsMailer();
    const check = "domain_dns_aging:released.test";
    await reconcileAlerts(env, mailer, [bad(check, "un-ready mail DNS for 50h")], T0);
    await reconcileAlerts(env, mailer, [bad(check, "un-ready mail DNS for 50h")], T0 + SWEEP);
    expect(mailer.sent).toHaveLength(1);

    const [outcome] = await reconcileAlerts(env, mailer, [departed(check)], T0 + 2 * SWEEP);
    expect(outcome!.action).toBe("recovered");
    const row = await env.DB.prepare(`SELECT status FROM watchtower_state WHERE check_name = ?`).bind(check).first<{ status: string }>();
    expect(row?.status).toBe("healthy");
    // ...and the renderer still refuses to repeat the producer's prose for a
    // merely-departed entity.
    expect(mailer.sent.at(-1)!.subject).toContain("NO LONGER TRACKED");
  });

  it("a NEVER-ANNOUNCED episode departing is silent in both directions", async () => {
    const mailer = new SandboxOpsMailer();
    const check = "mailbox_orphan:gone@example.com";
    await reconcileAlerts(env, mailer, [bad(check)], T0);
    const [outcome] = await reconcileAlerts(env, mailer, [departed(check)], T0 + SWEEP);
    expect(outcome!.action).toBe("healthy");
    expect(mailer.sent).toEqual([]);
  });
});

describe("item 12 (gate constraint 1) — U-2's polarity", () => {
  // THE HIGHEST-VALUE RED IN THE INCREMENT. `gradeStreak`'s arms are DISJOINT BY
  // INPUT: fed `observedUnhealthy = (grade === null)`, a tick satisfying
  // `grade === null` takes the first branch, which can only return `false` or
  // `null`. `true` is UNREACHABLE there — so the v1 composition
  // `grade === null && holdGrade` is always falsy, and 300 ticks of a sustained
  // sub-threshold rate produce nothing at all, byte-identical to HEAD. The
  // inversion passes every "it alerts on a real signal" test, because the
  // real-signal path is the OTHER arm.
  it("the streak's THRESHOLD arm is `false`, and `true` is unreachable from a dead-band tick", async () => {
    const stub = watchtowerStub(env);
    const grades: (boolean | null)[] = [];
    for (let i = 0; i < SUSTAINED_HOLD_TICKS + 5; i++) {
      grades.push(await stub.gradeSweepStreak(FAILURE_SIGNALS_HOLD_STREAK, true, SUSTAINED_HOLD_TICKS, 1));
    }

    // Every tick before the threshold is `null` (hold); at and after it, `false`.
    expect(grades.slice(0, SUSTAINED_HOLD_TICKS - 1).every((g) => g === null)).toBe(true);
    expect(grades[SUSTAINED_HOLD_TICKS - 1]).toBe(false);
    // THE RED: `true` never appears on this arm at all, over 149 ticks. A guard
    // written as `holdGrade === true` (or the truthiness form `&& holdGrade`)
    // can therefore never fire, however long the dead band is occupied.
    expect(grades.filter((g) => g === true)).toEqual([]);
  }, 30_000);

  it("one genuinely clean window clears the hold streak (recover parameter 1)", async () => {
    const stub = watchtowerStub(env);
    for (let i = 0; i < SUSTAINED_HOLD_TICKS; i++) {
      await stub.gradeSweepStreak(FAILURE_SIGNALS_HOLD_STREAK, true, SUSTAINED_HOLD_TICKS, 1);
    }
    expect(await stub.gradeSweepStreak(FAILURE_SIGNALS_HOLD_STREAK, false, SUSTAINED_HOLD_TICKS, 1)).toBe(true);
    // ...and the tally really is reset, not merely reported clean.
    expect(await stub.gradeSweepStreak(FAILURE_SIGNALS_HOLD_STREAK, true, SUSTAINED_HOLD_TICKS, 1)).toBe(null);
  }, 30_000);

  it("THE REAL PATH — 12h in the dead band produces a `sustained_subthreshold` observation", async () => {
    // The isolated arms above prove the grader's polarity. This one drives the
    // COMPOSED GUARD through `evaluateHealthChecks`, which is what actually reds
    // on the v1 `&& holdGrade` form: a shape check on the grader cannot see a
    // guard that never fires.
    await env.DB.prepare("DELETE FROM tenants_index").run();
    await seedBenignSdnList();
    const { tenantId } = await mintTenant("Dead Band Co", "managed");

    // One terminal failure every 30 min, forever — recorded tick by tick,
    // because the count is a TRAILING window with no upper bound and a
    // future-stamped fixture would read as a burst. Every 60-minute window
    // therefore holds 1-2, below `FAILURE_SIGNAL_FAILED_THRESHOLD`, so
    // `gradeFailureSignals` answers `null` on EVERY sweep and the check is
    // reported by nothing at all. That is U-2: a real, sustained, money-losing
    // fault that no threshold will ever see.
    const TICKS_PER_FAILURE = 6; // 30 min at the 5-minute cadence
    const failureResults: { tick: number; materiality?: string }[] = [];
    for (let tick = 0; tick < SUSTAINED_HOLD_TICKS + 3; tick++) {
      const now = T0 + tick * SWEEP;
      if (tick % TICKS_PER_FAILURE === 0) {
        await runInDurableObject(tenantStub(tenantId), (_instance, state) => {
          state.storage.sql.exec(
            `INSERT INTO events (id, tenant_id, campaign_id, lead_id, type, step, message_id, thread_id, ts, metadata_json)
             VALUES (?, ?, 'camp_u2', 'lead_u2', 'failed', 0, NULL, 'thr_u2', ?, '{}')`,
            crypto.randomUUID(),
            tenantId,
            now - 60_000,
          );
        });
      }
      const results = await evaluateHealthChecks(env, now);
      const signal = results.find((r) => r.name === "failure_signals");
      if (signal) failureResults.push({ tick, materiality: signal.healthy ? undefined : signal.materiality });
    }

    // Silent for the whole hold window — no threshold is ever crossed...
    expect(failureResults.filter((r) => r.tick < SUSTAINED_HOLD_TICKS - 1)).toEqual([]);
    // ...and then the SUSTAINED rate is reported, under its own key.
    expect(failureResults.length).toBeGreaterThan(0);
    expect(failureResults.every((r) => r.materiality === "sustained_subthreshold")).toBe(true);
    expect(failureResults[0]!.tick).toBe(SUSTAINED_HOLD_TICKS - 1);
  }, 180_000);

  it("a sustained sub-threshold rate announces under its OWN materiality key", async () => {
    const mailer = new SandboxOpsMailer();
    const check = "failure_signals";
    const sustained: CheckResult = {
      name: check,
      healthy: false,
      materiality: "sustained_subthreshold",
      detail: "Terminal send failures have sat BELOW the alerting threshold continuously for ~12h",
    };
    await reconcileAlerts(env, mailer, [sustained], T0);
    await reconcileAlerts(env, mailer, [sustained], T0 + SWEEP);
    expect(mailer.sent).toHaveLength(1);

    // ...and it is a KEY on the existing family, not a new family: crossing to a
    // real over-threshold burst escalates on the SAME check rather than opening
    // a second episode with its own cooldown.
    const over: CheckResult = { name: check, healthy: false, materiality: "failed_severe", detail: "120 terminal-failed send(s)" };
    const [outcome] = await reconcileAlerts(env, mailer, [over], T0 + 2 * SWEEP);
    expect(outcome!.action).toBe("escalated");
    expect(mailer.sent).toHaveLength(2);
  });
});

describe("item 16 (gate constraint 4) — IN-9 is INERT for send_starved:, and that is a RULING", () => {
  // PINNED, NOT FIXED. The drain arm emits `no_longer_applicable` ("only the
  // mailbox half is evidence that capacity came back"), which under §3.1 closes
  // the episode in ONE tick and zeroes the count — strictly stronger than "does
  // not count as recovery evidence". So a tenant alternating starved/drained
  // never confirms.
  //
  // The alternative (episode-holding semantics for the drain arm) is REJECTED on
  // three grounds: it contradicts §3.1's departure rule, it puts a per-tenant
  // family into the per-day multiplier, and it does not fix the ROOT CAUSE —
  // the unhealthy predicate conjoins a CAPACITY fact (`eligibleMailboxes === 0`)
  // with a DEMAND fact (`dueNonDemoPendingSends > 0`), so a tenant with zero
  // send capacity reads healthy whenever its queue happens to be empty. That is
  // a producer-side change with its own blast radius and is a NAMED NON-GOAL
  // (§8). This test exists so a later "fix" is a deliberate decision.
  function summaryWith(due: number, eligible: number): TenantOpsSummary {
    return {
      brand: "Starved Co",
      plan: "managed",
      status: "active",
      billingState: "current",
      failureSignalsInWindow: { failed: 0, complaints: 0 },
      mailboxProvenance: [],
      sendPipeline: {
        activated: true,
        agingPendingDomains: [],
        agingPendingPushes: [],
        credentialPushes: [],
        dueNonDemoPendingSends: due,
        eligibleMailboxes: eligible,
        provisionedDomains: [],
      },
    } as unknown as TenantOpsSummary;
  }

  it("the drain arm is `no_longer_applicable`, so alternation costs ZERO emails", async () => {
    const mailer = new SandboxOpsMailer();
    const check = "send_starved:ten_inert";
    const reported = new Set([check]);

    for (let i = 0; i < 12; i++) {
      // Starved on even ticks; on odd ticks the QUEUE drained while capacity
      // stayed at zero — which is the whole point.
      const results = sendPipelineChecks("ten_inert", summaryWith(i % 2 === 0 ? 5 : 0, 0), reported);
      const starved = results.filter((r) => r.name === check);
      expect(starved).toHaveLength(1);
      if (i % 2 === 1) {
        expect(starved[0]).toMatchObject({ healthy: true, basis: "no_longer_applicable" });
      }
      await reconcileAlerts(env, mailer, starved, T0 + i * SWEEP);
    }

    // The RULED behaviour: silent, and the episode closed on every drain.
    expect(mailer.sent).toEqual([]);
    const row = await env.DB.prepare(`SELECT status, unhealthy_obs FROM watchtower_state WHERE check_name = ?`)
      .bind(check)
      .first<{ status: string; unhealthy_obs: number }>();
    expect(row).toMatchObject({ status: "healthy", unhealthy_obs: 0 });
  });

  it("a tenant that STAYS starved still confirms and alerts normally", async () => {
    // The inertness is specific to the drain arm; the check itself works.
    const mailer = new SandboxOpsMailer();
    const check = "send_starved:ten_pinned";
    const reported = new Set([check]);
    for (let i = 0; i < 2; i++) {
      await reconcileAlerts(env, mailer, sendPipelineChecks("ten_pinned", summaryWith(5, 0), reported), T0 + i * SWEEP);
    }
    expect(mailer.sent.map((m) => m.subject)).toEqual(["[coldrig] Send capacity ten_pinned: UNHEALTHY"]);
  });
});
