import { describe, expect, it } from "vitest";
import { interpretPreflightScan, isDnsVerified, recommendDnsMode } from "../src/engine/byo-preflight.js";

// SPEC.md §20.1 — the mandatory pre-flight live-infra scan + DNS-mode
// recommendation. Live infra on the target hostname hard-refuses NS
// delegation (both apex and subdomain-of-primary); a registrar-default
// parking A-record is explicitly NOT live infra (so a freshly-registered
// domain still on its registrar's parking page still qualifies for the
// happy path). DNSSEC DS hard-blocks apex/whole-domain delegation ONLY —
// subdomain delegation under a signed parent is a normal, unblocked config.
// Primary domains are records-to-apply ONLY, unconditionally, regardless of scan.

function scan(over: Partial<Parameters<typeof interpretPreflightScan>[0]> = {}) {
  return {
    hasMx: false,
    aRecordResolved: false,
    isParkingPage: false,
    hasSpfInclude: false,
    dmarcPolicy: null as "none" | "quarantine" | "reject" | null,
    hasDnssecDs: false,
    delegatedToUs: false,
    recordsApplied: false,
    ...over,
  };
}

describe("interpretPreflightScan", () => {
  it("finds no live infra on a genuinely fresh domain", () => {
    expect(interpretPreflightScan(scan()).liveInfraFound).toBe(false);
  });

  it("finds live infra on an existing MX", () => {
    expect(interpretPreflightScan(scan({ hasMx: true })).liveInfraFound).toBe(true);
  });

  it("finds live infra on a resolved, non-parking A record (a hosted website)", () => {
    expect(interpretPreflightScan(scan({ aRecordResolved: true, isParkingPage: false })).liveInfraFound).toBe(true);
  });

  it("does NOT treat a registrar-default parking page as live infra", () => {
    // A freshly-registered domain still sitting on its registrar's parking
    // page must still qualify for the we-manage-zone happy path.
    expect(interpretPreflightScan(scan({ aRecordResolved: true, isParkingPage: true })).liveInfraFound).toBe(false);
  });

  it("finds live infra on an existing SPF include (another legitimate sender already authorized)", () => {
    expect(interpretPreflightScan(scan({ hasSpfInclude: true })).liveInfraFound).toBe(true);
  });

  it("finds live infra when DMARC is already in enforcement (quarantine/reject)", () => {
    expect(interpretPreflightScan(scan({ dmarcPolicy: "quarantine" })).liveInfraFound).toBe(true);
    expect(interpretPreflightScan(scan({ dmarcPolicy: "reject" })).liveInfraFound).toBe(true);
  });

  it("does NOT treat DMARC p=none as live infra by itself", () => {
    expect(interpretPreflightScan(scan({ dmarcPolicy: "none" })).liveInfraFound).toBe(false);
  });
});

describe("recommendDnsMode", () => {
  it("is 'records_to_apply' + hard-refuses delegation for ANY primary domain, even with zero live infra", () => {
    const result = recommendDnsMode({
      isPrimary: true,
      liveInfraFound: false,
      domainRelationship: "is_primary",
      hasDnssecDs: false,
    });
    expect(result.mode).toBe("records_to_apply");
    expect(result.hardRefuseDelegation).toBe(true);
  });

  it("allows 'we_manage_zone' for a fresh standalone domain with no live infra", () => {
    const result = recommendDnsMode({
      isPrimary: false,
      liveInfraFound: false,
      domainRelationship: "fresh_standalone",
      hasDnssecDs: false,
    });
    expect(result.mode).toBe("we_manage_zone");
    expect(result.hardRefuseDelegation).toBe(false);
  });

  it("allows 'we_manage_zone' for a fresh subdomain of the customer's primary, no live infra", () => {
    const result = recommendDnsMode({
      isPrimary: false,
      liveInfraFound: false,
      domainRelationship: "subdomain_of_primary",
      hasDnssecDs: false,
    });
    expect(result.mode).toBe("we_manage_zone");
  });

  it("hard-refuses delegation on ANY live-infra hit, even for a non-primary subdomain/standalone", () => {
    const subdomain = recommendDnsMode({
      isPrimary: false,
      liveInfraFound: true,
      domainRelationship: "subdomain_of_primary",
      hasDnssecDs: false,
    });
    expect(subdomain.mode).toBe("records_to_apply");
    expect(subdomain.hardRefuseDelegation).toBe(true);

    const standalone = recommendDnsMode({
      isPrimary: false,
      liveInfraFound: true,
      domainRelationship: "fresh_standalone",
      hasDnssecDs: false,
    });
    expect(standalone.mode).toBe("records_to_apply");
  });

  it("hard-blocks apex/whole-domain delegation on a DNSSEC DS record for a fresh-standalone domain", () => {
    const result = recommendDnsMode({
      isPrimary: false,
      liveInfraFound: false,
      domainRelationship: "fresh_standalone",
      hasDnssecDs: true,
    });
    expect(result.mode).toBe("records_to_apply");
    expect(result.hardRefuseDelegation).toBe(true);
  });

  it("does NOT block subdomain delegation under a signed parent (an insecure delegation is a normal, valid config)", () => {
    const result = recommendDnsMode({
      isPrimary: false,
      liveInfraFound: false,
      domainRelationship: "subdomain_of_primary",
      hasDnssecDs: true,
    });
    expect(result.mode).toBe("we_manage_zone");
    expect(result.hardRefuseDelegation).toBe(false);
  });
});

describe("isDnsVerified", () => {
  it("checks delegatedToUs for we_manage_zone", () => {
    expect(isDnsVerified(scan({ delegatedToUs: true }), "we_manage_zone")).toBe(true);
    expect(isDnsVerified(scan({ delegatedToUs: false }), "we_manage_zone")).toBe(false);
  });

  it("checks recordsApplied for records_to_apply, ignoring delegatedToUs entirely", () => {
    expect(isDnsVerified(scan({ recordsApplied: true, delegatedToUs: false }), "records_to_apply")).toBe(true);
    expect(isDnsVerified(scan({ recordsApplied: false, delegatedToUs: true }), "records_to_apply")).toBe(false);
  });
});
