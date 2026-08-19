import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { NextStep, NextSteps } from "@coldstart/shared";
import { removeMailboxes } from "../src/engine/billing.js";
import { realNowMs } from "../src/engine/clamped-age.js";
import { deriveNextSteps, owedSignals } from "../src/engine/next-steps.js";
import {
  DEFAULT_CUSTOMER_PROGRESS_OWED_MAX_MS,
  DEFAULT_PROVISIONING_ORPHAN_GRACE_MS,
} from "../src/engine/ops-summary.js";
import { planFor, readProvisioningSnapshot } from "../src/engine/provisioning-plan.js";
import { emitTenantMessage, pruneTenantMessages, READ_RETENTION_MS } from "../src/engine/tenant-messages.js";
import { tenantStub, withTenantContext } from "./helpers.js";
import { type Seed, seedTenant } from "./next-steps-fleet.js";

// THE ROUND-2 BLOCKING (docs/adversarial/customer-continuity-build-gate-r2-
// 2026-08-19.md) — the B2 auto-expiry SILENCES and then DELETES a live
// `retry_setup` action item.
//
// THE STATE IT MISSES. `provisionMailboxesForDomain` runs a domain's mailbox
// slots through `forEachIsolated` and rethrows only after every slot has had
// its chance, so a retryable vendor failure leaves: intent 'committed', the
// `domains` row written, DNS 'ready', and SOME of the slots persisted. Against
// that state none of the four setup-family reasons fired — `ordinal_incomplete`
// needs `live === null`, `domain_dns_incomplete` needs a non-ready DNS,
// `paid_seats_unprovisioned` needs `billable === 0`, `setup_capacity_held`
// needs `capacity_pending` — so `setupFamilyOwed` was false, the `retry_setup`
// row was re-derived as RESOLVED, `expires_at` was banked on the 5-minute ops
// fan-out, and the deliverability sweep's prune then DELETED the only durable
// record of work the customer still has to redo. The same `owedCount === 0`
// disarmed `seat_headroom_free`'s E1 guard, the `customer_progress_*` checks
// and the one-shot nudge.
//
// THE FIX, in three parts, one per describe block below:
//   1. `ordinal_slot_shortfall` — the missing owed reason, derived from the
//      ordinal's own persisted ask (`domain_intents.inboxes_each`) against the
//      deterministic slot addresses `planFor` uses, so the family predicate is
//      true BY COVERAGE rather than by luck.
//   2. A MIN-AGE guard on the durable expiry: a row younger than the
//      provisioning orphan grace cannot be banked, so a `dangling` ordinal
//      inside its own 30-minute grace no longer loses the race to the 5-minute
//      sweep.
//   3. Expired rows get the SAME retention grace read rows already have, so an
//      expiry mistake is recoverable and the audit trail survives it.

/** The gate's live row, verbatim in shape: the `action_required` emit at provisioning.ts:820-831. */
async function emitRetrySetup(tenantId: string, domain: string): Promise<void> {
  await withTenantContext(tenantId, (ctx) =>
    emitTenantMessage(ctx, {
      kind: "retry_setup",
      severity: "action_required",
      body: `Setup for ${domain} has not finished yet — its mailbox purchase is still completing at the vendor.`,
      actionHint: { tool: "setup_infrastructure", idempotencyKey: null },
      dedupKey: `retry:${domain}`,
    }),
  );
}

function derive(tenantId: string): Promise<NextSteps> {
  return withTenantContext(tenantId, (ctx) => deriveNextSteps(ctx));
}

function messageRows(tenantId: string): Promise<{ id: string; kind: string; expires_at: number | null }[]> {
  return withTenantContext(tenantId, (ctx) =>
    ctx.sql
      .exec<{ id: string; kind: string; expires_at: number | null }>(
        `SELECT id, kind, expires_at FROM tenant_messages WHERE tenant_id = ? ORDER BY rowid`,
        ctx.tenantId,
      )
      .toArray(),
  );
}

function shortfallStep(steps: NextStep[]): NextStep | undefined {
  return steps.find((s) => s.reason === "ordinal_slot_shortfall");
}

/**
 * RUNS the emitted recommendation through the REAL planner, on the EXACT params
 * the step carries — never a shape check of the distribution (this repo's own
 * `recommendation-must-be-executed-not-shape-checked`). This is the gate's own
 * probe: `planFor` against `params.persona` + `params.distribution` verbatim.
 */
function executeEmittedPlan(tenantId: string, step: NextStep): Promise<{ newDomains: number; newMailboxes: number }> {
  if (step.action.via !== "mcp_tool") throw new Error(`${step.reason} carries no runnable call (via: ${step.action.via})`);
  const { persona, distribution } = step.action.params as { persona?: unknown; distribution?: unknown };
  if (typeof persona !== "string") throw new Error(`${step.reason} emitted no persona`);
  if (!Array.isArray(distribution)) throw new Error(`${step.reason} emitted no distribution`);
  return withTenantContext(tenantId, (ctx) => {
    const plan = planFor(readProvisioningSnapshot(ctx), { persona, distribution: distribution as number[] });
    return { newDomains: plan.newDomains, newMailboxes: plan.newMailboxes };
  });
}

/** The post-slot-failure state: ordinal 0 asked for 3, holds 2; ordinal 1 finished. Billed 5, DNS ready everywhere. */
const SLOT_SHORTFALL_FLEET: Seed = {
  ordinals: [
    { domain: "theauthorpitchdesk.com", liveMailboxes: 2, requestedSlots: 3 },
    { domain: "goauthorpitchdesk.com", liveMailboxes: 2 },
  ],
  billedQuantity: 5,
};

describe("R2-BLOCKING part 1 — a live ordinal short of its requested slots is OWED", () => {
  it("the post-slot-failure state derives ordinal_slot_shortfall, owed", async () => {
    const tenantId = await seedTenant(SLOT_SHORTFALL_FLEET);
    const derived = await derive(tenantId);
    const step = derived.steps.find((s) => s.reason === "ordinal_slot_shortfall");

    expect(step, "a live, DNS-ready ordinal holding 2 of the 3 slots it asked for is owed work").toBeDefined();
    expect(step?.kind).toBe("owed");
    expect(step?.action.via).toBe("mcp_tool");
    expect(derived.status).toBe("owed");
    expect(owedSignals(derived).owedReasons).toContain("ordinal_slot_shortfall");
  });

  it("`seat_headroom_free` is SUPPRESSED — the account is never told 'nothing is required' in this state", async () => {
    const tenantId = await seedTenant(SLOT_SHORTFALL_FLEET);
    const derived = await derive(tenantId);
    expect(derived.steps.find((s) => s.reason === "seat_headroom_free")).toBeUndefined();
  });

  it("a live `retry_setup` row is NOT re-derived as resolved, and the ops fan-out does NOT expire it", async () => {
    const tenantId = await seedTenant(SLOT_SHORTFALL_FLEET);
    await emitRetrySetup(tenantId, "theauthorpitchdesk.com");

    // It still counts: the condition the message describes genuinely holds.
    expect(owedSignals(await derive(tenantId)).owedReasons).toContain("message_action_required");

    await tenantStub(tenantId).opsSummary(realNowMs());
    const rows = await messageRows(tenantId);
    expect(rows.find((r) => r.kind === "retry_setup")?.expires_at, "the row describes real outstanding work").toBeNull();
  });

  it("a genuinely FINISHED fleet (live === requested on every ordinal) derives no shortfall — the guard is not vacuous", async () => {
    const tenantId = await seedTenant({
      ordinals: [
        { domain: "fin0.com", liveMailboxes: 3, requestedSlots: 3 },
        { domain: "fin1.com", liveMailboxes: 2, requestedSlots: 2 },
      ],
      billedQuantity: 5,
    });
    const derived = await derive(tenantId);
    expect(derived.steps.find((s) => s.reason === "ordinal_slot_shortfall")).toBeUndefined();
    expect(owedSignals(derived).owedCount).toBe(0);
  });

  it("a legacy NULL-spec ordinal ABSTAINS rather than guessing an ask it has no record of", async () => {
    const tenantId = await seedTenant({
      ordinals: [{ domain: "legacy0.com", liveMailboxes: 2, requestedSlots: null }],
      billedQuantity: 5,
    });
    expect((await derive(tenantId)).steps.find((s) => s.reason === "ordinal_slot_shortfall")).toBeUndefined();
  });

  it("an ordinal whose DNS has not come up is `domain_dns_incomplete`'s, not this one's — one blocker, one sentence", async () => {
    const tenantId = await seedTenant({
      ordinals: [{ domain: "dnspending.com", liveMailboxes: 0, requestedSlots: 3, dnsReady: false }],
      billedQuantity: 5,
    });
    const derived = await derive(tenantId);
    expect(derived.steps.find((s) => s.reason === "domain_dns_incomplete")).toBeDefined();
    expect(derived.steps.find((s) => s.reason === "ordinal_slot_shortfall")).toBeUndefined();
  });

  it("a BYO ordinal is never told to buy a managed lookalike — the shortfall is scoped to provisioned domains", async () => {
    const tenantId = await seedTenant({
      ordinals: [{ domain: "byoshort.com", liveMailboxes: 1, requestedSlots: 3, source: "byo" }],
      billedQuantity: 5,
    });
    expect((await derive(tenantId)).steps.find((s) => s.reason === "ordinal_slot_shortfall")).toBeUndefined();
  });
});

describe("R2-BLOCKING part 2 — the durable expiry cannot outrun the orphan grace", () => {
  it("a `dangling` ordinal INSIDE its grace window keeps its message: the 5-minute sweep does not expire it", async () => {
    const tenantId = await seedTenant({
      ordinals: [
        { domain: "grace0.com", liveMailboxes: 2 },
        { domain: "grace1.com", liveMailboxes: 0, status: "dangling", noDomainRow: true, updatedAt: Date.now() - 1000 },
      ],
      billedQuantity: 5,
    });
    await emitRetrySetup(tenantId, "grace1.com");

    // Inside the grace, `ordinal_incomplete` has not matured — this is exactly
    // the window the sweep used to win.
    expect((await derive(tenantId)).steps.find((s) => s.reason === "ordinal_incomplete")).toBeUndefined();

    await tenantStub(tenantId).opsSummary(realNowMs());
    expect(
      (await messageRows(tenantId)).find((r) => r.kind === "retry_setup")?.expires_at,
      "a row younger than the orphan grace is never banked as resolved",
    ).toBeNull();
  });

  it("once the grace opens the reason fires and the SURVIVING row counts again", async () => {
    const tenantId = await seedTenant({
      ordinals: [
        { domain: "grace2.com", liveMailboxes: 2 },
        { domain: "grace3.com", liveMailboxes: 0, status: "dangling", noDomainRow: true },
      ],
      billedQuantity: 5,
    });
    await emitRetrySetup(tenantId, "grace3.com");
    await tenantStub(tenantId).opsSummary(realNowMs());

    const reasons = owedSignals(await derive(tenantId)).owedReasons;
    expect(reasons).toContain("ordinal_incomplete");
    expect(reasons).toContain("message_action_required");
    expect((await messageRows(tenantId)).find((r) => r.kind === "retry_setup")?.expires_at).toBeNull();
  });

  it("an `operator_pending` row is untouched — the control the severity scoping exists for", async () => {
    const tenantId = await seedTenant({
      ordinals: [{ domain: "opctl.com", liveMailboxes: 2 }],
      billedQuantity: 5,
    });
    await withTenantContext(tenantId, (ctx) =>
      emitTenantMessage(ctx, {
        kind: "setup_failed",
        severity: "operator_pending",
        body: "The platform has stopped on a step only an operator can clear.",
      }),
    );
    await tenantStub(tenantId).opsSummary(realNowMs());
    expect((await messageRows(tenantId))[0]?.expires_at).toBeNull();
  });

  it("a resolved row PAST the grace is still banked — the guard delays the expiry, it does not remove it", async () => {
    const tenantId = await seedTenant({
      ordinals: [
        { domain: "banked0.com", liveMailboxes: 2 },
        { domain: "banked1.com", liveMailboxes: 2 },
      ],
      billedQuantity: 5,
    });
    await emitRetrySetup(tenantId, "banked1.com");
    // Age the row past the grace without waiting for it.
    await withTenantContext(tenantId, (ctx) =>
      ctx.sql.exec(
        `UPDATE tenant_messages SET created_at = ? WHERE tenant_id = ?`,
        ctx.clock.now() - DEFAULT_PROVISIONING_ORPHAN_GRACE_MS * 2,
        ctx.tenantId,
      ),
    );

    await tenantStub(tenantId).opsSummary(realNowMs());
    expect((await messageRows(tenantId))[0]?.expires_at).not.toBeNull();
  });
});

describe("R2-BLOCKING part 3 — an expired row survives long enough for the mistake to be caught", () => {
  it("a just-expired row is NOT deleted by the prune sweep", async () => {
    const tenantId = await seedTenant({ ordinals: [{ domain: "prune0.com", liveMailboxes: 2 }], billedQuantity: 5 });
    await withTenantContext(tenantId, (ctx) =>
      emitTenantMessage(ctx, {
        kind: "retry_setup",
        severity: "action_required",
        body: "expired one second ago",
        expiresAt: ctx.clock.now() - 1000,
      }),
    );
    await withTenantContext(tenantId, (ctx) => pruneTenantMessages(ctx));
    expect((await messageRows(tenantId)).length, "the audit trail outlives the expiry decision").toBe(1);
  });

  it("a row expired past the retention window IS deleted — the sweep is still bounded", async () => {
    const tenantId = await seedTenant({ ordinals: [{ domain: "prune1.com", liveMailboxes: 2 }], billedQuantity: 5 });
    await withTenantContext(tenantId, (ctx) =>
      emitTenantMessage(ctx, {
        kind: "retry_setup",
        severity: "action_required",
        body: "expired long ago",
        expiresAt: ctx.clock.now() - READ_RETENTION_MS - 1000,
      }),
    );
    await withTenantContext(tenantId, (ctx) => pruneTenantMessages(ctx));
    expect((await messageRows(tenantId)).length).toBe(0);
  });
});

// ── ROUND 3 ─────────────────────────────────────────────────────────────────
// docs/adversarial/customer-continuity-build-gate-r3-2026-08-19.md found the
// reason added above to be a FALSE-POSITIVE GENERATOR with four reachable
// production paths, and its remedy computed in a different coordinate system
// than the shortfall it claims to fix. Both are recreated here as in-repo
// tests, each one the gate's own executable probe.

describe("R3-BLOCKING-1 — the predicate tells 'never created' from 'created, then removed or moved'", () => {
  // PATH A. `applyReplaceDomain` flips the domain to 'burning' and releases
  // every mailbox on it BEFORE deciding on a replacement. `readProvisioningSnapshot`
  // resolves `intent.live` on `status != 'released'`, so the burned ordinal
  // stays "live" — and the old predicate then recommended re-populating the
  // domain the platform had just retired for reputation, at the customer's
  // expense. No customer action was involved at any point.
  it("A1 — a BURNED domain whose mailboxes were released is not a slot shortfall", async () => {
    const tenantId = await seedTenant({
      ordinals: [
        { domain: "burned0.com", liveMailboxes: 0, requestedSlots: 3, domainStatus: "burning", releasedSlots: [0, 1, 2] },
        { domain: "healthy1.com", liveMailboxes: 2 },
      ],
      billedQuantity: 5,
    });
    expect(shortfallStep((await derive(tenantId)).steps)).toBeUndefined();
  });

  // The status half of path A on its own: a domain retired before its slots
  // ever landed. Nothing was "created then removed" here, so only the
  // liveness predicate can refuse it — a domain the platform has retired
  // cannot carry mail, so naming its empty slots would name the wrong blocker.
  it("A2 — a RETIRED domain whose slots never landed is not this reason's either", async () => {
    const tenantId = await seedTenant({
      ordinals: [{ domain: "retired0.com", liveMailboxes: 0, requestedSlots: 3, domainStatus: "retired" }],
      billedQuantity: 5,
    });
    expect(shortfallStep((await derive(tenantId)).steps)).toBeUndefined();
  });

  // PATH B, driven through the REAL `removeMailboxes` — the same call whose
  // own response embeds `deriveNextSteps`. The customer asks to spend less and
  // the platform used to answer, in that very response, that it had failed
  // them, with a ready-to-execute call that undid the downgrade.
  it("B — a customer DOWNGRADE is not reported back inside the downgrade's own response", async () => {
    const tenantId = await seedTenant({
      ordinals: [
        { domain: "down0.com", liveMailboxes: 4, requestedSlots: 4 },
        { domain: "down1.com", liveMailboxes: 4, requestedSlots: 4 },
      ],
      billedQuantity: 8,
    });
    await withTenantContext(tenantId, (ctx) =>
      ctx.sql.exec(
        `UPDATE tenant_profile SET stripe_subscription_id = 'sub_r3', stripe_mailbox_item_id = 'si_mbx' WHERE id = ?`,
        ctx.tenantId,
      ),
    );

    const saved = env.STRIPE_SECRET_KEY;
    (env as { STRIPE_SECRET_KEY?: string }).STRIPE_SECRET_KEY = "sk_test_fake_r3";
    let result;
    try {
      result = await withTenantContext(tenantId, async (ctx) => {
        vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
        return removeMailboxes(ctx, { count: 2, acknowledged: true });
      });
    } finally {
      (env as { STRIPE_SECRET_KEY?: string }).STRIPE_SECRET_KEY = saved;
      vi.unstubAllGlobals();
    }

    expect(result.releasedCount).toBe(2);
    expect(result.failedCount).toBe(0);
    expect(shortfallStep(result.nextSteps?.steps ?? []), "the customer asked for this; it is not a platform failure").toBeUndefined();
  });

  // PATH C. `recordDomainIntent` is INSERT OR IGNORE, so the intent keeps the
  // FIRST persona while the saga provisions under the REQUEST persona. The
  // domain holds every mailbox it asked for; only the ADDRESSES moved.
  it("C — a domain whose live count already covers its ask is not short, whatever persona the addresses carry", async () => {
    const tenantId = await seedTenant({
      ordinals: [
        {
          domain: "drift0.com",
          liveMailboxes: 2,
          requestedSlots: 5,
          persona: "alpha",
          driftedSlots: [
            { persona: "beta", slot: 2 },
            { persona: "beta", slot: 3 },
            { persona: "beta", slot: 4 },
          ],
        },
      ],
      billedQuantity: 5,
    });
    expect(shortfallStep((await derive(tenantId)).steps)).toBeUndefined();
  });

  // PATH D — the one the reason exists for. If the discriminators above muted
  // this too they would be a blanket mute rather than a discriminator.
  it("D — a real per-slot vendor failure STILL fires, and its remedy is runnable", async () => {
    const tenantId = await seedTenant(SLOT_SHORTFALL_FLEET);
    const step = shortfallStep((await derive(tenantId)).steps);
    expect(step?.kind).toBe("owed");
    expect(step?.action.via).toBe("mcp_tool");
    expect(await executeEmittedPlan(tenantId, step!)).toEqual({ newDomains: 0, newMailboxes: 1 });
  });

  // THE MIXED CASE, and the honesty test for the two halves together: one slot
  // deliberately released, one that never existed. Only the second is owed —
  // and the single call the platform could construct would ALSO re-create the
  // released one, so it must not be recommended as "exactly the missing ones".
  it("D2 — a released slot beside a never-created one: owed for one, and the platform will not offer a call that undoes the other", async () => {
    const tenantId = await seedTenant({
      ordinals: [{ domain: "mixed0.com", liveMailboxes: 2, requestedSlots: 4, releasedSlots: [2] }],
      billedQuantity: 5,
    });
    const step = shortfallStep((await derive(tenantId)).steps);
    expect(step?.kind).toBe("owed");
    expect(step?.why).toContain("1 mailbox");
    expect(step?.action.via, "the only expressible call would re-create the released slot too").toBe("none");
    expect(step?.why).not.toContain("creates exactly");
    // `waitingOn: null` is the contract's "the agent can act right now".
    expect(step?.waitingOn, "nothing the caller can send fills these slots").toBe("operator");
  });

  // PATH C, PARTIALLY. The drift gate above is a CAP, not only a gate: a domain
  // asking 5 that holds 4 under two personas is short by ONE mailbox, while the
  // address walk finds THREE unfilled addresses. Reporting three would be a
  // remedy that is exact, executable, and two mailboxes' worth of bill too big.
  it("C2 — a partially drifted ordinal is short by what it LACKS, not by how many addresses moved", async () => {
    const tenantId = await seedTenant({
      ordinals: [
        {
          domain: "drift1.com",
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
    });
    const step = shortfallStep((await derive(tenantId)).steps);
    expect(step?.why, "the domain lacks one mailbox, not three").toContain("1 mailbox");
    expect(step?.action.via, "and no call it can construct creates only that one").toBe("none");
  });
});

describe("R3-BLOCKING-2 — the remedy is EXECUTED before it is claimed", () => {
  // THE NO-OP-FOREVER SHAPE. The old remedy was `fillDistribution(snap,
  // max(billed, 5))` — a flat total packed 3-per-domain — while the shortfall
  // is per-ordinal against `inboxes_each`. Asked [3,3] with 5 live and billed
  // 5, that emitted [3,2], which the real planner says buys NOTHING: the
  // account stays permanently short a mailbox it paid for and the agent
  // executes the same successful no-op forever.
  it("case A — the emitted call creates the missing mailbox instead of buying nothing", async () => {
    const tenantId = await seedTenant({
      ordinals: [
        { domain: "noop0.com", liveMailboxes: 3, requestedSlots: 3 },
        { domain: "noop1.com", liveMailboxes: 2, requestedSlots: 3 },
      ],
      billedQuantity: 5,
    });
    const step = shortfallStep((await derive(tenantId)).steps);
    expect(step, "one slot of ordinal 1 never landed").toBeDefined();
    expect(await executeEmittedPlan(tenantId, step!)).toEqual({ newDomains: 0, newMailboxes: 1 });
    expect(step?.why).toContain("creates exactly the 1 missing");
  });

  // THE ESCALATION SHAPE. Asked [5] on one domain with 4 live and billed 5,
  // the old remedy emitted [3,2] — which buys a NEW DOMAIN and two mailboxes,
  // never touches slot 4, and raises the live count so the next derivation's
  // fill target grows again: a money-spending loop up to the 60-mailbox
  // self-serve ceiling.
  it("case B — the emitted call buys NO new domain", async () => {
    const tenantId = await seedTenant({
      ordinals: [{ domain: "esc0.com", liveMailboxes: 4, requestedSlots: 5 }],
      billedQuantity: 5,
    });
    const step = shortfallStep((await derive(tenantId)).steps);
    expect(step, "slot 4 of ordinal 0 never landed").toBeDefined();
    const plan = await executeEmittedPlan(tenantId, step!);
    expect(plan.newDomains, "a shortfall remedy never adds a domain").toBe(0);
    expect(plan.newMailboxes).toBe(1);
    expect(step?.why).toContain("creates exactly the 1 missing");
  });

  // THE CONTROL. The wave's own fixture is the single shape where the two
  // coordinate systems happened to agree, which is why the suite was green on
  // both failures above. It must stay correct under the fix.
  it("control — the wave's own fixture still emits a call that fits exactly", async () => {
    const tenantId = await seedTenant(SLOT_SHORTFALL_FLEET);
    const step = shortfallStep((await derive(tenantId)).steps);
    expect(await executeEmittedPlan(tenantId, step!)).toEqual({ newDomains: 0, newMailboxes: 1 });
    expect(step?.why).toContain("creates exactly the 1 missing");
  });

  // THE SIBLING, per the gate's shaping note: `ordinal_incomplete` makes a
  // comparable claim off the same `fillDistribution`, so it goes through the
  // same execute-then-claim helper rather than the new reason being special-cased.
  it("the sibling `ordinal_incomplete` states what its own emitted call would acquire", async () => {
    const tenantId = await seedTenant({
      ordinals: [
        { domain: "sib0.com", liveMailboxes: 2 },
        { domain: "sib1.com", liveMailboxes: 0, status: "dangling", noDomainRow: true },
      ],
      billedQuantity: 5,
    });
    const step = (await derive(tenantId)).steps.find((s) => s.reason === "ordinal_incomplete");
    expect(step?.action.via).toBe("mcp_tool");
    const plan = await executeEmittedPlan(tenantId, step!);
    expect(step?.why).toContain(`buys ${plan.newDomains} new domain`);
    expect(step?.why).toContain(`creates ${plan.newMailboxes} mailbox`);
  });
});

describe("R3 NON-BLOCKING fold-ins", () => {
  // NB-1 — `domain_intents.updated_at` moves only on a status transition, so a
  // shortfall on an ordinal committed weeks ago read as owed-for-weeks the
  // instant it appeared: past the 48h bound, so the stuck-customer check went
  // unhealthy and the one-shot nudge told the customer their account had not
  // progressed in over a day, about a failure minutes old.
  it("NB-1 — sinceMs measures the SHORTFALL's onset, not the intent's last status transition", async () => {
    const now = Date.now();
    const tenantId = await seedTenant({
      ordinals: [
        {
          domain: "aged0.com",
          liveMailboxes: 2,
          requestedSlots: 3,
          updatedAt: now - 60 * 24 * 60 * 60 * 1000,
          mailboxCreatedAt: now - 60 * 60 * 1000,
        },
      ],
      billedQuantity: 5,
    });
    const step = shortfallStep((await derive(tenantId)).steps);
    expect(step?.sinceMs).not.toBeNull();
    expect(step!.sinceMs!, "the ordinal is weeks old; the shortfall is an hour old").toBeLessThan(
      DEFAULT_CUSTOMER_PROGRESS_OWED_MAX_MS,
    );
  });

  // NB-2 — `expires_at` is stamped `realNowMs()` and `read_at` is stamped
  // `ctx.clock.now()`. One cutoff for both legs made the expired leg
  // cross-domain: a virtual-clock tenant leading real time by >30 days had
  // every just-expired row deleted on the next sweep, which is exactly the
  // destruction the retention grace was added to prevent.
  it("NB-2 — the prune's expired leg is measured on the column's OWN clock", async () => {
    const tenantId = await seedTenant({ ordinals: [{ domain: "vclock0.com", liveMailboxes: 2 }], billedQuantity: 5 });
    await withTenantContext(tenantId, (ctx) =>
      ctx.sql.exec(
        `UPDATE tenant_profile SET clock_mode = 'virtual', clock_base = ?, clock_offset = ?, clock_multiplier = 1 WHERE id = ?`,
        Date.now(),
        40 * 24 * 60 * 60 * 1000,
        ctx.tenantId,
      ),
    );
    await withTenantContext(tenantId, (ctx) =>
      emitTenantMessage(ctx, {
        kind: "retry_setup",
        severity: "action_required",
        body: "expired one second ago in REAL time",
        expiresAt: realNowMs() - 1000,
      }),
    );

    await withTenantContext(tenantId, (ctx) => pruneTenantMessages(ctx));
    expect(
      (await messageRows(tenantId)).length,
      "a real-wall-clock column must not be aged against a 40-day-ahead VirtualClock",
    ).toBe(1);
  });

  // NB-4 — the grace-window silence, PINNED. The r2 fix moved the failure from
  // durable-and-destructive to transient-and-reversible, which the gate ruled
  // non-blocking; but `provisioningOrphanGraceMs` is env-tunable with no upper
  // bound, so an operator raising it silently extends this surface. What the
  // customer IS told here is pinned so widening the window cannot go untested.
  it("NB-4 — inside the orphan grace the customer surface is pinned, not merely un-owed", async () => {
    const tenantId = await seedTenant({
      ordinals: [
        { domain: "pin0.com", liveMailboxes: 2 },
        { domain: "pin1.com", liveMailboxes: 0, status: "dangling", noDomainRow: true, updatedAt: Date.now() - 1000 },
      ],
      billedQuantity: 5,
    });
    await emitRetrySetup(tenantId, "pin1.com");

    const derived = await derive(tenantId);
    expect(derived.status).toBe("none_owed");
    expect(owedSignals(derived).owedReasons).toEqual([]);
    expect(derived.steps.map((s) => s.reason)).toEqual(["ready_to_launch", "seat_headroom_free"]);
    // The durable action item survives the silence — that is what bounds it.
    expect((await messageRows(tenantId)).find((r) => r.kind === "retry_setup")?.expires_at).toBeNull();
  });

  // NB-5 — both reasons fire on one condition (`billable === 0` with a
  // committed, DNS-ready, spec-carrying ordinal), giving the customer two
  // `why` sentences and two identical calls for one problem.
  it("NB-5 — the shortfall yields when `paid_seats_unprovisioned` covers the same condition", async () => {
    const tenantId = await seedTenant({
      ordinals: [{ domain: "double0.com", liveMailboxes: 0, requestedSlots: 3 }],
      billedQuantity: 5,
    });
    const reasons = owedSignals(await derive(tenantId)).owedReasons;
    expect(reasons).toContain("paid_seats_unprovisioned");
    expect(reasons).not.toContain("ordinal_slot_shortfall");
  });
});
