// C3 part d (2026-08-13) — the out-of-band provisioning-reconcile leg.
//
// WHAT IT DOES. For one tenant, finds every setup domain still short of
// completion — dns_status 'pending', or a committed intent whose mailboxes are
// below the desired count — and re-drives the ALREADY-IDEMPOTENT
// `provisionDomainWithMailboxes` to finish it, so a benign propagation wait
// (C3 part b's SUCCESS-PENDING) completes without the agent ever having to
// retry. It is the level-triggered reconciler the priorart prescribes: it reads
// the OBSERVED resources (the domains/mailboxes rows) each pass and drives
// toward the DESIRED spec (persona + mailbox count) persisted on the intent.
//
// ⚠ SHIPS DARK. Nothing here runs unless PROVISIONING_RECONCILE_ENABLED is armed
// (checked ONCE in admin/ops-sweep.ts before this is ever reached). Arming it
// causes real mailbox spend on an armed tenant WITHOUT an agent request — a
// deliberate, separate deploy-time decision.
//
// SPEND SAFETY rides entirely on the EXISTING guards, never a new parallel one:
//  - The domain is NEVER re-bought: a 'committed' intent resolves to a live
//    domains row, so provisionDomainWithMailboxes takes its resume branch and
//    skips the buy path entirely.
//  - Mailboxes are bought only for MISSING addresses, each address-derived and
//    dispatch-record-guarded (engine/provision-intents.ts) — a re-drive of a
//    fully-provisioned domain is a no-op, and we filter those out first anyway.
//  - The desired spec MUST be recoverable from the intent. A NULL-spec row (a
//    pre-part-d or rebound-legacy intent) is SKIPPED, never guessed: a guessed
//    persona would create addresses an agent's own retry would not converge on,
//    doubling the mailbox count. Those complete via an agent retry instead.
//
// SCOPE GUARDS. It touches ONLY current-derivation setup ordinals on
// 'provisioned', 'active', not-given-up-on domains, and NEVER a `replace:`
// burn-replacement intent (the deliverability loop's second-writer landmine —
// re-driving one would re-create the P0 orphan defect on the burn route).

import type { TenantContext } from "../tenant-context.js";
import { logVendorFailure } from "../vendor-failure.js";
import { logAction } from "./deliverability-actions.js";
import { provisionDomainWithMailboxes } from "./provisioning.js";
import { domainIntentKey, domainIntentOrdinal, replacementDomainIntentKeyPrefix } from "./provision-intents.js";

export interface ProvisioningReconcileSummary {
  /** Committed setup intents examined that had a live provisioned+active domain. */
  scanned: number;
  /** Domains this pass actually re-drove (had genuine DNS/mailbox work left). */
  reconciled: number;
  /** Re-drives that finished cleanly. */
  completed: number;
  /** Re-drives that errored — still incomplete, the next sweep retries (== errors). */
  deferred: number;
  /** Committed intents left alone because their desired spec is unrecoverable (legacy rows). */
  skippedNoSpec: number;
  /**
   * Alias of `deferred`, exposed under the name admin/sweep-signals.ts's
   * LEG_COUNTERS sums, so a reconcile that keeps failing surfaces in the same
   * founder signal as every other sweep leg's failures.
   */
  errors: number;
}

interface CommittedSetupIntent {
  key: string;
  candidate_domain: string;
  persona_slug: string | null;
  inboxes_each: number | null;
  [column: string]: SqlStorageValue;
}

interface LiveSetupDomain {
  id: string;
  dns_status: string;
  [column: string]: SqlStorageValue;
}

/**
 * Reconciles one tenant's incomplete setup domains toward completion. Pure
 * per-tenant work against `ctx`'s own SqlStorage (CLAUDE.md rule h); the caller
 * (admin/ops-sweep.ts) already gated on the arming flag and isolates THIS
 * tenant's failure from every other tenant's.
 */
export async function runProvisioningReconcile(ctx: TenantContext): Promise<ProvisioningReconcileSummary> {
  const summary: ProvisioningReconcileSummary = {
    scanned: 0,
    reconciled: 0,
    completed: 0,
    deferred: 0,
    skippedNoSpec: 0,
    errors: 0,
  };

  const replacePrefix = replacementDomainIntentKeyPrefix(ctx.tenantId);
  const intents = ctx.sql
    .exec<CommittedSetupIntent>(
      `SELECT key, candidate_domain, persona_slug, inboxes_each FROM domain_intents WHERE tenant_id = ? AND status = 'committed'`,
      ctx.tenantId,
    )
    .toArray();

  for (const intent of intents) {
    // NEVER the burn-replacement path (the load-bearing scope guard). A `replace:`
    // key belongs to REPLACE_DOMAIN; re-driving one would re-create the P0 orphan
    // on the burn route. domainIntentOrdinal already rejects a non-`tenant:` key,
    // so this is belt-and-suspenders — kept explicit because it is the guard the
    // whole spend-safety argument leans on.
    if (intent.key.startsWith(replacePrefix)) continue;
    const ordinal = domainIntentOrdinal(ctx.tenantId, intent.key);
    if (ordinal === undefined) continue;

    // The live setup domain this ordinal committed. Scoped hard: 'provisioned'
    // only (a BYO domain has its own intake pipeline owning its DNS), 'active'
    // only (a burned/released domain is not ours to complete), NOT given up on
    // (see below), matched by the exact candidate name the intent recorded.
    //
    // `dns_gave_up_at IS NULL` is the vendor-verdict class fix's facet-2 half
    // reaching this leg: a domain whose registration the provider reports dead,
    // or whose pending state outlived DNS_PENDING_MAX_MS, is not incomplete work
    // — it is finished and failed. Without this the level-triggered loop would
    // re-drive it on every pass forever, which is the same unbounded spin the
    // customer's own retry loop was, just with nobody watching. A domain that
    // RECOVERS has its marker cleared by setDnsWithRetry, so it re-enters scope
    // on its own.
    const domain = ctx.sql
      .exec<LiveSetupDomain>(
        `SELECT id, dns_status FROM domains
          WHERE tenant_id = ? AND domain = ? AND status = 'active' AND source = 'provisioned'
            AND dns_gave_up_at IS NULL LIMIT 1`,
        ctx.tenantId,
        intent.candidate_domain,
      )
      .toArray()[0];
    if (!domain) continue; // nothing live to reconcile for this ordinal

    summary.scanned++;
    const dnsPending = domain.dns_status !== "ready";
    const liveMailboxes = ctx.sql
      .exec<{ n: number }>(
        `SELECT COUNT(*) as n FROM mailboxes WHERE tenant_id = ? AND domain_id = ? AND released_at IS NULL`,
        ctx.tenantId,
        domain.id,
      )
      .one().n;

    // A recoverable desired spec is REQUIRED to finish safely. Without it we can
    // neither know the mailbox count nor generate the agent's addresses, so a
    // re-drive would guess — the one thing a spend path must never do. Skip and
    // log only when there is visibly work left (DNS still pending), so a legacy
    // row that is actually done stays silent.
    if (intent.persona_slug === null || intent.inboxes_each === null) {
      if (dnsPending) {
        summary.skippedNoSpec++;
        logAction(ctx, "PROVISIONING_RECONCILE_SKIPPED", intent.candidate_domain, {
          reason:
            "no durable provisioning spec on this intent (a legacy row) — completing it needs an agent retry that supplies the persona and mailbox count",
          ordinal,
          dnsStatus: domain.dns_status,
        });
      }
      continue;
    }

    const inboxesEach = intent.inboxes_each;
    if (!dnsPending && liveMailboxes >= inboxesEach) continue; // already complete — nothing to do

    summary.reconciled++;
    try {
      // The resume branch of the SAME idempotent primitive setup_infrastructure
      // uses: it re-drives DNS (a read-only poll for a purchased domain, no spend)
      // and then provisions only the MISSING mailboxes for the SAME persona +
      // count the original call used. The intentKey is the ordinal derivation, so
      // it resolves to this exact committed intent — never a fresh buy.
      await provisionDomainWithMailboxes(ctx, {
        domain: intent.candidate_domain,
        domainIndex: ordinal,
        personaSlug: intent.persona_slug,
        inboxesEach,
        intentKey: domainIntentKey(ctx.tenantId, ordinal),
      });
      summary.completed++;
      logAction(ctx, "PROVISIONING_RECONCILE_COMPLETED", intent.candidate_domain, {
        reason: "the out-of-band reconcile finished a pending setup domain — no agent retry was needed",
        ordinal,
      });
    } catch (err) {
      // Per-domain isolation: one domain still not ready (DNS mid-propagation, an
      // incomplete registrant, a transient vendor error) must never abort the
      // reconcile for this tenant's OTHER pending domains. It stays pending and
      // the next sweep retries. The raw error is operator-only (Worker log); the
      // customer-readable activity row carries prose, never vendor text.
      summary.deferred++;
      summary.errors++;
      logVendorFailure(`provisioning reconcile ${intent.candidate_domain}`, err);
      logAction(ctx, "PROVISIONING_RECONCILE_DEFERRED", intent.candidate_domain, {
        reason: "still incomplete after this reconcile pass — the next sweep will try again",
        ordinal,
      });
    }
  }

  return summary;
}
