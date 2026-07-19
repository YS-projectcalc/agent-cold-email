// SPEC.md §20.1 — the mandatory pre-flight live-infra scan + DNS-mode
// recommendation. PURE — no I/O; the caller supplies already-gathered DNS
// findings (from a DnsScanPort — see vendor-ports.ts) exactly like
// deliverability.ts's `evaluate` consumes already-gathered health signals.

import type { DnsScanResult } from "@coldstart/shared";

/**
 * The pre-flight interpretation reads only the live-infra-relevant subset of
 * DnsScanPort's result (a real scan's `delegatedToUs`/`recordsApplied` fields
 * are poll-verify-only — see `isDnsVerified` below — and simply ignored here).
 * Reusing `DnsScanResult` directly (rather than a near-duplicate local shape)
 * keeps the port contract and its consumer in lockstep (CLAUDE.md rule c).
 */
export type PreflightScanFindings = DnsScanResult;

export interface PreflightInterpretation {
  liveInfraFound: boolean;
  reasons: string[];
}

/**
 * SPEC.md §20.1's live-infra detection set. Any hit -> hard-refuse NS
 * delegation on the target hostname (recommendDnsMode below); no hit ->
 * subdomain/fresh-domain delegation proceeds normally.
 */
export function interpretPreflightScan(findings: PreflightScanFindings): PreflightInterpretation {
  const reasons: string[] = [];

  if (findings.hasMx) reasons.push("existing MX record — mail is already flowing on this hostname");
  if (findings.aRecordResolved && !findings.isParkingPage) {
    reasons.push("existing A/AAAA record resolving to a live (non-parking) site");
  }
  if (findings.hasSpfInclude) reasons.push("existing SPF include: entries — another legitimate sender is already authorized");
  if (findings.dmarcPolicy === "quarantine" || findings.dmarcPolicy === "reject") {
    reasons.push(`DMARC already in enforcement (p=${findings.dmarcPolicy})`);
  }

  return { liveInfraFound: reasons.length > 0, reasons };
}

export type DnsMode = "we_manage_zone" | "records_to_apply";

/** The three §20.1 domain-relationship shapes the delegation-risk ladder distinguishes. */
export type DomainRelationship = "fresh_standalone" | "subdomain_of_primary" | "is_primary";

export interface DnsModeInput {
  isPrimary: boolean;
  liveInfraFound: boolean;
  domainRelationship: DomainRelationship;
  /** DS record at the parent zone for the EXACT hostname being delegated. */
  hasDnssecDs: boolean;
}

export interface DnsModeRecommendation {
  mode: DnsMode;
  hardRefuseDelegation: boolean;
  reasons: string[];
}

/**
 * SPEC.md §20.1 — "Apex/primary sending is permitted but is the highest tier:
 * records-to-apply ONLY, never NS delegation, regardless of how badly the
 * customer wants the simpler flow." Any live-infra hit ALSO hard-refuses
 * delegation (for both the primary and non-primary cases) — the two rules
 * compose, not race: primary is checked first because it is unconditional,
 * then live-infra, then the DNSSEC apex-only carve-out.
 */
export function recommendDnsMode(input: DnsModeInput): DnsModeRecommendation {
  if (input.isPrimary) {
    return {
      mode: "records_to_apply",
      hardRefuseDelegation: true,
      reasons: ["primary-domain sending is records-to-apply ONLY — NS delegation is never offered, regardless of scan result"],
    };
  }

  if (input.liveInfraFound) {
    return {
      mode: "records_to_apply",
      hardRefuseDelegation: true,
      reasons: ["pre-flight scan found live infra on this hostname — NS delegation would risk breaking it"],
    };
  }

  // DNSSEC DS hard-blocks APEX/WHOLE-DOMAIN delegation only — a subdomain
  // delegation under a signed parent is a normal, valid ("insecure
  // delegation") config and is NOT blocked by this rule.
  if (input.domainRelationship === "fresh_standalone" && input.hasDnssecDs) {
    return {
      mode: "records_to_apply",
      hardRefuseDelegation: true,
      reasons: ["DNSSEC DS record present on this domain's own zone — apex/whole-domain NS delegation without a matching DS update breaks resolution (SERVFAIL)"],
    };
  }

  return { mode: "we_manage_zone", hardRefuseDelegation: false, reasons: [] };
}

/**
 * SPEC.md §20.1's poll-verify criterion: for `we_manage_zone`, verified means
 * the hostname is now delegated to us; for `records_to_apply`, verified means
 * the specific records we asked for are now confirmed present (never a bare
 * "some MX exists" — see DnsScanResult's `recordsApplied` doc comment).
 */
export function isDnsVerified(scan: Pick<DnsScanResult, "delegatedToUs" | "recordsApplied">, mode: DnsMode): boolean {
  return mode === "we_manage_zone" ? scan.delegatedToUs : scan.recordsApplied;
}
