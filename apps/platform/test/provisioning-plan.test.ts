import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { planFor, readProvisioningSnapshot } from "../src/engine/provisioning-plan.js";
import { managedMailboxAddress } from "../src/engine/mailbox-provisioning.js";
import { domainIntentKey } from "../src/engine/provision-intents.js";
import { mintTenant, tenantStub, withTenantContext } from "./helpers.js";

// I1 CHARACTERIZATION MATRIX — the planner extraction (design §7.3).
//
// The extraction moves `planProvisioning`'s body out of engine/provisioning.ts
// into a snapshot + a pure `planFor`, and changes the TARGET from
// `{domains, inboxesEach}` to `{persona, distribution}`. Two properties are
// pinned here because both are load-bearing and neither is visible from the
// saga's own tests:
//
//   1. BEHAVIOUR IS UNCHANGED. Every row of the matrix below states the number
//      the pre-extraction `planProvisioning` produced for the same state, so a
//      refactor that quietly changed a count reddens here rather than at a
//      spend guard in production.
//   2. `newMailboxes` IS NOT UNDERSTATED WHEN THE PERSONA CHANGES. The slot
//      count is derived from `managedMailboxAddress`, which is keyed on the
//      persona — so a call that changes it targets addresses no live mailbox
//      fills. Counting live mailbox ROWS instead would report 0 new and size
//      both `assertWithinProvisioningCap` and the quoteOnly projection too
//      small. provisioning.ts:106-109 calls that "the one direction a spend
//      guard must never be wrong in"; v1's matrix could not be green on both
//      sides of it, so this one pins the direction explicitly.

interface SeedDomain {
  ordinal: number;
  domain: string;
  /** The intent row's status — only 'committed' resolves to a live domain. */
  status?: string;
  /** Live mailbox local-part slots on this domain, as (personaSlug, slot) pairs. */
  mailboxes?: { personaSlug: string; slot: number }[];
  /** Omit the `domains` row entirely (an intent with no live domain). */
  noDomainRow?: boolean;
}

async function seedTenant(brand: string, seeds: SeedDomain[]): Promise<string> {
  const { tenantId } = await mintTenant(brand, "managed");
  await runInDurableObject(tenantStub(tenantId), (_instance, state) => {
    const sql = state.storage.sql;
    for (const seed of seeds) {
      sql.exec(
        `INSERT INTO domain_intents (key, tenant_id, candidate_domain, status, persona_slug, inboxes_each, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        domainIntentKey(tenantId, seed.ordinal),
        tenantId,
        seed.domain,
        seed.status ?? "committed",
        seed.mailboxes?.[0]?.personaSlug ?? null,
        seed.mailboxes?.length ?? null,
        1000 + seed.ordinal,
        1000 + seed.ordinal,
      );
      if (seed.noDomainRow) continue;
      const domainId = `dom_${seed.ordinal}_${brand.replace(/\W/g, "")}`;
      sql.exec(
        `INSERT INTO domains (id, tenant_id, domain, status, purchased_at, dns_status) VALUES (?, ?, ?, 'active', ?, 'ready')`,
        domainId,
        tenantId,
        seed.domain,
        1000,
      );
      for (const mailbox of seed.mailboxes ?? []) {
        const email = managedMailboxAddress(mailbox.personaSlug, seed.domain, seed.ordinal, mailbox.slot);
        sql.exec(
          `INSERT INTO mailboxes (id, tenant_id, domain_id, domain, email, daily_cap, warmup_started_at, created_at)
           VALUES (?, ?, ?, ?, ?, 5, 1000, 1000)`,
          `mbx_${email}`,
          tenantId,
          domainId,
          seed.domain,
          email,
        );
      }
    }
  });
  return tenantId;
}

describe("I1 — planner extraction characterization", () => {
  it("a tenant with nothing provisioned owes every domain and every slot", async () => {
    const tenantId = await seedTenant("Plan Empty", []);
    const plan = await withTenantContext(tenantId, (ctx) =>
      planFor(readProvisioningSnapshot(ctx), { persona: "Mordy Tee", distribution: [3, 2] }),
    );
    expect(plan.newDomains).toBe(2);
    expect(plan.newMailboxes).toBe(5);
    expect(plan.satisfied.size).toBe(0);
  });

  it("resumes a committed ordinal and counts only the unfilled slots", async () => {
    const tenantId = await seedTenant("Plan Partial", [
      {
        ordinal: 0,
        domain: "mordytee.com",
        mailboxes: [
          { personaSlug: "mordytee", slot: 0 },
          { personaSlug: "mordytee", slot: 1 },
        ],
      },
    ]);
    const plan = await withTenantContext(tenantId, (ctx) =>
      planFor(readProvisioningSnapshot(ctx), { persona: "mordytee", distribution: [3, 2] }),
    );
    // ordinal 0 resumes: 1 of its 3 slots is unfilled. ordinal 1 is untouched.
    expect(plan.newDomains).toBe(1);
    expect(plan.newMailboxes).toBe(3);
    expect(plan.satisfied.size).toBe(1);
  });

  it("carries the domains row ID, not just its name (gate B3 — the lossy-snapshot half)", async () => {
    const tenantId = await seedTenant("Plan Id", [{ ordinal: 0, domain: "carriesid.com" }]);
    const { plan, rowId } = await withTenantContext(tenantId, (ctx) => ({
      plan: planFor(readProvisioningSnapshot(ctx), { persona: "p", distribution: [1] }),
      rowId: ctx.sql.exec<{ id: string }>(`SELECT id FROM domains WHERE domain = 'carriesid.com'`).one().id,
    }));
    expect(plan.satisfied.get(0)).toEqual({ id: rowId, domain: "carriesid.com" });
  });

  it("an intent that is NOT 'committed' is not satisfied, even with a live domains row", async () => {
    const tenantId = await seedTenant("Plan Intent", [{ ordinal: 0, domain: "notyet.com", status: "intent" }]);
    const plan = await withTenantContext(tenantId, (ctx) =>
      planFor(readProvisioningSnapshot(ctx), { persona: "p", distribution: [2] }),
    );
    expect(plan.satisfied.size).toBe(0);
    expect(plan.newDomains).toBe(1);
    expect(plan.newMailboxes).toBe(2);
  });

  it("a committed intent whose domains row is gone is not satisfied", async () => {
    const tenantId = await seedTenant("Plan Dangling", [{ ordinal: 0, domain: "gone.com", noDomainRow: true }]);
    const plan = await withTenantContext(tenantId, (ctx) =>
      planFor(readProvisioningSnapshot(ctx), { persona: "p", distribution: [2] }),
    );
    expect(plan.satisfied.size).toBe(0);
    expect(plan.newDomains).toBe(1);
    expect(plan.newMailboxes).toBe(2);
  });

  it("a released domain does not satisfy its ordinal", async () => {
    const tenantId = await seedTenant("Plan Released", [{ ordinal: 0, domain: "released.com" }]);
    await runInDurableObject(tenantStub(tenantId), (_i, state) => {
      state.storage.sql.exec(`UPDATE domains SET status = 'released' WHERE tenant_id = ?`, tenantId);
    });
    const plan = await withTenantContext(tenantId, (ctx) =>
      planFor(readProvisioningSnapshot(ctx), { persona: "p", distribution: [1] }),
    );
    expect(plan.satisfied.size).toBe(0);
    expect(plan.newDomains).toBe(1);
  });

  it("a released mailbox leaves its slot unfilled", async () => {
    const tenantId = await seedTenant("Plan Released Mbx", [
      { ordinal: 0, domain: "relmbx.com", mailboxes: [{ personaSlug: "sender", slot: 0 }] },
    ]);
    await runInDurableObject(tenantStub(tenantId), (_i, state) => {
      state.storage.sql.exec(`UPDATE mailboxes SET released_at = 1 WHERE tenant_id = ?`, tenantId);
    });
    const plan = await withTenantContext(tenantId, (ctx) =>
      planFor(readProvisioningSnapshot(ctx), { persona: "sender", distribution: [1] }),
    );
    expect(plan.satisfied.size).toBe(1);
    expect(plan.newMailboxes).toBe(1);
  });

  // ── THE SPEND-GUARD DIRECTION ──────────────────────────────────────────────
  it("a persona CHANGE plans against the NEW addresses — newMailboxes is never understated", async () => {
    const tenantId = await seedTenant("Plan Persona", [
      {
        ordinal: 0,
        domain: "persona.com",
        mailboxes: [
          { personaSlug: "oldpersona", slot: 0 },
          { personaSlug: "oldpersona", slot: 1 },
          { personaSlug: "oldpersona", slot: 2 },
        ],
      },
    ]);
    const { same, changed } = await withTenantContext(tenantId, (ctx) => {
      const snap = readProvisioningSnapshot(ctx);
      return {
        same: planFor(snap, { persona: "oldpersona", distribution: [3] }),
        changed: planFor(snap, { persona: "A Brand New Persona", distribution: [3] }),
      };
    });
    // Same persona: every slot's deterministic address already exists.
    expect(same.newMailboxes).toBe(0);
    // Changed persona: three addresses nothing fills. Counting live mailbox
    // ROWS would report 0 here, and 0 is the answer that under-sizes the cap.
    expect(changed.newMailboxes).toBe(3);
    expect(changed.satisfied.size).toBe(1);
  });

  it("the persona is slugified by the planner, so a raw persona and its slug plan identically", async () => {
    const tenantId = await seedTenant("Plan Slug", [
      { ordinal: 0, domain: "slug.com", mailboxes: [{ personaSlug: "mordytee", slot: 0 }] },
    ]);
    const { raw, slug } = await withTenantContext(tenantId, (ctx) => {
      const snap = readProvisioningSnapshot(ctx);
      return {
        raw: planFor(snap, { persona: "Mordy Tee", distribution: [2] }),
        slug: planFor(snap, { persona: "mordytee", distribution: [2] }),
      };
    });
    expect(raw.newMailboxes).toBe(slug.newMailboxes);
    expect(raw.newMailboxes).toBe(1);
  });

  // ── THE UNIFORM WIDENING ───────────────────────────────────────────────────
  it("a uniform distribution reproduces the legacy {domains, inboxesEach} target exactly", async () => {
    const tenantId = await seedTenant("Plan Uniform", [
      { ordinal: 0, domain: "uniform.com", mailboxes: [{ personaSlug: "sender", slot: 0 }] },
    ]);
    const plan = await withTenantContext(tenantId, (ctx) =>
      // The legacy shape {domains: 3, inboxesEach: 2}, widened at the boundary.
      planFor(readProvisioningSnapshot(ctx), { persona: "sender", distribution: [2, 2, 2] }),
    );
    expect(plan.newDomains).toBe(2);
    // ordinal 0: 1 of 2 slots filled -> 1 new; ordinals 1+2: 2 each -> 4. Total 5.
    expect(plan.newMailboxes).toBe(5);
  });

  it("a per-ordinal distribution narrows one ordinal without moving another's addresses", async () => {
    const tenantId = await seedTenant("Plan Distribution", [
      { ordinal: 0, domain: "dist0.com", mailboxes: [{ personaSlug: "sender", slot: 0 }] },
      { ordinal: 1, domain: "dist1.com", mailboxes: [{ personaSlug: "sender", slot: 0 }] },
    ]);
    const { wide, narrowed } = await withTenantContext(tenantId, (ctx) => {
      const snap = readProvisioningSnapshot(ctx);
      return {
        wide: planFor(snap, { persona: "sender", distribution: [3, 3] }),
        narrowed: planFor(snap, { persona: "sender", distribution: [3, 2] }),
      };
    });
    expect(wide.newMailboxes).toBe(4);
    // Narrowing ordinal 1 from 3 slots to 2 drops exactly one slot. It moves no
    // surviving address: managedMailboxAddress is keyed on (ordinal, slot) and
    // never on the per-domain count (gate R7's failed attack).
    expect(narrowed.newMailboxes).toBe(3);
    expect(narrowed.satisfied.get(1)?.domain).toBe("dist1.com");
  });

  // ── THE SNAPSHOT ───────────────────────────────────────────────────────────
  it("the snapshot carries the last-used persona slug for the recommendation", async () => {
    const tenantId = await seedTenant("Plan Persona Slug", [
      { ordinal: 0, domain: "psl0.com", mailboxes: [{ personaSlug: "firstpersona", slot: 0 }] },
      { ordinal: 1, domain: "psl1.com", mailboxes: [{ personaSlug: "laterpersona", slot: 0 }] },
    ]);
    const snap = await withTenantContext(tenantId, (ctx) => readProvisioningSnapshot(ctx));
    expect(snap.personaSlug).toBe("laterpersona");
    expect(snap.intentsByOrdinal.get(0)?.candidateDomain).toBe("psl0.com");
    expect(snap.intentsByOrdinal.get(1)?.live?.domain).toBe("psl1.com");
  });

  it("a tenant that has never provisioned has a NULL persona slug", async () => {
    const tenantId = await seedTenant("Plan No Persona", []);
    const snap = await withTenantContext(tenantId, (ctx) => readProvisioningSnapshot(ctx));
    expect(snap.personaSlug).toBeNull();
    expect(snap.intentsByOrdinal.size).toBe(0);
  });

  it("the snapshot is read ONCE and re-plans in memory — no SQL per candidate target", async () => {
    const tenantId = await seedTenant("Plan Memory", [
      { ordinal: 0, domain: "mem.com", mailboxes: [{ personaSlug: "sender", slot: 0 }] },
    ]);
    const results = await withTenantContext(tenantId, (ctx) => {
      const snap = readProvisioningSnapshot(ctx);
      // Evaluating many candidate targets against ONE snapshot is what
      // deriveNextSteps does, and `planFor` is handed no TenantContext at all —
      // so "no SQL inside the candidate loop" (§7.16 #2) is structural rather
      // than a convention a later edit can quietly break.
      return [1, 2, 3, 4, 5].map((n) => planFor(snap, { persona: "sender", distribution: [n] }).newMailboxes);
    });
    expect(results).toEqual([0, 1, 2, 3, 4]);
  });
});
