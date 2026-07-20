import { afterEach, describe, expect, it, vi } from "vitest";
import { NotActivatedError, VendorError } from "@coldstart/shared";
import { RealInboxKitDomainPort, type InboxKitDomainRegistrant } from "../src/vendors/real/inboxkit-domain-port.js";
import {
  IK_API_KEY,
  IK_DOMAIN_AVAILABLE,
  IK_DOMAIN_NOT_AVAILABLE,
  IK_DOMAIN_REGISTER_STRIPE_SESSION,
  IK_DOMAIN_REGISTER_WALLET_SUCCESS,
  IK_DOMAIN_REMOVE_SUCCESS,
  IK_NAMESERVERS_RESULT,
  IK_PROPAGATION_CONFIRMED,
  IK_PROPAGATION_PENDING,
  IK_WORKSPACE_ID,
} from "./fixtures/inboxkit.js";

// Contract test for RealInboxKitDomainPort — the InboxKit-registered +
// connect-existing-domain flows (real/inboxkit-domain-port.ts's doc comment).
// `fetch` is stubbed with sanitized fixtures; no real network call.

const CONFIG = { apiKey: IK_API_KEY, workspaceId: IK_WORKSPACE_ID, baseUrl: "https://ik.example.internal/v1/api" };

const REGISTRANT: InboxKitDomainRegistrant = {
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

function stubFetchSequence(responses: Array<{ status: number; body: unknown }>) {
  const spy = vi.spyOn(globalThis, "fetch");
  for (const res of responses) {
    spy.mockImplementationOnce(async () => new Response(JSON.stringify(res.body), { status: res.status, headers: { "content-type": "application/json" } }));
  }
  return spy;
}

afterEach(() => vi.restoreAllMocks());

describe("RealInboxKitDomainPort — dark until configured", () => {
  it("throws NotActivatedError on every method with no InboxKit config", async () => {
    const port = new RealInboxKitDomainPort();
    await expect(port.searchLookalikes("Acme", "acme.com", 1)).rejects.toBeInstanceOf(NotActivatedError);
    await expect(port.buy("acme-lookalike.com", "k1")).rejects.toBeInstanceOf(VendorError); // registrant missing, not even reaching the client
    await expect(port.setDns("acme-lookalike.com", "k1")).rejects.toBeInstanceOf(NotActivatedError);
    await expect(port.release("acme-lookalike.com", "k1")).rejects.toBeInstanceOf(NotActivatedError);
  });
});

describe("RealInboxKitDomainPort — configured (InboxKit)", () => {
  it("searchLookalikes() checks each generated candidate via GET /domains/available and reports the vendor's true availability", async () => {
    const spy = stubFetchSequence([{ status: 200, body: IK_DOMAIN_AVAILABLE }, { status: 200, body: IK_DOMAIN_NOT_AVAILABLE }]);
    const candidates = await new RealInboxKitDomainPort(CONFIG).searchLookalikes("Acme", "acme.com", 2);

    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toEqual({ domain: "goacme.com", available: true });
    expect(candidates[1]).toEqual({ domain: "theacme.com", available: false });
    const [url] = spy.mock.calls[0]!;
    expect(url).toBe("https://ik.example.internal/v1/api/domains/available?domain=goacme.com");
  });

  it("buy() refuses without a configured registrant (never invents a fake identity)", async () => {
    const err = await new RealInboxKitDomainPort(CONFIG).buy("acme-lookalike.com", "k1").catch((e) => e);
    expect(err).toBeInstanceOf(VendorError);
    expect((err as VendorError).message).toContain("registrant contact details");
  });

  it("buy() POSTs /domains/register with use_wallet_balance:true and the configured registrant", async () => {
    const spy = stubFetchSequence([{ status: 200, body: IK_DOMAIN_REGISTER_WALLET_SUCCESS }]);
    const result = await new RealInboxKitDomainPort(CONFIG, REGISTRANT).buy("acme-lookalike.com", "k1");

    expect(result).toEqual({ domain: "acme-lookalike.com", purchasedAt: expect.any(Number), registrar: "inboxkit" });
    const [url, init] = spy.mock.calls[0]!;
    expect(url).toBe("https://ik.example.internal/v1/api/domains/register");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.use_wallet_balance).toBe(true);
    expect(body.domains).toEqual([{ name: "acme-lookalike.com", registration_years: 1 }]);
    expect(body.contact_details).toEqual({
      first_name: "Jane",
      last_name: "Registrant",
      email: "registrant@example.test",
      phone: "+15550100",
      organization: "Example LLC",
      address_line1: "1 Test Way",
      city: "Testville",
      state: "CA",
      country: "US",
      postal_code: "94000",
    });
  });

  it("buy() fails permanently when the wallet balance is insufficient (vendor returns a Stripe checkout session instead)", async () => {
    stubFetchSequence([{ status: 200, body: IK_DOMAIN_REGISTER_STRIPE_SESSION }]);
    const err = await new RealInboxKitDomainPort(CONFIG, REGISTRANT).buy("acme-lookalike.com", "k1").catch((e) => e);
    expect(err).toBeInstanceOf(VendorError);
    expect((err as VendorError).retryable).toBe(false);
    expect((err as VendorError).message).toContain("Stripe checkout");
  });

  it("setDns() creates InboxKit nameservers then maps a confirmed propagation onto all five DnsRecordSet flags", async () => {
    const spy = stubFetchSequence([{ status: 200, body: IK_NAMESERVERS_RESULT }, { status: 200, body: IK_PROPAGATION_CONFIRMED }]);
    const result = await new RealInboxKitDomainPort(CONFIG).setDns("acme-lookalike.com", "k1");

    expect(result).toEqual({ mx: true, spf: true, dkim: true, dmarc: true, rdns: true });
    const [nsUrl] = spy.mock.calls[0]!;
    expect(nsUrl).toBe("https://ik.example.internal/v1/api/domains/nameservers");
    const [propUrl, propInit] = spy.mock.calls[1]!;
    expect(propUrl).toBe("https://ik.example.internal/v1/api/domains/nameservers/check-propagation");
    expect(JSON.parse((propInit as RequestInit).body as string)).toEqual({ domains: ["acme-lookalike.com"] });
  });

  it("setDns() maps a not-yet-propagated domain onto all-false DnsRecordSet flags (never a false positive)", async () => {
    stubFetchSequence([{ status: 200, body: IK_NAMESERVERS_RESULT }, { status: 200, body: IK_PROPAGATION_PENDING }]);
    const result = await new RealInboxKitDomainPort(CONFIG).setDns("acme-lookalike.com", "k1");
    expect(result).toEqual({ mx: false, spf: false, dkim: false, dmarc: false, rdns: false });
  });

  it("release() POSTs /domains/remove and reports released:true", async () => {
    const spy = stubFetchSequence([{ status: 200, body: IK_DOMAIN_REMOVE_SUCCESS }]);
    const result = await new RealInboxKitDomainPort(CONFIG).release("acme-lookalike.com", "k1");
    expect(result).toEqual({ released: true, releasedAt: expect.any(Number) });
    const [, init] = spy.mock.calls[0]!;
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ domains: ["acme-lookalike.com"] });
  });
});
