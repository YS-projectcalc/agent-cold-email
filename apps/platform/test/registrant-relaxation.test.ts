import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SetupInfrastructureInput } from "@coldstart/shared";
import { activatePaidPlan, api, mintTenant, seedBenignSdnList, tenantStub } from "./helpers.js";
import { fakeInboxKit, REGISTRANT } from "./fixtures/inboxkit-workspace.js";

// I2 — RELAX THE `registrant` REFINEMENT (design §7.8, gate L1(i)).
//
// The flagship recommendation this wave emits carries `registerDomains: true`
// (omitting it reads as NOT opted in for the request — `tenant-do.ts`'s
// `optIn: input.registerDomains ?? false` — and 503s a buy-bearing call, which
// is the live incident). It must NOT also carry a `registrant`: that is legal
// PII, and echoing it into a status response an unattended agent replays is not
// something this platform does.
//
// So the zod refinement that made `registrant` mandatory alongside
// `registerDomains: true` is relaxed. The safety property is preserved at the
// point that matters: `assertCompleteRegistrant` still fails loud at the ACTUAL
// buy call site, naming the missing fields, before any purchase.
//
// THE HONEST COST, stated in the design and asserted below: a call with no
// registrant ANYWHERE used to fail at the zod boundary before any vendor touch;
// now it fails at `assertCompleteRegistrant`, which is after `searchLookalikes`
// (a vendor READ). No spend, one wasted read.

const COMPLETE_REGISTRANT = REGISTRANT;

function setupBody(over: Record<string, unknown>): string {
  return JSON.stringify({
    brand: "Relaxation Co",
    primaryDomain: "relaxationco.com",
    domains: 1,
    inboxesEach: 1,
    persona: "Sales",
    physicalAddress: "1 Main St",
    senderIdentity: "Sales Team",
    ...over,
  });
}

async function seedPersistedRegistrant(tenantId: string, registrant: typeof COMPLETE_REGISTRANT): Promise<void> {
  await runInDurableObject(tenantStub(tenantId), (_instance, state) => {
    state.storage.sql.exec(
      `UPDATE tenant_profile SET register_domains = 1, registrant_json = ? WHERE id = ?`,
      JSON.stringify(registrant),
      tenantId,
    );
  });
}

function readProfile(tenantId: string): Promise<{ register_domains: number; registrant_json: string | null }> {
  return runInDurableObject(tenantStub(tenantId), (_instance, state) =>
    state.storage.sql
      .exec<{ register_domains: number; registrant_json: string | null }>(
        `SELECT register_domains, registrant_json FROM tenant_profile WHERE id = ?`,
        tenantId,
      )
      .one(),
  );
}

function registerContactDetails(fixture: ReturnType<typeof fakeInboxKit>): Record<string, unknown>[] {
  return fixture.calls
    .filter((c) => c.path === "/domains/register")
    .map((c) => (c.body as { contact_details: Record<string, unknown> }).contact_details);
}

describe("I2 — the registrant refinement, relaxed", () => {
  it("zod ACCEPTS registerDomains:true with no body registrant", () => {
    const parsed = SetupInfrastructureInput.safeParse(JSON.parse(setupBody({ registerDomains: true })));
    expect(parsed.success).toBe(true);
  });

  it("zod still accepts the complete call, and registrant stays optional on an opt-OUT", () => {
    expect(SetupInfrastructureInput.safeParse(JSON.parse(setupBody({ registerDomains: true, registrant: COMPLETE_REGISTRANT }))).success).toBe(true);
    expect(SetupInfrastructureInput.safeParse(JSON.parse(setupBody({ registerDomains: false }))).success).toBe(true);
  });

  it("zod still rejects a PARTIAL registrant — relaxing 'required' never relaxed 'well-formed'", () => {
    const parsed = SetupInfrastructureInput.safeParse(
      JSON.parse(setupBody({ registerDomains: true, registrant: { firstName: "Jane" } })),
    );
    expect(parsed.success).toBe(false);
  });
});

describe("I2 — registerDomains:true with no body registrant, end to end", () => {
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
    Object.assign(env, { REGISTRAR_PROVIDER: "inboxkit", INBOXKIT_API_KEY: "k", INBOXKIT_WORKSPACE_ID: "w" });
  });

  // THE FLAGSHIP CASE. This is the exact call §7.5's recommendation emits:
  // `registerDomains: true`, no `registrant`, `paramsToSupply: []` — "this call
  // succeeds verbatim". It must reach the buy AND file the tenant's real
  // registrant, not the brand/address-derived partial the port would otherwise
  // carry (the incomplete-payload half of this change).
  it("buys, and files the PERSISTED registrant on the wire", async () => {
    const { token, tenantId } = await mintTenant("Relaxation Co", "managed");
    await activatePaidPlan(tenantId, "managed");
    await seedPersistedRegistrant(tenantId, COMPLETE_REGISTRANT);

    const fixture = fakeInboxKit({ domains: [] });
    const res = await api<{ code?: string; missingFields?: string[] }>("/setup-infrastructure", {
      method: "POST",
      token,
      body: setupBody({ registerDomains: true }),
    });

    expect(res.body?.code).not.toBe("incomplete_registrant");
    const filed = registerContactDetails(fixture);
    expect(filed).toHaveLength(1);
    expect(filed[0]).toMatchObject({
      first_name: COMPLETE_REGISTRANT.firstName,
      last_name: COMPLETE_REGISTRANT.lastName,
      email: COMPLETE_REGISTRANT.email,
      phone: COMPLETE_REGISTRANT.phone,
      city: COMPLETE_REGISTRANT.city,
      country: COMPLETE_REGISTRANT.country,
    });
  });

  // The write-path half. A call that expressed NO opinion about the registrant
  // must not erase the one the tenant already gave — the same reasoning H8b
  // applied to `register_domains` itself, one field over. Nulling it here would
  // make the very next `assertCompleteRegistrant` 400 on a tenant whose
  // registrant is on file, which is the opposite of what relaxing the
  // refinement is for.
  it("leaves the persisted registrant intact — an absent registrant is not a revocation", async () => {
    const { token, tenantId } = await mintTenant("Relaxation Co", "managed");
    await activatePaidPlan(tenantId, "managed");
    await seedPersistedRegistrant(tenantId, COMPLETE_REGISTRANT);

    fakeInboxKit({ domains: [] });
    await api("/setup-infrastructure", { method: "POST", token, body: setupBody({ registerDomains: true }) });

    const row = await readProfile(tenantId);
    expect(row.register_domains).toBe(1);
    expect(JSON.parse(row.registrant_json ?? "null")).toMatchObject({ email: COMPLETE_REGISTRANT.email });
  });

  // The loud-failure half — the safety property the refinement used to hold is
  // preserved, one seam later.
  it("with NO registrant anywhere it 400s naming the missing fields, and buys nothing", async () => {
    const { token, tenantId } = await mintTenant("Relaxation Co", "managed");
    await activatePaidPlan(tenantId, "managed");

    const fixture = fakeInboxKit({ domains: [] });
    const res = await api<{ code?: string; missingFields?: string[] }>("/setup-infrastructure", {
      method: "POST",
      token,
      body: setupBody({ registerDomains: true }),
    });

    expect(res.status).toBe(400);
    expect(res.body?.code).toBe("incomplete_registrant");
    expect(res.body?.missingFields).toEqual(
      expect.arrayContaining(["firstName", "lastName", "email", "phone", "city", "state", "country", "postalCode"]),
    );
    expect(fixture.countOf("/domains/register")).toBe(0);
    // The stated cost: it fails AFTER the candidate search, which is a vendor
    // READ. No purchase, one wasted round trip.
    expect(fixture.countOf("/domains/available")).toBeGreaterThan(0);
  });

  // A body registrant, when supplied, is still authoritative for THIS call —
  // the B1 property (registrar-arming.test.ts (c)) is untouched by relaxing the
  // requirement to supply one.
  it("a supplied registrant still overrides the persisted one", async () => {
    const { token, tenantId } = await mintTenant("Relaxation Co", "managed");
    await activatePaidPlan(tenantId, "managed");
    await seedPersistedRegistrant(tenantId, COMPLETE_REGISTRANT);
    const fresh = { ...COMPLETE_REGISTRANT, firstName: "Bob", email: "bob@example.test" };

    const fixture = fakeInboxKit({ domains: [] });
    await api("/setup-infrastructure", {
      method: "POST",
      token,
      body: setupBody({ registerDomains: true, registrant: fresh }),
    });

    const filed = registerContactDetails(fixture);
    expect(filed).toHaveLength(1);
    expect(filed[0]).toMatchObject({ first_name: "Bob", email: "bob@example.test" });
    expect(JSON.parse((await readProfile(tenantId)).registrant_json ?? "null")).toMatchObject({ firstName: "Bob" });
  });
});
