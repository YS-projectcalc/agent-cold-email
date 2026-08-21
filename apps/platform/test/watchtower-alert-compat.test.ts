import { beforeEach, describe, expect, it } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { reconcileAlerts } from "../src/admin/watchtower.js";
import { customerProgressAgentCheckName, customerProgressOperatorCheckName } from "../src/admin/watchtower-alerts.js";
import { watchtowerStub } from "../src/admin/watchtower-infra.js";
import {
  DEBOUNCED_ALERT_POLICY,
  decideAlert,
  normalizeAlertState,
  MAX_ANNOUNCED_KEYS_PER_EPISODE,
  type AlertState,
  type PersistedAlertState,
} from "../src/admin/watchtower-policy.js";
import type { CheckResult } from "../src/admin/watchtower-alerts.js";
import { SandboxOpsMailer } from "../src/ops-mail/sandbox-ops-mailer.js";

// PERSISTED-STATE COMPAT AND THE INVARIANTS (alert-state design §2, test-plan
// items 6, 7, 10, 14).
//
// The increment adds three fields to a state that lives in TWO stores, and only
// one of them has a migration mechanism at all. The rule that covers both is
// §2.2's legacy-adopt: an episode with `alertCount > 0` and an EMPTY ledger
// adopts its first observed key SILENTLY. Each test here carries its CONTROL
// ARM — what the same fixture does without the rule — because "zero deploy-day
// emails" is only meaningful against a fixture that would otherwise emit some.

const T0 = 1_800_000_000_000;
const SWEEP = 300_000;

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM watchtower_state").run();
  await runInDurableObject(watchtowerStub(env), async (_instance, state) => {
    await state.storage.deleteAll();
    await state.storage.deleteAlarm();
  });
});

const bad = (name: string, materiality: string, detail = "still broken"): CheckResult => ({ name, healthy: false, materiality, detail });

/** A row exactly as migration 0021 leaves it for an episode that was already
 * running at deploy time: the three new columns at their DEFAULTS, plus 0021's
 * own `realert_count` backfill. */
async function seedPreMigrationEpisode(name: string, opts: { alertCount: number; lastAlertTs: number }): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO watchtower_state
       (check_name, status, since_ts, last_alert_ts, last_detail, updated_at, unhealthy_obs, alert_count, healthy_obs, realert_count, announced_keys)
     VALUES (?, 'unhealthy', ?, ?, 'un-ready mail DNS for 50h', ?, 2, ?, 0, ?, '{"keys":[],"overflow":0}')`,
  )
    .bind(name, T0 - 50 * 3_600_000, opts.lastAlertTs, opts.lastAlertTs, opts.alertCount, opts.alertCount >= 2 ? 1 : 0)
    .run();
}

describe("item 6 — a pre-migration D1 row emits ZERO deploy-day emails", () => {
  const CHECK = "domain_dns_aging:stuck.test";

  it("adopts its first observed key silently, and does not restart the ladder", async () => {
    const mailer = new SandboxOpsMailer();
    // The founder's actual case: a stuck domain, announced long ago, sitting on
    // the 24h step when the deploy lands.
    await seedPreMigrationEpisode(CHECK, { alertCount: 2, lastAlertTs: T0 - 3_600_000 });

    const [outcome] = await reconcileAlerts(env, mailer, [bad(CHECK, "pending")], T0);
    expect(outcome!.action).toBe("suppressed");
    expect(mailer.sent).toEqual([]);

    const row = await env.DB.prepare(`SELECT announced_keys, alert_count, realert_count FROM watchtower_state WHERE check_name = ?`)
      .bind(CHECK)
      .first<{ announced_keys: string; alert_count: number; realert_count: number }>();
    // The key IS banked — so it never announces for this episode — and the
    // counters are untouched.
    expect(JSON.parse(row!.announced_keys)).toEqual({ keys: ["pending"], overflow: 0 });
    expect(row).toMatchObject({ alert_count: 2, realert_count: 1 });
  });

  it("CONTROL ARM — without the adopt rule that same row emits one spurious email", () => {
    // The adopt rule is `announcedKeys.keys.length === 0` inside phase 2. Remove
    // it and the first observed key is "novel" and under the cap, so row 2 fires
    // an `escalated` email about a condition the founder was told about weeks
    // ago. This drives `decideAlert` directly with a ledger that is NOT empty —
    // the only difference — and gets exactly that.
    const legacy: PersistedAlertState = {
      status: "unhealthy",
      sinceTs: T0 - 50 * 3_600_000,
      lastAlertTs: T0 - 3_600_000,
      unhealthyObs: 2,
      alertCount: 2,
      realertCount: 1,
      announcedKeys: { keys: ["gave_up"], overflow: 0 },
    };
    const escalates = decideAlert(legacy, { healthy: false, materiality: "pending" }, T0, DEBOUNCED_ALERT_POLICY);
    expect(escalates.action).toBe("escalated");

    // The SAME state with an empty ledger takes the adopt branch instead.
    const adopts = decideAlert({ ...legacy, announcedKeys: { keys: [], overflow: 0 } }, { healthy: false, materiality: "pending" }, T0, DEBOUNCED_ALERT_POLICY);
    expect(adopts.action).toBe("suppressed");
  });

  it("the ladder still fires on schedule for an adopted episode — it is not muted", async () => {
    const mailer = new SandboxOpsMailer();
    await seedPreMigrationEpisode(CHECK, { alertCount: 2, lastAlertTs: T0 - 3_600_000 });
    await reconcileAlerts(env, mailer, [bad(CHECK, "pending")], T0);
    expect(mailer.sent).toEqual([]);
    // 0021's backfill put it on the 24h rung, so the next reminder is 24h after
    // its LAST ALERT (which was an hour before T0) — not 6h, and not never.
    await reconcileAlerts(env, mailer, [bad(CHECK, "pending")], T0 + 22 * 3_600_000);
    expect(mailer.sent).toEqual([]);
    await reconcileAlerts(env, mailer, [bad(CHECK, "pending")], T0 + 23 * 3_600_000);
    expect(mailer.sent).toHaveLength(1);
  });

  it("an UNREADABLE ledger takes the LEGACY branch, never the empty one", () => {
    // A corrupt byte must not read as "this episode announced nothing" — that
    // instructs the machine to re-announce every key in the episode, so one bad
    // write becomes a storm. Empty routes to the silent adopt instead.
    const corrupt = normalizeAlertState({
      status: "unhealthy",
      sinceTs: T0,
      lastAlertTs: T0,
      unhealthyObs: 2,
      alertCount: 2,
      realertCount: 1,
      announcedKeys: { keys: "not-an-array" as never, overflow: NaN },
    });
    expect(corrupt!.announcedKeys).toEqual({ keys: [], overflow: 0 });
    const transition = decideAlert(corrupt, { healthy: false, materiality: "pending" }, T0 + SWEEP, DEBOUNCED_ALERT_POLICY);
    expect(transition.action).toBe("suppressed");
  });
});

describe("item 7 — a DO-storage value written before these fields existed", () => {
  // DO storage has NO migration mechanism, so `normalizeAlertState` is the only
  // thing that reconciles a `d1_alert_state` / `dead_man_alert_state` value the
  // previous deploy wrote. This is the same rule the D1 side uses, which is the
  // point: a backfill would only ever reach one store.
  it("normalizes a pre-field value and behaves identically to a fresh one", () => {
    const preField = {
      status: "unhealthy" as const,
      sinceTs: T0 - 3_600_000,
      lastAlertTs: T0 - 3_600_000,
      unhealthyObs: 2,
      alertCount: 2,
    };
    const normalized = normalizeAlertState(preField) as AlertState;
    expect(normalized).toMatchObject({
      healthyObs: 0,
      // Mirrors 0018's LEGACY_EPISODE_ALERT_COUNT credit: an in-flight episode
      // stays on the 24h step rather than dropping back to the 6h rung.
      realertCount: 1,
      announcedKeys: { keys: [], overflow: 0 },
    });

    // ...and it adopts silently rather than emailing on deploy day.
    expect(decideAlert(preField, { healthy: false, materiality: "down" }, T0, DEBOUNCED_ALERT_POLICY).action).toBe("suppressed");
  });

  it("a value with NO counters at all (pre-0018) still normalizes", () => {
    const ancient = { status: "unhealthy" as const, sinceTs: T0 - 3_600_000, lastAlertTs: T0 - 3_600_000 };
    expect(normalizeAlertState(ancient)).toMatchObject({ unhealthyObs: 1, alertCount: 2, realertCount: 1, healthyObs: 0 });
  });

  it("a pre-field HEALTHY value carries no episode and no ledger", () => {
    const healthy = { status: "healthy" as const, sinceTs: T0, lastAlertTs: null };
    expect(normalizeAlertState(healthy)).toMatchObject({ alertCount: 0, realertCount: 0, healthyObs: 0, announcedKeys: { keys: [] } });
  });
});

describe("item 10 — the property fuzz: three invariants over randomized timelines", () => {
  // Deterministic PRNG so a failure is reproducible from the seed alone.
  function prng(seed: number): () => number {
    let s = seed >>> 0;
    return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  }

  it("holds over 200 randomized 400-tick episodes", () => {
    const KEYS = ["rpc_unreachable", "constructor_throw", "storage_throw", "other"];
    const violations: string[] = [];

    for (let seed = 1; seed <= 200; seed++) {
      const rand = prng(seed);
      let state: AlertState | null = null;
      let emails = 0;
      let recoveriesThisEpisode = 0;
      let distinctKeys = new Set<string>();
      let ladderRungs = 0;
      let announcedInEpisode = false;

      for (let tick = 0; tick < 400; tick++) {
        const nowMs = T0 + tick * SWEEP;
        const healthy = rand() < 0.35;
        const key = KEYS[Math.floor(rand() * KEYS.length)]!;
        const observation = healthy
          ? ({ healthy: true, basis: rand() < 0.15 ? "no_longer_applicable" : "reobserved" } as const)
          : ({ healthy: false, materiality: key } as const);
        const transition = decideAlert(state, observation, nowMs, DEBOUNCED_ALERT_POLICY);

        // (iii) `alertCount > 0` implies the ledger is non-empty — an announced
        // episode always knows WHAT it announced, or the escape is blind.
        if (transition.next.alertCount > 0 && transition.next.announcedKeys.keys.length === 0) {
          violations.push(`seed ${seed} tick ${tick}: alertCount>0 with an empty ledger`);
        }
        // The cap is never exceeded, whatever the key stream does.
        if (transition.next.announcedKeys.keys.length > MAX_ANNOUNCED_KEYS_PER_EPISODE) {
          violations.push(`seed ${seed} tick ${tick}: ledger past the cap`);
        }

        if (!healthy) distinctKeys.add(key);
        if (transition.action === "alerted" || transition.action === "escalated") {
          emails++;
          announcedInEpisode = true;
        }
        if (transition.action === "realerted") {
          emails++;
          ladderRungs++;
          announcedInEpisode = true;
        }
        if (transition.action === "recovered") recoveriesThisEpisode++;

        const closed = transition.next.status === "healthy";
        if (closed) {
          // (ii) an episode that announced at least one key emits EXACTLY one
          // recovery — never zero (a silent close on an announced incident) and
          // never two.
          if (announcedInEpisode && recoveriesThisEpisode !== 1) {
            violations.push(`seed ${seed} tick ${tick}: announced episode emitted ${recoveriesThisEpisode} recoveries`);
          }
          if (!announcedInEpisode && recoveriesThisEpisode !== 0) {
            violations.push(`seed ${seed} tick ${tick}: un-announced episode emitted a recovery`);
          }
          // (i) emails per episode <= 1 + min(distinct keys - 1, cap) + rungs + 1.
          const ceiling = 1 + Math.min(Math.max(distinctKeys.size - 1, 0), MAX_ANNOUNCED_KEYS_PER_EPISODE) + ladderRungs + 1;
          if (emails > ceiling) {
            violations.push(`seed ${seed} tick ${tick}: ${emails} emails against a ceiling of ${ceiling}`);
          }
          emails = 0;
          recoveriesThisEpisode = 0;
          ladderRungs = 0;
          announcedInEpisode = false;
          distinctKeys = new Set();
        }
        state = transition.next;
      }
    }

    expect(violations).toEqual([]);
  }, 60_000);
});

describe("item 14 (gate constraint 6) — B6: `holding` must be invisible to onset adoption", () => {
  // THE SILENT DIRECTION of the exactly-once nudge (N-2), which v1 asserted was
  // safe having walked only the DUPLICATE direction.
  //
  // The adoption fires on `siblingState.status === "unhealthy"`. `holding`
  // leaves a check reading exactly that while its PRODUCER has already said
  // healthy — so without the gate the new episode inherits the OLD onset, and
  // `maybeEmitContinuityNudge`'s monotone `>=` guard then returns early: ZERO
  // nudges for the new episode's ENTIRE duration.
  const TENANT = "ten_b6";
  const OPERATOR = customerProgressOperatorCheckName(TENANT);
  const AGENT = customerProgressAgentCheckName(TENANT);
  const stalled = (name: string): CheckResult => ({ name, healthy: false, materiality: "ours_to_fix", detail: `Tenant ${TENANT} has owed next-step(s)` });
  const clear = (name: string): CheckResult => ({ name, healthy: true, basis: "reobserved", detail: `Tenant ${TENANT} is no longer stalled` });

  it("the four-step scenario: the SECOND episode carries its own onset", async () => {
    const mailer = new SandboxOpsMailer();

    // 1 — the operator-blamed episode opens and is announced.
    await reconcileAlerts(env, mailer, [stalled(OPERATOR)], T0);
    await reconcileAlerts(env, mailer, [stalled(OPERATOR)], T0 + SWEEP);
    const first = await env.DB.prepare(`SELECT since_ts FROM watchtower_state WHERE check_name = ?`).bind(OPERATOR).first<{ since_ts: number }>();
    expect(first!.since_ts).toBe(T0);

    // 2 — the producer reports it healthy. The episode HOLDS: the row still
    //     reads `unhealthy`, which is precisely the trap.
    await reconcileAlerts(env, mailer, [clear(OPERATOR)], T0 + 2 * SWEEP);
    const holding = await env.DB.prepare(`SELECT status, healthy_obs FROM watchtower_state WHERE check_name = ?`)
      .bind(OPERATOR)
      .first<{ status: string; healthy_obs: number }>();
    expect(holding).toMatchObject({ status: "unhealthy", healthy_obs: 1 });

    // 3 — much later, a genuinely NEW stall, blamed on the agent this time.
    const T2 = T0 + 10 * SWEEP;
    await reconcileAlerts(env, mailer, [stalled(AGENT)], T2);

    // 4 — THE ASSERTION. The new episode's onset is its OWN, not the holding
    //     sibling's. `stallOnsetTs` is exactly what is handed to
    //     `maybeEmitContinuityNudge`, and the guard is monotone, so inheriting
    //     T0 here would make the nudge a permanent no-op for this episode.
    const second = await env.DB.prepare(`SELECT since_ts FROM watchtower_state WHERE check_name = ?`).bind(AGENT).first<{ since_ts: number }>();
    expect(second!.since_ts).toBe(T2);
    expect(second!.since_ts).not.toBe(T0);
  });

  it("RED ARM — the `healthyObs`-blind predicate inherits the stale onset", async () => {
    // The gate is `siblingState.healthyObs === 0`. Without it the predicate is
    // just `status === "unhealthy"`, which the holding row satisfies. Re-derived
    // here from the state the scenario above actually persists, so this reds the
    // moment someone drops the gate.
    const mailer = new SandboxOpsMailer();
    await reconcileAlerts(env, mailer, [stalled(OPERATOR)], T0);
    await reconcileAlerts(env, mailer, [stalled(OPERATOR)], T0 + SWEEP);
    await reconcileAlerts(env, mailer, [clear(OPERATOR)], T0 + 2 * SWEEP);

    const sibling = await env.DB.prepare(`SELECT status, since_ts, healthy_obs FROM watchtower_state WHERE check_name = ?`)
      .bind(OPERATOR)
      .first<{ status: string; since_ts: number; healthy_obs: number }>();
    const T2 = T0 + 10 * SWEEP;

    // The blind predicate WOULD adopt (this is the defect):
    expect(sibling!.status === "unhealthy").toBe(true);
    expect(Math.min(T2, sibling!.since_ts)).toBe(T0);
    // The gated predicate does NOT:
    expect(sibling!.status === "unhealthy" && sibling!.healthy_obs === 0).toBe(false);
  });

  it("the LEGITIMATE same-tick blame flip still adopts", async () => {
    // `stateByName` is the PRE-PASS read, so on the flip tick the abandoned
    // sibling still reads `healthyObs === 0` — the gate must not break N-3.
    const mailer = new SandboxOpsMailer();
    await reconcileAlerts(env, mailer, [stalled(OPERATOR)], T0);
    await reconcileAlerts(env, mailer, [stalled(OPERATOR)], T0 + SWEEP);

    // The flip: the agent name goes unhealthy while the operator name clears, in
    // the SAME pass — which is how the producer emits it.
    const T2 = T0 + 5 * SWEEP;
    const crossClear: CheckResult = {
      name: OPERATOR,
      healthy: true,
      basis: "no_longer_applicable",
      detail: `Tenant ${TENANT} is still stalled, but blame moved to the agent`,
    };
    await reconcileAlerts(env, mailer, [stalled(AGENT), crossClear], T2);

    const flipped = await env.DB.prepare(`SELECT since_ts FROM watchtower_state WHERE check_name = ?`).bind(AGENT).first<{ since_ts: number }>();
    // ONE continuous stall — the newly-blamed name holds the TRUE onset.
    expect(flipped!.since_ts).toBe(T0);
  });
});
