import { afterEach, describe, expect, it, vi } from "vitest";
import { VendorError } from "@coldstart/shared";
import { RealInboxKitDomainPort } from "../src/vendors/real/inboxkit-domain-port.js";
import {
  IK_API_KEY,
  IK_DOMAINS_LIST_CONNECTED,
  IK_DOMAINS_LIST_PURCHASED_NS_MATCHED_DNS_PENDING,
  IK_DOMAINS_LIST_PURCHASED_PENDING,
  IK_DOMAINS_LIST_PURCHASED_PROPAGATED,
  IK_NAMESERVERS_RESULT,
  IK_PROPAGATION_CONFIRMED,
  IK_WORKSPACE_ID,
} from "./fixtures/inboxkit.js";

// INCIDENT 2026-08-05 ROOT CAUSE (docs/adversarial/sweep-domain-type-2026-08-05.md).
//
// The port implemented the CONNECT-AN-EXISTING-DOMAIN nameserver flow and was
// only ever invoked on domains the vendor itself had REGISTERED. That is the
// wrong operation for a purchased domain: it threw at step 1 on every one of the
// customer's retries, before a single mailbox was attempted.
//
// The reason no test caught it is worth stating, because it is the same reason
// twice: every fixture in the suite modelled setDns as "fails N times, then
// succeeds", so the ONLY failure mode expressible was a transient race. A wrong
// operation never succeeds — no amount of retrying reaches the green branch —
// and no fixture could say so. These tests drive the REAL port against the live
// vendor shapes instead (test/fixtures/inboxkit.ts, captured 2026-08-05).

const CONFIG = { apiKey: IK_API_KEY, workspaceId: IK_WORKSPACE_ID, baseUrl: "https://ik.example.internal/v1/api" };
const DOMAIN = "goauthorpitchdesk.com";

interface Call {
  url: string;
  body: unknown;
}

/**
 * Routes each InboxKit endpoint to a response, and RECORDS every call — so a
 * test can assert not just what came back but which operation was performed,
 * which is the whole subject here.
 */
function installFetch(routes: { list?: unknown; nameservers?: unknown; propagation?: unknown }): Call[] {
  const calls: Call[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const bodyText = typeof init?.body === "string" ? init.body : undefined;
    calls.push({ url, body: bodyText ? JSON.parse(bodyText) : undefined });
    const json = (obj: unknown) => new Response(JSON.stringify(obj), { status: 200, headers: { "content-type": "application/json" } });
    if (url.includes("/domains/nameservers/check-propagation")) {
      if (!routes.propagation) return new Response(JSON.stringify({ error: true, message: "not routed" }), { status: 400 });
      return json(routes.propagation);
    }
    if (url.includes("/domains/nameservers")) {
      // What the LIVE vendor does when asked to connect a domain it registered
      // itself: rejects it. Permanently — the domain's type will never change.
      if (!routes.nameservers) {
        return new Response(JSON.stringify({ error: true, message: "Domain not found" }), { status: 404 });
      }
      return json(routes.nameservers);
    }
    if (url.includes("/domains/list")) return json(routes.list ?? { error: false, domains: [], pages: 1 });
    return json({ error: false });
  }) as typeof fetch);
  return calls;
}

const nameserverCalls = (calls: Call[]) => calls.filter((c) => c.url.endsWith("/domains/nameservers"));

afterEach(() => vi.restoreAllMocks());

describe("setDns branches on connection type — the wrong-operation root cause", () => {
  it("a PURCHASED domain is never sent through the connect-existing nameserver flow", async () => {
    // The pre-fix code called POST /domains/nameservers unconditionally, and the
    // vendor answered 404 "Domain not found" — the exact 24-hour failure loop.
    const calls = installFetch({ list: IK_DOMAINS_LIST_PURCHASED_PROPAGATED });
    const result = await new RealInboxKitDomainPort(CONFIG).setDns(DOMAIN, "k1", "purchased");

    expect(nameserverCalls(calls)).toEqual([]); // THE fix: the wrong op is not attempted
    expect(calls.some((c) => c.url.includes("/domains/list"))).toBe(true); // it POLLS instead
    expect(result).toEqual({ mx: true, spf: true, dkim: true, dmarc: true, rdns: true });
  });

  it("an 'unknown' (pre-column) domain takes the same read-only poll, never the handshake", async () => {
    const calls = installFetch({ list: IK_DOMAINS_LIST_PURCHASED_PROPAGATED });
    await new RealInboxKitDomainPort(CONFIG).setDns(DOMAIN, "k1", "unknown");
    expect(nameserverCalls(calls)).toEqual([]);
  });

  it("a CONNECTED domain still runs the handshake — the branch keeps the half that was always correct", async () => {
    const calls = installFetch({ nameservers: IK_NAMESERVERS_RESULT, propagation: IK_PROPAGATION_CONFIRMED });
    const result = await new RealInboxKitDomainPort(CONFIG).setDns("connected-elsewhere.com", "k1", "connected");

    expect(nameserverCalls(calls)).toHaveLength(1);
    expect(result.mx).toBe(true);
  });
});

describe("purchased-domain readiness is derived from REAL propagation state", () => {
  it("Mordy's live state (nameservers assigned, none observed) reports NOT ready — without throwing", async () => {
    installFetch({ list: IK_DOMAINS_LIST_PURCHASED_PENDING });
    const result = await new RealInboxKitDomainPort(CONFIG).setDns(DOMAIN, "k1", "purchased");
    // Not an error — the vendor is simply not finished. All-false is what makes
    // the caller's gate work; "did not throw" used to be read as "ready".
    expect(result).toEqual({ mx: false, spf: false, dkim: false, dmarc: false, rdns: false });
  });

  it("ready only once the vendor's own propagation verdict says so", async () => {
    installFetch({ list: IK_DOMAINS_LIST_PURCHASED_PROPAGATED });
    const result = await new RealInboxKitDomainPort(CONFIG).setDns(DOMAIN, "k1", "purchased");
    expect(result.mx).toBe(true);
  });

  it("NS delegation landed but mail DNS still pending reads NOT ready — the false-ready bug", async () => {
    // Combined-diff gate 2026-08-06 finding #1, EXECUTED end to end: readiness
    // short-circuited on a nameserver match and never consulted
    // `dns_propagation_status`, so this exact record marked the domain ready and
    // a mailbox was bought, warmup-enrolled and BILLED on a domain whose mail DNS
    // does not work yet. Delegation is a precondition of propagation, not a
    // substitute for it.
    installFetch({ list: IK_DOMAINS_LIST_PURCHASED_NS_MATCHED_DNS_PENDING });
    const result = await new RealInboxKitDomainPort(CONFIG).setDns(DOMAIN, "k1", "purchased");
    expect(result).toEqual({ mx: false, spf: false, dkim: false, dmarc: false, rdns: false });
  });

  it("a matching nameserver set cannot override an unrecognized propagation token either", async () => {
    // The deleted route trusted the vendor's RAW field over the vendor's own
    // verdict computed from it. Neither an explicit 'pending' nor an unknown
    // token may be overridden by the nameservers agreeing.
    installFetch({
      list: {
        ...IK_DOMAINS_LIST_PURCHASED_NS_MATCHED_DNS_PENDING,
        domains: [
          {
            ...IK_DOMAINS_LIST_PURCHASED_NS_MATCHED_DNS_PENDING.domains[0],
            dns_propagation_status: "not_started",
          },
        ],
      },
    });
    const result = await new RealInboxKitDomainPort(CONFIG).setDns(DOMAIN, "k1", "purchased");
    expect(result.mx).toBe(false);
  });

  it("an unrecognized vendor status token falls to NOT ready (the safe direction)", async () => {
    // Guessing "not ready" costs a retry. Guessing "ready" provisions billable
    // mailboxes onto a domain whose mail DNS does not work — so an unknown token
    // must never be read as success.
    installFetch({
      list: {
        ...IK_DOMAINS_LIST_PURCHASED_PENDING,
        domains: [
          {
            ...IK_DOMAINS_LIST_PURCHASED_PENDING.domains[0],
            dns_propagation_status: "not_started",
            nameserver_match_status: "not_started",
          },
        ],
      },
    });
    const result = await new RealInboxKitDomainPort(CONFIG).setDns(DOMAIN, "k1", "purchased");
    expect(result.mx).toBe(false);
  });

  it("a domain the vendor has not listed yet is RETRYABLE (async registration, genuinely heals)", async () => {
    installFetch({ list: { error: false, domains: [], pages: 1 } });
    const err = await new RealInboxKitDomainPort(CONFIG).setDns(DOMAIN, "k1", "purchased").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VendorError);
    expect((err as VendorError).retryable).toBe(true);
  });

  it("a non-active domain is never ready, whatever its nameservers say", async () => {
    installFetch({
      list: {
        ...IK_DOMAINS_LIST_PURCHASED_PROPAGATED,
        domains: [{ ...IK_DOMAINS_LIST_PURCHASED_PROPAGATED.domains[0], status: "expired" }],
      },
    });
    const result = await new RealInboxKitDomainPort(CONFIG).setDns(DOMAIN, "k1", "purchased");
    expect(result.mx).toBe(false);
  });
});

describe("listOwnedDomains carries the discriminator (the enabler defect)", () => {
  it("reports connection_type for both kinds, so the caller CAN branch", async () => {
    installFetch({ list: IK_DOMAINS_LIST_PURCHASED_PENDING });
    expect((await new RealInboxKitDomainPort(CONFIG).listOwnedDomains())[0]!.connectionType).toBe("purchased");

    vi.restoreAllMocks();
    installFetch({ list: IK_DOMAINS_LIST_CONNECTED });
    expect((await new RealInboxKitDomainPort(CONFIG).listOwnedDomains())[0]!.connectionType).toBe("connected");
  });

  it("a vendor row with no connection_type reads 'unknown', never a silent default to either branch", async () => {
    installFetch({
      list: { error: false, pages: 1, domains: [{ name: "legacy.com", status: "active", assigned_mailboxes: 0 }] },
    });
    expect((await new RealInboxKitDomainPort(CONFIG).listOwnedDomains())[0]!.connectionType).toBe("unknown");
  });

  it("a workspace with more pages than the walker will read fails PERMANENTLY, not retryably", async () => {
    // The pre-fix grade was retryable:true — a permanent condition dressed as a
    // hiccup, so the caller loops forever re-walking the same ceiling.
    installFetch({ list: { error: false, pages: 999, domains: [{ name: "x.com", status: "active" }] } });
    const err = await new RealInboxKitDomainPort(CONFIG).listOwnedDomains().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VendorError);
    expect((err as VendorError).retryable).toBe(false);
  });
});
