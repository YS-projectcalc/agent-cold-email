/// <reference types="vite/client" />
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  domainDnsResult,
  NotActivatedError,
  VendorError,
  type DomainDnsResult,
  type DomainConnectionType,
  type DomainPort,
  type LookalikeCandidate,
  type OwnedDomain,
  type PurchasedDomain,
  type ReleaseResult,
} from "@coldstart/shared";
import { runSetupInfrastructure } from "../src/engine/provisioning.js";
import { toErrorResponse } from "../src/error-response.js";
import { SandboxOpsMailer } from "../src/ops-mail/sandbox-ops-mailer.js";
import { activatePaidPlan, mintTenant, tenantStub, withTenantContext } from "./helpers.js";

// Gate fixes — docs/adversarial/incident-hotfix-gate-2026-08-05.md.
// EVERY provisioning assertion here drives `runSetupInfrastructure`, never the
// inner `provisionDomainWithMailboxes`. Calling the inner helper is exactly why
// all four adopt tests missed B2: it bypasses the candidate filter that was
// deleting adopt's only input.

interface PortState {
  buys: string[];
  setDns: string[];
  listOwned: number;
}

/**
 * A DomainPort with PRODUCTION-REAL availability semantics (the B2 fixture
 * correction): a domain the account already owns reports `available:false`,
 * because the real port derives availability from GET /domains/available. The
 * old adopt fixtures reported owned domains as available:true — a state that
 * cannot exist in production, which is what let the broken filter look correct.
 */
function realisticDomainPort(opts: { owned?: OwnedDomain[]; setDnsFailures?: number; candidates?: string[] }): {
  port: DomainPort;
  state: PortState;
} {
  const state: PortState = { buys: [], setDns: [], listOwned: 0 };
  const owned = opts.owned ?? [];
  const ownedNames = new Set(owned.map((o) => o.domain.toLowerCase()));
  let dnsFailures = opts.setDnsFailures ?? 0;

  const port: DomainPort = {
    async searchLookalikes(brand, primaryDomain, count): Promise<LookalikeCandidate[]> {
      const slug = (primaryDomain.split(".")[0] ?? brand).toLowerCase();
      const names = opts.candidates ?? [`go${slug}.com`, `the${slug}.com`, `my${slug}.com`, `get${slug}.com`, `try${slug}.com`];
      const out: LookalikeCandidate[] = [];
      for (let i = 0; out.length < count; i++) {
        const domain = names[i] ?? `${slug}${i - names.length + 1}.com`;
        out.push({ domain, available: !ownedNames.has(domain.toLowerCase()) });
      }
      return out;
    },
    async listOwnedDomains(): Promise<OwnedDomain[]> {
      state.listOwned++;
      return owned;
    },
    async buy(domain: string): Promise<PurchasedDomain> {
      state.buys.push(domain);
      return { domain, purchasedAt: Date.now(), registrar: "test", connectionType: "purchased" };
    },
    async setDns(domain: string, _key: string, connectionType: DomainConnectionType): Promise<DomainDnsResult> {
      state.setDns.push(`${domain}:${connectionType}`);
      if (dnsFailures-- > 0) throw new VendorError("inboxkit domains/nameservers failed: domain not found", true);
      return domainDnsResult({ kind: "ready" });
    },
    async release(): Promise<ReleaseResult> {
      return { released: true, releasedAt: Date.now() };
    },
  };
  return { port, state };
}

function setupInput(brand: string, primaryDomain: string, domains = 1, inboxesEach = 1) {
  return {
    brand,
    primaryDomain,
    domains,
    inboxesEach,
    persona: "Sender",
    physicalAddress: "1 Test St",
    senderIdentity: `S <s@${primaryDomain}>`,
    quoteOnly: false as const,
  };
}

function readDomains(tenantId: string): Promise<{ domain: string; dns_status: string }[]> {
  return runInDurableObject(tenantStub(tenantId), (_i, s) =>
    s.storage.sql.exec<{ domain: string; dns_status: string }>(`SELECT domain, dns_status FROM domains`).toArray(),
  );
}

function readMailboxCount(tenantId: string): Promise<number> {
  return runInDurableObject(tenantStub(tenantId), (_i, s) =>
    s.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) as n FROM mailboxes WHERE released_at IS NULL`).one().n,
  );
}

function readIntents(tenantId: string): Promise<{ candidate_domain: string; status: string }[]> {
  return runInDurableObject(tenantStub(tenantId), (_i, s) =>
    s.storage.sql.exec<{ candidate_domain: string; status: string }>(`SELECT candidate_domain, status FROM domain_intents`).toArray(),
  );
}

describe("B2 — adopt fires for a domain the vendor already owns (Mordy's live state)", () => {
  it("replaying his exact call ADOPTS goauthorpitchdesk.com with ZERO buys, no seeded intent row", async () => {
    // His live state: the domain is registered at InboxKit with no mailboxes
    // attached, there is NO local domains row and NO domain_intents row (the
    // table did not exist when his call failed). Pre-fix this bought a SECOND
    // $12.50 domain and left the first orphaned forever.
    const { tenantId } = await mintTenant("Author Pitch Desk", "managed");
    await activatePaidPlan(tenantId, "managed");
    const { port, state } = realisticDomainPort({
      owned: [{ domain: "goauthorpitchdesk.com", status: "active", assignedMailboxes: 0, connectionType: "purchased" }],
      candidates: ["goauthorpitchdesk.com", "theauthorpitchdesk.com", "myauthorpitchdesk.com"],
    });

    await withTenantContext(tenantId, (base) =>
      runSetupInfrastructure(
        { ...base, adapters: { ...base.adapters, domain: port } },
        setupInput("Author Pitch Desk", "authorpitchdesk.com", 1, 2),
        new SandboxOpsMailer(),
        "apd-setup-a-2mbx",
      ),
    );

    expect(state.buys).toEqual([]); // the whole point: $12.50 recovered, not re-spent
    expect(await readDomains(tenantId)).toEqual([{ domain: "goauthorpitchdesk.com", dns_status: "ready" }]);
    expect(await readMailboxCount(tenantId)).toBe(2);
    // N1 — the intent names what we actually hold.
    expect(await readIntents(tenantId)).toEqual([{ candidate_domain: "goauthorpitchdesk.com", status: "committed" }]);
  });

  it("still BUYS when the owned domain already has mailboxes attached (never re-homes someone's mail)", async () => {
    const { tenantId } = await mintTenant("Assigned Owned Co", "managed");
    await activatePaidPlan(tenantId, "managed");
    const { port, state } = realisticDomainPort({
      owned: [{ domain: "goassignedownedco.com", status: "active", assignedMailboxes: 3, connectionType: "purchased" }],
      candidates: ["goassignedownedco.com", "theassignedownedco.com"],
    });

    await withTenantContext(tenantId, (base) =>
      runSetupInfrastructure(
        { ...base, adapters: { ...base.adapters, domain: port } },
        setupInput("Assigned Owned Co", "assignedownedco.com"),
        new SandboxOpsMailer(),
        "assigned-key",
      ),
    );

    expect(state.buys).toEqual(["theassignedownedco.com"]);
  });
});

describe("B1 — a retry re-drives DNS and never bills mailboxes onto dead DNS", () => {
  it("attempt 1 fails DNS with zero mailboxes; attempt 2 RE-DRIVES setDns and only then provisions", async () => {
    const { tenantId } = await mintTenant("Retry Dns Co", "managed");
    await activatePaidPlan(tenantId, "managed");

    // Attempt 1: buy lands, DNS loses the ~32s async-registration race.
    const first = realisticDomainPort({ setDnsFailures: 99 });
    const err = await withTenantContext(tenantId, (base) =>
      runSetupInfrastructure(
        { ...base, adapters: { ...base.adapters, domain: first.port } },
        setupInput("Retry Dns Co", "retrydnsco.com", 1, 2),
        new SandboxOpsMailer(),
        "retry-dns-key",
      ).catch((e: unknown) => e),
    );
    expect(err).toBeInstanceOf(VendorError);
    expect((await readDomains(tenantId))[0]!.dns_status).toBe("pending");
    // NO mailbox spend onto a domain whose nameservers were never pointed.
    expect(await readMailboxCount(tenantId)).toBe(0);

    // Attempt 2: same key → convergence branch. Pre-fix it returned a 202 with
    // 2 billable mailboxes and setDns calls: ZERO — the failed step never re-ran.
    const second = realisticDomainPort({ setDnsFailures: 0 });
    await withTenantContext(tenantId, (base) =>
      runSetupInfrastructure(
        { ...base, adapters: { ...base.adapters, domain: second.port } },
        setupInput("Retry Dns Co", "retrydnsco.com", 1, 2),
        new SandboxOpsMailer(),
        "retry-dns-key",
      ),
    );

    expect(second.state.setDns.length).toBeGreaterThan(0); // it was actually re-driven
    expect(second.state.buys).toEqual([]); // converged, no second purchase
    expect((await readDomains(tenantId))[0]!.dns_status).toBe("ready");
    expect(await readMailboxCount(tenantId)).toBe(2);
  });

  it("a retry whose DNS STILL fails provisions NO mailboxes", async () => {
    const { tenantId } = await mintTenant("Dns Still Dead Co", "managed");
    await activatePaidPlan(tenantId, "managed");
    const opts = { setDnsFailures: 99 };

    for (let attempt = 0; attempt < 2; attempt++) {
      const { port } = realisticDomainPort(opts);
      await withTenantContext(tenantId, (base) =>
        runSetupInfrastructure(
          { ...base, adapters: { ...base.adapters, domain: port } },
          setupInput("Dns Still Dead Co", "dnsstilldead.com", 1, 2),
          new SandboxOpsMailer(),
          "dns-dead-key",
        ).catch(() => undefined),
      );
    }

    expect((await readDomains(tenantId))[0]!.dns_status).toBe("pending");
    expect(await readMailboxCount(tenantId)).toBe(0); // never billed onto dead DNS
  });
});

describe("B3 — the partial unique index can never brick a tenant DO", () => {
  it("a DO carrying DUPLICATE live mailbox rows still boots, and ends deduped", async () => {
    const { tenantId } = await mintTenant("Dupe Rows Co", "managed");

    // Seed the F12 state: two LIVE rows sharing (tenant_id, email). Done with
    // the index already present, so drop it first — this reproduces a DO that
    // predates the index and carries duplicates at deploy time.
    await runInDurableObject(tenantStub(tenantId), (_i, s) => {
      s.storage.sql.exec(`DROP INDEX IF EXISTS idx_mailboxes_live_email`);
      for (let i = 0; i < 2; i++) {
        s.storage.sql.exec(
          `INSERT INTO mailboxes (id, tenant_id, domain_id, domain, email, daily_cap, sent_today, sent_today_epoch_day, status, warmup_started_at, created_at, poll_cursor)
           VALUES (?, ?, 'dom_x', 'dupe.com', 'dupe@dupe.com', 5, 0, 0, 'warming', 1, 1, -1)`,
          `mbx_dupe_${i}`,
          tenantId,
        );
      }
      const n = s.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) as n FROM mailboxes WHERE email = 'dupe@dupe.com'`).one().n;
      expect(n).toBe(2);
    });

    // Run the migration step exactly as the constructor does. (The pool reuses
    // a constructed DO instance, so there is no way to force a real re-boot
    // here — invoking the same private helper against the same duplicate state
    // is the closest honest reproduction, and it is the code that threw.)
    // Pre-fix this raised UNIQUE constraint failed, the throw escaped the
    // constructor, and the tenant's DO became permanently unbootable.
    await runInDurableObject(tenantStub(tenantId), (instance) => {
      const migrate = instance as unknown as {
        ensurePartialDedupeIndex(i: string, t: string, c: string[], p: string): void;
      };
      expect(() =>
        migrate.ensurePartialDedupeIndex("idx_mailboxes_live_email", "mailboxes", ["tenant_id", "email"], "released_at IS NULL"),
      ).not.toThrow();
    });

    // And the DO is still usable afterwards.
    expect(await tenantStub(tenantId).account()).toBeDefined();

    const after = await runInDurableObject(tenantStub(tenantId), (_i, s) => ({
      dupes: s.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) as n FROM mailboxes WHERE email = 'dupe@dupe.com'`).one().n,
      hasIndex: s.storage.sql
        .exec<{ n: number }>(`SELECT COUNT(*) as n FROM sqlite_master WHERE type='index' AND name='idx_mailboxes_live_email'`)
        .one().n,
    }));
    expect(after.dupes).toBe(1); // collapsed, original kept
    expect(after.hasIndex).toBe(1); // and the index did get applied
  });

  it("the constructor's migration path uses the guarded helper, not a raw CREATE", async () => {
    // The behavioral test above cannot re-boot a pooled DO, so this pins the
    // structural half: a raw `CREATE UNIQUE INDEX` for this index anywhere in
    // tenant-do.ts means the collapse + try/catch have been bypassed again, and
    // the brick-the-DO hazard is back regardless of what the helper does.
    const source = (await import("../src/tenant-do.ts?raw")).default;
    expect(source).toContain('ensurePartialDedupeIndex("idx_mailboxes_live_email"');
    expect(source).not.toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS idx_mailboxes_live_email/);
  });
});

describe("N2 — no adapter internals reach a customer", () => {
  const LEAKS = [
    /ACTIVATION\.md/i,
    /ENGINE_BASE_URL/,
    /INBOXKIT_API_KEY/,
    /REGISTRAR_PROVIDER/,
    /CLOUDFLARE_REGISTRAR_API_TOKEN/,
    /10\.\d+\.\d+\.\d+/,
    /ECONNREFUSED/,
    /checkout\.stripe\.com/,
    /https?:\/\//,
  ];

  // Real messages from the actual adapter throw sites, verbatim in shape.
  const REAL_VENDOR_ERRORS = [
    new VendorError(
      "inboxkit domains/register for goauthorpitchdesk.com requires a Stripe checkout (insufficient wallet balance): https://checkout.stripe.com/c/pay/cs_live_a1b2c3",
      false,
    ),
    new VendorError("engine send unreachable at http://10.0.0.7:8787: connect ECONNREFUSED 10.0.0.7:8787", true),
    new VendorError("gmail oauth grant for sender11@x.com is manually-minted and missing; see ACTIVATION.md", false),
    new VendorError("inboxkit has no mailbox matching sender11@goauthorpitchdesk.com", false),
    new NotActivatedError("mailbox", "provision"),
  ];

  it("every real adapter error translates to a customer-safe body", () => {
    for (const err of REAL_VENDOR_ERRORS) {
      const { body } = toErrorResponse(err);
      const serialized = JSON.stringify(body);
      for (const leak of LEAKS) {
        expect(serialized, `leaked ${leak} from: ${err.message}`).not.toMatch(leak);
      }
      // Still actionable: a code, and a retryable grade the agent can branch on.
      expect(typeof body.code).toBe("string");
    }
  });

  it("drops junk step values and maps recognized ones to an ABSTRACT label", () => {
    // "unreachable" / "manually-minted" are the junk the old parse emitted.
    expect(toErrorResponse(new VendorError("engine send unreachable at http://10.0.0.7:8787", true)).body.step).toBeUndefined();
    expect(toErrorResponse(new VendorError("gmail oauth manually-minted grant missing", false)).body.step).toBeUndefined();
    // The allowlist USED to pass the vendor's literal endpoint path through as
    // `step` — its own leak (sweep-vendor-leak-2026-08-05): "domains/register"
    // is a route you can curl to identify the provider. It is now prose.
    expect(toErrorResponse(new VendorError("inboxkit domains/register failed for x.com", false)).body.step).toBe("domain registration");
  });

  it("preserves the retryable grade so an agent can still back off correctly", () => {
    expect(toErrorResponse(new VendorError("inboxkit warmup/cancel transient", true)).body.retryable).toBe(true);
    expect(toErrorResponse(new VendorError("inboxkit mailboxes/buy permanent", false)).body.retryable).toBe(false);
  });
});

void env;
