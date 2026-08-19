import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { RegistrarUnarmedError, SetupInfrastructureInput, VendorError } from "@coldstart/shared";
import { CapacityPendingError, IncompleteRegistrantError } from "@coldstart/shared";
import { VirtualClock } from "../src/clock.js";
import { createVendorAdapters, type VendorAdapterBundle } from "../src/vendors/factory.js";
import { RegistrarUnarmedDomainPort } from "../src/vendors/real/domain-port.js";
import { RealInboxKitDomainPort } from "../src/vendors/real/inboxkit-domain-port.js";
import { withSpendCeiling } from "../src/engine/spend-ceiling.js";
import { provisionDomainWithMailboxes } from "../src/engine/provisioning.js";
import { assertCompleteRegistrant } from "../src/vendors/registrar-arming.js";
import type { TenantContext } from "../src/tenant-context.js";
import { activatePaidPlan, api, mintTenant, seedBenignSdnList, signup, tenantStub, withTenantContext } from "./helpers.js";
import {
  IK_DOMAIN_AVAILABLE,
  IK_DOMAIN_REGISTER_WALLET_SUCCESS,
  IK_NAMESERVERS_RESULT,
  IK_PROPAGATION_CONFIRMED,
  IK_MAILBOX_BUY_SUCCESS,
  IK_MAILBOX_LIST_SUCCESS,
  IK_WARMUP_ADD_SUCCESS,
  IK_API_KEY,
  IK_WORKSPACE_ID,
} from "./fixtures/inboxkit.js";

// G5 gate (a) follow-up (2026-07-27) — InboxKit-as-registrar arming. Founder
// rulings: (1) 2026-07-21 "InboxKit-as-registrar is per-tenant opt-in only,
// never a default"; (2) G5 gate (a) decoupling
// (docs/adversarial/ga-gates-design-review-2026-07-23.md) must stay intact;
// (3) vendor-spend ceiling + slot caps govern domain spend exactly as mailbox
// spend. This file proves the two-leg (env-armed AND tenant-opted-in) branch
// and the spend choke-point coverage for the new 'domain' kind path.

const clock = new VirtualClock(Date.now(), 0, 1);
const INBOXKIT_CONFIG = { apiKey: IK_API_KEY, workspaceId: IK_WORKSPACE_ID };
const COMPLETE_REGISTRANT = {
  firstName: "Jane",
  lastName: "Registrant",
  email: "registrant@example.test",
  phone: "+15550100",
  organization: "Example LLC",
  addressLine1: "1 Test Way",
  city: "Testville",
  state: "CA",
  country: "US",
  postalCode: "94000",
};

interface TenantDOWithBuildAdapters {
  buildAdapters(): VendorAdapterBundle;
}

// Distinguishable registrants for the B1 "this call is authoritative at buy
// time" tests: R1 is a PRIOR persisted registrant, R2 is what a later call
// passes. The domain buy must file whichever registrant the CURRENT call is
// authoritative for — never a stale persisted one.
const REGISTRANT_R1 = { ...COMPLETE_REGISTRANT, firstName: "Alice", email: "alice@example.test" };
const REGISTRANT_R2 = { ...COMPLETE_REGISTRANT, firstName: "Bob", email: "bob@example.test" };

interface RecordedInboxKitCall {
  url: string;
  method: string;
  body: unknown;
}

/**
 * Routes the InboxKit vendor calls a REAL setup_infrastructure makes to their
 * captured fixtures (test/fixtures/inboxkit.ts) and records each one, so a test
 * can assert whether — and with which contact_details — the domain buy
 * (POST /domains/register) fired. Only the Worker-internal InboxKitClient fetch
 * routes through globalThis.fetch (SELF.fetch, which api() uses, is a SEPARATE
 * cloudflare:test harness binding — proven by the stale-row test asserting an
 * exact vendor call count), so these recorded calls are exactly the vendor
 * round trips, nothing else. A real paid provision always ends in a non-2xx
 * AFTER the domain buy (the real BillingPort is a dark NotActivatedError stub,
 * and the warmup fixtures don't line up with the freshly-bought domain) — the
 * domain buy and its filed registrant are the B1-relevant observation, exactly
 * as the adversary's live repro established.
 */
function installInboxKitFetchMock(): RecordedInboxKitCall[] {
  const calls: RecordedInboxKitCall[] = [];
  const json = (obj: unknown): Response =>
    new Response(JSON.stringify(obj), { status: 200, headers: { "content-type": "application/json" } });
  vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = String(init?.method ?? "GET").toUpperCase();
    const bodyText = typeof init?.body === "string" ? init.body : undefined;
    calls.push({ url, method, body: bodyText ? JSON.parse(bodyText) : undefined });
    if (url.includes("/domains/available")) return json(IK_DOMAIN_AVAILABLE);
    if (url.includes("/domains/register")) return json(IK_DOMAIN_REGISTER_WALLET_SUCCESS);
    if (url.includes("/domains/nameservers/check-propagation")) return json(IK_PROPAGATION_CONFIRMED);
    if (url.includes("/domains/nameservers")) return json(IK_NAMESERVERS_RESULT);
    if (url.includes("/mailboxes/buy")) return json(IK_MAILBOX_BUY_SUCCESS);
    if (url.includes("/mailboxes/list")) return json(IK_MAILBOX_LIST_SUCCESS);
    if (url.includes("/warmup/add")) return json(IK_WARMUP_ADD_SUCCESS);
    return json({ error: false });
  }) as typeof fetch);
  return calls;
}

function domainBuyCalls(calls: RecordedInboxKitCall[]): RecordedInboxKitCall[] {
  return calls.filter((c) => c.url.includes("/domains/register") && c.method === "POST");
}

function buyContactDetails(call: RecordedInboxKitCall): Record<string, string> {
  return (call.body as { contact_details: Record<string, string> }).contact_details;
}

describe("createVendorAdapters — registrar arming two-leg decoupling", () => {
  // (a) THE decoupling regression test — env armed WITHOUT tenant opt-in must
  // NEVER wire a real domain port. RED-proven by stashing the factory's optIn
  // check (quoted in the build report): temporarily changing
  // `useInboxKitRegistrar` to read only `registrarArming?.armed` (dropping the
  // `&& registrarArming?.optIn` conjunct) makes this test fail.
  it("(a) armed (env) WITHOUT opt-in (tenant) → hard-block, never InboxKit-as-registrar", async () => {
    const bundle = createVendorAdapters("managed", clock, true, undefined, INBOXKIT_CONFIG, {
      armed: true,
      optIn: false,
      registrant: COMPLETE_REGISTRANT,
    });
    expect(bundle.kind).toBe("real");
    expect(bundle.domain).toBeInstanceOf(RegistrarUnarmedDomainPort);
    expect(bundle.domain).not.toBeInstanceOf(RealInboxKitDomainPort);
    await expect(bundle.domain.buy("evil-lookalike.com", "k1")).rejects.toBeInstanceOf(RegistrarUnarmedError);
  });

  // (b) opt-in (tenant) WITHOUT armed (env) → hard-block too — the inverse leg.
  it("(b) opt-in (tenant) WITHOUT armed (env) → hard-block, never InboxKit-as-registrar", async () => {
    const bundle = createVendorAdapters("managed", clock, true, undefined, INBOXKIT_CONFIG, {
      armed: false,
      optIn: true,
      registrant: COMPLETE_REGISTRANT,
    });
    expect(bundle.kind).toBe("real");
    expect(bundle.domain).toBeInstanceOf(RegistrarUnarmedDomainPort);
    await expect(bundle.domain.buy("evil-lookalike.com", "k1")).rejects.toBeInstanceOf(RegistrarUnarmedError);
  });

  // (c) BOTH legs true → the real InboxKit-as-registrar port is selected, and
  // it actually reaches InboxKit's client (fixture-stubbed fetch — no live
  // network call).
  it("(c) armed AND opted-in → RealInboxKitDomainPort selected and functional (fixture client, no live calls)", async () => {
    const bundle = createVendorAdapters("managed", clock, true, undefined, INBOXKIT_CONFIG, {
      armed: true,
      optIn: true,
      registrant: COMPLETE_REGISTRANT,
    });
    expect(bundle.kind).toBe("real");
    expect(bundle.domain).toBeInstanceOf(RealInboxKitDomainPort);

    const spy = vi.spyOn(globalThis, "fetch").mockImplementationOnce(
      async () =>
        new Response(JSON.stringify(IK_DOMAIN_REGISTER_WALLET_SUCCESS), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    try {
      const result = await bundle.domain.buy("acme-lookalike.com", "k1");
      expect(result).toEqual({
        domain: "acme-lookalike.com",
        purchasedAt: expect.any(Number),
        registrar: "inboxkit",
        // A registered domain is one the vendor HOLDS — the discriminator that
        // decides which DNS operation applies to it (INCIDENT 2026-08-05).
        connectionType: "purchased",
      });
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("SetupInfrastructureInput — registerDomains backward compatibility", () => {
  // (e) absent field parses to false (existing callers unaffected).
  // H8b (INCIDENT 2026-08-05, pipeline F2) changed this contract deliberately.
  // The field is now OPTIONAL with no default, so absent is DISTINGUISHABLE
  // from an explicit false: absent leaves the tenant's persisted consent alone,
  // where the old `.default(false)` silently WIPED it on any call that merely
  // omitted the field. Port selection still treats absent as not-opted-in (the
  // B1 money direction, asserted separately below) — only the WRITE changed.
  it("(e) omitting registerDomains leaves it UNDEFINED (absent is not false — H8b)", () => {
    const parsed = SetupInfrastructureInput.parse({
      brand: "Acme",
      primaryDomain: "acme.com",
      domains: 1,
      inboxesEach: 1,
      persona: "Sales",
      physicalAddress: "1 Main St, Anytown, ST 00000",
      senderIdentity: "Sales Team",
    });
    expect(parsed.registerDomains).toBeUndefined();
  });

  // Mechanical fix (registrant-capture follow-up): registerDomains:true now
  // REQUIRES `registrant` at the zod boundary (see the (a)/(b)/(c)/(d) suite
  // below) — this test's own subject is registerDomains parsing through, not
  // registrant absence, so it now supplies COMPLETE_REGISTRANT alongside it.
  it("registerDomains:true parses through explicitly", () => {
    const parsed = SetupInfrastructureInput.parse({
      brand: "Acme",
      primaryDomain: "acme.com",
      domains: 1,
      inboxesEach: 1,
      persona: "Sales",
      physicalAddress: "1 Main St, Anytown, ST 00000",
      senderIdentity: "Sales Team",
      registerDomains: true,
      registrant: COMPLETE_REGISTRANT,
    });
    expect(parsed.registerDomains).toBe(true);
  });
});

describe("TenantDO buildAdapters — registrar arming end-to-end (persisted per-tenant opt-in)", () => {
  const saved = {
    REGISTRAR_PROVIDER: env.REGISTRAR_PROVIDER,
    INBOXKIT_API_KEY: env.INBOXKIT_API_KEY,
    INBOXKIT_WORKSPACE_ID: env.INBOXKIT_WORKSPACE_ID,
  };
  afterEach(() => Object.assign(env, saved));

  beforeEach(async () => {
    await seedBenignSdnList();
  });

  it("REGISTRAR_PROVIDER=inboxkit armed, but a freshly-provisioned tenant never opted in → domain stays the hard-block", async () => {
    Object.assign(env, { REGISTRAR_PROVIDER: "inboxkit", INBOXKIT_API_KEY: "k", INBOXKIT_WORKSPACE_ID: "w" });
    const { tenantId } = await mintTenant("Never Opted In Co", "managed");
    await activatePaidPlan(tenantId, "managed");

    await runInDurableObject(tenantStub(tenantId), (instance) => {
      const bundle = (instance as unknown as TenantDOWithBuildAdapters).buildAdapters();
      expect(bundle.kind).toBe("real");
      expect(bundle.domain).toBeInstanceOf(RegistrarUnarmedDomainPort);
      expect(bundle.domain).not.toBeInstanceOf(RealInboxKitDomainPort);
    });
  });

  it("REGISTRAR_PROVIDER=inboxkit armed AND tenant_profile.register_domains=1 (persisted opt-in) → RealInboxKitDomainPort", async () => {
    Object.assign(env, { REGISTRAR_PROVIDER: "inboxkit", INBOXKIT_API_KEY: "k", INBOXKIT_WORKSPACE_ID: "w" });
    const { tenantId } = await mintTenant("Opted In Co", "managed");
    await activatePaidPlan(tenantId, "managed");

    // Simulates the persisted result of a prior setup_infrastructure call with
    // registerDomains:true (provisioning.ts persists this column exactly like
    // brand/primary_domain/physical_address/sender_identity).
    await runInDurableObject(tenantStub(tenantId), (_instance, state) => {
      state.storage.sql.exec(`UPDATE tenant_profile SET register_domains = 1 WHERE id = ?`, tenantId);
    });

    await runInDurableObject(tenantStub(tenantId), (instance) => {
      const bundle = (instance as unknown as TenantDOWithBuildAdapters).buildAdapters();
      expect(bundle.kind).toBe("real");
      expect(bundle.domain).toBeInstanceOf(RealInboxKitDomainPort);
    });
  });
});

describe("withSpendCeiling — 'domain' kind meters against the SAME ceiling as mailbox spend", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM vendor_spend_entries").run();
    await env.DB.prepare("DELETE FROM vendor_spend_ledger").run();
    await env.DB.prepare("DELETE FROM vendor_slot_state").run();
  });

  function realCtx<T>(tenantId: string, fn: (ctx: TenantContext) => Promise<T>): Promise<T> {
    return withTenantContext(tenantId, (ctx) => fn({ ...ctx, adapters: { ...ctx.adapters, kind: "real" } }));
  }

  it("(d) a domain buy reserves+commits COST_DOMAIN_CENTS against the SAME per-month ledger row mailbox spend uses", async () => {
    const { tenantId } = await mintTenant("Domain Spend Co", "managed");
    await realCtx(tenantId, async (ctx) => {
      const result = await withSpendCeiling(ctx, "domain", async () => "bought-domain");
      expect(result).toBe("bought-domain");
      const pk = new Date(ctx.clock.now()).toISOString().slice(0, 7);
      const row = await env.DB.prepare(
        `SELECT reserved_cents, committed_cents FROM vendor_spend_ledger WHERE period_key = ?`,
      )
        .bind(pk)
        .first<{ reserved_cents: number; committed_cents: number }>();
      expect(row?.committed_cents).toBe(1500); // DEFAULT_COST_DOMAIN_CENTS
      expect(row?.reserved_cents).toBe(0);
    });
  });

  it("(d) a domain buy that would exceed the ceiling is blocked with CapacityPendingError, no charge", async () => {
    const { tenantId } = await mintTenant("Domain Ceiling Co", "managed");
    await realCtx(tenantId, async (ctx) => {
      const now = ctx.clock.now();
      const pk = new Date(now).toISOString().slice(0, 7);
      // Pre-seed a ceiling far below the domain cost (1500¢ default) so the
      // very first domain buy attempt is rejected.
      await env.DB.prepare(
        `INSERT INTO vendor_spend_ledger (period_key, reserved_cents, committed_cents, ceiling_cents, updated_at)
         VALUES (?, 0, 0, ?, ?)`,
      )
        .bind(pk, 500, now)
        .run();

      let called = false;
      await expect(
        withSpendCeiling(ctx, "domain", async () => {
          called = true;
          return "should not run";
        }),
      ).rejects.toBeInstanceOf(CapacityPendingError);
      expect(called).toBe(false);

      const row = await env.DB.prepare(
        `SELECT reserved_cents, committed_cents FROM vendor_spend_ledger WHERE period_key = ?`,
      )
        .bind(pk)
        .first<{ reserved_cents: number; committed_cents: number }>();
      expect(row?.reserved_cents).toBe(0); // no leaked reservation
      expect(row?.committed_cents).toBe(0); // no charge
    });
  });
});

describe("provisionDomainWithMailboxes — registrant completeness fail-loud boundary", () => {
  it("an opted-in tenant with an INCOMPLETE CAN-SPAM profile fails loud naming the missing fields, BEFORE any spend reservation or vendor call (never invents)", async () => {
    const { tenantId } = await mintTenant("Incomplete Registrant Co", "managed");
    // tenant_profile.physical_address/sender_identity are '' by default
    // (schema.ts) — brand alone maps to organization; addressLine1/city/
    // state/country/postalCode/firstName/lastName/email/phone are ALL
    // unsourceable from this thin profile.
    const bundle = createVendorAdapters("managed", clock, true, undefined, INBOXKIT_CONFIG, {
      armed: true,
      optIn: true,
      registrant: {},
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      await withTenantContext(tenantId, async (ctx) => {
        const realCtx = { ...ctx, adapters: { ...ctx.adapters, kind: "real" as const, domain: bundle.domain } };
        const err = await provisionDomainWithMailboxes(realCtx, {
          domain: "acme-lookalike.com",
          domainIndex: 0,
          personaSlug: "sales",
          inboxesEach: 1,
          intentKey: "registrar-arming-test#0",
        }).catch((e) => e);
        expect(err).toBeInstanceOf(VendorError);
        expect((err as VendorError).message).toContain("firstName");
        expect((err as VendorError).message).toContain("postalCode");
      });
      expect(fetchSpy).not.toHaveBeenCalled();
      const row = await env.DB.prepare(`SELECT COUNT(*) as n FROM vendor_spend_entries`).first<{ n: number }>();
      expect(row?.n ?? 0).toBe(0); // no reservation ever created
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

// Registrant-capture follow-up (2026-07-28) — closes the gap a prior lane
// found: deriveInboxKitRegistrant could only ever source `organization` (from
// brand) and `addressLine1` (from physicalAddress); every other
// InboxKitDomainRegistrant field had no structured source, so
// assertCompleteRegistrant fail-louded for EVERY tenant with
// registerDomains:true. The fix: `SetupInfrastructureInput.registrant`
// (packages/shared/src/intents.ts), required by a zod refinement whenever
// registerDomains:true, persisted onto tenant_profile.registrant_json, and
// preferred by deriveInboxKitRegistrant over the old brand/address-derived
// partial.

describe("SetupInfrastructureInput — registrant capture at the intent boundary", () => {
  const VALID_BASE = {
    brand: "Acme",
    primaryDomain: "acme.com",
    domains: 1,
    inboxesEach: 1,
    persona: "Sales",
    physicalAddress: "1 Main St, Anytown, ST 00000",
    senderIdentity: "Sales Team",
  };

  // (a) RETIRED AND INVERTED (design §7.8, gate L1(i) — deliberate contract
  // change #1 of §7.9's three). `registerDomains: true` with NO registrant used
  // to be rejected here, which made the one call this platform must be able to
  // RECOMMEND impossible to emit without echoing legal PII into a status
  // response. It is accepted now; the safety property moved one seam later, to
  // `assertCompleteRegistrant` at the actual buy call site, which still 400s
  // naming the missing fields before any purchase.
  //
  // The relaxation's own coverage — including that the buy files the PERSISTED
  // registrant and that an absent one is not a revocation — is
  // test/registrant-relaxation.test.ts.
  it("(a) registerDomains:true with no registrant is ACCEPTED at the boundary", () => {
    const result = SetupInfrastructureInput.safeParse({ ...VALID_BASE, registerDomains: true });
    expect(result.success).toBe(true);
  });

  it("(a) registerDomains:true WITH a complete registrant parses through cleanly", () => {
    const result = SetupInfrastructureInput.safeParse({
      ...VALID_BASE,
      registerDomains: true,
      registrant: COMPLETE_REGISTRANT,
    });
    expect(result.success).toBe(true);
  });

  // A partial registrant (object present, one field missing) is caught by
  // Registrant's OWN required fields — no extra refinement logic needed for
  // this case, just proving zod's ordinary nested-object validation applies.
  it("(a) registerDomains:true with a PARTIAL registrant names the specific missing sub-field", () => {
    const { phone: _phone, ...partial } = COMPLETE_REGISTRANT;
    const result = SetupInfrastructureInput.safeParse({ ...VALID_BASE, registerDomains: true, registrant: partial });
    expect(result.success).toBe(false);
    if (result.success) return;
    const issue = result.error.issues.find((i) => i.path.join(".") === "registrant.phone");
    expect(issue).toBeDefined();
  });
});

describe("registrant capture — persisted structured registrant threads exactly into RealInboxKitDomainPort", () => {
  const saved = {
    REGISTRAR_PROVIDER: env.REGISTRAR_PROVIDER,
    INBOXKIT_API_KEY: env.INBOXKIT_API_KEY,
    INBOXKIT_WORKSPACE_ID: env.INBOXKIT_WORKSPACE_ID,
  };
  afterEach(() => Object.assign(env, saved));

  beforeEach(async () => {
    await seedBenignSdnList();
  });

  // (b) complete registrant → RealInboxKitDomainPort receives exactly the
  // mapped field values (fixture-level assertion on the actual outbound
  // InboxKit request body).
  it("(b) a complete persisted registrant reaches InboxKit's /domains/register request with EXACT mapped field values", async () => {
    Object.assign(env, { REGISTRAR_PROVIDER: "inboxkit", INBOXKIT_API_KEY: "k", INBOXKIT_WORKSPACE_ID: "w" });
    const { tenantId } = await mintTenant("Threaded Registrant Co", "managed");
    await activatePaidPlan(tenantId, "managed");

    // Simulates what provisioning.ts's runSetupInfrastructure persists after a
    // registerDomains:true call — register_domains + registrant_json written
    // together (this test asserts the READ side; add-billing-projection-style
    // tests elsewhere already cover the WRITE side end-to-end via the HTTP facade).
    await runInDurableObject(tenantStub(tenantId), (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE tenant_profile SET register_domains = 1, registrant_json = ? WHERE id = ?`,
        JSON.stringify(COMPLETE_REGISTRANT),
        tenantId,
      );
    });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementationOnce(
      async () =>
        new Response(JSON.stringify(IK_DOMAIN_REGISTER_WALLET_SUCCESS), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    try {
      await runInDurableObject(tenantStub(tenantId), async (instance) => {
        const bundle = (instance as unknown as TenantDOWithBuildAdapters).buildAdapters();
        expect(bundle.domain).toBeInstanceOf(RealInboxKitDomainPort);
        await bundle.domain.buy("acme-lookalike.com", "k1");
      });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [, init] = fetchSpy.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string);
      expect(body.contact_details).toEqual({
        first_name: COMPLETE_REGISTRANT.firstName,
        last_name: COMPLETE_REGISTRANT.lastName,
        email: COMPLETE_REGISTRANT.email,
        phone: COMPLETE_REGISTRANT.phone,
        organization: COMPLETE_REGISTRANT.organization,
        address_line1: COMPLETE_REGISTRANT.addressLine1,
        city: COMPLETE_REGISTRANT.city,
        state: COMPLETE_REGISTRANT.state,
        country: COMPLETE_REGISTRANT.country,
        postal_code: COMPLETE_REGISTRANT.postalCode,
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe("assertCompleteRegistrant — throws the dedicated IncompleteRegistrantError class", () => {
  // Unit-level complement to the VendorError-level assertion above: proves
  // the concrete class threaded through to index.ts's onError mapping (not
  // just a bare VendorError), carrying the missing-field list as data.
  it("throws IncompleteRegistrantError (not a bare VendorError) with a missingFields array", () => {
    let caught: unknown;
    try {
      assertCompleteRegistrant({ organization: "Acme" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(IncompleteRegistrantError);
    expect((caught as IncompleteRegistrantError).missingFields).toContain("firstName");
    expect((caught as IncompleteRegistrantError).missingFields).not.toContain("organization");
  });
});

describe("registerDomains:false backward compatibility — unaffected by registrant capture", () => {
  // (c) registerDomains:false, no registrant → everything works as before.
  // Exercises the REAL HTTP facade end-to-end (not just the zod parse),
  // proving provisioning.ts's new registrant_json write is a harmless NULL
  // for every caller that never opts in — the pre-existing (default) shape.
  it("(c) a normal setup_infrastructure call (registerDomains omitted, no registrant) provisions exactly as before", async () => {
    const { token, tenantId } = await signup("Backward Compat Co", "founder@backcompat-registrant-test.example");
    const res = await api<{ jobId: string }>("/setup-infrastructure", {
      method: "POST",
      token,
      body: JSON.stringify({
        brand: "Backward Compat Co",
        primaryDomain: "backwardcompatco.com",
        domains: 1,
        inboxesEach: 1,
        persona: "Sales",
        physicalAddress: "1 Main St",
        senderIdentity: "Sales Team",
      }),
    });
    expect(res.status).toBe(202);

    await runInDurableObject(tenantStub(tenantId), (_instance, state) => {
      const row = state.storage.sql
        .exec<{ register_domains: number; registrant_json: string | null }>(
          `SELECT register_domains, registrant_json FROM tenant_profile WHERE id = ?`,
          tenantId,
        )
        .toArray()[0];
      expect(row?.register_domains).toBe(0);
      expect(row?.registrant_json).toBeNull();
    });

    const status = await api<{ domains: number; mailboxes: number }>("/infrastructure-status", { token });
    expect(status.body.domains).toBe(1);
    expect(status.body.mailboxes).toBe(1);
  });
});

describe("registrant capture — a stale persisted register_domains=1 no longer forces a real buy when THIS call doesn't re-opt-in (B1 fix)", () => {
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
  });

  // The SAME genuinely-stale row the old test (d) used — register_domains=1 set
  // out-of-band (or by a tenant who opted in before the registrant-capture
  // column existed) with NO registrant_json — but asserting the POST-B1-FIX
  // behavior. Under the OLD code buildAdapters read that stale row and wired
  // RealInboxKitDomainPort regardless of THIS request's body, so a call that
  // does NOT re-opt-in (registerDomains omitted → false) still reached the
  // domain port and fell into assertCompleteRegistrant → 400 incomplete_registrant.
  // Under the fix, THIS call's (absent) opt-in is authoritative: the port is the
  // RegistrarUnarmed hard-block, so no buy is attempted and no incomplete
  // registrant is ever sent. (The incomplete_registrant → 400 mapping stays as
  // defensive code, reachable now only via the persisted-state flows like
  // REPLACE_DOMAIN, not a fresh setup call — see the assertCompleteRegistrant
  // unit test above for its data shape.)
  //
  // THE REFUSAL'S GRADE MOVED (design §7.8, gate L2 — deliberate contract
  // change #3 of §7.9's three). The hard-block and the zero buys below are the
  // load-bearing assertions and are unchanged; what changed is that this leg no
  // longer answers 503 "not enabled for this ACCOUNT", which is the sentence
  // that sent a real customer's unattended agent to file a ticket instead of
  // resending one field (sup_dce385a8 / sup_9d2c9a3a). The opt-in leg is now a
  // 400 naming the field — test/registrar-two-leg-split.test.ts owns the split.
  it("a stale register_domains=1 row does NOT drive a real buy for a call that omits registerDomains — hard-blocks, zero buys, never incomplete_registrant", async () => {
    Object.assign(env, { REGISTRAR_PROVIDER: "inboxkit", INBOXKIT_API_KEY: "k", INBOXKIT_WORKSPACE_ID: "w" });
    const { token, tenantId } = await mintTenant("Stale Registrant Co", "managed");
    await activatePaidPlan(tenantId, "managed");

    await runInDurableObject(tenantStub(tenantId), (_instance, state) => {
      state.storage.sql.exec(`UPDATE tenant_profile SET register_domains = 1 WHERE id = ?`, tenantId);
    });

    const calls = installInboxKitFetchMock();
    const res = await api<{ error: string; code: string; missingFields?: string[] }>("/setup-infrastructure", {
      method: "POST",
      token,
      body: JSON.stringify({
        brand: "Stale Registrant Co",
        primaryDomain: "staleregistrantco.com",
        domains: 1,
        inboxesEach: 1,
        persona: "Sales",
        physicalAddress: "1 Main St",
        senderIdentity: "Sales Team",
      }),
    });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("registrar_optin_missing");
    expect(res.body.code).not.toBe("incomplete_registrant");
    // The hard-block port throws on searchLookalikes before any vendor round
    // trip — no domain buy, no partial InboxKit registration on the stale
    // incomplete registrant.
    expect(domainBuyCalls(calls)).toHaveLength(0);
  });
});

// B1 (docs/adversarial/registrar-arming-review-2026-07-28.md) — the domain port
// buildAdapters() bakes reflects the PRE-call persisted register_domains/
// registrant_json (register_domains has no writer other than
// runSetupInfrastructure's own UPDATE, which runs AFTER requireContext()). These
// tests drive the REAL single HTTP setup_infrastructure call end-to-end (the
// path the rest of the suite was structurally blind to — every other opt-in
// test hand-builds adapters or pre-seeds the row in a separate DO block) and
// prove THIS call's validated opt-in + registrant is authoritative at buy time
// in BOTH directions. See installInboxKitFetchMock's doc for why a real paid
// provision ends non-2xx AFTER the buy — the buy (count + filed registrant) is
// the load-bearing observation.
describe("setup_infrastructure — THIS call's opt-in + registrant is authoritative at buy time (B1 fix, 2026-07-28)", () => {
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
  });

  function setupBody(over: Record<string, unknown>): string {
    return JSON.stringify({
      brand: "Authoritative Co",
      primaryDomain: "authoritativeco.com",
      domains: 1,
      inboxesEach: 1,
      persona: "Sales",
      physicalAddress: "1 Main St",
      senderIdentity: "Sales Team",
      ...over,
    });
  }

  async function seedPersistedOptIn(tenantId: string, registrant: typeof COMPLETE_REGISTRANT): Promise<void> {
    await runInDurableObject(tenantStub(tenantId), (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE tenant_profile SET register_domains = 1, registrant_json = ? WHERE id = ?`,
        JSON.stringify(registrant),
        tenantId,
      );
    });
  }

  async function readPersistedRegistrant(tenantId: string): Promise<{ register_domains: number; registrant_json: string | null }> {
    return runInDurableObject(tenantStub(tenantId), (_instance, state) =>
      state.storage.sql
        .exec<{ register_domains: number; registrant_json: string | null }>(
          `SELECT register_domains, registrant_json FROM tenant_profile WHERE id = ?`,
          tenantId,
        )
        .toArray()[0]!,
    );
  }

  // (a) Fresh activated tenant, env armed, ONE POST {registerDomains:true,
  // registrant:complete}. The documented single-call opt-in+buy must actually
  // buy in this call, filing THIS call's registrant, with NO false
  // registrar_unarmed 503/alert. RED on the pre-fix code: buildAdapters read
  // register_domains=0 → RegistrarUnarmedDomainPort → searchLookalikes throws →
  // 503 registrar_unarmed with ZERO buys (silently requiring a second call).
  it("(a) fresh single-call opt-in buys same-call with THIS call's registrant and fires no false unarmed 503/alert", async () => {
    Object.assign(env, { REGISTRAR_PROVIDER: "inboxkit", INBOXKIT_API_KEY: "k", INBOXKIT_WORKSPACE_ID: "w" });
    const { token, tenantId } = await mintTenant("Authoritative Co", "managed");
    await activatePaidPlan(tenantId, "managed");

    const calls = installInboxKitFetchMock();
    const res = await api<{ code?: string }>("/setup-infrastructure", {
      method: "POST",
      token,
      body: setupBody({ registerDomains: true, registrant: COMPLETE_REGISTRANT }),
    });

    // No false unarmed alert: alertRegistrarUnarmed fires IFF a
    // RegistrarUnarmedError is caught IFF this exact 503 code is returned
    // (provisioning.ts catch + index.ts onError). "Not registrar_unarmed" is
    // therefore the HTTP-observable proxy for "zero unarmed alerts". (The
    // response is non-2xx only because of the downstream dark BillingPort stub —
    // orthogonal to B1; see installInboxKitFetchMock.)
    expect(res.status).not.toBe(503);
    expect(res.body?.code).not.toBe("registrar_unarmed");

    const buys = domainBuyCalls(calls);
    expect(buys).toHaveLength(1);
    const cd = buyContactDetails(buys[0]!);
    expect(cd.first_name).toBe(COMPLETE_REGISTRANT.firstName);
    expect(cd.last_name).toBe(COMPLETE_REGISTRANT.lastName);
    expect(cd.email).toBe(COMPLETE_REGISTRANT.email);

    const row = await readPersistedRegistrant(tenantId);
    expect(row.register_domains).toBe(1);
    expect(JSON.parse(row.registrant_json ?? "null")).toMatchObject({ firstName: COMPLETE_REGISTRANT.firstName });
  });

  // (b) Prior persisted opt-in with registrant R1; ONE call
  // {registerDomains:false, registrant:R2}. THIS call opts OUT, so NO real buy
  // may fire regardless of the persisted opt-in, and the freshly-passed R2 is
  // persisted (schema permits registrant when registerDomains is false). RED on
  // the pre-fix code: buildAdapters read the persisted opt-in → RealInboxKit
  // baked with R1 → a real buy fired filing the stale R1 (the money direction).
  it("(b) opt-out this call fires zero buys despite a persisted opt-in, and persists the freshly-passed registrant", async () => {
    Object.assign(env, { REGISTRAR_PROVIDER: "inboxkit", INBOXKIT_API_KEY: "k", INBOXKIT_WORKSPACE_ID: "w" });
    const { token, tenantId } = await mintTenant("Authoritative Co", "managed");
    await activatePaidPlan(tenantId, "managed");
    await seedPersistedOptIn(tenantId, REGISTRANT_R1);

    const calls = installInboxKitFetchMock();
    await api("/setup-infrastructure", {
      method: "POST",
      token,
      body: setupBody({ registerDomains: false, registrant: REGISTRANT_R2 }),
    });

    expect(domainBuyCalls(calls)).toHaveLength(0);
    const row = await readPersistedRegistrant(tenantId);
    expect(row.register_domains).toBe(0);
    expect(JSON.parse(row.registrant_json ?? "null")).toMatchObject({ firstName: REGISTRANT_R2.firstName });
  });

  // (c) Prior persisted registrant R1; ONE call {registerDomains:true,
  // registrant:R2}. The buy must file R2 (this call), not the stale R1. RED on
  // the pre-fix code: the baked port carried R1, so the buy filed R1 while the
  // pre-flight validated the freshly-persisted R2 (validate-fresh / buy-stale).
  it("(c) re-opt-in with a new registrant files THIS call's registrant, not the prior persisted one", async () => {
    Object.assign(env, { REGISTRAR_PROVIDER: "inboxkit", INBOXKIT_API_KEY: "k", INBOXKIT_WORKSPACE_ID: "w" });
    const { token, tenantId } = await mintTenant("Authoritative Co", "managed");
    await activatePaidPlan(tenantId, "managed");
    await seedPersistedOptIn(tenantId, REGISTRANT_R1);

    const calls = installInboxKitFetchMock();
    await api("/setup-infrastructure", {
      method: "POST",
      token,
      body: setupBody({ registerDomains: true, registrant: REGISTRANT_R2 }),
    });

    const buys = domainBuyCalls(calls);
    expect(buys).toHaveLength(1);
    const cd = buyContactDetails(buys[0]!);
    expect(cd.first_name).toBe(REGISTRANT_R2.firstName);
    expect(cd.first_name).not.toBe(REGISTRANT_R1.firstName);
    expect(cd.email).toBe(REGISTRANT_R2.email);
  });

  // (d) The two-leg decouple guard stays INVIOLABLE: env leg unset
  // (REGISTRAR_PROVIDER not "inboxkit") + {registerDomains:true,
  // registrant:complete} must STILL hard-block. This passes on both the pre-fix
  // and fixed code — it proves the fix never arms the registrar on the strength
  // of the call's opt-in alone when the operator's global switch is absent.
  it("(d) env leg unset still hard-blocks a registerDomains:true call — decouple guard holds, zero buys", async () => {
    Object.assign(env, { REGISTRAR_PROVIDER: undefined, INBOXKIT_API_KEY: "k", INBOXKIT_WORKSPACE_ID: "w" });
    const { token, tenantId } = await mintTenant("Authoritative Co", "managed");
    await activatePaidPlan(tenantId, "managed");

    const calls = installInboxKitFetchMock();
    const res = await api<{ code?: string }>("/setup-infrastructure", {
      method: "POST",
      token,
      body: setupBody({ registerDomains: true, registrant: COMPLETE_REGISTRANT }),
    });

    expect(res.status).toBe(503);
    expect(res.body?.code).toBe("registrar_unarmed");
    expect(domainBuyCalls(calls)).toHaveLength(0);
  });
});
