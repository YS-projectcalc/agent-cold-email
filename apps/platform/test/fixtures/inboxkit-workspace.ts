/**
 * A STATEFUL stand-in for the live InboxKit workspace — the fixture the
 * provisioning acceptance tests drive the REAL adapters against.
 *
 * Extracted from test/provisioning-orphan-acceptance.test.ts (2026-08-13) once
 * a second acceptance file needed it; it is deliberately not one of the static
 * payload fixtures in ./inboxkit.ts, because its whole value is that it HOLDS
 * STATE and REFUSES the operations the live vendor refuses. The sandbox ports
 * model "the call returns == the resource exists", which cannot express a wrong
 * operation or an async vendor — the two shapes that actually shipped
 * (HANDOFF.md: "the sandbox is built to always-succeed").
 */

import { vi } from "vitest";

export const ASSIGNED_NS = ["alexandra.ns.cloudflare.com", "phil.ns.cloudflare.com"];

/** A complete InboxKit registrant — real domain purchases refuse a partial one. */
export const REGISTRANT = {
  firstName: "Jane",
  lastName: "Registrant",
  email: "registrant@example.test",
  phone: "+15550100",
  organization: "Author Pitch Desk LLC",
  addressLine1: "1 Test Way",
  city: "Testville",
  state: "CA",
  country: "US",
  postalCode: "94000",
};

export interface VendorDomain {
  name: string;
  status: string;
  /** Omitted for a domain the vendor does not classify — the 'unknown' branch. */
  connection_type?: string;
  assigned_mailboxes: number;
  dns_propagation_status: string;
  nameserver_match_status: string;
  nameservers: string[];
  actual_nameservers: string[];
}

/** A domain in the shape the live workspace reports a REGISTERED, unassigned one. */
export function purchasedVendorDomain(name: string, overrides: Partial<VendorDomain> = {}): VendorDomain {
  return {
    name,
    status: "active",
    connection_type: "purchased",
    assigned_mailboxes: 0,
    dns_propagation_status: "pending",
    nameserver_match_status: "pending",
    nameservers: ASSIGNED_NS,
    actual_nameservers: [],
    ...overrides,
  };
}

/**
 * Answers the endpoints the real adapters call, holds the state they mutate,
 * and refuses what the live vendor refuses. Installs a `fetch` spy for the
 * duration of the test (restore with `vi.restoreAllMocks()`).
 */
export function fakeInboxKit(seed: {
  domains: VendorDomain[];
  mailboxBuyFailure?: { status: number; message: string };
  /**
   * The vendor has already caught up on mailbox creation, so a buy lands
   * 'active' rather than 'scheduled'. Only for tests whose subject is what got
   * PROVISIONED, not how the accept-before-create window is survived — that
   * window has its own coverage and costs a real backoff wait per attempt.
   */
  mailboxesReadyOnBuy?: boolean;
}) {
  const domains = new Map(seed.domains.map((d) => [d.name.toLowerCase(), { ...d }]));
  const mailboxes = new Map<string, { uid: string; username: string; domain_name: string; status: string }>();
  const calls: { path: string; body: unknown }[] = [];

  const json = (obj: unknown, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

  vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const path = new URL(url).pathname.replace("/v1/api", "");
    const body: Record<string, unknown> = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    calls.push({ path, body });

    if (path === "/domains/available") {
      const name = new URL(url).searchParams.get("domain") ?? "";
      // PRODUCTION-REAL: a domain the account already owns is NOT available for
      // registration. The old adopt fixtures reported owned domains as
      // available:true — a state that cannot exist — which is what let a filter
      // that discarded every adoptable candidate look correct.
      return json({ error: false, available: !domains.has(name.toLowerCase()) });
    }
    if (path === "/domains/list") {
      return json({ error: false, domains: [...domains.values()], total: domains.size, pages: 1 });
    }
    if (path === "/domains/register") {
      for (const d of (body.domains as { name: string }[]) ?? []) {
        domains.set(d.name.toLowerCase(), purchasedVendorDomain(d.name));
      }
      return json({ error: false, payment_type: "wallet" });
    }
    if (path.startsWith("/domains/nameservers")) {
      // THE LIVE FAILURE. Connecting an existing domain is meaningless for one
      // the vendor registered itself, and it answers exactly this. If any code
      // path still runs the handshake on a purchased domain, this test fails.
      const requested = ((body.domains as string[]) ?? [])[0] ?? "";
      const record = domains.get(requested.toLowerCase());
      if (record?.connection_type === "purchased") return json({ error: true, message: "Domain not found" }, 404);
      return json({ error: false, result: [{ name: requested, nameservers: ASSIGNED_NS, uid: "dom-x" }] });
    }
    if (path === "/mailboxes/buy") {
      // The vendor's mailbox PROCESSING is where it configures a purchased
      // domain's DNS, so a failure in that work surfaces here and nowhere else.
      if (seed.mailboxBuyFailure) {
        return json({ error: true, message: seed.mailboxBuyFailure.message }, seed.mailboxBuyFailure.status);
      }
      for (const m of (body.mailboxes as { username: string; domain_name: string }[]) ?? []) {
        const email = `${m.username}@${m.domain_name}`;
        // ACCEPTED, not created: the vendor answers "scheduled". This is the
        // window every uid-resolving call used to run straight into.
        mailboxes.set(email, {
          uid: `mbx-${mailboxes.size + 1}`,
          username: m.username,
          domain_name: m.domain_name,
          status: seed.mailboxesReadyOnBuy ? "active" : "scheduled",
        });
      }
      return json({ error: false, mailboxes: [...mailboxes.values()] });
    }
    if (path === "/mailboxes/list") {
      const keyword = String(body.keyword ?? "").toLowerCase();
      const match = mailboxes.get(keyword);
      return json({ error: false, mailboxes: match ? [match] : [] });
    }
    if (path === "/warmup/add") {
      return json({
        error: false,
        subscriptions: [{ uid: "warm-1", status: "active", mailbox_email: "x", started_at: null, createdAt: "2026-08-05T00:00:00.000Z" }],
      });
    }
    return json({ error: false });
  }) as typeof fetch);

  return {
    calls,
    countOf: (path: string) => calls.filter((c) => c.path === path).length,
    /** Every domain name the account holds — what `/domains/register` actually bought. */
    registered: () => [...domains.keys()],
    /**
     * The registrar's NS delegation lands — and NOTHING else. Separated from
     * `propagate` because flipping every signal at once is precisely what hid a
     * false-ready bug (gate 2026-08-06 #1): a readiness rule that consulted the
     * nameservers and ignored the propagation verdict was indistinguishable from
     * one that required both. Mail DNS cannot propagate before delegation lands,
     * so every purchased domain really does pass through this state.
     */
    matchNameservers(domain: string) {
      const record = domains.get(domain.toLowerCase());
      if (!record) throw new Error(`fixture: ${domain} not registered`);
      record.actual_nameservers = [...ASSIGNED_NS];
      record.nameserver_match_status = "matched";
    },
    /** The vendor finishes setting up the mail DNS — the verdict readiness turns on. */
    propagate(domain: string) {
      const record = domains.get(domain.toLowerCase());
      if (!record) throw new Error(`fixture: ${domain} not registered`);
      record.actual_nameservers = [...ASSIGNED_NS];
      record.dns_propagation_status = "completed";
      record.nameserver_match_status = "matched";
    },
    /** The vendor finishes creating every scheduled mailbox. */
    activateMailboxes() {
      for (const m of mailboxes.values()) m.status = "active";
    },
    /** The workspace's own view of a domain — used to assert what did NOT move. */
    domainState(domain: string): VendorDomain | undefined {
      return domains.get(domain.toLowerCase());
    },
  };
}
