import { beforeEach, describe, expect, it } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { reconcileAlerts, reportAlertBudgetHealth } from "../src/admin/watchtower.js";
import { watchtowerStub } from "../src/admin/watchtower-infra.js";
import {
  admits,
  countRing,
  isSaturated,
  MAX_ANNOUNCEMENT_EMAILS_PER_DAY,
  MAX_PER_ENTITY_ANNOUNCEMENTS_PER_DAY,
  pruneRing,
  type AnnouncementCounts,
  type AnnouncementRing,
} from "../src/admin/watchtower-budget.js";
import { alertDeliveryKey } from "../src/admin/watchtower-families.js";
import type { CheckResult } from "../src/admin/watchtower-alerts.js";
import { SandboxOpsMailer } from "../src/ops-mail/sandbox-ops-mailer.js";

// THE DAILY ANNOUNCEMENT BUDGET — item 15's five arms (alert-state design §5.5).
//
// SPLIT INTO ARMS DELIBERATELY: gating this on a single number would have let
// three of the five pass while the mechanism was broken. Each arm pins one part.
//
// The governing principle every arm is a consequence of:
//   the budget may delay an ANNOUNCEMENT; it may never delay an episode CLOSE,
//   and it may never suppress the report that it is itself suppressing.

const T0 = 1_800_000_000_000;
const SWEEP = 300_000;
const DAY = 24 * 3_600_000;

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM watchtower_state").run();
  await runInDurableObject(watchtowerStub(env), async (_instance, state) => {
    await state.storage.deleteAll();
    await state.storage.deleteAlarm();
  });
});

/** A PURE per-entity storm: N wedged tenants, no global family alerting. */
function wedgedTenants(count: number, tick: number): CheckResult[] {
  return Array.from({ length: count }, (_v, i) => ({
    name: `tenant_do_wedged:ten_${i}`,
    healthy: false as const,
    materiality: "rpc_unreachable",
    detail: `Durable Object threw instead of answering opsSummary (tick ${tick})`,
  }));
}

async function budgetNow(nowMs: number) {
  return watchtowerStub(env).readAnnouncementBudget(nowMs);
}

/** Announcement emails only — recoveries are exempt and are counted separately. */
const announcements = (mailer: SandboxOpsMailer) => mailer.sent.filter((m) => m.subject.includes("UNHEALTHY"));
const recoveries = (mailer: SandboxOpsMailer) => mailer.sent.filter((m) => m.subject.includes("RECOVERED"));

describe("15a — VOLUME: <=20 announcements in any rolling 24h, against ~114/day uncapped", () => {
  it("100 flapping instances over a day cannot exceed the cap", async () => {
    const mailer = new SandboxOpsMailer();
    // Two ticks to confirm, then the ladder. 24h of the live cadence would be
    // 288 ticks; 60 is well past the point where the uncapped number blows the
    // ratified ~2/day, and keeps the test inside a sane runtime.
    for (let tick = 0; tick < 60; tick++) {
      await reconcileAlerts(env, mailer, wedgedTenants(100, tick), T0 + tick * SWEEP);
    }

    expect(announcements(mailer).length).toBeLessThanOrEqual(MAX_ANNOUNCEMENT_EMAILS_PER_DAY);
    // LOAD-BEARING, NOT DECORATIVE: without the budget every one of the 100
    // instances confirms on tick 2, which is 100 emails in one tick alone.
    expect(announcements(mailer).length).toBeLessThan(100);

    const budget = await budgetNow(T0 + 60 * SWEEP);
    expect(budget.total).toBeLessThanOrEqual(MAX_ANNOUNCEMENT_EMAILS_PER_DAY);
    expect(budget.perEntity).toBeLessThanOrEqual(MAX_PER_ENTITY_ANNOUNCEMENTS_PER_DAY);
  }, 120_000);

  it("a withheld announcement reports WHY, and its episode still advances", async () => {
    const mailer = new SandboxOpsMailer();
    let outcomes = await reconcileAlerts(env, mailer, wedgedTenants(100, 0), T0);
    outcomes = await reconcileAlerts(env, mailer, wedgedTenants(100, 1), T0 + SWEEP);

    const withheld = outcomes.filter((o) => o.why === "suppressed_daily_budget");
    expect(withheld.length).toBeGreaterThan(0);
    // The STATE transition happened for all 100 — only the email waits. Nothing
    // is lost, which is what makes a delay acceptable at all.
    const rows = await env.DB.prepare(`SELECT COUNT(*) AS n FROM watchtower_state WHERE status = 'unhealthy'`).first<{ n: number }>();
    expect(rows!.n).toBe(100);
  }, 60_000);
});

describe("15b — alert_budget_exceeded IS DELIVERED on a saturated day (NEW-1)", () => {
  // THE FIXTURE IS A PURE PER-ENTITY STORM, and that is the point. In this shape
  // the 15-of-20 sub-cap binds FIRST and pins the TOTAL at 15/20 forever, so:
  //   - a total-only reading of `saturated` NEVER fires (gate round 3: 0 sent
  //     over 7 days while 85 of 100 instances are being suppressed);
  //   - budgeting the check itself never fires either, because it goes unhealthy
  //     exactly when there is no slot left (gate round 2: 0 sent / 2015 withheld).
  // A MIXED-family fixture certifies the defect instead of catching it.
  it("reds at 0 on the TOTAL-ONLY reading — the defect this fixture discriminates", async () => {
    const mailer = new SandboxOpsMailer();
    for (let tick = 0; tick < 40; tick++) {
      await reconcileAlerts(env, mailer, wedgedTenants(100, tick), T0 + tick * SWEEP);
      await reportAlertBudgetHealth(env, mailer, T0 + tick * SWEEP);
    }

    const budget = await budgetNow(T0 + 40 * SWEEP);
    // The shape the two defects depend on: the sub-cap binds, the total does not.
    expect(budget.perEntity).toBe(MAX_PER_ENTITY_ANNOUNCEMENTS_PER_DAY);
    expect(budget.total).toBeLessThan(MAX_ANNOUNCEMENT_EMAILS_PER_DAY);

    // RED ARM (v3): `saturated` = the total counter ALONE.
    const totalOnly = budget.total >= MAX_ANNOUNCEMENT_EMAILS_PER_DAY;
    expect(totalOnly).toBe(false);
    // GREEN: EITHER counter at its cap.
    expect(isSaturated(budget)).toBe(true);

    // ⚠️ THE v2 DEFECT (the check budgeted like any other announcement) IS NOT
    // DISCRIMINATED HERE, and this test no longer pretends to. It used to carry
    // a hand-built `admits({total: 20, perEntity: 0}, false)` assertion as a
    // "red arm" — a tautology about `admits`, four lines after this same test
    // asserts the total is BELOW 20, so it observed nothing about the fixture.
    // Executed by the build gate: with `alert_budget_exceeded` flipped to
    // `budget: "counted"`, this whole test stays GREEN.
    //
    // The reason is the shipped 15/5 sub-cap: it pins the total at 15/20 in a
    // pure per-entity storm, which RESCUES a budgeted global check through the
    // 5 reserved slots. The fixture that does discriminate the exemption is the
    // TOTAL-saturating one below ("is EXEMPT where the exemption is
    // load-bearing"), and it reds at 0 under that mutation.

    // ...and on the real path it ARRIVES.
    const delivered = mailer.sent.filter((m) => m.subject.includes("Founder alert budget") && m.subject.includes("UNHEALTHY"));
    expect(delivered.length).toBeGreaterThanOrEqual(1);
    expect(delivered[0]!.text).toContain("WITHHOLDING announcements");
  }, 120_000);

  it("delivers EXACTLY 8 over 7 days of that storm — one confirm plus the daily ladder", async () => {
    // §6.15b's literal number. It is not a magic constant: `alert_budget_exceeded`
    // takes the DEBOUNCED policy, so it confirms on its SECOND observation
    // (t=5min), re-alerts at +6h, then once per 24h — which over a 168h window
    // is 5min, +6h, +30h, +54h, +78h, +102h, +126h, +150h. Eight. The ninth
    // would land at +174h, outside the window.
    const mailer = new SandboxOpsMailer();
    const TICKS = 7 * 24 * 12; // 7 days at the live 5-minute cadence
    const STORM_EVERY = 24; // top the ring up every 2h as entries age out

    for (let tick = 0; tick < TICKS; tick++) {
      const now = T0 + tick * SWEEP;
      // The storm keeps asking. Admission self-regulates: it only takes a slot
      // when one has aged out, so the per-entity counter sits at its sub-cap
      // continuously — which is the steady state §5.5 describes, one email per
      // instance per day.
      if (tick % STORM_EVERY === 0) await reconcileAlerts(env, mailer, wedgedTenants(100, tick), now);
      await reportAlertBudgetHealth(env, mailer, now);
    }

    const delivered = mailer.sent.filter((m) => m.subject === "[coldrig] Founder alert budget: UNHEALTHY");
    expect(delivered).toHaveLength(8);

    // ...and it was never RECOVERED mid-storm, which would mean the channel had
    // stopped being saturated while 85 of 100 instances were still suppressed.
    expect(mailer.sent.filter((m) => m.subject.includes("Founder alert budget") && m.subject.includes("RECOVERED"))).toEqual([]);
  }, 300_000);

  // THE EXEMPTION'S OWN FIXTURE, and it is NOT the pure per-entity storm.
  //
  // A CORRECTION TO THE DESIGN'S ROUND-4 TABLE, found by executing it. That
  // table reports v2 (the check budgeted) and v3 (`saturated` = total alone)
  // as BOTH delivering 0 on the pure per-entity fixture. Only v3 does. v2's
  // machine had no 15/5 sub-cap — the storm took all 20 total slots and the
  // budgeted check got nothing — but on the machine we actually shipped, the
  // sub-cap holds the per-entity side at 15 and RESCUES a budgeted global
  // check through the 5 reserved slots. Executed: flipping
  // `alert_budget_exceeded` to `budget: "counted"` leaves the 7-day arm above
  // GREEN at 8.
  //
  // So the exemption is still load-bearing, just not in that shape: it earns
  // its keep when the TOTAL saturates, which needs global families alerting
  // alongside the storm. That is this test. Each defect gets the fixture that
  // discriminates it — a pure per-entity fixture certifies this one exactly the
  // way a mixed fixture would have certified v3.
  it("is EXEMPT where the exemption is load-bearing — a TOTAL-saturating storm", async () => {
    const mailer = new SandboxOpsMailer();
    // Five global families alerting alongside the 100-instance storm: 15
    // per-entity + 5 global = the total cap, with nothing left for anyone.
    const globals: CheckResult[] = [
      { name: "engine", healthy: false, materiality: "down", detail: "engine /health -> HTTP 503" },
      { name: "do_storage", healthy: false, materiality: "down", detail: "DO probe failed" },
      { name: "vendor_wallet", healthy: false, materiality: "unreachable", detail: "wallet unreachable" },
      { name: "warmup_duplicates", healthy: false, materiality: "dup_b2", detail: "duplicate subscriptions" },
      { name: "failure_signals", healthy: false, materiality: "failed_severe", detail: "120 terminal-failed send(s)" },
    ];
    for (let tick = 0; tick < 12; tick++) {
      await reconcileAlerts(env, mailer, [...wedgedTenants(100, tick), ...globals], T0 + tick * SWEEP);
      await reportAlertBudgetHealth(env, mailer, T0 + tick * SWEEP);
    }

    const budget = await budgetNow(T0 + 12 * SWEEP);
    // BOTH counters at their caps — there is no slot left for anybody.
    expect(budget.total).toBe(MAX_ANNOUNCEMENT_EMAILS_PER_DAY);
    expect(budget.perEntity).toBe(MAX_PER_ENTITY_ANNOUNCEMENTS_PER_DAY);
    expect(admits(budget, false)).toBe(false);

    // ...and the report that the channel is withholding STILL ARRIVES, because
    // it is exempt. Budgeted, it would be the one announcement with no slot
    // left, on every tick, forever — an alarm that depends on the thing it
    // monitors.
    expect(mailer.sent.filter((m) => m.subject === "[coldrig] Founder alert budget: UNHEALTHY").length).toBeGreaterThanOrEqual(1);
  }, 120_000);

  it("stays quiet, and reports the headroom, while the channel has room", async () => {
    const mailer = new SandboxOpsMailer();
    for (let tick = 0; tick < 4; tick++) {
      await reconcileAlerts(env, mailer, wedgedTenants(2, tick), T0 + tick * SWEEP);
      await reportAlertBudgetHealth(env, mailer, T0 + tick * SWEEP);
    }
    expect(mailer.sent.filter((m) => m.subject.includes("Founder alert budget"))).toEqual([]);
    expect(isSaturated(await budgetNow(T0 + 4 * SWEEP))).toBe(false);
  });
});

describe("15c — RECOVERY STORM: no budget decision may block an episode CLOSE (NEW-2)", () => {
  it("100 simultaneous recoveries all close in the tick they recover", async () => {
    const mailer = new SandboxOpsMailer();
    // Announce a storm first, so there are real episodes to close and the budget
    // is genuinely saturated when the recoveries arrive.
    for (let tick = 0; tick < 4; tick++) {
      await reconcileAlerts(env, mailer, wedgedTenants(100, tick), T0 + tick * SWEEP);
    }
    const announced = announcements(mailer).length;
    expect(isSaturated(await budgetNow(T0 + 4 * SWEEP))).toBe(true);

    // Three clean observations to confirm, then every episode closes AT ONCE.
    const clears: CheckResult[] = Array.from({ length: 100 }, (_v, i) => ({
      name: `tenant_do_wedged:ten_${i}`,
      healthy: true as const,
      basis: "reobserved" as const,
      detail: "answering again",
    }));
    for (let i = 4; i < 7; i++) await reconcileAlerts(env, mailer, clears, T0 + i * SWEEP);

    // ZERO checks left reading unhealthy. Under the budgeted-recovery reading
    // this was up to 100 for 4.0 DAYS, on the exact surface the 2-hourly watch
    // cron polls as `?unhealthy=1`.
    const stuck = await env.DB.prepare(`SELECT COUNT(*) AS n FROM watchtower_state WHERE status = 'unhealthy'`).first<{ n: number }>();
    expect(stuck!.n).toBe(0);

    // And the exemption is SELF-BOUNDING: a recovery is owed only for an episode
    // that was actually ANNOUNCED, so recoveries can never exceed announcements.
    expect(recoveries(mailer).length).toBeLessThanOrEqual(announced);
    expect(recoveries(mailer).length).toBeGreaterThan(0);
  }, 120_000);
});

describe("15d — the window is ROLLING, not tumbling (NEW-3)", () => {
  // `{windowStartMs, count}` expresses a window that RESETS on a boundary, which
  // permits 20 sends at T+23.9h and 20 more at T+24.1h — 40 emails in a 0.20h
  // span while every stated gate still passes. A ring of send timestamps is
  // exact for arbitrary spans.
  const ringWith = (stamps: number[]): AnnouncementRing => ({ sends: stamps.map((ts, i) => ({ id: `s${i}`, ts, perEntity: false })) });

  it("20 sends at T+23.9h leave NO room at T+24.1h", () => {
    const at239 = T0 + 23.9 * 3_600_000;
    const ring = ringWith(Array.from({ length: MAX_ANNOUNCEMENT_EMAILS_PER_DAY }, () => at239));
    const at241 = T0 + 24.1 * 3_600_000;

    // The 0.20h span still holds all 20, so nothing may be admitted.
    const counts = countRing(pruneRing(ring, at241));
    expect(counts.total).toBe(MAX_ANNOUNCEMENT_EMAILS_PER_DAY);
    expect(admits(counts, false)).toBe(false);

    // RED ARM: a tumbling window keyed on a start boundary reads zero here,
    // which is how 40 emails land in 12 minutes.
    const tumbling = { windowStartMs: T0, count: MAX_ANNOUNCEMENT_EMAILS_PER_DAY };
    const tumblingCount = at241 - tumbling.windowStartMs >= DAY ? 0 : tumbling.count;
    expect(tumblingCount).toBe(0);
  });

  it("entries age out individually, exactly 24h after each one", () => {
    const ring = ringWith([T0, T0 + 6 * 3_600_000, T0 + 12 * 3_600_000]);
    expect(countRing(pruneRing(ring, T0 + DAY - 1)).total).toBe(3);
    expect(countRing(pruneRing(ring, T0 + DAY)).total).toBe(2);
    expect(countRing(pruneRing(ring, T0 + DAY + 6 * 3_600_000)).total).toBe(1);
    expect(countRing(pruneRing(ring, T0 + DAY + 12 * 3_600_000)).total).toBe(0);
  });
});

describe("15e — the RESERVED SLICE keeps the monitor's own checks audible (NEW-5)", () => {
  it("a 100-instance per-entity storm cannot starve cron_legs / sweep_coverage / alert_delivery", async () => {
    const mailer = new SandboxOpsMailer();
    // Saturate the per-entity side first — the storm arrives BEFORE the sweep's
    // own checks, which is the cross-batch ordering gap this sub-cap closes
    // without needing ordering to cross batches at all.
    for (let tick = 0; tick < 8; tick++) {
      await reconcileAlerts(env, mailer, wedgedTenants(100, tick), T0 + tick * SWEEP);
    }
    const budget = await budgetNow(T0 + 8 * SWEEP);
    expect(budget.perEntity).toBe(MAX_PER_ENTITY_ANNOUNCEMENTS_PER_DAY);

    const before = mailer.sent.length;
    const monitor: CheckResult[] = [
      { name: "cron_legs", healthy: false, materiality: "threw", detail: "a sweep leg is throwing every tick" },
      { name: "sweep_coverage", healthy: false, materiality: "rotation_behind", detail: "the rotation needs 40 ticks" },
      // KEY FROM THE REAL CLASSIFIER, not hand-written (build gate B1b). This
      // line used to spell `"dark_channel"` by hand — a key the producer could
      // not emit at all while `alertDeliveryKey` was being fed rendered prose.
      // A fixture that asserts on an unreachable key certifies the defect.
      { name: "alert_delivery", healthy: false, materiality: alertDeliveryKey(["dark_channel"]), detail: "alerts owed and not delivered" },
    ];
    // These are IMMEDIATE, so one observation confirms.
    await reconcileAlerts(env, mailer, monitor, T0 + 9 * SWEEP);

    expect(mailer.sent.length).toBeGreaterThan(before);
    const landed = mailer.sent.slice(before).map((m) => m.subject);
    expect(landed.length).toBeGreaterThanOrEqual(1);

    // RED ARM: without the sub-cap the per-entity storm would have taken all 20
    // total slots, and `admits` for a global family would be false.
    const noSubCap: AnnouncementCounts = { total: MAX_ANNOUNCEMENT_EMAILS_PER_DAY, perEntity: MAX_ANNOUNCEMENT_EMAILS_PER_DAY };
    expect(admits(noSubCap, false)).toBe(false);
    // With it, at least 5 slots are always reachable by a global family.
    expect(admits({ total: MAX_PER_ENTITY_ANNOUNCEMENTS_PER_DAY, perEntity: MAX_PER_ENTITY_ANNOUNCEMENTS_PER_DAY }, false)).toBe(true);
  }, 120_000);
});

describe("N2 — the fail-open is BOUNDED: a burst cap when the budget cannot be consulted", () => {
  // THE COST THE FIRST BUILD DID NOT PRICE (build gate N2). `claimAnnouncementSlots`
  // catches any error from `admitAnnouncements` and used to admit EVERY candidate,
  // measured at 200 announcements in 24h at 100 instances against a ratified <=20.
  // The direction is right for a monitor — under-alerting is the failure this
  // subsystem exists to prevent — but the failure is CORRELATED with the storm the
  // budget bounds, because the DO holding the ring is the one that is down.
  //
  // What is bounded is the per-tick BURST, at the reserved global slice: the one
  // allowance the budget's own rules make safe to hand out blind. What is NOT
  // bounded is the 24h total — see `claimAnnouncementSlots`' docstring for why
  // that is not honestly implementable while the counter's store is the thing
  // that is down, and §9.13 for the disclosure that owes.
  const FAIL_OPEN_PER_TICK = MAX_ANNOUNCEMENT_EMAILS_PER_DAY - MAX_PER_ENTITY_ANNOUNCEMENTS_PER_DAY;

  /** An env whose WatchtowerDO refuses every budget call. */
  function envWithDeadBudget() {
    return {
      ...env,
      WATCHTOWER: {
        idFromName: (name: string) => env.WATCHTOWER.idFromName(name),
        get: () => ({
          admitAnnouncements: () => {
            throw new Error("WatchtowerDO unreachable");
          },
          releaseAnnouncements: () => {
            throw new Error("WatchtowerDO unreachable");
          },
          readAnnouncementBudget: () => {
            throw new Error("WatchtowerDO unreachable");
          },
        }),
      },
    } as unknown as typeof env;
  }

  it("a correlated 100-instance onset cannot put 100 emails in one tick", async () => {
    const dead = envWithDeadBudget();
    const mailer = new SandboxOpsMailer();
    // Two ticks: the first confirms nothing (DEBOUNCED), the second announces
    // all 100 at once — the acute burst.
    await reconcileAlerts(dead, mailer, wedgedTenants(100, 0), T0);
    const before = mailer.sent.length;
    await reconcileAlerts(dead, mailer, wedgedTenants(100, 1), T0 + SWEEP);
    const burst = mailer.sent.length - before;

    // RED ON THE UNCONDITIONAL FAIL-OPEN: that admitted all 100.
    expect(burst).toBe(FAIL_OPEN_PER_TICK);
    expect(burst).toBeLessThan(100);
  }, 120_000);

  it("spends the allowance in the BUDGET's own priority order, not array order", async () => {
    // A new incident outranks a repeat, round-robin across families — so the
    // emails that do go out are the ones the budget would itself have chosen.
    const dead = envWithDeadBudget();
    const mailer = new SandboxOpsMailer();
    const globals: CheckResult[] = [
      { name: "engine", healthy: false, materiality: "down", detail: "engine down" },
      { name: "do_storage", healthy: false, materiality: "down", detail: "DO probe failed" },
    ];
    // The storm is FIRST in the array — under array order it would take every slot.
    for (let tick = 0; tick < 2; tick++) {
      await reconcileAlerts(dead, mailer, [...wedgedTenants(100, tick), ...globals], T0 + tick * SWEEP);
    }
    const subjects = mailer.sent.map((m) => m.subject);
    // Round-robin across families means the two global families are reached
    // despite 100 per-entity instances queued ahead of them.
    expect(subjects).toContain("[coldrig] Engine /health: UNHEALTHY");
    expect(subjects).toContain("[coldrig] Durable Object storage: UNHEALTHY");
    expect(mailer.sent).toHaveLength(FAIL_OPEN_PER_TICK);
  }, 120_000);

  it("the withheld ones report WHY, and their episodes still advance", async () => {
    const dead = envWithDeadBudget();
    const mailer = new SandboxOpsMailer();
    await reconcileAlerts(dead, mailer, wedgedTenants(100, 0), T0);
    const outcomes = await reconcileAlerts(dead, mailer, wedgedTenants(100, 1), T0 + SWEEP);
    expect(outcomes.filter((o) => o.why === "suppressed_daily_budget").length).toBe(100 - FAIL_OPEN_PER_TICK);
    const rows = await env.DB.prepare(`SELECT COUNT(*) AS n FROM watchtower_state WHERE status = 'unhealthy'`).first<{ n: number }>();
    expect(rows!.n).toBe(100);
  }, 120_000);
});

describe("the invariant that makes under-reading safe — DENIAL IMPLIES SATURATION", () => {
  // Exempt sends do not consume ring slots and are not recorded, so the total
  // counter UNDER-READS real inbox volume. That cannot hide suppression, because
  // whenever a send is denied `saturated` is true — the counters that GATE are
  // the counters OBSERVED. Checked exhaustively over the whole counter space
  // rather than sampled.
  // N7 — verifying a design-gate evidence claim rather than trusting it.
  // Round 4 item 3 reports "0 ticks where a send was denied while `saturated`
  // was false under v4, against 672 such ticks under BOTH defective readings".
  // The two defective readings round 3 names are TOTAL-ONLY and ANY-WITHHOLDING.
  // Under any-withholding the count cannot be 672: `saturated` is then broader
  // than denial, so denial implies saturation TRIVIALLY and the violating count
  // is 0 by construction. The 672 figure can only belong to the total-only
  // reading — the same conflation of two machines that made the round-4 table
  // wrong. Nothing rests on it: the invariant itself is exhaustively pinned
  // below, and it is exact.
  it("N7 — under an ANY-WITHHOLDING reading, denial implies saturation trivially (0 violations, never 672)", () => {
    let violations = 0;
    let denials = 0;
    for (let total = 0; total <= MAX_ANNOUNCEMENT_EMAILS_PER_DAY + 2; total++) {
      for (let perEntity = 0; perEntity <= Math.min(total, MAX_PER_ENTITY_ANNOUNCEMENTS_PER_DAY + 2); perEntity++) {
        for (const scope of [true, false]) {
          const counts = { total, perEntity };
          const denied = !admits(counts, scope);
          if (!denied) continue;
          denials++;
          // The any-withholding reading: "saturated" IS "something was withheld".
          const anyWithholdingSaturated = denied;
          if (!anyWithholdingSaturated) violations++;
          // ...and the total-only reading, which is where violations DO occur.
          if (!(counts.total >= MAX_ANNOUNCEMENT_EMAILS_PER_DAY)) {
            expect(counts.perEntity).toBeGreaterThanOrEqual(MAX_PER_ENTITY_ANNOUNCEMENTS_PER_DAY);
          }
        }
      }
    }
    expect(denials).toBeGreaterThan(0);
    expect(violations).toBe(0);
  });

  it("holds for every reachable (total, perEntity, scope) triple", () => {
    for (let total = 0; total <= MAX_ANNOUNCEMENT_EMAILS_PER_DAY + 2; total++) {
      for (let perEntity = 0; perEntity <= Math.min(total, MAX_PER_ENTITY_ANNOUNCEMENTS_PER_DAY + 2); perEntity++) {
        for (const scope of [true, false]) {
          const counts = { total, perEntity };
          if (!admits(counts, scope)) {
            expect({ total, perEntity, scope, saturated: isSaturated(counts) }).toMatchObject({ saturated: true });
          }
        }
      }
    }
  });
});
