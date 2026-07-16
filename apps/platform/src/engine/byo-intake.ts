// SPEC.md §20 — BYO domain intake orchestration (§20.1-§20.5). Ties the pure
// decision modules (byo-preflight/byo-abuse-gate/byo-reputation/byo-consent)
// into the actual intake pipeline against a tenant's own DO SQLite — mirrors
// provisioning.ts's role for the existing lookalike-domain flow, but this
// domain is never bought (DomainPort.buy/setDns don't apply): we either wait
// for delegation (we_manage_zone) or return records for the customer to apply
// (records_to_apply), tracked via byo_status/dns_check_count/
// dns_first_checked_at (see schema.ts's domains table doc comments).
//
// §20.6's mailbox COMPOSITION (attaching mailboxes to an active BYO domain)
// is a separate file, byo-mailbox-composition.ts — a distinct responsibility
// (CLAUDE.md rule b), reusing `requireByoDomainRow`/`ByoStatus` exported here.

import { NotFoundError, ValidationError, type AcknowledgeByoConsentInput, type RegisterByoDomainInput } from "@coldstart/shared";
import { newId } from "../schema.js";
import type { TenantContext } from "../tenant-context.js";
import { assertNotLifecycleFrozen } from "./billing-state.js";
import { assessByoDomainAbuse } from "./byo-abuse-gate.js";
import { buildConsentRecord, validateConsentAcknowledgment } from "./byo-consent.js";
import { interpretPreflightScan, isDnsVerified, recommendDnsMode, type DnsMode } from "./byo-preflight.js";
import { computeReputationBranch } from "./byo-reputation.js";
import { ONE_DAY_MS } from "./warmup.js";

const DNS_IDLE_TIMEOUT_MS = 7 * ONE_DAY_MS; // §20.1's "no mode silently blocks forever"
const PRIMARY_DMARC_WINDOW_ENFORCED_MS = 7 * ONE_DAY_MS; // §20.2 floor when the scan already found enforcement mode
const PRIMARY_DMARC_WINDOW_STANDARD_MS = 14 * ONE_DAY_MS; // §20.2 default

export type ByoStatus = "pending_kyc" | "pending_consent" | "pending_dns" | "active" | "rejected" | "abandoned";
export type BreakerTier = "standard" | "elevated" | "primary";

export interface ByoDomainRecord {
  domainId: string;
  domain: string;
  isPrimary: boolean;
  dnsMode: DnsMode;
  byoStatus: ByoStatus;
  breakerTier: BreakerTier;
  reputationBranch: string | null;
  scan: unknown;
  abuseVerdict: string;
  consentAcknowledged: boolean;
}

export interface DomainRow {
  id: string;
  domain: string;
  is_primary: number;
  dns_mode: string | null;
  byo_status: string;
  breaker_tier: string;
  reputation_branch: string | null;
  scan_json: string | null;
  abuse_gate_json: string | null;
  consent_json: string | null;
  dns_check_count: number;
  dns_first_checked_at: number | null;
  [column: string]: SqlStorageValue;
}

const DOMAIN_ROW_COLUMNS =
  "id, domain, is_primary, dns_mode, byo_status, breaker_tier, reputation_branch, scan_json, abuse_gate_json, consent_json, dns_check_count, dns_first_checked_at";

/** Shared by byo-mailbox-composition.ts (exported) — the tenant-isolated BYO domain lookup every intake/composition function keys off. */
export function requireByoDomainRow(ctx: TenantContext, domainId: string): DomainRow {
  const row = ctx.sql
    .exec<DomainRow>(`SELECT ${DOMAIN_ROW_COLUMNS} FROM domains WHERE id = ? AND tenant_id = ? AND source = 'byo'`, domainId, ctx.tenantId)
    .toArray()[0];
  if (!row) throw new NotFoundError(`BYO domain ${domainId} not found`);
  return row;
}

/**
 * schema.ts:62's documented "at most one is_primary per tenant" invariant —
 * actually enforced HERE, at the one boundary that creates a new BYO-primary
 * row. A primary that is no longer a LIVE candidate never blocks a new one:
 * rejected (blocklisted at intake) and abandoned (§20.1's 7-day DNS idle
 * timeout) are terminal-failed byo_status values, and a hard-paused primary
 * (domains.status='paused_primary', the §20.2 breaker's substitute remedy —
 * see deliverability-actions.ts's applyHardPauseDomain) is retired from
 * sending, not a second live primary to conflict with. Only a row still
 * actively pursuing or already running as the primary (status='active' AND
 * byo_status NOT IN rejected/abandoned) counts.
 */
function assertNoExistingActiveByoPrimary(ctx: TenantContext): void {
  const existing = ctx.sql
    .exec<{ n: number }>(
      `SELECT COUNT(*) as n FROM domains
       WHERE tenant_id = ? AND source = 'byo' AND is_primary = 1 AND status = 'active' AND byo_status NOT IN ('rejected', 'abandoned')`,
      ctx.tenantId,
    )
    .one().n;
  if (existing > 0) {
    throw new ValidationError(
      "tenant already has an active BYO primary-domain intake (SPEC.md §20 — at most one is_primary domain per tenant); " +
        "a rejected, abandoned, or hard-paused primary does not block registering a new one",
    );
  }
}

function toRecord(row: DomainRow): ByoDomainRecord {
  return {
    domainId: row.id,
    domain: row.domain,
    isPrimary: row.is_primary === 1,
    dnsMode: (row.dns_mode as DnsMode) ?? "records_to_apply",
    byoStatus: row.byo_status as ByoStatus,
    breakerTier: row.breaker_tier as BreakerTier,
    reputationBranch: row.reputation_branch,
    scan: row.scan_json ? JSON.parse(row.scan_json) : null,
    abuseVerdict: row.abuse_gate_json ? ((JSON.parse(row.abuse_gate_json).verdict as string) ?? "clear") : "clear",
    consentAcknowledged: row.consent_json !== null,
  };
}

/**
 * SPEC.md §20.1-§20.5 — registers a BYO domain: runs the mandatory pre-flight
 * live-infra scan, the abuse gate, and the reputation ladder (primary-axis-
 * first), then determines the intake lifecycle's STARTING state. Never
 * blocks on we_manage_zone vs records_to_apply — both proceed to
 * `pending_dns` (a primary domain visits `pending_consent` first) unless the
 * abuse gate or a blocklist hit reroutes it to `pending_kyc`/`rejected`.
 */
export async function registerByoDomain(ctx: TenantContext, input: RegisterByoDomainInput): Promise<ByoDomainRecord> {
  assertNotLifecycleFrozen(ctx, "register_byo_domain");

  const domain = input.domain.trim().toLowerCase();
  const isPrimary = input.domainRelationship === "is_primary";
  if (isPrimary) assertNoExistingActiveByoPrimary(ctx);
  const now = ctx.clock.now();

  const scan = await ctx.adapters.dnsScan.scan(domain);
  const preflight = interpretPreflightScan(scan);
  const dnsModeRec = recommendDnsMode({
    isPrimary,
    liveInfraFound: preflight.liveInfraFound,
    domainRelationship: input.domainRelationship,
    hasDnssecDs: scan.hasDnssecDs,
  });
  const abuse = assessByoDomainAbuse(domain);

  // Reputation ladder — queried uniformly (cheap in sandbox; the real
  // adapter is coded-but-unactivated, vendors/real/reputation-port.ts) so a
  // domain that turns out non-primary never silently skips the blocklist/age read.
  const reputationSignal = await ctx.adapters.reputation.check(domain);
  const reputation = computeReputationBranch({
    isPrimary,
    ageDays: reputationSignal.ageDays,
    blocklisted: reputationSignal.blocklisted,
    dmarcEnforced: scan.dmarcPolicy === "quarantine" || scan.dmarcPolicy === "reject",
    activeSendingEvidence: reputationSignal.activeSendingEvidence,
  });

  let byoStatus: ByoStatus;
  if (reputation.branch === "blocklisted_reject") {
    byoStatus = "rejected";
  } else if (abuse.verdict === "kyc_required") {
    // §20.3: TXT-verified-but-suspicious -> human-review/KYC queue, NEVER
    // auto-admit. No admin clearance route exists yet in this build — the
    // row sits here until a human clears it (flagged as an open item, not
    // silently auto-promoted).
    byoStatus = "pending_kyc";
  } else if (isPrimary) {
    byoStatus = "pending_consent";
  } else {
    byoStatus = "pending_dns";
  }

  const breakerTier: BreakerTier = isPrimary ? "primary" : input.domainRelationship === "subdomain_of_primary" ? "elevated" : "standard";

  // §20.2's mandatory DMARC p=none observation window — a PRIMARY-domain-only
  // guardrail (listed under §20.2, not §20.1/§20.5), computed at registration:
  // passive monitoring starts the moment we know about the domain, not
  // delayed by how quickly the human clicks through the consent screen below.
  const firstSendEligibleAt = isPrimary
    ? now +
      (scan.dmarcPolicy === "quarantine" || scan.dmarcPolicy === "reject" ? PRIMARY_DMARC_WINDOW_ENFORCED_MS : PRIMARY_DMARC_WINDOW_STANDARD_MS)
    : null;

  const scanJson = JSON.stringify({ scan, preflight, dnsModeRec });
  const abuseJson = JSON.stringify(abuse);
  const domainId = newId("dom");
  ctx.sql.exec(
    `INSERT INTO domains
       (id, tenant_id, domain, status, purchased_at, source, is_primary, dns_mode, byo_status, scan_json, abuse_gate_json, reputation_branch, breaker_tier, first_send_eligible_at)
     VALUES (?, ?, ?, 'active', ?, 'byo', ?, ?, ?, ?, ?, ?, ?, ?)`,
    domainId,
    ctx.tenantId,
    domain,
    now,
    isPrimary ? 1 : 0,
    dnsModeRec.mode,
    byoStatus,
    scanJson,
    abuseJson,
    reputation.branch,
    breakerTier,
    firstSendEligibleAt,
  );

  return toRecord({
    id: domainId,
    domain,
    is_primary: isPrimary ? 1 : 0,
    dns_mode: dnsModeRec.mode,
    byo_status: byoStatus,
    breaker_tier: breakerTier,
    reputation_branch: reputation.branch,
    scan_json: scanJson,
    abuse_gate_json: abuseJson,
    consent_json: null,
    dns_check_count: 0,
    dns_first_checked_at: null,
  });
}

export interface PollDnsResult {
  domainId: string;
  byoStatus: ByoStatus;
  verified: boolean;
  checksSoFar: number;
}

/** SPEC.md §20.1's poll-verify + 7-day idle-timeout — "no mode silently blocks forever." No-ops (returns current state) once past `pending_dns`. */
export async function pollByoDomainDns(ctx: TenantContext, domainId: string): Promise<PollDnsResult> {
  const row = requireByoDomainRow(ctx, domainId);

  if (row.byo_status !== "pending_dns") {
    return { domainId, byoStatus: row.byo_status as ByoStatus, verified: row.byo_status === "active", checksSoFar: row.dns_check_count };
  }

  const now = ctx.clock.now();
  const scan = await ctx.adapters.dnsScan.scan(row.domain);
  const verified = isDnsVerified(scan, (row.dns_mode as DnsMode) ?? "records_to_apply");
  const firstCheckedAt = row.dns_first_checked_at ?? now;
  const checksSoFar = row.dns_check_count + 1;

  if (verified) {
    ctx.sql.exec(`UPDATE domains SET byo_status = 'active', dns_check_count = ?, dns_first_checked_at = ? WHERE id = ?`, checksSoFar, firstCheckedAt, domainId);
    return { domainId, byoStatus: "active", verified: true, checksSoFar };
  }

  if (now - firstCheckedAt >= DNS_IDLE_TIMEOUT_MS) {
    ctx.sql.exec(`UPDATE domains SET byo_status = 'abandoned', dns_check_count = ?, dns_first_checked_at = ? WHERE id = ?`, checksSoFar, firstCheckedAt, domainId);
    return { domainId, byoStatus: "abandoned", verified: false, checksSoFar };
  }

  ctx.sql.exec(`UPDATE domains SET dns_check_count = ?, dns_first_checked_at = ? WHERE id = ?`, checksSoFar, firstCheckedAt, domainId);
  return { domainId, byoStatus: "pending_dns", verified: false, checksSoFar };
}

/** SPEC.md §20.4 — the separate, unbundled primary-domain risk acknowledgment. Idempotent past `pending_consent` (never re-logs a second consent record). */
export async function acknowledgePrimaryDomainConsent(
  ctx: TenantContext,
  domainId: string,
  input: AcknowledgeByoConsentInput,
): Promise<ByoDomainRecord> {
  validateConsentAcknowledgment(input);
  const row = requireByoDomainRow(ctx, domainId);
  if (row.is_primary !== 1) {
    throw new ValidationError("consent acknowledgment only applies to a primary-domain intake (SPEC.md §20.4)");
  }
  if (row.byo_status !== "pending_consent") {
    return toRecord(row); // already acknowledged (or moved past this step) — idempotent no-op
  }

  const now = ctx.clock.now();
  const scanSnapshot = row.scan_json ? JSON.parse(row.scan_json) : null;
  const consentRecord = buildConsentRecord(row.domain, now, scanSnapshot);
  const consentJson = JSON.stringify(consentRecord);

  ctx.sql.exec(`UPDATE domains SET consent_json = ?, byo_status = 'pending_dns' WHERE id = ? AND tenant_id = ?`, consentJson, domainId, ctx.tenantId);

  return toRecord({ ...row, consent_json: consentJson, byo_status: "pending_dns" });
}

export interface ByoDomainSummary {
  domainId: string;
  domain: string;
  isPrimary: boolean;
  dnsMode: DnsMode;
  byoStatus: ByoStatus;
  breakerTier: BreakerTier;
  reputationBranch: string | null;
  mailboxCount: number;
}

/** Read-only listing for the facade's status surface (routes/mcp parity). NEVER selects transport_json (see byo-mailbox-composition.ts's connectByoMailbox doc comment). */
export function listByoDomains(ctx: TenantContext): ByoDomainSummary[] {
  const rows = ctx.sql
    .exec<{ id: string; domain: string; is_primary: number; dns_mode: string | null; byo_status: string; breaker_tier: string; reputation_branch: string | null }>(
      `SELECT id, domain, is_primary, dns_mode, byo_status, breaker_tier, reputation_branch FROM domains WHERE tenant_id = ? AND source = 'byo'`,
      ctx.tenantId,
    )
    .toArray();

  return rows.map((r) => {
    const mailboxCount = ctx.sql
      .exec<{ n: number }>(`SELECT COUNT(*) as n FROM mailboxes WHERE tenant_id = ? AND domain_id = ?`, ctx.tenantId, r.id)
      .one().n;
    return {
      domainId: r.id,
      domain: r.domain,
      isPrimary: r.is_primary === 1,
      dnsMode: (r.dns_mode as DnsMode) ?? "records_to_apply",
      byoStatus: r.byo_status as ByoStatus,
      breakerTier: r.breaker_tier as BreakerTier,
      reputationBranch: r.reputation_branch,
      mailboxCount,
    };
  });
}

export function getByoDomain(ctx: TenantContext, domainId: string): ByoDomainRecord {
  return toRecord(requireByoDomainRow(ctx, domainId));
}
