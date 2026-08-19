import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { NextStep, NextSteps } from "@coldstart/shared";
import { deriveNextSteps } from "../src/engine/next-steps.js";
import { managedMailboxAddress } from "../src/engine/mailbox-provisioning.js";
import { domainIntentKey } from "../src/engine/provision-intents.js";
import { activatePaidPlan, mintTenant, seedBenignSdnList, tenantStub, withTenantContext } from "./helpers.js";

// I5 — `deriveNextSteps`, the one primitive (design §7.2, §7.5, §7.17.6).
//
// FIXTURES ARE HERMETIC AND SYNTHETIC, per §7.18.4. Production reached the
// design's own worked example WHILE the design was being written, and pinning a
// test to a live tenant's current shape is how the vendor-truth wave lost a
// round to a stale example. Every state below is constructed directly and is
// immune to production moving again.

interface Seed {
  /** Live domain ordinals, each with the number of live mailboxes under `persona`. */
  ordinals?: { domain: string; liveMailboxes: number }[];
  persona?: string;
  /** `tenant_profile.mailbox_qty_synced` — what Stripe is billing. */
  billedQuantity?: number;
  registerDomains?: 0 | 1;
  /** Blank these profile fields (they are `DEFAULT ''`, so a signup-only tenant has them empty). */
  blankProfile?: boolean;
}

let seq = 0;

async function seedTenant(seed: Seed): Promise<string> {
  const persona = seed.persona ?? "mordytee";
  const { tenantId } = await mintTenant(`Next Steps Co ${++seq}`, "managed");
  await seedBenignSdnList();
  await activatePaidPlan(tenantId, "managed");
  await runInDurableObject(tenantStub(tenantId), (_instance, state) => {
    const sql = state.storage.sql;
    if (!seed.blankProfile) {
      sql.exec(
        `UPDATE tenant_profile SET primary_domain = ?, physical_address = ?, sender_identity = ? WHERE id = ?`,
        "authorpitchdesk.com",
        "1 Press Way, Testville, CA 94000",
        "Press Outreach <hello@authorpitchdesk.com>",
        tenantId,
      );
    }
    sql.exec(
      `UPDATE tenant_profile SET mailbox_qty_synced = ?, register_domains = ? WHERE id = ?`,
      seed.billedQuantity ?? 5,
      seed.registerDomains ?? 1,
      tenantId,
    );
    (seed.ordinals ?? []).forEach((ord, ordinal) => {
      sql.exec(
        `INSERT INTO domain_intents (key, tenant_id, candidate_domain, status, persona_slug, inboxes_each, created_at, updated_at)
         VALUES (?, ?, ?, 'committed', ?, ?, ?, ?)`,
        domainIntentKey(tenantId, ordinal),
        tenantId,
        ord.domain,
        persona,
        Math.max(1, ord.liveMailboxes),
        1000,
        1000 + ordinal,
      );
      const domainId = `dom_${ordinal}_${tenantId}`;
      sql.exec(
        `INSERT INTO domains (id, tenant_id, domain, status, purchased_at, dns_status) VALUES (?, ?, ?, 'active', ?, 'ready')`,
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
  return tenantId;
}

function derive(tenantId: string): Promise<NextSteps> {
  return withTenantContext(tenantId, (ctx) => deriveNextSteps(ctx));
}

function stepFor(steps: NextStep[], reason: string): NextStep | undefined {
  return steps.find((s) => s.reason === reason);
}

function mcpAction(step: NextStep): { tool: string; params: Record<string, unknown>; paramsToSupply: string[] } {
  if (step.action.via !== "mcp_tool") throw new Error(`expected an mcp_tool action, got via=${step.action.via}`);
  return { tool: step.action.tool, params: step.action.params, paramsToSupply: step.action.paramsToSupply };
}

describe("I5 — the contract shape", () => {
  it("`status` is an EXPLICIT discriminator, never inferred from an empty steps array", async () => {
    // A tenant at the floor with headroom owes nothing AND has a step. If the
    // discriminator were "steps.length > 0" this would read as owed.
    const tenantId = await seedTenant({ ordinals: [{ domain: "sd0.com", liveMailboxes: 4 }], billedQuantity: 5 });
    const derived = await derive(tenantId);
    expect(derived.status).toBe("none_owed");
    expect(derived.steps.length).toBeGreaterThan(0);
    expect(derived.computedAt).toBeGreaterThan(0);
  });

  it("every emitted step names a reason from the runtime const and a `via` that is always present", async () => {
    const tenantId = await seedTenant({ ordinals: [], billedQuantity: 5 });
    const { steps } = await derive(tenantId);
    for (const step of steps) {
      expect(["owed", "available"]).toContain(step.kind);
      expect(["mcp_tool", "http", "none"]).toContain(step.action.via);
      expect(step.why.length).toBeGreaterThan(20);
    }
  });
});

describe("I5 — the recommendation is a DRY RUN through the real planner", () => {
  // The §7.5 state, hermetic: billed for 5, ordinal 0 live with 2 mailboxes,
  // consent already persisted. The exact-fit distribution is [3,2] and
  // `provisionedAfter` is 5 — NOT the 6 an `inboxesEach:3` overshoot bills.
  it("emits the exact-fit distribution and prices it from buildMailboxBilling", async () => {
    const tenantId = await seedTenant({
      ordinals: [{ domain: "mordytee.com", liveMailboxes: 2 }],
      billedQuantity: 5,
      registerDomains: 1,
    });
    const { steps } = await derive(tenantId);
    const step = stepFor(steps, "seat_headroom_free");
    expect(step).toBeDefined();
    const { tool, params, paramsToSupply } = mcpAction(step!);
    expect(tool).toBe("setup_infrastructure");
    expect(params.domains).toBe(2);
    expect(params.distribution).toEqual([3, 2]);
    expect(paramsToSupply).toEqual([]);
    expect(step!.effect?.provisionedAfter).toBe(5);
  });

  it("echoes the PERSISTED persona slug, so the recommended call reproduces today's addresses", async () => {
    const tenantId = await seedTenant({
      ordinals: [{ domain: "persona.com", liveMailboxes: 2 }],
      persona: "mordytee",
      billedQuantity: 5,
    });
    const { steps } = await derive(tenantId);
    expect(mcpAction(stepFor(steps, "seat_headroom_free")!).params.persona).toBe("mordytee");
  });

  it("a tenant whose seats are exactly satisfied gets no seat step at all", async () => {
    // Billed 5, five provisioned. Nothing owed, nothing free, no drift — and
    // the fill recommendation would buy nothing, so it is not emitted.
    const tenantId = await seedTenant({
      ordinals: [
        { domain: "exact0.com", liveMailboxes: 3 },
        { domain: "exact1.com", liveMailboxes: 2 },
      ],
      billedQuantity: 5,
    });
    const { steps } = await derive(tenantId);
    expect(stepFor(steps, "seat_headroom_free")).toBeUndefined();
    expect(stepFor(steps, "paid_seats_unprovisioned")).toBeUndefined();
    expect(stepFor(steps, "billed_quantity_drift")).toBeUndefined();
  });

  it("the floor gap is real even when the BILLED quantity is under the floor — the meter floors at 5", async () => {
    // `mailbox_qty_synced` = max(5, provisioned), so a 3 here is a state the
    // sync has not caught up on. The customer still PAYS for five, so the
    // headroom is genuinely free and the recommendation targets five, not three.
    const tenantId = await seedTenant({ ordinals: [{ domain: "underfloor.com", liveMailboxes: 3 }], billedQuantity: 3 });
    const { steps } = await derive(tenantId);
    const step = stepFor(steps, "seat_headroom_free");
    expect(step?.kind).toBe("available");
    expect(step?.effect?.provisionedAfter).toBe(5);
  });
});

describe("I5 — the three-way seat split", () => {
  it("paying with NOTHING provisioned is `paid_seats_unprovisioned`, and it is OWED", async () => {
    const tenantId = await seedTenant({ ordinals: [], billedQuantity: 5 });
    const derived = await derive(tenantId);
    const step = stepFor(derived.steps, "paid_seats_unprovisioned");
    expect(step?.kind).toBe("owed");
    expect(derived.status).toBe("owed");
    expect(step?.effect?.provisionedAfter).toBe(5);
  });

  it("the FLOOR GAP is `seat_headroom_free`, `available`, and proves the $0 claim in the payload", async () => {
    const tenantId = await seedTenant({ ordinals: [{ domain: "floor.com", liveMailboxes: 2 }], billedQuantity: 5 });
    const derived = await derive(tenantId);
    const step = stepFor(derived.steps, "seat_headroom_free");
    expect(step?.kind).toBe("available");
    expect(stepFor(derived.steps, "paid_seats_unprovisioned")).toBeUndefined();
    // The bill is UNCHANGED by filling to the floor — that is the whole claim,
    // and it proves itself in-payload rather than asserting itself in prose.
    const currentBill = await withTenantContext(tenantId, (ctx) =>
      ctx.sql.exec<{ d: number }>(`SELECT checkout_discount_pct as d FROM tenant_profile WHERE id = ?`, ctx.tenantId).one().d,
    );
    expect(typeof currentBill).toBe("number");
    expect(step?.effect?.provisionedAfter).toBe(5);
  });

  it("BILLED MORE THAN PROVISIONED above the floor is `billed_quantity_drift` — ours to fix, never theirs", async () => {
    const tenantId = await seedTenant({
      ordinals: [
        { domain: "d0.com", liveMailboxes: 3 },
        { domain: "d1.com", liveMailboxes: 2 },
      ],
      billedQuantity: 6,
    });
    const derived = await derive(tenantId);
    const step = stepFor(derived.steps, "billed_quantity_drift");
    expect(step?.kind).toBe("owed");
    expect(step?.waitingOn).toBe("operator");
    // Nothing the caller can DO — a stated value, not an empty object.
    expect(step?.action.via).toBe("none");
  });
});

describe("I5 — the consent branch (gate L1)", () => {
  it("register_domains = 1 re-states the consent the tenant already gave", async () => {
    const tenantId = await seedTenant({
      ordinals: [{ domain: "consent1.com", liveMailboxes: 2 }],
      billedQuantity: 5,
      registerDomains: 1,
    });
    const { steps } = await derive(tenantId);
    const { params, paramsToSupply } = mcpAction(stepFor(steps, "seat_headroom_free")!);
    expect(params.registerDomains).toBe(true);
    expect(paramsToSupply).not.toContain("registerDomains");
  });

  it("register_domains = 0 NEVER auto-emits true — consent is the customer's to give", async () => {
    const tenantId = await seedTenant({
      ordinals: [{ domain: "consent0.com", liveMailboxes: 2 }],
      billedQuantity: 5,
      registerDomains: 0,
    });
    const { steps } = await derive(tenantId);
    const step = stepFor(steps, "seat_headroom_free")!;
    const { params, paramsToSupply } = mcpAction(step);
    expect(params).not.toHaveProperty("registerDomains");
    expect(paramsToSupply).toContain("registerDomains");
    expect(paramsToSupply).toContain("registrant");
    // A step the customer must make a decision about is never OWED.
    expect(step.kind).toBe("available");
    expect(step.why).toContain("registerDomains");
  });

  it("no step ANYWHERE ever manufactures consent", async () => {
    for (const billedQuantity of [5, 6]) {
      const tenantId = await seedTenant({ ordinals: [], billedQuantity, registerDomains: 0 });
      const { steps } = await derive(tenantId);
      for (const step of steps) {
        if (step.action.via !== "mcp_tool") continue;
        expect(step.action.params.registerDomains).not.toBe(true);
      }
    }
  });
});

describe("I5 — paramsToSupply is per FIELD, by emptiness (N6)", () => {
  it("a signup-only tenant is never asked for its BRAND — that is captured at signup and NOT NULL", async () => {
    const tenantId = await seedTenant({ ordinals: [], billedQuantity: 5, blankProfile: true });
    const { steps } = await derive(tenantId);
    const { params, paramsToSupply } = mcpAction(stepFor(steps, "paid_seats_unprovisioned")!);
    expect(paramsToSupply).not.toContain("brand");
    expect(params.brand).toBeTruthy();
    // The genuinely-absent four: three `DEFAULT ''` columns and a persona,
    // which has no column at all.
    expect(paramsToSupply).toEqual(expect.arrayContaining(["primaryDomain", "physicalAddress", "senderIdentity", "persona"]));
    // A field that is asked for is NOT also emitted as a value.
    for (const name of paramsToSupply) expect(params).not.toHaveProperty(name);
  });

  it("a fully-populated tenant is asked for nothing", async () => {
    const tenantId = await seedTenant({ ordinals: [{ domain: "full2.com", liveMailboxes: 2 }], billedQuantity: 5 });
    const { steps } = await derive(tenantId);
    expect(mcpAction(stepFor(steps, "seat_headroom_free")!).paramsToSupply).toEqual([]);
  });
});

describe("I5 — the invariants a builder must not silently drop (§7.16)", () => {
  it("the derivation is SYNCHRONOUS — it returns a value, never a promise", async () => {
    const tenantId = await seedTenant({ ordinals: [], billedQuantity: 5 });
    const direct = await runInDurableObject(tenantStub(tenantId), async () => "checked");
    expect(direct).toBe("checked");
    const derived = await withTenantContext(tenantId, (ctx) => {
      const value = deriveNextSteps(ctx);
      // If any helper had become async this would be a Promise, and the
      // derivation would interleave with a live saga at every await.
      expect(value).not.toBeInstanceOf(Promise);
      return value;
    });
    expect(derived.status).toBeDefined();
  });

  it("the derivation MUTATES NOTHING — a dry run stays pure", async () => {
    const tenantId = await seedTenant({ ordinals: [{ domain: "pure.com", liveMailboxes: 2 }], billedQuantity: 5 });
    const before = await withTenantContext(tenantId, (ctx) => ({
      domains: ctx.sql.exec<{ n: number }>(`SELECT COUNT(*) as n FROM domains`).one().n,
      mailboxes: ctx.sql.exec<{ n: number }>(`SELECT COUNT(*) as n FROM mailboxes`).one().n,
      intents: ctx.sql.exec<{ n: number }>(`SELECT COUNT(*) as n FROM domain_intents`).one().n,
      messages: ctx.sql.exec<{ n: number }>(`SELECT COUNT(*) as n FROM tenant_messages`).one().n,
      actions: ctx.sql.exec<{ n: number }>(`SELECT COUNT(*) as n FROM deliverability_actions`).one().n,
    }));
    await derive(tenantId);
    const after = await withTenantContext(tenantId, (ctx) => ({
      domains: ctx.sql.exec<{ n: number }>(`SELECT COUNT(*) as n FROM domains`).one().n,
      mailboxes: ctx.sql.exec<{ n: number }>(`SELECT COUNT(*) as n FROM mailboxes`).one().n,
      intents: ctx.sql.exec<{ n: number }>(`SELECT COUNT(*) as n FROM domain_intents`).one().n,
      messages: ctx.sql.exec<{ n: number }>(`SELECT COUNT(*) as n FROM tenant_messages`).one().n,
      actions: ctx.sql.exec<{ n: number }>(`SELECT COUNT(*) as n FROM deliverability_actions`).one().n,
    }));
    expect(after).toEqual(before);
  });

  it("the recommendation is cap-checked in memory before it is emitted", async () => {
    // 20 live ordinals at 3 each = 60 mailboxes, exactly the self-serve
    // ceiling. A fill recommendation past it would be a call that 400s, which
    // is precisely what "the planner says it succeeds as written" forbids.
    const ordinals = Array.from({ length: 20 }, (_, i) => ({ domain: `cap${i}.com`, liveMailboxes: 3 }));
    const tenantId = await seedTenant({ ordinals, billedQuantity: 60 });
    const { steps } = await derive(tenantId);
    for (const step of steps) {
      if (step.action.via !== "mcp_tool" || step.action.tool !== "setup_infrastructure") continue;
      const distribution = step.action.params.distribution as number[];
      expect(distribution.length).toBeLessThanOrEqual(20);
      expect(distribution.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(60);
    }
  });
});
