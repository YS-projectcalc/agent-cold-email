import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { domainIntentKey } from "../src/engine/provision-intents.js";
import { activatePaidPlan, api, mintTenant, seedBenignSdnList, tenantStub } from "./helpers.js";
import { IK_API_KEY, IK_WORKSPACE_ID } from "./fixtures/inboxkit.js";

// THE ACCEPTANCE SCENARIO for provisioning fix wave 1 — the customer P0, end to
// end, through the REAL `POST /setup-infrastructure` route.
//
// Mordy's live state on 2026-08-05: a prior setup_infrastructure REGISTERED
// goauthorpitchdesk.com at the vendor ($12.50) and died before persisting it, so
// the domain was ours and invisible to us. Every retry then hit the same wall —
// `setDns` ran the connect-an-EXISTING-domain nameserver flow against a domain
// the vendor itself had registered, which is not a slow operation, it is the
// WRONG one. It threw at step 1, was graded "retryable", and the customer's
// agent obediently repeated it for 24 hours. Zero mailboxes, one stranded
// domain, three charges' worth of risk.
//
// WHY THIS TEST EXISTS IN THIS FORM: the suite was green throughout. Every
// vendor fixture modelled "fails N times, then succeeds" (a transient race) and
// the sandbox ports model "the call returns == the resource exists". Neither can
// express a wrong operation or an async vendor, so the two defects that actually
// shipped were unrepresentable. This drives the REAL adapters against a STATEFUL
// fake vendor that behaves like the live one: registration is async, a purchased
// domain REJECTS the nameserver handshake, propagation completes on its own
// schedule, and a mailbox buy is accepted before the mailbox exists.

const REGISTRANT = {
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

const ORPHAN = "goauthorpitchdesk.com";
const ASSIGNED_NS = ["alexandra.ns.cloudflare.com", "phil.ns.cloudflare.com"];

interface VendorDomain {
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

/**
 * A stateful stand-in for the live InboxKit workspace. It answers the endpoints
 * the real adapters call, holds the state they mutate, and — critically —
 * refuses the operations the live vendor refuses.
 */
function fakeInboxKit(seed: { domains: VendorDomain[]; mailboxBuyFailure?: { status: number; message: string } }) {
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
        domains.set(d.name.toLowerCase(), {
          name: d.name,
          status: "active",
          connection_type: "purchased",
          assigned_mailboxes: 0,
          dns_propagation_status: "pending",
          nameserver_match_status: "pending",
          nameservers: ASSIGNED_NS,
          actual_nameservers: [],
        });
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
        mailboxes.set(email, { uid: `mbx-${mailboxes.size + 1}`, username: m.username, domain_name: m.domain_name, status: "scheduled" });
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

function setupBody(): string {
  return JSON.stringify({
    brand: "Author Pitch Desk",
    primaryDomain: "authorpitchdesk.com",
    domains: 1,
    inboxesEach: 1,
    persona: "Sender",
    physicalAddress: "1 Main St",
    senderIdentity: "Author Pitch Desk <hello@authorpitchdesk.com>",
    registerDomains: true,
    registrant: REGISTRANT,
  });
}

const IDEMPOTENCY_KEY = "mordy-setup-1";

function post(token: string) {
  return api<Record<string, unknown>>("/setup-infrastructure", {
    method: "POST",
    token,
    headers: { "idempotency-key": IDEMPOTENCY_KEY },
    body: setupBody(),
  });
}

function readDomains(tenantId: string): Promise<{ domain: string; dns_status: string; connection_type: string | null }[]> {
  return runInDurableObject(tenantStub(tenantId), (_i, s) =>
    s.storage.sql
      .exec<{ domain: string; dns_status: string; connection_type: string | null }>(
        `SELECT domain, dns_status, connection_type FROM domains`,
      )
      .toArray(),
  );
}

function readMailboxes(tenantId: string): Promise<{ email: string }[]> {
  return runInDurableObject(tenantStub(tenantId), (_i, s) =>
    s.storage.sql.exec<{ email: string }>(`SELECT email FROM mailboxes WHERE released_at IS NULL`).toArray(),
  );
}

describe("ACCEPTANCE — the stranded purchased domain is recovered and provisioned end to end", () => {
  const saved = {
    REGISTRAR_PROVIDER: env.REGISTRAR_PROVIDER,
    INBOXKIT_API_KEY: env.INBOXKIT_API_KEY,
    INBOXKIT_WORKSPACE_ID: env.INBOXKIT_WORKSPACE_ID,
  };

  beforeEach(async () => {
    await seedBenignSdnList();
    await env.DB.prepare("DELETE FROM vendor_spend_entries").run();
    await env.DB.prepare("DELETE FROM vendor_spend_ledger").run();
    await env.DB.prepare("DELETE FROM vendor_slot_state").run();
    Object.assign(env, { REGISTRAR_PROVIDER: "inboxkit", INBOXKIT_API_KEY: IK_API_KEY, INBOXKIT_WORKSPACE_ID: IK_WORKSPACE_ID });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Object.assign(env, saved);
  });

  it("MORDY'S LIVE SHAPE: the purchased domain's never-updating propagation fields no longer block the mailbox", async () => {
    // THE DEADLOCK, end to end (InboxKit support, 2026-08-10, verbatim: "The
    // domain goauthorpitchdesk.com is now active, and the DNS will be configured
    // during mailbox processing"). On a PURCHASED domain the vendor's propagation
    // checker never runs before a mailbox exists, so these two fields are
    // "pending" on day 1 and "pending" on day 6 — every retry re-read them and
    // stalled. This fixture therefore NEVER propagates: the customer's provisioning
    // has to finish anyway, or it never finishes at all.
    const { token, tenantId } = await mintTenant("Author Pitch Desk", "managed");
    await activatePaidPlan(tenantId, "managed");

    const vendor = fakeInboxKit({
      domains: [
        {
          name: ORPHAN,
          status: "active",
          connection_type: "purchased",
          assigned_mailboxes: 0,
          dns_propagation_status: "pending",
          nameserver_match_status: "pending",
          nameservers: ASSIGNED_NS,
          actual_nameservers: [],
        },
      ],
    });

    // ── Attempt 1: the domain is recovered and the mailbox order is placed.
    //    The vendor accepts it ("scheduled") without the mailbox existing yet. ──
    const first = await post(token);

    expect(vendor.countOf("/domains/register")).toBe(0); // $12.50 recovered, not re-spent
    expect(vendor.countOf("/mailboxes/buy")).toBe(1); // PRE-FIX: 0, forever
    expect(vendor.countOf("/warmup/add")).toBe(0); // not enrolled before it exists
    expect(await readMailboxes(tenantId)).toEqual([]); // and not billed for
    expect(first.status).toBe(502);
    expect(first.body.retryable).toBe(true);
    expect(await readDomains(tenantId)).toEqual([{ domain: ORPHAN, dns_status: "ready", connection_type: "purchased" }]);

    // ── Attempt 2: the vendor has caught up. Resume, do not re-buy. ──
    vendor.activateMailboxes();
    const second = await post(token);

    expect(second.status).toBe(202);
    expect(vendor.countOf("/mailboxes/buy")).toBe(1); // ONE purchase across both attempts
    expect(vendor.countOf("/warmup/add")).toBe(1);
    expect(vendor.countOf("/domains/register")).toBe(0);
    expect(await readMailboxes(tenantId)).toEqual([{ email: "sender11@goauthorpitchdesk.com" }]);

    // THE DEADLOCK PROOF: provisioning completed while the two fields the old
    // gate waited on never moved — exactly as they never moved for six days live.
    expect(vendor.domainState(ORPHAN)).toMatchObject({
      dns_propagation_status: "pending",
      nameserver_match_status: "pending",
      actual_nameservers: [],
    });

    // The 2026-08-05 root cause stays fixed: the connect-an-existing-domain
    // handshake is never run against a domain the vendor registered.
    expect(vendor.calls.filter((c) => c.path.startsWith("/domains/nameservers"))).toEqual([]);
  });

  it("a domain the vendor does NOT classify still waits: 202-with-a-billed-mailbox must not happen", async () => {
    // The combined-diff gate's EXECUTED repro (2026-08-06 finding #1), kept on the
    // branch where it still governs. Readiness short-circuited on a nameserver
    // match and never consulted `dns_propagation_status`, so this exact vendor
    // state returned 202 with provisionedAfter:1, one /mailboxes/buy and one
    // /warmup/add — real spend and a recurring subscription on a domain whose mail
    // DNS does not work.
    //
    // The 2026-08-10 contract fact licenses skipping the propagation verdicts for
    // domains the vendor REGISTERED. It says nothing about a domain we cannot
    // classify, so an unclassified one keeps the full wait — and this asserts the
    // fix did not widen past its evidence.
    const { token, tenantId } = await mintTenant("Author Pitch Desk", "managed");
    await activatePaidPlan(tenantId, "managed");
    const vendor = fakeInboxKit({
      domains: [
        {
          name: ORPHAN,
          status: "active",
          assigned_mailboxes: 0,
          dns_propagation_status: "pending",
          nameserver_match_status: "pending",
          nameservers: ASSIGNED_NS,
          actual_nameservers: [],
        },
      ],
    });

    // Delegation lands. The mail DNS has NOT been set up yet.
    vendor.matchNameservers(ORPHAN);
    const held = await post(token);

    expect(held.status).not.toBe(202);
    expect(vendor.countOf("/mailboxes/buy")).toBe(0); // no spend
    expect(vendor.countOf("/warmup/add")).toBe(0); // no recurring subscription
    expect(await readMailboxes(tenantId)).toEqual([]); // nothing billable
    expect(await readDomains(tenantId)).toEqual([{ domain: ORPHAN, dns_status: "pending", connection_type: "unknown" }]);

    // The vendor finishes the mail DNS — NOW it may proceed.
    vendor.propagate(ORPHAN);
    await post(token);

    expect((await readDomains(tenantId))[0]!.dns_status).toBe("ready");
    expect(vendor.countOf("/mailboxes/buy")).toBe(1);
  });

  it("HIS POST-DEPLOY RETRY: a domain row recorded before the discriminator existed still classifies correctly", async () => {
    // The state his tenant is ACTUALLY in tonight. The adopt-before-buy hotfix
    // already recorded goauthorpitchdesk.com for him — BEFORE this wave added
    // `connection_type` — so his row carries no discriminator at all, and his
    // retry lands in the convergence branch that re-drives DNS against it. If a
    // legacy row fell through to the nameserver handshake he would fail
    // identically after deploy; if it were merely DEFAULTED, the answer would be
    // right by luck rather than by classification.
    const { token, tenantId } = await mintTenant("Author Pitch Desk", "managed");
    await activatePaidPlan(tenantId, "managed");

    await runInDurableObject(tenantStub(tenantId), (_i, s) => {
      s.storage.sql.exec(
        `INSERT INTO domains (id, tenant_id, domain, status, purchased_at, dns_status) VALUES ('dom_mordy', ?, ?, 'active', 1, 'pending')`,
        tenantId,
        ORPHAN,
      );
      s.storage.sql.exec(
        `INSERT INTO domain_intents (key, tenant_id, candidate_domain, status, created_at, updated_at)
         VALUES (?, ?, ?, 'committed', 1, 1)`,
        domainIntentKey(tenantId, 0),
        tenantId,
        ORPHAN,
      );
      // Exactly what a pre-wave row looks like.
      expect(
        s.storage.sql.exec<{ connection_type: string | null }>(`SELECT connection_type FROM domains`).one().connection_type,
      ).toBeNull();
    });

    const vendor = fakeInboxKit({
      domains: [
        {
          name: ORPHAN,
          status: "active",
          connection_type: "purchased",
          assigned_mailboxes: 0,
          dns_propagation_status: "completed",
          nameserver_match_status: "matched",
          nameservers: ASSIGNED_NS,
          actual_nameservers: [...ASSIGNED_NS],
        },
      ],
    });

    await post(token);

    // Never the wrong operation, and the row now DESCRIBES ITSELF, so no later
    // attempt has to ask again.
    expect(vendor.calls.filter((c) => c.path.startsWith("/domains/nameservers"))).toEqual([]);
    expect(vendor.countOf("/domains/register")).toBe(0);
    expect(await readDomains(tenantId)).toEqual([
      { domain: ORPHAN, dns_status: "ready", connection_type: "purchased" },
    ]);
    // And it got past DNS to the mailbox leg — the step he has never reached.
    expect(vendor.countOf("/mailboxes/buy")).toBe(1);
  });

  it("the vendor failing DURING mailbox processing still surfaces, retryable, with nothing billed", async () => {
    // The safety that REPLACES the propagation wait on a purchased domain. Our
    // gate no longer proves the mail DNS is live before the buy — the vendor sets
    // it up as part of mailbox processing — so the mailbox leg is where that work
    // failing has to become visible. It does: the buy's own error grade survives
    // (a 5xx is retryable), and no mailbox row is written, so nothing is billed
    // for a domain whose DNS the vendor did not finish.
    const { token, tenantId } = await mintTenant("Author Pitch Desk", "managed");
    await activatePaidPlan(tenantId, "managed");
    const vendor = fakeInboxKit({
      domains: [
        {
          name: ORPHAN,
          status: "active",
          connection_type: "purchased",
          assigned_mailboxes: 0,
          dns_propagation_status: "pending",
          nameserver_match_status: "pending",
          nameservers: ASSIGNED_NS,
          actual_nameservers: [],
        },
      ],
      mailboxBuyFailure: { status: 500, message: "failed to configure DNS for domain" },
    });

    const res = await post(token);

    expect(res.status).toBe(502);
    expect(res.body.retryable).toBe(true);
    expect(res.body.step).toBe("mailbox purchase");
    expect(vendor.countOf("/warmup/add")).toBe(0);
    expect(await readMailboxes(tenantId)).toEqual([]);
    // And the vendor's own words never reach the customer.
    expect(JSON.stringify(res.body)).not.toMatch(/inboxkit|configure DNS for domain/i);
  });

  it("the customer never sees the provider's name or endpoints in any of those responses", async () => {
    const { token, tenantId } = await mintTenant("Author Pitch Desk", "managed");
    await activatePaidPlan(tenantId, "managed");
    fakeInboxKit({
      domains: [
        {
          name: ORPHAN,
          status: "active",
          connection_type: "purchased",
          assigned_mailboxes: 0,
          dns_propagation_status: "pending",
          nameserver_match_status: "pending",
          nameservers: ASSIGNED_NS,
          actual_nameservers: [],
        },
      ],
    });

    const res = await post(token);
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toMatch(/inboxkit/i);
    expect(serialized).not.toMatch(/domains\/|mailboxes\/|warmup\//);
    // Still actionable: WHICH step, and whether retrying helps. The purchased
    // domain now clears the DNS gate on the vendor's contract, so the honest
    // stopping point is the mailbox the vendor has accepted but not yet created.
    expect(res.body.step).toBe("mailbox purchase");
    expect(res.body.retryable).toBe(true);

    // The activity feed the agent reads back is clean too.
    const actions = await runInDurableObject(tenantStub(tenantId), (_i, s) =>
      s.storage.sql.exec<{ detail_json: string }>(`SELECT detail_json FROM deliverability_actions`).toArray(),
    );
    expect(actions.length).toBeGreaterThan(0);
    expect(JSON.stringify(actions)).not.toMatch(/inboxkit/i);
  });
});
