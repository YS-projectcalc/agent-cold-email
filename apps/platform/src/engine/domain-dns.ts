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
 *
 * A FOURTH, from the vendor-verdict class fix (2026-08-14, docs/adversarial/
 * vendor-verdict-class-sweep-2026-08-14.md + c3-postship-reattack-2026-08-14.md
 * Finding 1), and it is defect 3 wearing a success costume:
 *   4. TERMINAL-AS-PENDING. A purchased domain whose registration had gone
 *      terminal (expired/suspended/cancelled) produced the same all-false answer
 *      as one registered two seconds ago, so the benign "still propagating"
 *      branch matched and `runSetupInfrastructure` returned HTTP 202
 *      `provisioning:"pending"` — a SUCCESS — on every subsequent call, forever.
 *      Paid domain, zero mailboxes, info-severity messages, nothing escalating.
 *      Two guards close it and BOTH are needed: the port now answers a VERDICT
 *      that the benign branch structurally cannot match ('terminal'), and the
 *      durable pending state is BOUNDED by age, so a not-yet that never arrives
 *      (an async registration that failed and was never listed — a case no
 *      verdict can see) still becomes a visible, non-retryable failure.
 */

import {
  DomainDnsTerminalError,
  VendorError,
  type DnsRecordSet,
  type DomainConnectionType,
  type VendorReadiness,
} from "@coldstart/shared";
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

/**
 * How long a provisioned domain's mail DNS may stay un-ready before the wait
 * stops being "in progress" and becomes a FAILURE (vendor-verdict class fix,
 * facet 2).
 *
 * The per-call budgets above it (SET_DNS_BACKOFF_MS, and the mailbox legs'
 * equivalents) cannot do this job: every one of them restarts from zero on the
 * next customer call, so an agent that retries hourly renews the "still
 * propagating" story indefinitely. The bound therefore measures the DURABLE
 * state's age, from `domains.dns_first_checked_at`, across calls.
 *
 * SIX HOURS. The condition it bounds is a vendor-side async registration that
 * the vendor itself describes as taking seconds-to-minutes (~32s measured on the
 * incident domain), so six hours is roughly two orders of magnitude of headroom —
 * long enough that no legitimate propagation is cut short, short enough that a
 * paying customer is not told "in progress" for a day. Past it, the honest
 * answer is "this did not work", which is exactly what the customer's agent
 * needs in order to stop retrying and escalate. The watchtower's aging check
 * (engine/ops-summary.ts) reads the SAME constant, so the founder is alerted at
 * the moment the platform gives up rather than on a second, drifting threshold.
 */
export const DNS_PENDING_MAX_MS = 6 * 60 * 60 * 1000;

/** Mail DNS is in effect only when EVERY record type the port reports is satisfied. */
function isDnsReady(records: DnsRecordSet): boolean {
  return records.mx && records.spf && records.dkim && records.dmarc && records.rdns;
}

/**
 * The domain row's own bookkeeping for the bound — one read, so a call never
 * disagrees with itself about the row it is deciding on.
 *
 * `status` is OUR lifecycle column (`active`/`burning`/`released`/…). It is read
 * here for exactly one purpose: "is this row still an active provisioning target
 * of ours". That is a legitimate use of a local column — see the sweep doc's OUT
 * list, which is full of them. It is emphatically NOT a proxy for the vendor's
 * verdict, which is the mistake the deleted `readDomainStatus` helper embodied:
 * that function's only caller used `status === 'active'` as the third conjunct of
 * a "the registration is fine" test, and nothing in this codebase ever syncs this
 * column to a registrar, so it read 'active' for a domain the vendor had killed.
 * The vendor's answer now arrives as a `VendorReadiness` verdict and is checked
 * before this is consulted at all.
 */
interface DnsBoundState {
  status: string;
  firstCheckedAt: number | null;
  checkCount: number;
  gaveUpAt: number | null;
}

function readDnsBoundState(ctx: TenantContext, domainId: string): DnsBoundState {
  const row = ctx.sql
    .exec<{ status: string; dns_first_checked_at: number | null; dns_check_count: number; dns_gave_up_at: number | null }>(
      `SELECT status, dns_first_checked_at, dns_check_count, dns_gave_up_at FROM domains WHERE id = ? AND tenant_id = ?`,
      domainId,
      ctx.tenantId,
    )
    .toArray()[0];
  return {
    status: (row?.status ?? "").trim().toLowerCase(),
    firstCheckedAt: row?.dns_first_checked_at ?? null,
    checkCount: row?.dns_check_count ?? 0,
    gaveUpAt: row?.dns_gave_up_at ?? null,
  };
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
   * Set when the port answered `{kind:"terminal"}` — the vendor's own statement
   * that this registration is dead. Carries the raw vendor token for the
   * operator-facing action row; never reaches a customer surface.
   */
  terminalVendorState?: string;
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
    let result: { verdict: VendorReadiness; records: DnsRecordSet };
    try {
      result = await ctx.adapters.domain.setDns(domain, idempotencyKey, connectionType);
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

    // EXHAUSTIVE by construction (guard D2 of the class fix): a new
    // VendorReadiness arm makes this switch fail to compile rather than falling
    // silently into the benign branch — which is exactly how 'terminal'
    // masqueraded as 'not_yet' before the union existed.
    const { verdict } = result;
    switch (verdict.kind) {
      case "ready":
        // The verdict alone does NOT promote a domain: every record flag must
        // also be satisfied. That conjunction is what preserves the readiness
        // asymmetry across this refactor — nothing that graded not-ready before
        // can grade ready now, whatever a port claims.
        if (isDnsReady(result.records)) {
          ctx.sql.exec(
            // Clearing the give-up marker is the recovery path: a registration
            // that came back is not condemned by a previous pass's verdict.
            `UPDATE domains SET dns_status = 'ready', dns_gave_up_at = NULL WHERE id = ? AND tenant_id = ?`,
            domainId,
            ctx.tenantId,
          );
          return;
        }
        // A port that says "ready" while reporting an unsatisfied record is
        // self-contradictory. We believe the flags (the conservative direction)
        // and treat the disagreement as an unclassifiable answer.
        failure = { retryable: true, step: DNS_STEP, notPropagated: true };
        break;
      case "not_yet":
      case "inconclusive":
        // ANSWERED, but the records are not in effect. Propagation genuinely
        // does finish on its own, so this is retryable — but it is NOT ready,
        // and the pre-fix code could not tell those apart. 'inconclusive' rides
        // the same branch on purpose: an answer we could not classify proves
        // nothing, so it must cost exactly what a not-yet costs and never more.
        failure = { retryable: true, step: DNS_STEP, notPropagated: true };
        break;
      case "terminal":
        // THE VENDOR SAYS THIS REGISTRATION IS DEAD. Not a wait — a fact. Stop
        // the loop immediately (re-polling a dead registration is a spin) and
        // fall through to the non-retryable, customer-visible failure below.
        failure = { retryable: false, step: DNS_STEP, notPropagated: false, terminalVendorState: verdict.vendorState };
        break;
      default: {
        const exhaustive: never = verdict;
        throw new Error(`unhandled DNS readiness verdict: ${JSON.stringify(exhaustive)}`);
      }
    }
    if (failure.terminalVendorState !== undefined) break;
    await backoff(backoffMs[attempt - 1]);
  }

  // A named class (registrar unarmed, seam not activated, capacity held) already
  // has a precise, customer-actionable mapping of its own — surface it intact
  // rather than flattening it into "an upstream provider failed". Checked before
  // any bookkeeping: it is a failure of the CALL, not an observation about the
  // domain, so it must not age the domain's pending state.
  if (failure.passthrough) {
    logAction(
      ctx,
      "DOMAIN_DNS_PENDING",
      domain,
      customerSafeDetail(failure, "domain DNS setup could not be completed", { attempts }),
    );
    throw failure.passthrough;
  }

  // From here the port ANSWERED (or refused permanently), so this call is a real
  // observation about the domain and counts toward the bound.
  const bound = recordDnsObservation(ctx, domainId, failure.notPropagated);

  if (failure.terminalVendorState !== undefined) {
    return failTerminal(ctx, domain, domainId, failure, {
      action: "DOMAIN_DNS_TERMINAL",
      reason: "the provider reports this domain's registration is no longer usable — no mailboxes were purchased onto it",
      detail: { attempts, vendorState: failure.terminalVendorState },
      message:
        `domain ${domain} is registered and recorded, but the provider now reports its registration as no longer usable, ` +
        `so its mail DNS will never come up. No mailboxes were purchased onto it. Retrying will not help — this domain ` +
        `needs to be replaced; contact support.`,
    });
  }

  // The BOUND (facet 2). A benign not-yet that has outlived DNS_PENDING_MAX_MS
  // is no longer benign, whatever the vendor's verdict says — this is what
  // catches the case NO verdict can see: an async registration that failed and
  // was therefore never listed at all, which the port can only report as
  // "not listed yet, forever".
  const pendingForMs = bound.firstCheckedAt === null ? 0 : ctx.clock.now() - bound.firstCheckedAt;
  if (failure.notPropagated && (bound.gaveUpAt !== null || pendingForMs >= DNS_PENDING_MAX_MS)) {
    return failTerminal(ctx, domain, domainId, { ...failure, retryable: false }, {
      action: "DOMAIN_DNS_GAVE_UP",
      reason: "domain DNS setup has been pending far longer than it should take — it is treated as failed rather than still in progress",
      detail: { attempts, pendingForMs, checks: bound.checkCount },
      message:
        `domain ${domain} is registered and recorded, but its mail DNS has still not come up long after it should have. ` +
        `No mailboxes were purchased onto it. Retrying will not help — this domain needs to be replaced; contact support.`,
    });
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
      { attempts, pendingForMs, checks: bound.checkCount },
    ),
  );

  // C3 part b — the ONE benign case: a freshly-registered PURCHASED domain whose
  // port answered "not in effect yet", WITHIN the bound. The vendor's
  // registration is async (~32s) and this genuinely heals on its own, so it is
  // reported as "provisioning in progress", not an error — but ONLY here, never
  // for a TERMINAL verdict (handled above, and structurally unable to reach this
  // line), a permanent rejection, a named class (passthrough above), a transient
  // vendor-API error (notPropagated false — setDns threw, so we never observed a
  // not-ready answer), a connected/unknown domain (its propagation is the
  // customer's registrar's job and can genuinely stall), or a wait past the
  // bound. `runSetupInfrastructure` turns this into a SUCCESS-PENDING result;
  // every other caller treats it as the retryable VendorError it still is.
  //
  // The `bound.status === "active"` conjunct is OUR lifecycle column and is a
  // scope check, not a vendor check (see readDnsBoundState): a burning /
  // paused_primary / retired row is not a domain we are still bringing up, and
  // reporting "provisioning in progress" for one would be a new lie in a wave
  // that exists to delete one.
  if (failure.notPropagated && connectionType === "purchased" && bound.status === "active") {
    throw new DomainPropagationPendingError(dnsFailureMessage(domain, failure), failure.step);
  }

  throw new VendorError(dnsFailureMessage(domain, failure), failure.retryable, { step: failure.step });
}

/**
 * Ages the domain's durable pending state by one observation and returns the
 * post-write bookkeeping.
 *
 * The anchor is stamped ONCE (COALESCE) so the bound measures the whole wait
 * rather than the gap since the last call — a customer's agent retrying hourly
 * must not be able to renew the "still propagating" story indefinitely, which is
 * precisely what every per-call backoff budget in this codebase does.
 */
function recordDnsObservation(ctx: TenantContext, domainId: string, notPropagated: boolean): DnsBoundState {
  if (notPropagated) {
    const now = ctx.clock.now();
    ctx.sql.exec(
      `UPDATE domains
          SET dns_check_count = dns_check_count + 1,
              dns_first_checked_at = COALESCE(dns_first_checked_at, ?)
        WHERE id = ? AND tenant_id = ?`,
      now,
      domainId,
      ctx.tenantId,
    );
  }
  return readDnsBoundState(ctx, domainId);
}

/**
 * The one exit for "this domain's DNS will not come up": stamp the durable
 * give-up marker, log an ops-visible row, and throw NON-retryably.
 *
 * NON-retryable is the whole point. The pre-fix code reported both of these
 * conditions as either a retryable error (a 24-hour agent loop) or, after C3
 * part b, as a 202 success (an indefinite silent stall). A caller that is told
 * "do not retry" escalates, which is the only outcome that gets a dead domain
 * replaced. Deliberately NOT a re-buy: this wave adds no automatic spend path.
 */
function failTerminal(
  ctx: TenantContext,
  domain: string,
  domainId: string,
  failure: DnsAttemptFailure,
  opts: { action: string; reason: string; detail: Record<string, unknown>; message: string },
): never {
  ctx.sql.exec(
    // Conditional on being unset so the marker records WHEN we first gave up,
    // not when we last re-confirmed it.
    `UPDATE domains SET dns_gave_up_at = ? WHERE id = ? AND tenant_id = ? AND dns_gave_up_at IS NULL`,
    ctx.clock.now(),
    domainId,
    ctx.tenantId,
  );
  logAction(ctx, opts.action, domain, customerSafeDetail(failure, opts.reason, opts.detail));
  throw new DomainDnsTerminalError(opts.message, failure.step);
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
