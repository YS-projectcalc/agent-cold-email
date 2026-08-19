import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { NextStep, NextSteps } from "@coldstart/shared";
import { deriveNextSteps } from "../src/engine/next-steps.js";
import { managedMailboxAddress, personaSlugFromManagedAddress } from "../src/engine/mailbox-provisioning.js";
import { domainIntentKey } from "../src/engine/provision-intents.js";
import { activatePaidPlan, mintTenant, seedBenignSdnList, tenantStub, withTenantContext } from "./helpers.js";

// BLOCKING-1 (docs/adversarial/customer-continuity-build-gate-2026-08-19.md) —
// `domain_intents.persona_slug` was added by `addColumnIfMissing` and is written
// INSERT-ONLY, so it is permanently NULL for every intent row written before it
// existed: the ENTIRE pre-column paying population. `readProvisioningSnapshot`
// sources the persona from that column alone, `deriveNextSteps` substituted
// `""`, and `slugify("")` ends `|| "hello"` — so the recommendation was planned
// against `hello11@…` addresses matching none of the tenant's real mailboxes,
// every slot counted as NEW, and a step whose prose says "your bill is
// unchanged" shipped beside an `effect` asserting nine mailboxes at +$16.00/mo.
//
// THE FIXTURE IS THE GATE'S OWN EXECUTED REPRO, transcribed from its read-only
// production probe: two ordinal intents with `persona_slug` NULL, four live
// mailboxes whose addresses still carry the persona, and the 60% checkout
// discount the gate inferred from platform `mrrCents: 3960`. It is a state no
// fixture in the 2001-test battery could produce, because every end-to-end
// fixture seeds the one column production leaves NULL (§7.18.4's rule is about
// not pinning a test to a live tenant's HEALTHY shape; a defect repro is the
// opposite job — it must be the shape production is actually in).

interface SeededOrdinal {
  domain: string;
  /** Local parts of the LIVE mailboxes on that domain — written verbatim, never derived from a seed persona. */
  mailboxLocalParts: string[];
}

interface Seed {
  ordinals: SeededOrdinal[];
  /** What `domain_intents.persona_slug` holds. `null` = the pre-column population. */
  personaSlug: string | null;
  billedQuantity?: number;
  discountPct?: number;
}

let seq = 0;

async function seedPreColumnTenant(seed: Seed): Promise<string> {
  const { tenantId } = await mintTenant(`Persona Recovery Co ${++seq}`, "managed");
  await seedBenignSdnList();
  await activatePaidPlan(tenantId, "managed");
  await runInDurableObject(tenantStub(tenantId), (_instance, state) => {
    const sql = state.storage.sql;
    sql.exec(
      `UPDATE tenant_profile
          SET primary_domain = ?, physical_address = ?, sender_identity = ?,
              mailbox_qty_synced = ?, register_domains = 1, checkout_discount_pct = ?
        WHERE id = ?`,
      "authorpitchdesk.com",
      "1 Press Way, Testville, CA 94000",
      "Press Outreach <hello@authorpitchdesk.com>",
      seed.billedQuantity ?? 5,
      seed.discountPct ?? 60,
      tenantId,
    );
    seed.ordinals.forEach((ord, ordinal) => {
      sql.exec(
        `INSERT INTO domain_intents (key, tenant_id, candidate_domain, status, persona_slug, inboxes_each, created_at, updated_at)
         VALUES (?, ?, ?, 'committed', ?, NULL, ?, ?)`,
        domainIntentKey(tenantId, ordinal),
        tenantId,
        ord.domain,
        seed.personaSlug,
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
      for (const localPart of ord.mailboxLocalParts) {
        const email = `${localPart}@${ord.domain}`;
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
  // The backfill is a CONSTRUCTOR one-shot, so the fixture's rows only meet it
  // on a genuine reconstruction — the real path, not a hand-called private
  // method (clock-migration.test.ts / legacy-domain-intent-key.test.ts idiom).
  await evictDurableObject(tenantStub(tenantId));
  return tenantId;
}

function personaSlugs(tenantId: string): Promise<(string | null)[]> {
  return withTenantContext(tenantId, (ctx) =>
    ctx.sql
      .exec<{ persona_slug: string | null }>(
        `SELECT persona_slug FROM domain_intents WHERE tenant_id = ? ORDER BY key`,
        ctx.tenantId,
      )
      .toArray()
      .map((r) => r.persona_slug),
  );
}

function derive(tenantId: string): Promise<NextSteps> {
  return withTenantContext(tenantId, (ctx) => deriveNextSteps(ctx));
}

function stepFor(steps: NextStep[], reason: string): NextStep | undefined {
  return steps.find((s) => s.reason === reason);
}

/** The gate's live state: Mordy's fleet, with the column production left NULL. */
function mordyShape(personaSlug: string | null): Seed {
  return {
    personaSlug,
    ordinals: [
      { domain: "theauthorpitchdesk.com", mailboxLocalParts: ["mordytee11", "mordytee12"] },
      { domain: "goauthorpitchdesk.com", mailboxLocalParts: ["mordytee21", "mordytee22"] },
    ],
    billedQuantity: 5,
    discountPct: 60,
  };
}

describe("B-1(a) — the persona backfill recovers what the address already encodes", () => {
  it("inverts the deterministic address of the live mailboxes and writes the recovered slug", async () => {
    const tenantId = await seedPreColumnTenant(mordyShape(null));
    expect(await personaSlugs(tenantId)).toEqual(["mordytee", "mordytee"]);
  });

  it("is a no-op for an intent that already carries a persona — never re-derives a stamped row", async () => {
    const tenantId = await seedPreColumnTenant(mordyShape("legacypersona"));
    expect(await personaSlugs(tenantId)).toEqual(["legacypersona", "legacypersona"]);
  });

  it("ABSTAINS when the live mailboxes on the domain disagree — an ambiguous inversion writes nothing", async () => {
    const tenantId = await seedPreColumnTenant({
      personaSlug: null,
      // Same ordinal, same domain, two different personas in the local parts:
      // no single slug reproduces both addresses, so nothing is knowable.
      ordinals: [{ domain: "ambiguous.com", mailboxLocalParts: ["mordytee11", "otherguy12"] }],
    });
    expect(await personaSlugs(tenantId)).toEqual([null]);
  });

  it("ABSTAINS when a live mailbox's local part is not an address this platform derives", async () => {
    const tenantId = await seedPreColumnTenant({
      personaSlug: null,
      // A BYO-style / hand-created address: no (ordinal, slot) suffix to strip.
      ordinals: [{ domain: "handmade.com", mailboxLocalParts: ["sales"] }],
    });
    expect(await personaSlugs(tenantId)).toEqual([null]);
  });

  it("ABSTAINS when the ordinal has NO live mailboxes to invert — nothing to recover from", async () => {
    const tenantId = await seedPreColumnTenant({
      personaSlug: null,
      ordinals: [{ domain: "empty.com", mailboxLocalParts: [] }],
    });
    expect(await personaSlugs(tenantId)).toEqual([null]);
  });

  it("is idempotent across reconstructions", async () => {
    const tenantId = await seedPreColumnTenant(mordyShape(null));
    // The first construction (inside the seed) applied it; wake, evict, and let
    // a SECOND construction run against the now-stamped rows.
    expect(await personaSlugs(tenantId)).toEqual(["mordytee", "mordytee"]);
    await evictDurableObject(tenantStub(tenantId));
    expect(await personaSlugs(tenantId)).toEqual(["mordytee", "mordytee"]);
  });
});

describe("B-1(a) — the inversion is the EXACT inverse of managedMailboxAddress", () => {
  it("round-trips every persona shape the forward function accepts", () => {
    const personas = ["mordytee", "hello", "a", "x1", "abc123", "twentycharacterslug1"];
    for (const persona of personas) {
      for (let ordinal = 0; ordinal < 5; ordinal++) {
        for (let slot = 0; slot < 3; slot++) {
          const email = managedMailboxAddress(persona, "round.trip.com", ordinal, slot);
          expect(personaSlugFromManagedAddress(email, "round.trip.com", ordinal, slot)).toBe(persona);
        }
      }
    }
  });

  it("returns undefined for an address this platform never derived", () => {
    expect(personaSlugFromManagedAddress("sales@round.trip.com", "round.trip.com", 0, 0)).toBeUndefined();
    // Right shape, WRONG slot — the suffix names (ordinal 0, slot 0), not slot 1.
    expect(personaSlugFromManagedAddress("mordytee11@round.trip.com", "round.trip.com", 0, 1)).toBeUndefined();
    // Right shape, wrong DOMAIN.
    expect(personaSlugFromManagedAddress("mordytee11@other.com", "round.trip.com", 0, 0)).toBeUndefined();
    // Nothing left after the suffix is stripped — a slug is never empty.
    expect(personaSlugFromManagedAddress("11@round.trip.com", "round.trip.com", 0, 0)).toBeUndefined();
  });
});

describe("B-1 — the gate's executed repro, end to end", () => {
  it("prices the recommendation from the tenant's REAL addresses, not slugify('') -> 'hello'", async () => {
    const tenantId = await seedPreColumnTenant(mordyShape(null));
    const derived = await derive(tenantId);

    // Nothing is owed for this fleet, so the ratified free-headroom sentence is
    // his real step — and its `effect` is the whole claim (§7.18.4).
    expect(derived.status).toBe("none_owed");
    const step = stepFor(derived.steps, "seat_headroom_free");
    expect(step, "seat_headroom_free must be emitted for a 4-of-5 fleet with nothing owed").toBeDefined();

    // THE NUMBERS. Persona lost: newMailboxes=5, provisionedAfter=9, 5560 cents
    // (+$16.00/mo) beside prose reading "your bill is unchanged". Persona
    // recovered: one free mailbox, and 3960 -> 3960 proves the $0 claim
    // in-payload.
    expect(step?.effect?.provisionedAfter).toBe(5);
    expect(step?.effect?.projectedMonthlyCents).toBe(3960);

    // The second half of the finding: `paramsToSupply` is specified as "fields
    // the PLATFORM cannot know". It knows this one.
    if (step?.action.via !== "mcp_tool") throw new Error("expected an mcp_tool action");
    expect(step.action.paramsToSupply).toEqual([]);
    expect(step.action.params.persona).toBe("mordytee");
    expect(step.action.params.distribution).toEqual([3, 2]);
  });
});

describe("B-1(b) — derivation-time abstention when the persona is genuinely unknowable", () => {
  it("emits the step UNPRICED rather than planning against 'hello'", async () => {
    // A live ordinal with NO live mailboxes: the backfill has nothing to invert,
    // so the persona stays unknown AND the planner would have to construct
    // addresses to answer. It abstains — the reconciler's own precedent for a
    // NULL spec (provisioning-reconcile.ts's `skippedNoSpec`).
    const tenantId = await seedPreColumnTenant({
      personaSlug: null,
      ordinals: [{ domain: "unknowable.com", mailboxLocalParts: [] }],
    });
    const derived = await derive(tenantId);

    const step = stepFor(derived.steps, "paid_seats_unprovisioned");
    expect(step, "a paying tenant with nothing provisioned is still owed this step").toBeDefined();
    // NEVER a priced effect derived from an unknowable persona.
    expect(step?.effect).toBeNull();
    // And the prose says WHY there is no number, rather than going quiet.
    expect(step?.why).toMatch(/persona/i);
    if (step?.action.via !== "mcp_tool") throw new Error("expected an mcp_tool action");
    expect(step.action.paramsToSupply).toContain("persona");
    expect(step.action.params).not.toHaveProperty("persona");
  });

  it("still PRICES a tenant that has provisioned nothing at all — no address is ever constructed there", async () => {
    // The §7.17.6 mirror-image rule: the platform must not pretend not to know.
    // With no live ordinal in the target, `planFor` never touches an address,
    // so the plan is persona-INDEPENDENT and the projection is honest.
    const tenantId = await seedPreColumnTenant({ personaSlug: null, ordinals: [] });
    const derived = await derive(tenantId);
    const step = stepFor(derived.steps, "paid_seats_unprovisioned");
    expect(step?.effect?.provisionedAfter).toBe(5);
    expect(step?.effect?.projectedMonthlyCents).toBe(3960);
  });
});
