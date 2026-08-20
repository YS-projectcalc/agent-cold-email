import { beforeEach, describe, expect, it } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { NEXT_STEP_REASONS } from "@coldstart/shared";
import {
  ALERT_FAMILIES,
  customerProgressKey,
  failureSignalsKey,
  sweepCoverageKey,
  tenantDoWedgedKey,
  warmupDuplicatesKey,
  warmupGaveUpKey,
} from "../src/admin/watchtower-families.js";
import { reportSweepSignals } from "../src/admin/sweep-signals.js";
import { reconcileAlerts, reportAlertBudgetHealth } from "../src/admin/watchtower.js";
import { ALERT_BUDGET_EXCEEDED_CHECK, type CheckResult } from "../src/admin/watchtower-alerts.js";
import { watchtowerStub } from "../src/admin/watchtower-infra.js";
import { FAILURE_SIGNAL_FAILED_THRESHOLD, LEG_ALERT_AFTER_SWEEPS } from "../src/admin/watchtower-grading.js";
import { SandboxOpsMailer } from "../src/ops-mail/sandbox-ops-mailer.js";

// THE CLASS GUARD (build gate B1b, CLAUDE.md Bug Response step 4).
//
// THE DEFECT THIS EXISTS FOR. `watchtower-families.test.ts` compares the family
// table TO ITSELF — declared names against rows, cap against widest space, the
// `customer_progress` map against `NEXT_STEP_REASONS` — and every other test
// that exercises a key WRITES THAT KEY BY HAND. So a family whose producer can
// only ever emit ONE of its declared keys ships green, and one did:
// `alertDeliveryKey` was handed `undeliveredAlerts.reasons`, which is rendered
// prose (`"engine (dark_channel)"`), so both of its membership tests were false
// for every input and it returned `send_failed` unconditionally. Two of three
// declared keys unreachable; the escape inert at that family.
//
// A DECLARED KEY NOBODY CAN EMIT IS A LIE IN THE TABLE, and the table is what
// the cap invariant and the whole anti-storm argument rest on. So this file
// asserts, per family, BOTH directions:
//   (a) SOUNDNESS  — every key a producer input can produce is in the declared
//                    space (nothing escapes the enumeration);
//   (b) REACHABILITY— every key in the declared space is produced by some real
//                    producer input (nothing in the enumeration is dead).
// (b) is the half that reds on B1.
//
// TWO LAYERS, AND THE DISTINCTION IS LOAD-BEARING.
//
//   END-TO-END (`describe` 1) — for the families whose key crosses a REDUCER
//   SEAM (`alert_delivery` and `cron_legs` both key off `collectLegSignals`),
//   which is where B1 lived and where its class can recur. These drive the real
//   `reportSweepSignals` and read the key the machine actually BANKED out of
//   `watchtower_state.announced_keys`. Nothing is reconstructed.
//
//   FUNCTION-LEVEL (`describe` 2 and 3) — for the rest, whose producers pass
//   structured facts straight through with no seam to corrupt.
//
// The first attempt at this guard was function-level for ALL of them, and it
// PASSED with B1 re-introduced: the probe rebuilt the composition
// (`alertDeliveryKey(collectLegSignals(...).whys)`) instead of observing what
// the producer emitted, so it never executed the wiring the defect was in. That
// is the same blind spot the U-2 polarity test had. A guard for "the producer
// feeds its classifier the wrong thing" must observe the PRODUCER.

/** One family's producer-reachable key set, with the scenarios that reach it. */
interface FamilyProbe {
  family: string;
  /** Real producer inputs → the key each one yields. */
  produce: () => string[];
  /** Why these scenarios are the producer's real shape, not a convenient one. */
  note: string;
}

const PROBES: FamilyProbe[] = [
  {
    family: "sweep_coverage",
    note:
      "The three booleans `reportSweepSignals` computes. ⚠️ The sibling sweep-calibration lane deletes two of " +
      "the three inputs (build gate F1), so this family's derivation AND its declared space are re-reconciled at " +
      "that fold — after which this probe must be rewritten against the merged producer, not patched.",
    produce: () => [
      sweepCoverageKey(true, false, true),
      sweepCoverageKey(false, true, false),
      sweepCoverageKey(false, false, true),
      sweepCoverageKey(false, true, true),
    ],
  },
  {
    family: "failure_signals",
    note:
      "Only reached when `gradeFailureSignals` returned false, i.e. `complaints >= 1 || failed >= 3`. " +
      "`sustained_subthreshold` is stated as a literal by the dead-band hold arm (§4), never derived from counts.",
    produce: () => [
      failureSignalsKey(0, 1),
      failureSignalsKey(2, 5),
      failureSignalsKey(FAILURE_SIGNAL_FAILED_THRESHOLD, 0),
      failureSignalsKey(120, 0),
      "sustained_subthreshold",
    ],
  },
  {
    family: "tenant_do_wedged:",
    note: "A closed map over `err.name`, from the throw shapes the opsSummary RPC actually produces.",
    produce: () => [
      tenantDoWedgedKey(new Error("rpc failed")),
      tenantDoWedgedKey(new TypeError("cannot read properties of undefined")),
      tenantDoWedgedKey(Object.assign(new Error("storage"), { name: "StorageError" })),
      tenantDoWedgedKey(Object.assign(new Error("odd"), { name: "SomethingNobodyAnticipated" })),
    ],
  },
  {
    family: "warmup_cancel_gave_up",
    note: "The digest's `gaveUpWarmupCancels` count, banded.",
    produce: () => [warmupGaveUpKey(1), warmupGaveUpKey(3), warmupGaveUpKey(9)],
  },
  {
    family: "warmup_duplicates",
    note: "`duplicateMailboxes.size`, banded. The producer only reports when the set is non-empty.",
    produce: () => [warmupDuplicatesKey(1), warmupDuplicatesKey(4)],
  },
  {
    family: "customer_progress_operator:",
    note: "Every one of the 12 NEXT_STEP_REASONS, as the highest-precedence owed step.",
    produce: () => NEXT_STEP_REASONS.map((reason) => customerProgressKey([reason])),
  },
  {
    family: "customer_progress_agent:",
    note: "The same map — both blame names share the action classes.",
    produce: () => NEXT_STEP_REASONS.map((reason) => customerProgressKey([reason])),
  },
];

/**
 * Families whose producer states a LITERAL key rather than calling a derivation.
 * Listed with the literal each producer writes, so a single-key space that grows
 * a second member without a producer to emit it still reds on (b).
 */
const LITERAL_PRODUCERS: Record<string, string[]> = {
  d1: ["down"],
  do_storage: ["down"],
  engine: ["down"],
  cron_sweep: ["stale"],
  sweep_signals: ["threw"],
  "cred_push_aging:": ["aging"],
  "send_starved:": ["starved"],
  "mailbox_orphan:": ["orphaned"],
  "domain_orphan:": ["orphaned"],
  "domain_dns_aging:": ["pending", "gave_up"],
  vendor_wallet: ["unreachable", "shape_drift", "below_floor_autotopup_on", "below_floor_autotopup_off"],
  "mailbox_provisioning:": ["lookup_failed", "too_recent", "rebuy_attempting"],
  "mailbox_rebuy:": ["unusable_at_vendor", "budget_spent", "dispatch_failed"],
  "mailbox_release_failed:": ["vendor_threw", "still_slot_counted"],
  "domain_ordinal_failed:": ["setup_threw", "paid_no_infra"],
  "mailbox_slot_failed:": ["buy_threw", "paid_no_infra"],
};


const T0 = 1_800_000_000_000;
const SWEEP = 300_000;

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM watchtower_state").run();
  await env.DB.prepare("DELETE FROM tenants_index").run();
  await runInDurableObject(watchtowerStub(env), async (_instance, state) => {
    await state.storage.deleteAll();
    await state.storage.deleteAlarm();
  });
});

/**
 * Drive the REAL producer until the check announces, then read the key the state
 * machine BANKED. Both families here are `gradeSweepStreak`-damped, so the
 * condition has to hold for `LEG_ALERT_AFTER_SWEEPS` ticks before it is even
 * reported; after that `policyFor` gives them IMMEDIATE, so the first reported
 * observation announces.
 */
async function bankedKeyFor(checkName: string, legs: Record<string, unknown>): Promise<string | null> {
  await env.DB.prepare("DELETE FROM watchtower_state").run();
  await runInDurableObject(watchtowerStub(env), async (_instance, state) => {
    await state.storage.deleteAll();
  });
  const mailer = new SandboxOpsMailer();
  for (let tick = 0; tick <= LEG_ALERT_AFTER_SWEEPS; tick++) {
    await reportSweepSignals(env, mailer, { legs, digest: null, coverage: null }, T0 + tick * SWEEP);
  }
  const row = await env.DB.prepare(`SELECT announced_keys FROM watchtower_state WHERE check_name = ?`)
    .bind(checkName)
    .first<{ announced_keys: string }>();
  if (!row) return null;
  const keys = (JSON.parse(row.announced_keys) as { keys: string[] }).keys;
  return keys[0] ?? null;
}

/**
 * Assert BOTH directions for one family from the keys its producer actually
 * banked. Both, always — asserting only reachability let a producer emitting an
 * UNDECLARED key pass, which is the soundness half and the one that protects the
 * table when a producer drifts.
 */
function assertKeySpace(family: string, produced: (string | null)[]): void {
  const declared = new Set(ALERT_FAMILIES[family]!.keys);
  expect(produced.filter((k) => k === null), `${family}: a scenario banked NO key at all`).toEqual([]);
  expect(
    [...new Set(produced)].filter((k) => k !== null && !declared.has(k)),
    `${family}: the producer emitted key(s) its family does not declare — the table no longer describes what the ` +
      `machine can do, and the cap invariant is computed from the table`,
  ).toEqual([]);
  expect(
    ALERT_FAMILIES[family]!.keys.filter((k) => !produced.includes(k)),
    `${family}: declares key(s) NO producer input can emit — its escalation is dead at those rungs. ` +
      `Produced: [${produced.join(", ")}]`,
  ).toEqual([]);
}

/** The first key banked for a check, straight out of the state machine's row. */
async function bankedKey(checkName: string): Promise<string | null> {
  const row = await env.DB.prepare(`SELECT announced_keys FROM watchtower_state WHERE check_name = ?`)
    .bind(checkName)
    .first<{ announced_keys: string }>();
  if (!row) return null;
  return (JSON.parse(row.announced_keys) as { keys: string[] }).keys[0] ?? null;
}

/** A PURE per-entity storm — the shape that saturates the sub-cap. */
function wedgedTenants(count: number, tick: number): CheckResult[] {
  return Array.from({ length: count }, (_v, i) => ({
    name: `tenant_do_wedged:ten_${i}`,
    healthy: false as const,
    materiality: "rpc_unreachable",
    detail: `Durable Object threw instead of answering opsSummary (tick ${tick})`,
  }));
}

/** An env whose WatchtowerDO refuses the budget read. */
function envWithDeadBudgetRead() {
  return {
    ...env,
    WATCHTOWER: {
      idFromName: (name: string) => env.WATCHTOWER.idFromName(name),
      get: () => ({
        readAnnouncementBudget: () => {
          throw new Error("WatchtowerDO unreachable");
        },
      }),
    },
  } as unknown as typeof env;
}

/** A watchtower leg result carrying alerts that were owed and did not land. */
function undelivered(whys: string[]): Record<string, unknown> {
  return { watchtower: whys.map((why, i) => ({ name: `check_${i}`, action: "alerted", emailSent: false, why })) };
}

describe("END-TO-END — the key the PRODUCER banks, for the families that cross a reducer seam", () => {
  // B1 lived exactly here: `reportSweepSignals` handed `alertDeliveryKey` the
  // rendered `reasons` array instead of the closed `whys` enum. Reading
  // `announced_keys` is the only observation that executes that wiring.
  it("alert_delivery: all three declared keys are reachable through the real producer", async () => {
    const produced = [
      await bankedKeyFor("alert_delivery", undelivered(["dark_channel"])),
      await bankedKeyFor("alert_delivery", undelivered(["send_failed"])),
      await bankedKeyFor("alert_delivery", undelivered(["dark_channel", "send_failed"])),
    ];
    expect(produced).toEqual(["dark_channel", "send_failed", "both"]);
    assertKeySpace("alert_delivery", produced);
  }, 60_000);

  // DESIGN DELTA (build-gate N2, option (a)): this family declares TWO keys, and
  // the second exists precisely for the case where the store is unreachable — so
  // a literal-table entry would be the weakest possible evidence for it. Both
  // members are driven end-to-end here, each from the branch that produces it.
  it("alert_budget_exceeded: both declared keys are reachable through the real producer", async () => {
    const mailer = new SandboxOpsMailer();

    // `saturated` — a real storm fills the ring, then the check observes it.
    for (let tick = 0; tick < 6; tick++) {
      await reconcileAlerts(env, mailer, wedgedTenants(100, tick), T0 + tick * SWEEP);
      await reportAlertBudgetHealth(env, mailer, T0 + tick * SWEEP);
    }
    const saturatedKey = await bankedKey(ALERT_BUDGET_EXCEEDED_CHECK);

    // `unreadable` — the WatchtowerDO refuses the read. DEBOUNCED, so two
    // observations before it announces and banks its key.
    await env.DB.prepare("DELETE FROM watchtower_state").run();
    const dead = envWithDeadBudgetRead();
    for (let tick = 0; tick < 3; tick++) {
      await reportAlertBudgetHealth(dead, mailer, T0 + (10 + tick) * SWEEP);
    }
    const unreadableKey = await bankedKey(ALERT_BUDGET_EXCEEDED_CHECK);

    const produced = [saturatedKey, unreadableKey];
    expect(produced).toEqual(["saturated", "unreadable"]);
    assertKeySpace(ALERT_BUDGET_EXCEEDED_CHECK, produced);
  }, 120_000);

  it("cron_legs: all three declared keys are reachable through the real producer", async () => {
    const produced = [
      await bankedKeyFor("cron_legs", { dunning: { errors: 2 } }),
      await bankedKeyFor("cron_legs", { dunning: null }),
      await bankedKeyFor("cron_legs", { dunning: null, digest: { errors: 1 } }),
    ];
    // The (false,false) input is deliberately absent: `cron_legs` is only
    // REPORTED once `gradeSweepStreak` graded it unhealthy, which requires the
    // disjunction of exactly these two inputs, so a no-failure key would be a
    // mislabel rather than a missing member.
    expect(produced).toEqual(["counted", "threw", "both"]);
    assertKeySpace("cron_legs", produced);
  }, 60_000);
});

describe("(a) SOUNDNESS — no producer can emit a key outside its declared space", () => {
  for (const probe of PROBES) {
    it(`${probe.family}: every produced key is declared`, () => {
      const declared = new Set(ALERT_FAMILIES[probe.family]!.keys);
      const escaped = [...new Set(probe.produce())].filter((key) => !declared.has(key));
      expect(escaped, `${probe.family} produced undeclared key(s). ${probe.note}`).toEqual([]);
    });
  }
});

describe("(b) REACHABILITY — every declared key is produced by some real producer input", () => {
  // THIS IS THE HALF THAT REDS ON B1. A declared key no input can reach is a
  // family whose escalation is dead: the machine can never tell that condition
  // apart from any other under the same check name, which is the entire
  // capability this increment exists to add.
  for (const probe of PROBES) {
    it(`${probe.family}: every declared key is reachable`, () => {
      const produced = new Set(probe.produce());
      const unreachable = ALERT_FAMILIES[probe.family]!.keys.filter((key) => !produced.has(key));
      expect(
        unreachable,
        `${probe.family} declares key(s) NO producer input can emit — its escalation is dead at those rungs. ` +
          `Produced: [${[...produced].join(", ")}]. ${probe.note}`,
      ).toEqual([]);
    });
  }

  for (const [family, literals] of Object.entries(LITERAL_PRODUCERS)) {
    it(`${family}: its declared space is exactly what its producer writes`, () => {
      expect(new Set(ALERT_FAMILIES[family]!.keys)).toEqual(new Set(literals));
    });
  }
});

describe("the guard covers EVERY family — it cannot go stale as families are added", () => {
  it("every row in ALERT_FAMILIES is probed, by derivation or by literal", () => {
    const covered = new Set([
      // Covered END-TO-END above, through the real producer.
      "alert_delivery",
      "cron_legs",
      "alert_budget_exceeded",
      ...PROBES.map((p) => p.family),
      ...Object.keys(LITERAL_PRODUCERS),
    ]);
    const unprobed = Object.keys(ALERT_FAMILIES).filter((name) => !covered.has(name));
    expect(
      unprobed,
      "a family was added to ALERT_FAMILIES with no reachability probe. Add one here driving its PRODUCER's real " +
        "input shape — not the key function with hand-made arguments, which is what let B1 ship green.",
    ).toEqual([]);
  });
});
