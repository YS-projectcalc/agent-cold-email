/**
 * The domain-DNS leg of provisioning: run the right DNS operation for the
 * domain, and decide — honestly — whether its mail DNS is actually in effect.
 *
 * Three defects from the 2026-08-05 incident meet here, and they are separable:
 *   1. WRONG OPERATION. The vendor's connect-an-existing-domain nameserver flow
 *      was run against domains the vendor itself had registered. Fixed at the
 *      adapter (vendors/real/inboxkit-domain-port.ts); this module's job is to
 *      tell it WHICH kind of domain it is holding.
 *   2. READINESS LIE. `dns_status` flipped to 'ready' whenever `setDns` merely
 *      did not THROW, discarding the DnsRecordSet it returns. A not-yet-propagated
 *      domain returns all-false without throwing, so billable mailboxes were
 *      provisioned onto nameservers that were not pointed anywhere.
 *   3. RETRYABLE LAUNDERING. Every failure here was re-thrown as
 *      `retryable: true`, so a PERMANENT failure read as "retry to finish it" —
 *      which is how one wrong vendor call became a 24-hour customer retry loop.
 *      The underlying grade is now preserved, and a permanent failure is not
 *      even re-attempted in-call: re-running an operation that cannot succeed is
 *      not a retry, it is a spin.
 */

import { VendorError, type DnsRecordSet, type DomainConnectionType } from "@coldstart/shared";
import type { TenantContext } from "../tenant-context.js";
import { customerSafeDetail, customerSafeVendorFailure, logVendorFailure, VENDOR_STEP } from "../vendor-failure.js";
import { logAction } from "./deliverability-actions.js";

/** The abstract step label every failure in this module reports (vendor-failure.ts's closed vocabulary). */
const DNS_STEP = VENDOR_STEP.domainDns;

/**
 * The benign "a freshly-registered domain's mail DNS has not finished
 * propagating yet" signal — NOT a failure (C3 part b, 2026-08-13). Thrown by
 * `setDnsWithRetry` INSTEAD of a plain retryable VendorError, but ONLY for the
 * one case the vendor's async registration produces: a `connection_type`
 * 'purchased', `status='active'` domain whose DNS the port answered as not yet
 * in effect (`notPropagated`). Every GENUINE failure — permanent rejection, a
 * named registrar/capacity class, a transient vendor-API error, a non-purchased
 * or non-active domain — still throws an ordinary error and is untouched.
 *
 * It EXTENDS VendorError and keeps `name = "VendorError"` deliberately: it must
 * still gate mailbox provisioning (the throw is the buy gate) and, if it ever
 * escapes to a customer surface, map exactly like the retryable VendorError it
 * replaced (error-response.ts's 502 retryable). What makes it special is only
 * that `runSetupInfrastructure` recognises it by `instanceof` and, when it is
 * the sole thing left incomplete, returns a SUCCESS-PENDING result rather than
 * throwing — the async-request-reply contract, not an error.
 */
export class DomainPropagationPendingError extends VendorError {
  constructor(message: string, step: string | undefined) {
    super(message, true, { step });
    // Intentionally NOT a distinct name — see the class doc. It is a VendorError
    // to every consumer except the one that narrows on `instanceof`.
    this.name = "VendorError";
  }
}

// The in-call re-attempt budget. Deliberately SHORT (one quick re-check, ~2s)
// rather than long enough to outlast a registrar's propagation: parking a
// Durable Object to wait out a vendor's async pipeline burns wall-clock budget,
// blocks the input gate, and would still be a guess about the vendor's timing.
// The SAFETY comes from the domain being persisted BEFORE any DNS work — the
// honest outcome is dns_status 'pending' plus a RETRYABLE error, and the
// caller's retry (which adopts rather than re-buys) finishes the job.
const SET_DNS_BACKOFF_MS = [2_000];

/** Mail DNS is in effect only when EVERY record type the port reports is satisfied. */
function isDnsReady(records: DnsRecordSet): boolean {
  return records.mx && records.spf && records.dkim && records.dmarc && records.rdns;
}

/**
 * The recorded connection type for a domain row. NULL/absent reads as 'unknown'.
 */
function readDomainConnectionType(ctx: TenantContext, domainId: string): DomainConnectionType {
  const row = ctx.sql
    .exec<{ connection_type: string | null }>(
      `SELECT connection_type FROM domains WHERE id = ? AND tenant_id = ?`,
      domainId,
      ctx.tenantId,
    )
    .toArray()[0];
  const value = (row?.connection_type ?? "").trim().toLowerCase();
  return value === "purchased" || value === "connected" ? value : "unknown";
}

/** The domain row's lifecycle status ('active' | 'burning' | 'released' | …), or '' if the row is gone. */
function readDomainStatus(ctx: TenantContext, domainId: string): string {
  const row = ctx.sql
    .exec<{ status: string }>(`SELECT status FROM domains WHERE id = ? AND tenant_id = ?`, domainId, ctx.tenantId)
    .toArray()[0];
  return (row?.status ?? "").trim().toLowerCase();
}

/**
 * The connection type to DRIVE DNS with — recorded if we have it, otherwise
 * asked of the vendor and BACKFILLED onto the row.
 *
 * THE LEGACY-ROW VECTOR. Every domain row that predates this column has no
 * discriminator, and the incident's own customer is in exactly that state: the
 * adopt-before-buy hotfix recorded his domain BEFORE the column existed, so his
 * post-deploy retry re-drives DNS against a row that says nothing. Defaulting
 * such a row to the read-only poll is SAFE (it can never re-run the operation
 * that stranded him) but it is a guess, not a classification — and it is the
 * WRONG guess for a legacy CONNECTED domain, which the adopt path can equally
 * produce: poll-only never creates the vendor-side zone, so that domain sits
 * 'pending' forever with nothing to show for it. A silent permanent stall is the
 * same failure shape as the incident, just quieter.
 *
 * So an unknown row asks the vendor, which reports `connection_type` on every
 * domain it holds, and the answer is PERSISTED — one extra read per legacy
 * domain, once, after which the row is self-describing. A lookup that fails, or
 * a domain the vendor does not list, stays 'unknown' (the safe poll branch) and
 * is NOT persisted, so a later attempt re-resolves rather than baking in a
 * guess. Rows written after this wave always carry the type from acquisition, so
 * this never fires for them.
 */
async function resolveDomainConnectionType(
  ctx: TenantContext,
  domainId: string,
  domain: string,
): Promise<DomainConnectionType> {
  const recorded = readDomainConnectionType(ctx, domainId);
  if (recorded !== "unknown") return recorded;

  let owned;
  try {
    owned = await ctx.adapters.domain.listOwnedDomains();
  } catch (err) {
    // Asking failed, which proves nothing about the domain. Fall through to the
    // read-only branch rather than failing DNS outright: the poll cannot do
    // damage, and the next attempt asks again.
    logVendorFailure(`listOwnedDomains (connection-type backfill) ${domain}`, err);
    return "unknown";
  }

  const match = owned.find((d) => d.domain.toLowerCase() === domain.toLowerCase());
  if (!match || match.connectionType === "unknown") return "unknown";

  ctx.sql.exec(
    `UPDATE domains SET connection_type = ? WHERE id = ? AND tenant_id = ?`,
    match.connectionType,
    domainId,
    ctx.tenantId,
  );
  logAction(ctx, "DOMAIN_CONNECTION_TYPE_RESOLVED", domain, {
    reason: "domain configuration was reconciled with the provider so DNS setup uses the right procedure",
    connectionType: match.connectionType,
  });
  return match.connectionType;
}

interface DnsAttemptFailure {
  retryable: boolean;
  step: string | undefined;
  /** True when the port ANSWERED but reported the DNS as not yet in effect. */
  notPropagated: boolean;
  /**
   * The original error, when it belongs to a NAMED error class that has its own
   * customer-facing response mapping (RegistrarUnarmedError -> 503
   * registrar_unarmed, NotActivatedError -> 503 not_activated,
   * CapacityPendingError -> 409). Re-wrapping those in a plain VendorError
   * silently DOWNGRADES an accurate, actionable answer into a generic 502.
   */
  passthrough?: Error;
}

/** A VendorError subclass carrying its own response mapping (not the base class). */
function namedErrorClass(err: unknown): Error | undefined {
  if (!(err instanceof Error)) return undefined;
  return err.name !== "VendorError" && err.name !== "Error" ? err : undefined;
}

/**
 * Drives DNS for an ALREADY-PERSISTED domain row. Every outcome is
 * non-destructive: mail DNS confirmed in effect flips `dns_status` to 'ready';
 * anything else leaves it 'pending' with an ops-visible action row and throws
 * with the TRUE retryability grade. Never deletes the domain.
 *
 * Throwing on not-ready is deliberate and is the mailbox-buy gate: the caller
 * provisions mailboxes on the line after this one, so "not ready" has to stop
 * the call, not merely be recorded.
 */
export async function setDnsWithRetry(
  ctx: TenantContext,
  domain: string,
  idempotencyKey: string,
  domainId: string,
  // Injectable so tests exercise the retry LOGIC without paying its wall-clock.
  // Production always uses the module default.
  backoffMs: number[] = SET_DNS_BACKOFF_MS,
): Promise<void> {
  // Resolved ONCE per call, before the attempt loop — a legacy row costs one
  // vendor read, ever, and every later attempt reads the backfilled value.
  const connectionType = await resolveDomainConnectionType(ctx, domainId, domain);
  const attempts = backoffMs.length + 1;
  let failure: DnsAttemptFailure = { retryable: true, step: DNS_STEP, notPropagated: true };

  for (let attempt = 1; attempt <= attempts; attempt++) {
    let records: DnsRecordSet;
    try {
      records = await ctx.adapters.domain.setDns(domain, idempotencyKey, connectionType);
    } catch (err) {
      logVendorFailure(`setDns ${domain}`, err);
      const graded = customerSafeVendorFailure(err);
      failure = {
        retryable: graded.retryable,
        step: graded.step ?? DNS_STEP,
        notPropagated: false,
        passthrough: namedErrorClass(err),
      };
      // A permanent failure cannot heal by repetition — stop immediately rather
      // than spending the budget re-issuing a call the vendor already refused.
      if (!failure.retryable) break;
      await backoff(backoffMs[attempt - 1]);
      continue;
    }

    if (isDnsReady(records)) {
      ctx.sql.exec(`UPDATE domains SET dns_status = 'ready' WHERE id = ? AND tenant_id = ?`, domainId, ctx.tenantId);
      return;
    }
    // ANSWERED, but the records are not in effect. Propagation genuinely does
    // finish on its own, so this is retryable — but it is NOT ready, and the
    // pre-fix code could not tell those apart.
    failure = { retryable: true, step: DNS_STEP, notPropagated: true };
    await backoff(backoffMs[attempt - 1]);
  }

  logAction(
    ctx,
    "DOMAIN_DNS_PENDING",
    domain,
    customerSafeDetail(
      failure,
      failure.notPropagated
        ? "domain DNS setup hasn't finished propagating — retry to complete"
        : "domain DNS setup could not be completed",
      { attempts },
    ),
  );
  // A named class (registrar unarmed, seam not activated, capacity held) already
  // has a precise, customer-actionable mapping of its own — surface it intact
  // rather than flattening it into "an upstream provider failed".
  if (failure.passthrough) throw failure.passthrough;

  // C3 part b — the ONE benign case: a freshly-registered PURCHASED domain
  // (row still 'active') whose port answered "not in effect yet". The vendor's
  // registration is async (~32s) and this genuinely heals on its own, so it is
  // reported as "provisioning in progress", not an error — but ONLY here, never
  // for a permanent rejection (retryable false, handled by passthrough/below),
  // a named class (passthrough above), a transient vendor-API error
  // (notPropagated false — setDns threw, so we never observed a not-ready
  // answer), or a connected/unknown domain (its propagation is the customer's
  // registrar's job and can genuinely stall). `runSetupInfrastructure` turns
  // this into a SUCCESS-PENDING result; every other caller treats it as the
  // retryable VendorError it still is.
  if (failure.notPropagated && connectionType === "purchased" && readDomainStatus(ctx, domainId) === "active") {
    throw new DomainPropagationPendingError(dnsFailureMessage(domain, failure), failure.step);
  }

  throw new VendorError(dnsFailureMessage(domain, failure), failure.retryable, { step: failure.step });
}

function dnsFailureMessage(domain: string, failure: DnsAttemptFailure): string {
  if (!failure.retryable) {
    return (
      `domain ${domain} is registered and recorded, but its DNS setup was permanently rejected by the provider. ` +
      `No mailboxes were purchased. Retrying as-is will not help — contact support.`
    );
  }
  if (failure.notPropagated) {
    return (
      `domain ${domain} is registered and recorded, but its DNS has not finished propagating yet. ` +
      `No mailboxes were purchased onto it. Nothing was lost — retry to finish it.`
    );
  }
  return (
    `domain ${domain} is registered and recorded, but its DNS setup has not completed yet. ` +
    `Nothing was lost — retry to finish it.`
  );
}

async function backoff(ms: number | undefined): Promise<void> {
  if (ms === undefined || ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}
