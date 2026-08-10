import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  RegistrarUnarmedError,
  VendorError,
  type DnsRecordSet,
  type DomainConnectionType,
  type DomainPort,
  type LookalikeCandidate,
  type OwnedDomain,
  type PurchasedDomain,
  type ReleaseResult,
} from "@coldstart/shared";
import { toErrorResponse } from "../src/error-response.js";
import { domainIntentKey } from "../src/engine/provision-intents.js";
import { runSetupInfrastructure } from "../src/engine/provisioning.js";
import { SandboxOpsMailer } from "../src/ops-mail/sandbox-ops-mailer.js";
import { activatePaidPlan, mintTenant, tenantStub, withTenantContext } from "./helpers.js";

// L1 + retryable-laundering (docs/adversarial/forward-path-audit-2026-08-05.md,
// sweep-domain-type class 2/3). Two defects that OUTLIVE the wrong-operation fix:
//
//  L1  `dns_status` flipped to 'ready' whenever setDns did not THROW. setDns
//      only throws on a vendor ERROR; a domain whose nameservers have not
//      propagated returns all-false perfectly successfully — so the mailbox buy
//      ran against a domain with no working mail DNS, and billed for it monthly.
//
//  L2* every failure was re-thrown as retryable:true. A PERMANENT failure then
//      reads to the customer's agent as "retry to finish it", which is precisely
//      how one wrong vendor call became a 24-hour retry loop.
//
// These drive runSetupInfrastructure (never the inner provision helper) so the
// candidate filter, adopt path and mailbox loop are all really in the path.

interface PortLog {
  buys: string[];
  setDns: { domain: string; connectionType: DomainConnectionType }[];
}

function domainPort(opts: {
  /** What setDns reports: 'ready' | 'not-propagated', or an error to throw. */
  dns: "ready" | "not-propagated" | { throw: VendorError };
}): { port: DomainPort; log: PortLog } {
  const log: PortLog = { buys: [], setDns: [] };
  const port: DomainPort = {
    async searchLookalikes(_brand, primaryDomain, count): Promise<LookalikeCandidate[]> {
      const slug = primaryDomain.split(".")[0];
      return Array.from({ length: count }, (_v, i) => ({ domain: `${slug}${i}.com`, available: true }));
    },
    async listOwnedDomains(): Promise<OwnedDomain[]> {
      return [];
    },
    async buy(domain: string): Promise<PurchasedDomain> {
      log.buys.push(domain);
      return { domain, purchasedAt: Date.now(), registrar: "test", connectionType: "purchased" };
    },
    async setDns(domain: string, _key: string, connectionType: DomainConnectionType): Promise<DnsRecordSet> {
      log.setDns.push({ domain, connectionType });
      if (typeof opts.dns === "object") throw opts.dns.throw;
      const ready = opts.dns === "ready";
      return { mx: ready, spf: ready, dkim: ready, dmarc: ready, rdns: ready };
    },
    async release(): Promise<ReleaseResult> {
      return { released: true, releasedAt: Date.now() };
    },
  };
  return { port, log };
}

function setupInput(brand: string, primaryDomain: string) {
  return {
    brand,
    primaryDomain,
    domains: 1,
    inboxesEach: 2,
    persona: "Sender",
    physicalAddress: "1 Test St",
    senderIdentity: `S <s@${primaryDomain}>`,
    quoteOnly: false as const,
  };
}

async function runSetup(tenantId: string, port: DomainPort, primaryDomain: string, key: string): Promise<unknown> {
  // The brand-ownership guard requires the brand and the primary domain to
  // correspond, so each scenario's brand is derived from its own domain.
  const brand = primaryDomain.replace(/\.com$/, "");
  return withTenantContext(tenantId, (base) =>
    runSetupInfrastructure(
      { ...base, adapters: { ...base.adapters, domain: port } },
      setupInput(brand, primaryDomain),
      new SandboxOpsMailer(),
      key,
    ).catch((e: unknown) => e),
  );
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

function readMailboxCount(tenantId: string): Promise<number> {
  return runInDurableObject(tenantStub(tenantId), (_i, s) =>
    s.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) as n FROM mailboxes WHERE released_at IS NULL`).one().n,
  );
}

function readActions(tenantId: string): Promise<{ action: string; detail_json: string }[]> {
  return runInDurableObject(tenantStub(tenantId), (_i, s) =>
    s.storage.sql.exec<{ action: string; detail_json: string }>(`SELECT action, detail_json FROM deliverability_actions`).toArray(),
  );
}

describe("L1 — the mailbox buy is gated on REAL propagation, not on setDns not throwing", () => {
  it("a domain whose DNS has NOT propagated provisions ZERO mailboxes and stays 'pending'", async () => {
    const { tenantId } = await mintTenant("Dns Gate Co", "managed");
    await activatePaidPlan(tenantId, "managed");
    const { port, log } = domainPort({ dns: "not-propagated" });

    const err = await runSetup(tenantId, port, "notpropagated.com", "gate-1");

    // Pre-fix: setDns returned WITHOUT throwing, so dns_status flipped to
    // 'ready', the call returned 202, and two mailboxes were bought (and billed
    // monthly) on a domain whose nameservers were pointed nowhere.
    expect(err).toBeInstanceOf(VendorError);
    expect((err as VendorError).retryable).toBe(true);
    expect(await readMailboxCount(tenantId)).toBe(0);
    const domains = await readDomains(tenantId);
    expect(domains).toHaveLength(1); // the domain we paid for is still recorded
    expect(domains[0]!.dns_status).toBe("pending");
    expect(log.buys).toHaveLength(1);
  });

  it("a domain whose DNS IS propagated flips 'ready' and provisions normally", async () => {
    const { tenantId } = await mintTenant("Dns Gate Co", "managed");
    await activatePaidPlan(tenantId, "managed");
    const { port } = domainPort({ dns: "ready" });

    await runSetup(tenantId, port, "propagated.com", "gate-2");

    expect((await readDomains(tenantId))[0]!.dns_status).toBe("ready");
    expect(await readMailboxCount(tenantId)).toBe(2);
  });

  it("the RECORDED connection type is what reaches setDns — the fix has something to branch on", async () => {
    const { tenantId } = await mintTenant("Dns Gate Co", "managed");
    await activatePaidPlan(tenantId, "managed");
    const { port, log } = domainPort({ dns: "ready" });

    await runSetup(tenantId, port, "carrytype.com", "gate-3");

    expect(log.setDns.map((c) => c.connectionType)).toEqual(["purchased"]);
    expect((await readDomains(tenantId))[0]!.connection_type).toBe("purchased");
  });
});

describe("LEGACY ROWS — a domain recorded before the discriminator existed is CLASSIFIED, not guessed", () => {
  // THE POST-DEPLOY ATTACK VECTOR. The incident customer's domain was recorded
  // by the adopt-before-buy hotfix BEFORE this column existed, so his row says
  // nothing about which DNS procedure applies. Defaulting it to the read-only
  // poll is safe but is still a guess — and the adopt path can equally produce a
  // CONNECTED domain, for which poll-only never creates the vendor-side zone and
  // the domain sits 'pending' forever. So an unknown row asks the vendor.

  /**
   * The incident customer's exact post-hotfix state: a COMMITTED intent plus a
   * domains row with dns_status 'pending' and NO connection_type, so his retry
   * lands in the convergence branch and re-drives DNS against a row that
   * describes nothing. The intent must sit at the key runSetupInfrastructure
   * resolves for ordinal 0, or the retry buys a fresh domain instead of
   * converging — which is the whole scenario.
   */
  async function seedLegacyRow(tenantId: string, domain: string): Promise<void> {
    await runInDurableObject(tenantStub(tenantId), (_i, s) => {
      s.storage.sql.exec(
        `INSERT INTO domains (id, tenant_id, domain, status, purchased_at, dns_status) VALUES ('dom_legacy', ?, ?, 'active', 1, 'pending')`,
        tenantId,
        domain,
      );
      s.storage.sql.exec(
        `INSERT INTO domain_intents (key, tenant_id, candidate_domain, status, created_at, updated_at)
         VALUES (?, ?, ?, 'committed', 1, 1)`,
        domainIntentKey(tenantId, 0),
        tenantId,
        domain,
      );
    });
  }

  function ownedAs(connectionType: DomainConnectionType, domain: string) {
    return { domain, status: "active", assignedMailboxes: 0, connectionType };
  }

  it("a legacy PURCHASED row is backfilled from the vendor and driven with the poll branch", async () => {
    const { tenantId } = await mintTenant("Legacy Purchased Co", "managed");
    await activatePaidPlan(tenantId, "managed");
    const { port, log } = domainPort({ dns: "ready" });
    port.listOwnedDomains = async () => [ownedAs("purchased", "legacypurchased0.com")];
    await seedLegacyRow(tenantId, "legacypurchased0.com");

    await runSetup(tenantId, port, "legacypurchased.com", "legacy-1");

    expect(log.setDns.map((c) => c.connectionType)).toEqual(["purchased"]);
    // Self-healing: the row now describes itself, so no later attempt re-asks.
    expect((await readDomains(tenantId))[0]!.connection_type).toBe("purchased");
  });

  it("a legacy CONNECTED row gets the HANDSHAKE — the case a safe default would stall forever", async () => {
    const { tenantId } = await mintTenant("Legacy Connected Co", "managed");
    await activatePaidPlan(tenantId, "managed");
    const { port, log } = domainPort({ dns: "ready" });
    port.listOwnedDomains = async () => [ownedAs("connected", "legacyconnected0.com")];
    await seedLegacyRow(tenantId, "legacyconnected0.com");

    await runSetup(tenantId, port, "legacyconnected.com", "legacy-2");

    // Guessing 'purchased' here would poll a zone that was never created: the
    // domain never becomes ready, and nothing ever says why.
    expect(log.setDns.map((c) => c.connectionType)).toEqual(["connected"]);
    expect((await readDomains(tenantId))[0]!.connection_type).toBe("connected");
  });

  it("when the vendor cannot be asked, it falls back to the READ-ONLY branch and records no guess", async () => {
    const { tenantId } = await mintTenant("Legacy Unaskable Co", "managed");
    await activatePaidPlan(tenantId, "managed");
    const { port, log } = domainPort({ dns: "ready" });
    port.listOwnedDomains = async () => {
      throw new VendorError("inboxkit domains/list -> HTTP 503: upstream busy", true);
    };
    await seedLegacyRow(tenantId, "legacyunaskable0.com");

    await runSetup(tenantId, port, "legacyunaskable.com", "legacy-3");

    // Never the handshake on an unproven domain, and the row keeps its NULL so a
    // later attempt re-resolves instead of inheriting a guess.
    expect(log.setDns.map((c) => c.connectionType)).toEqual(["unknown"]);
    expect((await readDomains(tenantId))[0]!.connection_type).toBeNull();
  });
});

describe("retryable laundering — a permanent DNS failure must not read as 'retry to finish it'", () => {
  it("a PERMANENT vendor error surfaces as non-retryable and is attempted exactly ONCE", async () => {
    const { tenantId } = await mintTenant("Dns Gate Co", "managed");
    await activatePaidPlan(tenantId, "managed");
    const { port, log } = domainPort({
      dns: { throw: new VendorError("inboxkit domains/nameservers -> HTTP 404: Domain not found", false) },
    });

    const err = await runSetup(tenantId, port, "permanentfail.com", "gate-4");

    // Pre-fix: setDnsWithRetry swallowed the grade and threw retryable:true
    // ("Nothing was lost — retry to finish it"), and re-issued the doomed call
    // on every in-call attempt AND every customer retry.
    expect(err).toBeInstanceOf(VendorError);
    expect((err as VendorError).retryable).toBe(false);
    expect(log.setDns).toHaveLength(1); // not re-attempted — repetition cannot help
    expect(await readMailboxCount(tenantId)).toBe(0);
  });

  it("a TRANSIENT vendor error is still retried in-call and still reads retryable", async () => {
    const { tenantId } = await mintTenant("Dns Gate Co", "managed");
    await activatePaidPlan(tenantId, "managed");
    const { port, log } = domainPort({
      dns: { throw: new VendorError("inboxkit domains/list -> HTTP 503: upstream busy", true) },
    });

    const err = await runSetup(tenantId, port, "transientfail.com", "gate-5");

    expect((err as VendorError).retryable).toBe(true);
    expect(log.setDns.length).toBeGreaterThan(1);
  });

  it("a NAMED error class survives the wrapper with its own mapping intact", async () => {
    const { tenantId } = await mintTenant("Dns Gate Co", "managed");
    await activatePaidPlan(tenantId, "managed");
    const { port } = domainPort({ dns: { throw: new RegistrarUnarmedError("setDns") } });

    const err = await runSetup(tenantId, port, "namederror.com", "gate-7");

    // Flattening this into a plain VendorError would DOWNGRADE an accurate,
    // actionable 503 registrar_unarmed ("no purchase was made, the operator has
    // been notified") into a generic 502 "an upstream provider failed".
    expect(err).toBeInstanceOf(RegistrarUnarmedError);
    expect(toErrorResponse(err).status).toBe(503);
    expect(toErrorResponse(err).body.code).toBe("registrar_unarmed");
  });

  it("the customer-visible failure names the step and the provider, never the vendor", async () => {
    const { tenantId } = await mintTenant("Dns Gate Co", "managed");
    await activatePaidPlan(tenantId, "managed");
    const { port } = domainPort({
      dns: { throw: new VendorError("inboxkit domains/nameservers -> HTTP 404: Domain not found", false) },
    });

    const err = await runSetup(tenantId, port, "leakcheck.com", "gate-6");

    expect((err as Error).message).not.toMatch(/inboxkit/i);
    expect((err as Error).message).not.toMatch(/domains\//);
    expect((err as VendorError).step).toBe("domain DNS setup");

    const pending = (await readActions(tenantId)).filter((a) => a.action === "DOMAIN_DNS_PENDING");
    expect(pending).toHaveLength(1);
    // The activity row is customer-readable (account().recentActions), so it
    // carries the abstract step + an honest grade — never the adapter's text.
    const detail = JSON.parse(pending[0]!.detail_json) as { step: string; retryable: boolean; reason: string };
    expect(detail.step).toBe("domain DNS setup");
    expect(detail.retryable).toBe(false);
    expect(JSON.stringify(detail)).not.toMatch(/inboxkit/i);
  });
});

void env;
