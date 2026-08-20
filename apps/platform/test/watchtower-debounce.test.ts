import type { RecoveryBasis } from "@coldstart/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { reconcileAlerts, runWatchtower, tenantDoWedgedCheckName } from "../src/admin/watchtower.js";
import { watchtowerStub } from "../src/admin/watchtower-infra.js";
import type { CheckResult } from "../src/admin/watchtower-alerts.js";
import { TENANT_DO_SCHEMA } from "../src/schema.js";
import { SandboxOpsMailer } from "../src/ops-mail/sandbox-ops-mailer.js";
import { activatePaidPlan, envWithDeadDb, mintTenant, seedBenignSdnList, tenantStub } from "./helpers.js";

// FOUNDER RULING 2026-08-16 — the inbox flood.
//
// Three complaints, one policy. (1) Two stuck `domain_dns_aging` checks
// re-alerted every 6h forever, ~8 emails a day that said nothing new.
// (2) `tenant_do_wedged` flapped on four demo tenants in a week — each a SINGLE
// sweep's Cloudflare transient, which the old machine read as a genuine
// healthy->unhealthy transition and emailed on immediately, plus a RECOVERED
// email 5 minutes later. (3) the DO-backed `d1` check did the same on
// single-observation blips.
//
// The policy: a check must be observed unhealthy on 2 CONSECUTIVE observations
// before the FIRST email (so a one-sweep flap is worth ZERO emails, recovery
// included), and while it stays unhealthy the re-alerts back off 6h -> 24h.
//
// Every case here drives the REAL entry points — `reconcileAlerts` for the
// D1-backed store, `runWatchtower` against a dead D1 for the DO-backed one —
// at the live 5-minute cadence, and asserts on emails a mailer actually
// received. The dead-man's exemption from all of this is proved in
// watchtower-deadman.test.ts (unchanged by this wave) and pinned in
// watchtower-policy.test.ts.

const T0 = 1_800_000_000_000;
const SWEEP = 300_000;
// The founder's schedule, written as literals on purpose: these tests must fail
// if the implementation's constants drift away from the ruling, which importing
// those same constants would hide.
const FIRST_REALERT_MS = 6 * 3_600_000;
const STEADY_REALERT_MS = 24 * 3_600_000;

function unhealthy(name: string, detail = "down", materiality = "down"): CheckResult {
  return { name, healthy: false, detail, materiality };
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

describe("A — transition debounce (D1-backed store)", () => {
  it("a single-sweep flap sends ZERO emails, recovery included", async () => {
    const mailer = new SandboxOpsMailer();

    // One bad observation...
    const first = await reconcileAlerts(env, mailer, [unhealthy("do_storage", "TenantDO canary probe failed")], T0);
    expect(first).toEqual([{ name: "do_storage", action: "pending", emailSent: false, why: "pending_debounce" }]);
    expect(mailer.sent).toEqual([]);

    // ...and it is fine again on the very next sweep. The founder never hears
    // about it: no UNHEALTHY, and no RECOVERED for an alert that never went out.
    //
    // SPEC CHANGE (alert-state design §3.1): the episode does not CLOSE on that
    // first clean sweep any more — it goes `holding`, silently, until
    // `recoverAfterObservations` clean observations confirm the recovery. The
    // property this test exists for is unchanged and is the assertion below:
    // ZERO emails. What changed is that the counters are no longer thrown away
    // by one good tick, which is the whole of IN-9 — see the alternation test.
    const second = await reconcileAlerts(env, mailer, [healthy("do_storage")], T0 + SWEEP);
    expect(second).toEqual([{ name: "do_storage", action: "holding", emailSent: false, why: "pending_recovery" }]);
    expect(mailer.sent).toEqual([]);

    // Three clean observations later the episode is closed, still silently:
    // nothing was ever announced, so nothing is owed in either direction.
    for (let i = 2; i <= 3; i++) await reconcileAlerts(env, mailer, [healthy("do_storage")], T0 + i * SWEEP);
    const closed = await reconcileAlerts(env, mailer, [healthy("do_storage")], T0 + 4 * SWEEP);
    expect(closed).toEqual([{ name: "do_storage", action: "healthy", emailSent: false, why: "nothing_owed" }]);
    expect(mailer.sent).toEqual([]);
  });

  it("emails on the SECOND consecutive unhealthy observation, once", async () => {
    const mailer = new SandboxOpsMailer();

    await reconcileAlerts(env, mailer, [unhealthy("engine", "engine /health -> HTTP 503")], T0);
    expect(mailer.sent).toEqual([]);

    const confirming = await reconcileAlerts(env, mailer, [unhealthy("engine", "engine /health -> HTTP 503")], T0 + SWEEP);
    expect(confirming).toEqual([{ name: "engine", action: "alerted", emailSent: true, why: "sent" }]);
    expect(mailer.sent.map((m) => m.subject)).toEqual(["[coldrig] Engine /health: UNHEALTHY"]);
    // The specifics still ride into the body — the debounce delays the email, it
    // does not degrade it.
    expect(mailer.sent[0]!.text).toContain("engine /health -> HTTP 503");

    // A third bad sweep is inside the cooldown: still exactly one email.
    await reconcileAlerts(env, mailer, [unhealthy("engine")], T0 + 2 * SWEEP);
    expect(mailer.sent).toHaveLength(1);
  });

  // REWRITTEN AS A SPEC CHANGE (IN-9, alert-state design §3.1 + §6.11).
  //
  // This test used to assert the DEFECT. Its own title was the mechanism: "the
  // debounce counts CONSECUTIVE observations — a good sweep in between resets
  // it", asserting `mailer.sent` was EMPTY across six sweeps of a fault that was
  // unhealthy half the time. That is a real, sustained fault that the founder
  // was never told about, and no length of it would ever have alerted — the
  // gate executed 24 alternating observations against HEAD and got 0 emails.
  //
  // The rule is now the one the already-shipped sibling fix uses one layer down
  // in `gradeStreak`: "N unhealthy observations NOT YET ANSWERED BY A FULL
  // RECOVERY RUN". A good tick moves the episode to `holding`; it does not
  // discard what was already seen. Only a confirmed recovery closes the episode
  // and zeroes the count, so a genuine once-a-month flake still costs zero
  // emails (the test above) while an intermittent fault pages inside the
  // founder's 10-15 minute ceiling.
  it("an INTERMITTENT fault confirms and alerts — a good sweep no longer erases the bad one", async () => {
    const mailer = new SandboxOpsMailer();
    const actions: string[] = [];
    // bad, good, bad, good, bad, good — six sweeps of an intermittent blip.
    for (let i = 0; i < 6; i++) {
      const result = i % 2 === 0 ? unhealthy("do_storage") : healthy("do_storage");
      const [outcome] = await reconcileAlerts(env, mailer, [result], T0 + i * SWEEP);
      actions.push(outcome!.action);
    }

    // Seen at t=0, held at t=5min, CONFIRMED at t=10min — inside the ceiling.
    expect(actions).toEqual(["pending", "holding", "alerted", "holding", "suppressed", "holding"]);
    expect(mailer.sent.map((m) => m.subject)).toEqual(["[coldrig] Durable Object storage: UNHEALTHY"]);
  });

  it("a confirmed alert still recovers loudly (the debounce did not mute recovery)", async () => {
    const mailer = new SandboxOpsMailer();
    await reconcileAlerts(env, mailer, [unhealthy("engine")], T0);
    await reconcileAlerts(env, mailer, [unhealthy("engine")], T0 + SWEEP);
    // SPEC CHANGE (§3.1): a `reobserved` clear now needs
    // `recoverAfterObservations` observations to close the episode. The first
    // two are silent holds; the third is the recovery, and it is still LOUD.
    const holding = await reconcileAlerts(env, mailer, [healthy("engine")], T0 + 2 * SWEEP);
    expect(holding).toEqual([{ name: "engine", action: "holding", emailSent: false, why: "pending_recovery" }]);
    await reconcileAlerts(env, mailer, [healthy("engine")], T0 + 3 * SWEEP);
    const recovered = await reconcileAlerts(env, mailer, [healthy("engine")], T0 + 4 * SWEEP);

    expect(recovered).toEqual([{ name: "engine", action: "recovered", emailSent: true, why: "sent" }]);
    expect(mailer.sent.map((m) => m.subject)).toEqual([
      "[coldrig] Engine /health: UNHEALTHY",
      "[coldrig] Engine /health: RECOVERED",
    ]);
  });

  it("the founder's tenant_do_wedged flap, on the real path: one bad sweep, zero emails", async () => {
    // The reported incident: four demo tenants, each a single sweep in which
    // Cloudflare failed the DO RPC, then fine again on the next one.
    await env.DB.prepare("DELETE FROM tenants_index").run();
    await seedBenignSdnList();
    const { tenantId } = await mintTenant("Flapping Demo Co", "managed");
    await activatePaidPlan(tenantId, "managed");
    const mailer = new SandboxOpsMailer();

    await runInDurableObject(tenantStub(tenantId), (_instance, state) => {
      state.storage.sql.exec(`DROP TABLE scheduled_sends`);
    });
    await runWatchtower(env, mailer, T0);
    expect(mailer.sent.filter((m) => m.subject.includes(tenantId))).toEqual([]);

    // Answering again on the next sweep — the transient is over.
    await runInDurableObject(tenantStub(tenantId), (_instance, state) => {
      state.storage.sql.exec(TENANT_DO_SCHEMA);
    });
    await runWatchtower(env, mailer, T0 + SWEEP);
    expect(mailer.sent.filter((m) => m.subject.includes(tenantId))).toEqual([]);

    // SPEC CHANGE (§3.1): the row is now HOLDING rather than closed — one clean
    // sweep is not a confirmed recovery. The founder-visible property this test
    // exists for is the two assertions above (zero emails), and it holds. What
    // `healthy_obs` buys is the other half of the same defect: the bad
    // observation is no longer erased, so a fault that flaps rather than staying
    // down confirms instead of hiding forever.
    const holding = await env.DB.prepare(`SELECT status, healthy_obs FROM watchtower_state WHERE check_name = ?`)
      .bind(tenantDoWedgedCheckName(tenantId))
      .first<{ status: string; healthy_obs: number }>();
    expect(holding).toMatchObject({ status: "unhealthy", healthy_obs: 1 });

    // Two more clean sweeps and it IS back to a clean baseline.
    await runWatchtower(env, mailer, T0 + 2 * SWEEP);
    await runWatchtower(env, mailer, T0 + 3 * SWEEP);
    const row = await env.DB.prepare(`SELECT status FROM watchtower_state WHERE check_name = ?`)
      .bind(tenantDoWedgedCheckName(tenantId))
      .first<{ status: string }>();
    expect(row?.status).toBe("healthy");
    expect(mailer.sent.filter((m) => m.subject.includes(tenantId))).toEqual([]);
  }, 30_000);
});

describe("B — re-alert backoff while a check stays unhealthy", () => {
  it("emails at confirmation, +6h, then every 24h — not every 6h forever", async () => {
    const mailer = new SandboxOpsMailer();
    const check = "domain_dns_aging:stuck-domain.test";
    const sentAt: number[] = [];

    // 55h of the live 5-minute cadence on the founder's actual stuck check.
    for (let i = 0; i * SWEEP <= 55 * 3_600_000; i++) {
      const nowMs = T0 + i * SWEEP;
      const before = mailer.sent.length;
      await reconcileAlerts(env, mailer, [unhealthy(check, "un-ready mail DNS for 50h")], nowMs);
      if (mailer.sent.length > before) sentAt.push(nowMs - T0);
    }

    // Confirmation one sweep in, then +6h, then a 24h step that REPEATS. On the
    // old policy this same loop produced an email every 6h — ten of them.
    const confirmedAt = SWEEP;
    expect(sentAt).toEqual([
      confirmedAt,
      confirmedAt + FIRST_REALERT_MS,
      confirmedAt + FIRST_REALERT_MS + STEADY_REALERT_MS,
      confirmedAt + FIRST_REALERT_MS + 2 * STEADY_REALERT_MS,
    ]);
    expect(mailer.sent.every((m) => m.subject === "[coldrig] Domain DNS stalled stuck-domain.test: UNHEALTHY")).toBe(true);
  }, 60_000);

  it("the 24h step is anchored on the last alert, not on the incident start", async () => {
    const mailer = new SandboxOpsMailer();
    const check = "send_starved:ten_backoff";
    await reconcileAlerts(env, mailer, [unhealthy(check)], T0);
    await reconcileAlerts(env, mailer, [unhealthy(check)], T0 + SWEEP); // confirmed
    await reconcileAlerts(env, mailer, [unhealthy(check)], T0 + SWEEP + FIRST_REALERT_MS); // +6h
    expect(mailer.sent).toHaveLength(2);

    const anchor = T0 + SWEEP + FIRST_REALERT_MS;
    await reconcileAlerts(env, mailer, [unhealthy(check)], anchor + STEADY_REALERT_MS - 1);
    expect(mailer.sent).toHaveLength(2);
    await reconcileAlerts(env, mailer, [unhealthy(check)], anchor + STEADY_REALERT_MS);
    expect(mailer.sent).toHaveLength(3);
  });
});

describe("C — the DO-backed d1 check debounces too, and still pages inside the guardrail", () => {
  it("a single-sweep D1 blip sends nothing", async () => {
    const mailer = new SandboxOpsMailer();
    await runWatchtower(envWithDeadDb(), mailer, T0);
    expect(mailer.sent).toEqual([]);

    // D1 answers again on the next sweep (the real binding).
    await runWatchtower(env, mailer, T0 + SWEEP);
    expect(mailer.sent.filter((m) => m.subject.includes("D1 database"))).toEqual([]);
  });

  it("a sustained outage pages on the second sweep — inside the 10-15 min guardrail", async () => {
    const mailer = new SandboxOpsMailer();
    const broken = envWithDeadDb();

    await runWatchtower(broken, mailer, T0);
    expect(mailer.sent).toEqual([]);

    const pagedAt = T0 + SWEEP;
    const outcomes = await runWatchtower(broken, mailer, pagedAt);
    expect(outcomes[0]).toEqual({ name: "d1", action: "alerted", emailSent: true, why: "sent" });
    expect(mailer.sent.map((m) => m.subject)).toEqual(["[coldrig] D1 database: UNHEALTHY"]);
    // Worst case the outage began just after the previous sweep, so the founder
    // is paged at most 2 cron periods after it started.
    expect(pagedAt - T0 + SWEEP).toBeLessThanOrEqual(15 * 60_000);
  });
});
