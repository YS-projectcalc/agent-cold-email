import { describe, expect, it } from "vitest";
import { billableMailboxes, type NextStep } from "@coldstart/shared";
import { deriveNextSteps } from "../src/engine/next-steps.js";
import { planFor, readProvisioningSnapshot } from "../src/engine/provisioning-plan.js";
import { withTenantContext } from "./helpers.js";
import { type Seed, seedTenant } from "./next-steps-fleet.js";

// THE CLASS GUARD for `NextStep.effect` (NEW-1, build gate r4
// docs/adversarial/customer-continuity-build-gate-r4-2026-08-19.md).
//
// THE DEFECT, and why a per-reason test could not have caught it.
// `packages/shared/src/next-steps.ts:154` defines `effect: null` as "the step
// changes no billable count" — an AFFIRMATIVE claim, not "unknown" (the same
// file refuses a bare null elsewhere for exactly that reason). THREE reasons
// emitted a runnable `setup_infrastructure` call whose executed plan buys real
// mailboxes and shipped `effect: null` beside it: at/above the five-seat floor
// each mailbox moves the invoice $10/mo, and the consumer is an unattended agent
// executing the emitted params verbatim. Every per-reason test was green,
// because each one asserted the reason it was about.
//
// The gate named two of the three. The third, `domain_dns_incomplete`, PREDATES
// the diff the gate was scoped to and was found by this guard on its first run —
// and it was the only one of the three reachable in production, which is the
// argument for writing the guard this way rather than per-reason.
//
// SO THE GUARD IS OVER THE DERIVATION, NOT OVER A REASON. It walks every step
// the derivation produces across the fleet fixtures the suite already exercises,
// finds the ones carrying a runnable provisioning call, RUNS the real `planFor`
// on the step's OWN emitted params, and holds the whole family to one rule:
//
//     newMailboxes > 0  =>  effect is non-null
//                           and effect.provisionedAfter === billable + newMailboxes
//
// A reason added later that emits a bill-raising call and forgets its `effect`
// reddens here without anyone remembering to write a test for it — which is the
// property the r4 builder named as "what would have caught this".
//
// EXECUTED, NEVER SHAPE-CHECKED (this repo's own
// `recommendation-must-be-executed-not-shape-checked`): the distribution is fed
// to the same planner the saga runs, so a step whose params and prose agree but
// whose PLAN disagrees is still caught.

/**
 * The three reasons that state what the bill does through `billMoveSentence`,
 * and are therefore held to prose that agrees with their own `effect`.
 *
 * `seat_headroom_free` and `paid_seats_unprovisioned` are absent on purpose:
 * they compose theirs from `billClaimSentence`, which anchors on the five-seat
 * minimum instead of on the billed quantity — correct for a reason whose own
 * predicate is `billable < 5`, and not this guard's to re-litigate.
 */
const BILL_MOVE_REASONS = ["ordinal_slot_shortfall", "ordinal_incomplete", "domain_dns_incomplete"];

/** The fleets the per-reason suites already run on — the guard adds no private state of its own. */
const FLEETS: { name: string; seed: Seed }[] = [
  {
    // The wave's own fixture: ordinal 0 asked 3 and holds 2, ordinal 1 finished.
    name: "slot shortfall (the wave's fixture)",
    seed: {
      ordinals: [
        { domain: "guard-short0.com", liveMailboxes: 2, requestedSlots: 3 },
        { domain: "guard-short1.com", liveMailboxes: 2 },
      ],
      billedQuantity: 5,
    },
  },
  {
    // R3-BLOCKING-2 case A — the shape whose old remedy bought nothing.
    name: "slot shortfall, one slot missing on the second ordinal",
    seed: {
      ordinals: [
        { domain: "guard-noop0.com", liveMailboxes: 3, requestedSlots: 3 },
        { domain: "guard-noop1.com", liveMailboxes: 2, requestedSlots: 3 },
      ],
      billedQuantity: 5,
    },
  },
  {
    // R3-BLOCKING-2 case B — a single ordinal asking 5 and holding 4.
    name: "slot shortfall on a single deep ordinal",
    seed: { ordinals: [{ domain: "guard-esc0.com", liveMailboxes: 4, requestedSlots: 5 }], billedQuantity: 5 },
  },
  {
    // A three-slot shortfall: the $30/mo variant the gate priced.
    name: "slot shortfall of three mailboxes",
    seed: {
      ordinals: [
        { domain: "guard-deep0.com", liveMailboxes: 3, requestedSlots: 3 },
        { domain: "guard-deep1.com", liveMailboxes: 0, requestedSlots: 3, mailboxCreatedAt: 1000 },
      ],
      billedQuantity: 6,
    },
  },
  {
    // The sibling: an ordinal requested and never completed, past its grace.
    name: "ordinal incomplete (dangling second ordinal)",
    seed: {
      ordinals: [
        { domain: "guard-sib0.com", liveMailboxes: 2 },
        { domain: "guard-sib1.com", liveMailboxes: 0, status: "dangling", noDomainRow: true },
      ],
      billedQuantity: 5,
    },
  },
  {
    // Both setup-family reasons at once, on a fleet whose remedy buys a domain.
    name: "ordinal incomplete beside a short live ordinal",
    seed: {
      ordinals: [
        { domain: "guard-mix0.com", liveMailboxes: 2, requestedSlots: 3 },
        { domain: "guard-mix1.com", liveMailboxes: 0, status: "intent", noDomainRow: true },
      ],
      billedQuantity: 6,
    },
  },
  {
    name: "paid seats unprovisioned",
    seed: { ordinals: [{ domain: "guard-double0.com", liveMailboxes: 0, requestedSlots: 3 }], billedQuantity: 5 },
  },
  {
    name: "a tenant that has never provisioned anything",
    seed: { ordinals: [], billedQuantity: 5 },
  },
  {
    name: "seat headroom below the floor",
    seed: { ordinals: [{ domain: "guard-head0.com", liveMailboxes: 2, requestedSlots: 2 }], billedQuantity: 5 },
  },
  {
    name: "a domain whose mail DNS has not come up",
    seed: {
      ordinals: [{ domain: "guard-dns0.com", liveMailboxes: 0, requestedSlots: 3, dnsReady: false }],
      billedQuantity: 5,
    },
  },
  {
    name: "a mid-registration domain on an account already at the floor",
    seed: {
      ordinals: [
        { domain: "guard-dns3.com", liveMailboxes: 5, requestedSlots: 5 },
        { domain: "guard-dns4.com", liveMailboxes: 0, requestedSlots: 2, dnsReady: false },
      ],
      billedQuantity: 5,
    },
  },
  {
    // The same state with a FINISHED first ordinal, so `paid_seats_unprovisioned`
    // does not fire beside it: here the DNS step is the only one speaking about
    // the call, which is what makes it reachable on its own rather than only
    // alongside a step that happens to price the same params.
    name: "a second domain mid-registration behind a finished one",
    seed: {
      ordinals: [
        { domain: "guard-dns1.com", liveMailboxes: 3, requestedSlots: 3 },
        { domain: "guard-dns2.com", liveMailboxes: 0, requestedSlots: 2, dnsReady: false },
      ],
      billedQuantity: 5,
    },
  },
  {
    // The WITHHELD branch: a released slot beside a never-created one. Nothing
    // is bought, so `effect: null` is TRUE here and the guard must not object.
    name: "shortfall whose remedy is withheld",
    seed: {
      ordinals: [{ domain: "guard-mixed0.com", liveMailboxes: 2, requestedSlots: 4, releasedSlots: [2] }],
      billedQuantity: 5,
    },
  },
  {
    name: "a legacy ordinal with no recorded ask",
    seed: { ordinals: [{ domain: "guard-legacy0.com", liveMailboxes: 2, requestedSlots: null }], billedQuantity: 5 },
  },
  {
    name: "a burned domain whose mailboxes were released",
    seed: {
      ordinals: [
        { domain: "guard-burn0.com", liveMailboxes: 0, requestedSlots: 3, domainStatus: "burning", releasedSlots: [0, 1, 2] },
        { domain: "guard-burn1.com", liveMailboxes: 2 },
      ],
      billedQuantity: 5,
    },
  },
  {
    name: "a partially persona-drifted ordinal",
    seed: {
      ordinals: [
        {
          domain: "guard-drift0.com",
          liveMailboxes: 2,
          requestedSlots: 5,
          persona: "alpha",
          driftedSlots: [
            { persona: "beta", slot: 2 },
            { persona: "beta", slot: 3 },
          ],
        },
      ],
      billedQuantity: 5,
    },
  },
  {
    name: "a finished fleet",
    seed: {
      ordinals: [
        { domain: "guard-fin0.com", liveMailboxes: 3, requestedSlots: 3 },
        { domain: "guard-fin1.com", liveMailboxes: 2, requestedSlots: 2 },
      ],
      billedQuantity: 5,
    },
  },
];

interface Audited {
  fleet: string;
  step: NextStep;
  newDomains: number;
  newMailboxes: number;
  /** True when NO ordinal the distribution reaches is live, which makes the plan persona-independent. */
  personaIndependent: boolean;
  /** Does the step emit a persona, or is it the caller's to supply? */
  emitsPersona: boolean;
  billable: number;
  /** `mailbox_qty_synced` — the quantity the subscription actually charges on. */
  billed: number;
}

/**
 * Every runnable `setup_infrastructure` step this fleet derives, with the REAL
 * planner's answer for its OWN emitted params attached.
 *
 * The persona is read off the step, not off the tenant: a step is a call an
 * agent sends verbatim, so what it emits IS what gets planned. When the step
 * declares `persona` as the caller's to supply, the platform does not hold one —
 * `planFor`'s `slugify` floor (`|| "hello"`) makes `""` plannable, and
 * `plan.satisfied` reports whether the answer actually depended on it.
 */
async function auditFleet(name: string, seed: Seed): Promise<Audited[]> {
  const tenantId = await seedTenant(seed);
  const steps = (await withTenantContext(tenantId, (ctx) => deriveNextSteps(ctx))).steps;
  return withTenantContext(tenantId, (ctx) => {
    const snapshot = readProvisioningSnapshot(ctx);
    const billable = ctx.sql
      .exec<{ n: number }>(`SELECT COUNT(*) as n FROM mailboxes WHERE tenant_id = ? AND released_at IS NULL`, ctx.tenantId)
      .one().n;
    const billed = ctx.sql
      .exec<{ q: number }>(`SELECT mailbox_qty_synced as q FROM tenant_profile WHERE id = ?`, ctx.tenantId)
      .one().q;
    const audited: Audited[] = [];
    for (const step of steps) {
      if (step.action.via !== "mcp_tool" || step.action.tool !== "setup_infrastructure") continue;
      const { persona, distribution } = step.action.params as { persona?: unknown; distribution?: unknown };
      if (persona === undefined) {
        expect(
          step.action.paramsToSupply,
          `${name}/${step.reason} omits \`persona\` from params without declaring it as the caller's to supply`,
        ).toContain("persona");
      }
      expect(Array.isArray(distribution), `${name}/${step.reason} emitted no distribution`).toBe(true);
      const plan = planFor(snapshot, {
        persona: typeof persona === "string" ? persona : "",
        distribution: distribution as number[],
      });
      audited.push({
        fleet: name,
        step,
        newDomains: plan.newDomains,
        newMailboxes: plan.newMailboxes,
        personaIndependent: plan.satisfied.size === 0,
        emitsPersona: typeof persona === "string",
        billable,
        billed,
      });
    }
    return audited;
  });
}

describe("NEW-1 class guard — a runnable provisioning call that buys mailboxes carries its price", () => {
  it("every derived setup_infrastructure step prices what its own emitted params would buy", async () => {
    const audited: Audited[] = [];
    for (const fleet of FLEETS) audited.push(...(await auditFleet(fleet.name, fleet.seed)));

    // The guard would be vacuous if no fixture reached the state it is about.
    const buying = audited.filter((a) => a.newMailboxes > 0);
    expect(buying.length, "no fixture derived a bill-raising provisioning call — the guard proves nothing").toBeGreaterThan(0);
    expect(new Set(buying.map((a) => a.step.reason)).size, "the guard must span more than one reason").toBeGreaterThan(1);

    // EVERY bill-raising step is in exactly one of two states, and the
    // violations of both are collected into one list so a failure names every
    // offender rather than the first.
    const violations: string[] = [];
    for (const a of buying) {
      const at = `${a.fleet}/${a.step.reason}`;
      // (1) THE PLATFORM CANNOT PLAN THIS CALL. `persona` is the caller's to
      // supply and the answer depends on it, so `planEmittedCall` abstains. The
      // null is honest here — but ONLY as a stated abstention: a bare null is
      // indistinguishable from "this step changes no billable count", which is
      // the very confusion `PERSONA_UNKNOWN_SENTENCE` exists to end. So the
      // abstention has to be visible in the prose, which is what stops this
      // branch from becoming the hiding place for an unpriced call.
      if (!a.emitsPersona && !a.personaIndependent) {
        if (a.step.effect !== null) violations.push(`${at}: priced a call whose persona the platform does not hold`);
        if (!a.step.why.includes("will not project a mailbox count or a price")) {
          violations.push(`${at}: withheld the price without saying so`);
        }
        continue;
      }
      // (2) THE PLAN IS REAL. `effect: null` is the contract's affirmative claim
      // that the step changes no billable count, and a call the planner says
      // creates N mailboxes moves the meter (`COUNT(*) FROM mailboxes WHERE
      // released_at IS NULL`) by exactly N. The price must also be the RIGHT
      // one, not merely present: `provisionedAfter` is the live count AFTER the
      // call — today's meter plus what the plan adds.
      if (a.step.effect === null) {
        violations.push(`${at}: plan buys ${a.newMailboxes} mailboxes, effect: null`);
        continue;
      }
      if (a.step.effect.provisionedAfter !== a.billable + a.newMailboxes) {
        violations.push(
          `${at}: effect projects ${a.step.effect.provisionedAfter}, plan says ${a.billable} + ${a.newMailboxes}`,
        );
      }
      // (3) AND THE PROSE SAYS WHAT THE NUMBER SAYS. The r1 gate's ruling was
      // that a confident wrong number needs BOTH halves checked, and a machine
      // field the customer sentence contradicts is the same defect wearing the
      // other hat. The bill moves iff the FLOORED projection exceeds the floored
      // quantity the subscription charges on — both sides of that comparison
      // fold the same discount, so the counts decide the cents.
      if (BILL_MOVE_REASONS.includes(a.step.reason)) {
        const raises = billableMailboxes(a.step.effect.provisionedAfter) > billableMailboxes(a.billed);
        if (raises !== a.step.why.includes("DOES change your bill")) {
          violations.push(
            `${at}: effect ${raises ? "raises" : "does not raise"} the bill (${a.step.effect.provisionedAfter} vs billed ${a.billed}) and the prose says otherwise`,
          );
        }
      }
    }

    expect(violations, "a step whose executed plan buys mailboxes must carry that call's price").toEqual([]);
  });

  // The gate's own worked example, pinned as an example rather than an
  // invariant: billed 5 with 5 live and one slot never created, so the remedy
  // takes the account to 6 and the invoice from $99 to $109. This is the exact
  // state that shipped `effect: null` under the sentence "creates exactly the 1
  // missing one and buys nothing twice".
  it("the +$10/mo case states the price in the field AND in the sentence", async () => {
    const audited = await auditFleet("bill mover", {
      ordinals: [
        { domain: "guard-move0.com", liveMailboxes: 3, requestedSlots: 3 },
        { domain: "guard-move1.com", liveMailboxes: 2, requestedSlots: 3 },
      ],
      billedQuantity: 5,
    });
    const step = audited.find((a) => a.step.reason === "ordinal_slot_shortfall")?.step;
    expect(step?.effect).toEqual({
      provisionedAfter: 6,
      projectedMonthlyCents: 10900,
      formula: "$49 platform + $10/mailbox, 5 minimum",
    });
    expect(step?.why).toContain("creates exactly the 1 missing one");
    expect(step?.why, "the sentence beside the count must not read as 'costs nothing'").toContain("DOES change your bill");
  });

  // The other side of the same fix: the branch where nothing is bought is the
  // ONE place `effect: null` is a true statement, and it must stay null rather
  // than acquire a price along with its siblings.
  it("the withheld remedy stays unpriced and makes no bill claim", async () => {
    const audited = await auditFleet("withheld", {
      ordinals: [{ domain: "guard-withheld0.com", liveMailboxes: 2, requestedSlots: 4, releasedSlots: [2] }],
      billedQuantity: 5,
    });
    expect(audited, "a withheld remedy carries no runnable call for the guard to audit").toEqual([]);
    const tenantId = await seedTenant({
      ordinals: [{ domain: "guard-withheld1.com", liveMailboxes: 2, requestedSlots: 4, releasedSlots: [2] }],
      billedQuantity: 5,
    });
    const step = (await withTenantContext(tenantId, (ctx) => deriveNextSteps(ctx))).steps.find(
      (s) => s.reason === "ordinal_slot_shortfall",
    );
    expect(step?.action.via).toBe("none");
    expect(step?.effect, "nothing is bought here, so 'changes no billable count' is TRUE").toBeNull();
    expect(step?.why).not.toContain("DOES change your bill");
    expect(step?.why).not.toContain("does not add to it");
  });

  it("a call the planner says buys NOTHING is never priced as if it did", async () => {
    const audited: Audited[] = [];
    for (const fleet of FLEETS) audited.push(...(await auditFleet(fleet.name, fleet.seed)));

    // The mirror direction. A step is free to carry an effect that reports the
    // count UNCHANGED, but never one claiming mailboxes a plan does not buy.
    for (const a of audited.filter((x) => x.newMailboxes === 0)) {
      if (a.step.effect === null) continue;
      expect(
        a.step.effect.provisionedAfter,
        `${a.fleet}/${a.step.reason}: the plan buys nothing, so the projection cannot exceed today's count`,
      ).toBeLessThanOrEqual(a.billable);
    }
  });
});
