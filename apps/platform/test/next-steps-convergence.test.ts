import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NEXT_STEP_REASONS, type NextStep, type NextStepReason, type NextSteps } from "@coldstart/shared";
import { deriveNextSteps, owedSignals } from "../src/engine/next-steps.js";
import { managedMailboxAddress } from "../src/engine/mailbox-provisioning.js";
import { domainIntentKey } from "../src/engine/provision-intents.js";
import { activatePaidPlan, api, mintTenant, seedBenignSdnList, tenantStub, withTenantContext } from "./helpers.js";
import { fakeInboxKit, REGISTRANT } from "./fixtures/inboxkit-workspace.js";
import { IK_API_KEY, IK_WORKSPACE_ID } from "./fixtures/inboxkit.js";

// G5 REBUILT — THE CONVERGENCE GUARD (design §7.6).
//
// A recommendation that cannot be executed is worse than no recommendation: an
// unattended agent runs it verbatim, gets a refusal, and files a ticket. This
// guard EXECUTES the emitted step against the real entry point and asserts the
// account moved toward done.
//
// TWO DEFECTS IN v1, TWO FIXES.
//
// (1) REAL PORT SELECTION, NOT THE SANDBOX EARLY-RETURN. `selectSetupDomainPort`
//     returns early for a non-real bundle, so on sandbox fixtures
//     `registerDomains` has NO EFFECT AT ALL — the one field whose omission
//     breaks the recommendation was invisible to the guard written to make that
//     impossible. Every fixture here runs with `bundle.kind === "real"`
//     (INBOXKIT_* present + the registrar armed) and the vendor HTTP layer
//     stubbed through the existing real-adapter fixture. The MANDATORY NEGATIVE
//     at the bottom strips `registerDomains` from an emitted step and asserts
//     the call FAILS — which is what proves this guard can see the field.
//
// (2) MONOTONE PROGRESS, NOT DISAPPEARANCE-AND-EQUALITY. Equality is
//     contradicted by the platform's own documented partial-success paths
//     (`capacity_pending` reports what landed rather than the ask,
//     `forEachIsolated` deliberately completes some ordinals and fails others,
//     `DomainPropagationPendingError` returns `provisioning:"pending"`). A
//     builder facing that either excludes partials from the fixture set — the
//     167-green-tests-on-the-happy-path shape — or weakens the assertion at
//     build time. So the property is monotone progress instead.
//
// ── A DEVIATION FROM §7.6(a), STATED RATHER THAN TAKEN QUIETLY ───────────────
// §7.6(a) reads "the owed set did not GROW". Taken as cardinality it is
// unsatisfiable on EVERY partial path §7.6 itself requires to pass: under the
// eleven-reason list, a spend/slot hold introduces `setup_capacity_held`, a
// per-ordinal failure introduces `ordinal_incomplete`, and a propagation wait
// introduces `domain_dns_incomplete`. Each is genuine NEW owed work created by
// making progress, so (a) and "partials must pass" contradict each other as
// written.
//
// Resolution implemented here, and reported to the orchestrator rather than
// decided silently: (a) is measured over reasons the executed action did NOT
// itself create work for. `PROGRESS_INTRODUCED_REASONS` below is that closed
// set; every other owed reason must not grow, and §7.6(d) is unchanged and
// asserted separately with a planted row so it is not vacuous.

/** The owed reasons a SUCCESSFUL-BUT-PARTIAL execution legitimately introduces. */
const PROGRESS_INTRODUCED_REASONS: NextStepReason[] = [
  "domain_dns_incomplete",
  "setup_capacity_held",
  "ordinal_incomplete",
];

/** Reasons whose source is a row THIS WAVE writes — §7.6(d)'s structural guard against self-re-arm. */
const WAVE_WRITTEN_REASONS: NextStepReason[] = ["message_action_required"];

interface Ordinal {
  domain: string;
  liveMailboxes: number;
}

/**
 * The brand and `primaryDomain` must CORRESPOND — `assertBrandOwnership` rejects
 * a lookalike request whose primary domain does not derive from the brand — so
 * fixtures share one brand and distinguish themselves by their domain names.
 */
const BRAND = "Convergence Co";
const PRIMARY_DOMAIN = "convergenceco.com";

async function seedRealTenant(ordinals: Ordinal[], billedQuantity: number, persona = "sender"): Promise<{ tenantId: string; token: string }> {
  const { tenantId, token } = await mintTenant(BRAND, "managed");
  await activatePaidPlan(tenantId, "managed");
  await runInDurableObject(tenantStub(tenantId), (_instance, state) => {
    const sql = state.storage.sql;
    sql.exec(
      `UPDATE tenant_profile
          SET primary_domain = ?, physical_address = ?, sender_identity = ?,
              mailbox_qty_synced = ?, register_domains = 1, registrant_json = ?
        WHERE id = ?`,
      PRIMARY_DOMAIN,
      "1 Main St, Testville, CA 94000",
      `${BRAND} <hello@${PRIMARY_DOMAIN}>`,
      billedQuantity,
      JSON.stringify(REGISTRANT),
      tenantId,
    );
    ordinals.forEach((ord, ordinal) => {
      sql.exec(
        `INSERT INTO domain_intents (key, tenant_id, candidate_domain, status, persona_slug, inboxes_each, created_at, updated_at)
         VALUES (?, ?, ?, 'committed', ?, ?, ?, ?)`,
        domainIntentKey(tenantId, ordinal),
        tenantId,
        ord.domain,
        persona,
        Math.max(1, ord.liveMailboxes),
        1000,
        Date.now(),
      );
      const domainId = `dom_${ordinal}_${tenantId}`;
      sql.exec(
        `INSERT INTO domains (id, tenant_id, domain, status, purchased_at, dns_status, connection_type)
         VALUES (?, ?, ?, 'active', ?, 'ready', 'purchased')`,
        domainId,
        tenantId,
        ord.domain,
        1000,
      );
      for (let slot = 0; slot < ord.liveMailboxes; slot++) {
        const email = managedMailboxAddress(persona, ord.domain, ordinal, slot);
        sql.exec(
          `INSERT INTO mailboxes (id, tenant_id, domain_id, domain, email, daily_cap, warmup_started_at, created_at, provider)
           VALUES (?, ?, ?, ?, ?, 5, 1000, 1000, 'google')`,
          `mbx_${email}`,
          tenantId,
          domainId,
          ord.domain,
          email,
        );
      }
    });
  });
  return { tenantId, token };
}

function derive(tenantId: string): Promise<NextSteps> {
  return withTenantContext(tenantId, (ctx) => deriveNextSteps(ctx));
}

function billableCount(tenantId: string): Promise<number> {
  return withTenantContext(
    tenantId,
    (ctx) =>
      ctx.sql
        .exec<{ n: number }>(`SELECT COUNT(*) as n FROM mailboxes WHERE tenant_id = ? AND released_at IS NULL`, ctx.tenantId)
        .one().n,
  );
}

/** The step this guard executes: the one carrying a runnable `setup_infrastructure` call. */
function runnableSetupStep(steps: NextStep[]): NextStep {
  const step = steps.find(
    (s) => s.action.via === "mcp_tool" && s.action.tool === "setup_infrastructure" && s.action.paramsToSupply.length === 0,
  );
  if (!step) throw new Error(`no runnable setup step among: ${steps.map((s) => s.reason).join(", ")}`);
  return step;
}

/** Executes an emitted step VERBATIM, optionally stripping a field first. */
async function execute(token: string, step: NextStep, strip?: string): Promise<{ status: number; code?: string }> {
  if (step.action.via !== "mcp_tool") throw new Error("not an mcp_tool step");
  const params = { ...step.action.params };
  if (strip) delete params[strip];
  const res = await api<{ code?: string }>("/setup-infrastructure", {
    method: "POST",
    token,
    body: JSON.stringify(params),
  });
  return { status: res.status, code: res.body?.code };
}

/** The shortfall a seat reason is about: what is billed for versus what exists. */
async function shortfall(tenantId: string): Promise<number> {
  const billed = await withTenantContext(
    tenantId,
    (ctx) => ctx.sql.exec<{ q: number }>(`SELECT mailbox_qty_synced as q FROM tenant_profile WHERE id = ?`, ctx.tenantId).one().q,
  );
  return Math.max(0, billed - (await billableCount(tenantId)));
}

// NON-BLOCKING-1 (build gate 2026-08-19, the J1 residual). The exempt set is a
// hand-maintained allowlist living in the same file as the assertions it
// relaxes, and nothing reddened when it grew. Pinned to its exact contents —
// the treatment `NEXT_STEP_REASONS` already gets — so WIDENING it is a
// deliberate edit to this line rather than a silent one three functions down.
// Each member maps to a documented partial-success mechanism the platform
// really has: `capacity_pending` state, per-ordinal isolation, DNS propagation.
describe("NB-1 — the G5(a) exemption set is pinned, not open-ended", () => {
  it("PROGRESS_INTRODUCED_REASONS is exactly these three", () => {
    expect(PROGRESS_INTRODUCED_REASONS).toEqual(["domain_dns_incomplete", "setup_capacity_held", "ordinal_incomplete"]);
  });

  it("every member is a real NextStepReason, and the set is a strict subset of them", () => {
    for (const reason of PROGRESS_INTRODUCED_REASONS) expect(NEXT_STEP_REASONS).toContain(reason);
    expect(PROGRESS_INTRODUCED_REASONS.length).toBeLessThan(NEXT_STEP_REASONS.length);
  });
});

describe("G5 — an emitted step, executed, moves the account toward done", () => {
  const saved = {
    REGISTRAR_PROVIDER: env.REGISTRAR_PROVIDER,
    INBOXKIT_API_KEY: env.INBOXKIT_API_KEY,
    INBOXKIT_WORKSPACE_ID: env.INBOXKIT_WORKSPACE_ID,
  };
  afterEach(() => {
    vi.restoreAllMocks();
    Object.assign(env, saved);
  });
  beforeEach(async () => {
    await seedBenignSdnList();
    await env.DB.prepare("DELETE FROM vendor_spend_entries").run();
    await env.DB.prepare("DELETE FROM vendor_spend_ledger").run();
    await env.DB.prepare("DELETE FROM vendor_slot_state").run();
    // THE REAL BUNDLE. Without both INBOXKIT_* keys the factory returns the
    // sandbox bundle and `selectSetupDomainPort` early-returns, which is
    // precisely the blindness this rebuild exists to remove.
    Object.assign(env, { REGISTRAR_PROVIDER: "inboxkit", INBOXKIT_API_KEY: IK_API_KEY, INBOXKIT_WORKSPACE_ID: IK_WORKSPACE_ID });
  });

  it("the fixture really does run on the REAL bundle, not the sandbox one", async () => {
    const { tenantId } = await seedRealTenant([{ domain: "realbundle.com", liveMailboxes: 2 }], 5);
    // Asked of the DO's OWN `buildAdapters()`, which is what the HTTP path
    // uses. `withTenantContext` builds its own sandbox bundle and would report
    // 'sandbox' here no matter what the env says — exactly the kind of
    // fixture-shaped blindness this rebuild exists to remove.
    await runInDurableObject(tenantStub(tenantId), (instance) => {
      const bundle = (instance as unknown as { buildAdapters(): { kind: string } }).buildAdapters();
      expect(bundle.kind).toBe("real");
    });
  });

  // FILLING EXISTING ORDINALS: the step buys mailboxes on domains that already
  // exist, so nothing new is introduced and the monotone property holds in its
  // strongest form.
  it("filling the floor gap converges: the reason clears, the shortfall closes, nothing new is owed", async () => {
    const { tenantId, token } = await seedRealTenant(
      [
        { domain: "conv0.com", liveMailboxes: 2 },
        { domain: "conv1.com", liveMailboxes: 1 },
      ],
      5,
    );
    const before = await derive(tenantId);
    const beforeSignals = owedSignals(before);
    const beforeShortfall = await shortfall(tenantId);
    const step = runnableSetupStep(before.steps);

    fakeInboxKit({ domains: [], mailboxesReadyOnBuy: true });
    const executed = await execute(token, step);
    expect(executed.code).toBeUndefined();

    const after = await derive(tenantId);
    const afterSignals = owedSignals(after);
    const afterBillable = await billableCount(tenantId);

    // (b) the step's own reason cleared, or its shortfall STRICTLY decreased.
    const stillOwed = after.steps.some((s) => s.reason === step.reason);
    expect(!stillOwed || (await shortfall(tenantId)) < beforeShortfall).toBe(true);
    // (c) `effect.provisionedAfter` is an UPPER BOUND on what actually landed —
    // never an equality, because a partial reports what landed rather than the ask.
    expect(step.effect?.provisionedAfter ?? Infinity).toBeGreaterThanOrEqual(afterBillable);
    // (a), scoped as documented at the top of this file.
    const introduced = afterSignals.owedReasons.filter((r) => !beforeSignals.owedReasons.includes(r));
    expect(introduced.filter((r) => !PROGRESS_INTRODUCED_REASONS.includes(r))).toEqual([]);
    // Progress actually happened.
    expect(afterBillable).toBeGreaterThan(3);
  });

  // THE PARTIAL-SUCCESS FIXTURE. The step opens a NEW ordinal, whose domain is
  // bought but whose mail DNS has not propagated — the documented
  // `provisioning: "pending"` path. Under v1's disappearance-and-equality this
  // FAILS (the reason does not vanish and `provisionedAfter` is not equal to the
  // observed count); under monotone progress it passes, which is the whole
  // point of the rebuild.
  it("a partial-success path PASSES under monotone progress and would FAIL under equality", async () => {
    const { tenantId, token } = await seedRealTenant([{ domain: "partial0.com", liveMailboxes: 2 }], 5);
    const before = await derive(tenantId);
    const beforeSignals = owedSignals(before);
    const beforeBillable = await billableCount(tenantId);
    const step = runnableSetupStep(before.steps);

    fakeInboxKit({ domains: [], mailboxesReadyOnBuy: true });
    await execute(token, step);

    const after = await derive(tenantId);
    const afterBillable = await billableCount(tenantId);

    // Progress: strictly more mailboxes than before.
    expect(afterBillable).toBeGreaterThan(beforeBillable);
    // (c) UPPER BOUND, and deliberately not equality — a partial lands less
    // than the ask and the guard must still pass.
    expect(step.effect?.provisionedAfter ?? Infinity).toBeGreaterThanOrEqual(afterBillable);
    // (a) scoped: nothing owed appeared that the progress did not create.
    const introduced = owedSignals(after).owedReasons.filter((r) => !beforeSignals.owedReasons.includes(r));
    expect(introduced.filter((r) => !PROGRESS_INTRODUCED_REASONS.includes(r))).toEqual([]);
  });

  // §7.6(d) — THE SELF-RE-ARM GUARD, made non-vacuous with a planted row. A
  // reason sourced from a row this wave writes must never appear as a
  // consequence of executing a step: that is the loop where the nudge's own
  // message sustains the check that fires the nudge.
  it("no new owed reason is sourced from a row this wave writes", async () => {
    const { tenantId, token } = await seedRealTenant(
      [
        { domain: "selfarm0.com", liveMailboxes: 2 },
        { domain: "selfarm1.com", liveMailboxes: 1 },
      ],
      5,
    );
    const before = owedSignals(await derive(tenantId));
    const step = runnableSetupStep((await derive(tenantId)).steps);

    fakeInboxKit({ domains: [], mailboxesReadyOnBuy: true });
    await execute(token, step);

    // The wave's own row, planted at exactly the severity that would otherwise
    // become an owed `message_action_required`.
    await withTenantContext(tenantId, (ctx) => {
      ctx.sql.exec(
        `INSERT INTO tenant_messages (id, tenant_id, kind, severity, body, source, created_at)
         VALUES (?, ?, 'continuity_nudge', 'action_required', 'a nudge this wave wrote', 'system', ?)`,
        `msg_nudge_${ctx.tenantId}`,
        ctx.tenantId,
        Date.now(),
      );
    });

    const after = owedSignals(await derive(tenantId));
    const introduced = after.owedReasons.filter((r) => !before.owedReasons.includes(r));
    expect(introduced.filter((r) => WAVE_WRITTEN_REASONS.includes(r))).toEqual([]);
  });

  // ── THE MANDATORY NEGATIVE (§7.6) ──────────────────────────────────────────
  // If this passes, the guard is blind to the ONE field whose omission breaks
  // the recommendation — and a guard that cannot see it cannot be evidence for
  // anything. The live incident is exactly this call minus this field.
  it("an emitted step with `registerDomains` STRIPPED fails — proving the guard can see the field", async () => {
    const { tenantId, token } = await seedRealTenant(
      [
        { domain: "strip0.com", liveMailboxes: 2 },
        { domain: "strip1.com", liveMailboxes: 1 },
      ],
      5,
    );
    const before = await derive(tenantId);
    const step = runnableSetupStep(before.steps);
    expect(step.action.via === "mcp_tool" && step.action.params.registerDomains).toBe(true);
    const beforeBillable = await billableCount(tenantId);

    fakeInboxKit({ domains: [], mailboxesReadyOnBuy: true });
    const executed = await execute(token, step, "registerDomains");

    // The call is REFUSED — and, after the two-leg split, refused in the way
    // that tells the agent to resend one field rather than escalate.
    expect(executed.status).toBe(400);
    expect(executed.code).toBe("registrar_optin_missing");
    // And it converged on nothing: no progress at all.
    expect(await billableCount(tenantId)).toBe(beforeBillable);
  });

  it("the same step UNSTRIPPED converges — the negative above is about the field, not the fixture", async () => {
    const { tenantId, token } = await seedRealTenant(
      [
        { domain: "unstrip0.com", liveMailboxes: 2 },
        { domain: "unstrip1.com", liveMailboxes: 1 },
      ],
      5,
    );
    const step = runnableSetupStep((await derive(tenantId)).steps);
    const beforeBillable = await billableCount(tenantId);

    fakeInboxKit({ domains: [], mailboxesReadyOnBuy: true });
    await execute(token, step);

    expect(await billableCount(tenantId)).toBeGreaterThan(beforeBillable);
  });
});
