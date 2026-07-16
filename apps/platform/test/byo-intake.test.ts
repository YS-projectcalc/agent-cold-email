import { describe, expect, it } from "vitest";
import { ValidationError } from "@coldstart/shared";
import {
  acknowledgePrimaryDomainConsent,
  getByoDomain,
  listByoDomains,
  pollByoDomainDns,
  registerByoDomain,
} from "../src/engine/byo-intake.js";
import { ONE_DAY_MS } from "../src/engine/warmup.js";
import { signup, tenantStub, withTenantContext } from "./helpers.js";

// Integration tests for the SPEC.md §20 intake orchestration, driven through
// a REAL TenantContext (withTenantContext) against the real DO SQLite +
// sandbox DnsScanPort/DomainReputationPort fixtures (magic-substring
// hostnames — see vendors/sandbox/dns-scan-port.ts / reputation-port.ts).

async function tenant(brand: string, contact: string) {
  const { tenantId } = await signup(brand, contact);
  return tenantId;
}

describe("registerByoDomain", () => {
  it("registers a fresh-standalone domain as we_manage_zone/pending_dns, standard breaker tier", async () => {
    const tenantId = await tenant("Fresh Standalone Co", "fresh@example.com");
    const record = await withTenantContext(tenantId, (ctx) =>
      registerByoDomain(ctx, { domain: "fresh-standalone.com", domainRelationship: "fresh_standalone" }),
    );
    expect(record.isPrimary).toBe(false);
    expect(record.dnsMode).toBe("we_manage_zone");
    expect(record.byoStatus).toBe("pending_dns");
    expect(record.breakerTier).toBe("standard");
    expect(record.abuseVerdict).toBe("clear");
  });

  it("registers a primary domain as records_to_apply/pending_consent, primary breaker tier, lowercased+trimmed", async () => {
    const tenantId = await tenant("Primary Register Co", "primary@example.com");
    const record = await withTenantContext(tenantId, (ctx) =>
      registerByoDomain(ctx, { domain: "  Primary-Register.COM  ", domainRelationship: "is_primary" }),
    );
    expect(record.domain).toBe("primary-register.com");
    expect(record.isPrimary).toBe(true);
    expect(record.dnsMode).toBe("records_to_apply");
    expect(record.byoStatus).toBe("pending_consent");
    expect(record.breakerTier).toBe("primary");
  });

  it("registers a subdomain-of-primary as 'elevated' breaker tier, non-primary", async () => {
    const tenantId = await tenant("Subdomain Co", "sub@example.com");
    const record = await withTenantContext(tenantId, (ctx) =>
      registerByoDomain(ctx, { domain: "send.subdomain-co.com", domainRelationship: "subdomain_of_primary" }),
    );
    expect(record.isPrimary).toBe(false);
    expect(record.breakerTier).toBe("elevated");
    expect(record.byoStatus).toBe("pending_dns");
  });

  it("hard-refuses delegation (records_to_apply) when the pre-flight scan finds live infra on a non-primary domain", async () => {
    const tenantId = await tenant("Live Infra Co", "live@example.com");
    const record = await withTenantContext(tenantId, (ctx) =>
      registerByoDomain(ctx, { domain: "liveinfra-dedicated.com", domainRelationship: "fresh_standalone" }),
    );
    expect(record.dnsMode).toBe("records_to_apply");
  });

  it("routes an abuse-gate hit (paypa1.com-class) to pending_kyc, never auto-admit", async () => {
    const tenantId = await tenant("Kyc Test Co", "kyc@example.com");
    const record = await withTenantContext(tenantId, (ctx) =>
      registerByoDomain(ctx, { domain: "paypa1-outreach.com", domainRelationship: "fresh_standalone" }),
    );
    expect(record.abuseVerdict).toBe("kyc_required");
    expect(record.byoStatus).toBe("pending_kyc");
  });

  it("rejects a blocklisted domain at intake (deliverability lane, not abuse), for a non-primary domain", async () => {
    const tenantId = await tenant("Blocklist Test Co", "blk@example.com");
    const record = await withTenantContext(tenantId, (ctx) =>
      registerByoDomain(ctx, { domain: "blocklisted-domain.com", domainRelationship: "fresh_standalone" }),
    );
    expect(record.byoStatus).toBe("rejected");
    expect(record.reputationBranch).toBe("blocklisted_reject");
  });

  it("rejects a blocklisted PRIMARY domain too (blocklist gates before the primary-axis-first branch)", async () => {
    const tenantId = await tenant("Blocklist Primary Co", "blkp@example.com");
    const record = await withTenantContext(tenantId, (ctx) =>
      registerByoDomain(ctx, { domain: "blocklisted-primary.com", domainRelationship: "is_primary" }),
    );
    expect(record.byoStatus).toBe("rejected");
  });

  it("routes a non-primary established-good domain to the shortened-ramp reputation branch", async () => {
    // Trips BOTH sandbox heuristics: "established" (reputation port: age>=2yr
    // + active-sending-evidence) AND "enforced" (DNS-scan port: DMARC
    // p=reject) -- computeReputationBranch requires ALL of age+dmarc+
    // active-sending together (SPEC.md §20.5).
    const tenantId = await tenant("Established Co", "est@example.com");
    const record = await withTenantContext(tenantId, (ctx) =>
      registerByoDomain(ctx, { domain: "established-enforced.com", domainRelationship: "fresh_standalone" }),
    );
    expect(record.reputationBranch).toBe("established_good");
  });

  it("a primary domain always reports 'primary_standard' reputation, ignoring an otherwise-established-good signal", async () => {
    const tenantId = await tenant("Established Primary Co", "estp@example.com");
    const record = await withTenantContext(tenantId, (ctx) =>
      registerByoDomain(ctx, { domain: "established-enforced-primary.com", domainRelationship: "is_primary" }),
    );
    expect(record.reputationBranch).toBe("primary_standard");
  });

  it("refuses registration on a lifecycle-frozen (suspended) tenant", async () => {
    const tenantId = await tenant("Frozen Co", "frozen@example.com");
    await withTenantContext(tenantId, (ctx) => {
      ctx.sql.exec(`UPDATE tenant_profile SET status = 'suspended', suspend_reason = 'terminate' WHERE id = ?`, tenantId);
    });
    await expect(
      withTenantContext(tenantId, (ctx) => registerByoDomain(ctx, { domain: "frozen-domain.com", domainRelationship: "fresh_standalone" })),
    ).rejects.toThrow(ValidationError);
  });

  it("is tenant-isolated: a domain registered by tenant A is invisible to tenant B's listByoDomains", async () => {
    const tenantA = await tenant("Isolation A Co", "a@example.com");
    const tenantB = await tenant("Isolation B Co", "b@example.com");
    await withTenantContext(tenantA, (ctx) => registerByoDomain(ctx, { domain: "isolation-a.com", domainRelationship: "fresh_standalone" }));

    const listB = await withTenantContext(tenantB, (ctx) => listByoDomains(ctx));
    expect(listB).toHaveLength(0);
    const listA = await withTenantContext(tenantA, (ctx) => listByoDomains(ctx));
    expect(listA).toHaveLength(1);
    expect(listA[0]!.domain).toBe("isolation-a.com");
  });
});

describe("pollByoDomainDns", () => {
  it("stays pending_dns and increments checksSoFar while unverified", async () => {
    const tenantId = await tenant("Poll Pending Co", "poll@example.com");
    const record = await withTenantContext(tenantId, (ctx) =>
      registerByoDomain(ctx, { domain: "poll-pending.com", domainRelationship: "fresh_standalone" }),
    );
    const poll1 = await withTenantContext(tenantId, (ctx) => pollByoDomainDns(ctx, record.domainId));
    expect(poll1).toMatchObject({ byoStatus: "pending_dns", verified: false, checksSoFar: 1 });
    const poll2 = await withTenantContext(tenantId, (ctx) => pollByoDomainDns(ctx, record.domainId));
    expect(poll2.checksSoFar).toBe(2);
  });

  it("flips to active once the sandbox scan reports delegated/records-applied", async () => {
    const tenantId = await tenant("Poll Verified Co", "pollv@example.com");
    const record = await withTenantContext(tenantId, (ctx) =>
      registerByoDomain(ctx, { domain: "delegated-domain.com", domainRelationship: "fresh_standalone" }),
    );
    expect(record.dnsMode).toBe("we_manage_zone");
    const poll = await withTenantContext(tenantId, (ctx) => pollByoDomainDns(ctx, record.domainId));
    expect(poll).toMatchObject({ byoStatus: "active", verified: true });
  });

  it("abandons after the 7-day idle timeout with no verification", async () => {
    const tenantId = await tenant("Poll Abandon Co", "polla@example.com");
    const record = await withTenantContext(tenantId, (ctx) =>
      registerByoDomain(ctx, { domain: "poll-abandon.com", domainRelationship: "fresh_standalone" }),
    );
    await withTenantContext(tenantId, (ctx) => pollByoDomainDns(ctx, record.domainId)); // first check, sets dns_first_checked_at

    // Advance the tenant's virtual clock past the 7-day idle window.
    await tenantStub(tenantId).advanceClock(8 * ONE_DAY_MS);

    const poll = await withTenantContext(tenantId, (ctx) => pollByoDomainDns(ctx, record.domainId));
    expect(poll).toMatchObject({ byoStatus: "abandoned", verified: false });
  });

  it("is a no-op once past pending_dns (e.g. pending_kyc) — never silently advances a KYC-gated domain", async () => {
    const tenantId = await tenant("Poll Kyc Noop Co", "pollkyc@example.com");
    const record = await withTenantContext(tenantId, (ctx) =>
      registerByoDomain(ctx, { domain: "paypa1-poll-noop.com", domainRelationship: "fresh_standalone" }),
    );
    expect(record.byoStatus).toBe("pending_kyc");
    const poll = await withTenantContext(tenantId, (ctx) => pollByoDomainDns(ctx, record.domainId));
    expect(poll).toMatchObject({ byoStatus: "pending_kyc", verified: false, checksSoFar: 0 });
  });
});

describe("acknowledgePrimaryDomainConsent", () => {
  it("flips pending_consent -> pending_dns and records the consent snapshot", async () => {
    const tenantId = await tenant("Consent Co", "consent@example.com");
    const record = await withTenantContext(tenantId, (ctx) =>
      registerByoDomain(ctx, { domain: "consent-primary.com", domainRelationship: "is_primary" }),
    );
    expect(record.consentAcknowledged).toBe(false);

    const acked = await withTenantContext(tenantId, (ctx) => acknowledgePrimaryDomainConsent(ctx, record.domainId, { acknowledged: true }));
    expect(acked.byoStatus).toBe("pending_dns");
    expect(acked.consentAcknowledged).toBe(true);
  });

  it("is idempotent — a second acknowledgment call is a no-op, not a re-log", async () => {
    const tenantId = await tenant("Consent Idem Co", "consentidem@example.com");
    const record = await withTenantContext(tenantId, (ctx) =>
      registerByoDomain(ctx, { domain: "consent-idem.com", domainRelationship: "is_primary" }),
    );
    await withTenantContext(tenantId, (ctx) => acknowledgePrimaryDomainConsent(ctx, record.domainId, { acknowledged: true }));
    const second = await withTenantContext(tenantId, (ctx) => acknowledgePrimaryDomainConsent(ctx, record.domainId, { acknowledged: true }));
    expect(second.byoStatus).toBe("pending_dns");
  });

  it("rejects consent acknowledgment on a NON-primary domain", async () => {
    const tenantId = await tenant("Consent Nonprimary Co", "consentnp@example.com");
    const record = await withTenantContext(tenantId, (ctx) =>
      registerByoDomain(ctx, { domain: "consent-nonprimary.com", domainRelationship: "fresh_standalone" }),
    );
    await expect(
      withTenantContext(tenantId, (ctx) => acknowledgePrimaryDomainConsent(ctx, record.domainId, { acknowledged: true })),
    ).rejects.toThrow(ValidationError);
  });

  it("is tenant-isolated: tenant B cannot acknowledge consent for tenant A's domain", async () => {
    const tenantA = await tenant("Consent Isolation A", "ca@example.com");
    const tenantB = await tenant("Consent Isolation B", "cb@example.com");
    const record = await withTenantContext(tenantA, (ctx) =>
      registerByoDomain(ctx, { domain: "consent-isolation.com", domainRelationship: "is_primary" }),
    );
    await expect(
      withTenantContext(tenantB, (ctx) => acknowledgePrimaryDomainConsent(ctx, record.domainId, { acknowledged: true })),
    ).rejects.toThrow(/not found/i);
  });
});

describe("getByoDomain / listByoDomains", () => {
  it("404s on an unknown or cross-tenant domainId (NotFoundError, not a leak)", async () => {
    const tenantId = await tenant("Not Found Co", "nf@example.com");
    await expect(withTenantContext(tenantId, (ctx) => Promise.resolve(getByoDomain(ctx, "dom_does_not_exist")))).rejects.toThrow(/not found/i);
  });
});
