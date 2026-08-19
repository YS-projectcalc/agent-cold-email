/**
 * What a `setup_infrastructure` call would actually acquire, given what the
 * tenant already has — split out of engine/provisioning.ts (CLAUDE.md rule b/c)
 * so the SAGA and the RECOMMENDATION share one planner verbatim rather than one
 * running and the other describing (design §2.1's anti-drift rule: a
 * recommendation is a DRY RUN, not a sentence).
 *
 * Two shapes, deliberately separate:
 *
 *   `readProvisioningSnapshot` — ONE read of each table. Every SQL statement
 *   this planning path issues lives here, so a caller evaluating many candidate
 *   targets (deriveNextSteps) does it entirely in memory. That is not a
 *   performance note: a `ctx.sql.exec` inside a candidate loop reddens
 *   test/loop-isolation-coverage.test.ts across the whole platform suite, and
 *   the derivation's non-interleaving with a live saga depends on staying
 *   synchronous and read-once (design §7.16 #1/#2).
 *
 *   `planFor` — pure, handed no `TenantContext` at all, so "no SQL per
 *   candidate" is structural rather than a convention.
 *
 * THE PERSONA RIDES THE TARGET, NOT THE SNAPSHOT (gate B3). A call that changes
 * `persona` targets different addresses, so it must be planned against the NEW
 * ones; a snapshot-carried persona would silently plan every candidate against
 * the last-used one and understate `newMailboxes` — the direction
 * `assertWithinProvisioningCap` and the `quoteOnly` projection must never be
 * wrong in. `ProvisioningSnapshot.personaSlug` exists for the RECOMMENDATION
 * (what to echo back so a suggested call reproduces today's addresses) and is
 * never read by `planFor`.
 */

import type { TenantContext } from "../tenant-context.js";
import { managedMailboxAddress } from "./mailbox-provisioning.js";
import { domainIntentOrdinal } from "./provision-intents.js";

/**
 * The persona -> local-part-prefix normalizer. Lives beside the planner because
 * the plan's slot arithmetic and the saga's actual purchases must derive the
 * SAME addresses from the same persona string, and a second copy is how those
 * two come to disagree.
 */
export function slugify(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 20) || "hello";
}

/** One ordinal's committed state: the name the intent resolved to, and the live domain row if it landed. */
export interface OrdinalSnapshot {
  candidateDomain: string;
  /** 'intent' (written, buy unconfirmed) | 'dangling' (the buy leg threw) | 'committed' | … */
  status: string;
  /**
   * `domain_intents.updated_at`, RAW. Every consumer that ages from it must
   * read it through `clampedAge` (§7.19): it is stamped from `ctx.clock` and is
   * NOT in the clock migration's shift list, so a tenant that provisioned on
   * the demo VirtualClock and later upgraded carries a FUTURE-dated value.
   */
  updatedAt: number;
  /**
   * The live `domains` row this ordinal resolved to, or null. Carries the row
   * `id` as well as the name (gate B3): `ProvisioningPlan.satisfied` is
   * `{id, domain}`, and a snapshot holding only the name could not reconstruct
   * it — the lossy-snapshot half of that finding.
   */
  live: { id: string; domain: string } | null;
  /**
   * THIS ORDINAL'S OWN persisted spec — the persona its addresses were derived
   * from and the mailbox count the call that created it asked for (C3 part d,
   * `recordDomainIntent`'s INSERT-only write). Both NULL together on a row that
   * predates the columns.
   *
   * PER-ORDINAL, deliberately, and not the same thing as the snapshot's
   * tenant-level `personaSlug` below: that one is the LATEST persona, for the
   * recommendation to echo, while these two are the record of what was actually
   * asked for HERE — which is what `provisioning-reconcile.ts` re-drives from
   * and what `ordinal_slot_shortfall` (build gate r2, 2026-08-19) measures the
   * live slots against.
   */
  personaSlug: string | null;
  inboxesEach: number | null;
}

export interface ProvisioningSnapshot {
  /** Ordinal -> that ordinal's intent, for the ordinal-keyed intents only (burn-replacement keys are a different writer). */
  intentsByOrdinal: Map<number, OrdinalSnapshot>;
  /** Every live mailbox address (`released_at IS NULL`) — the slot-filled set. */
  liveMailboxAddresses: ReadonlySet<string>;
  /**
   * The persona slug this tenant last provisioned under, or null when it has
   * never provisioned. `domain_intents.persona_slug` is the ONLY persistence of
   * a persona anywhere in the schema, and it holds the SLUGIFIED form — which
   * is address-equivalent (`slugify` is idempotent on a slug), so echoing it
   * back reproduces the same deterministic addresses. RECOMMENDATION ONLY.
   */
  personaSlug: string | null;
}

/** What a call against this snapshot would acquire. */
export interface ProvisioningPlan {
  /** Ordinal -> the live domain a prior attempt already committed there. */
  satisfied: Map<number, { id: string; domain: string }>;
  /** Domains this call still has to BUY. */
  newDomains: number;
  /** Mailbox slots in the request that no live mailbox fills yet. */
  newMailboxes: number;
}

/**
 * The TARGET a call reconciles toward. ONE target type: the legacy
 * `{domains, inboxesEach}` pair is widened to a uniform distribution at the
 * request boundary (`resolveDistribution`, @coldstart/shared), so nothing
 * downstream has to decide what a call sending both would mean.
 */
export interface ProvisioningTarget {
  /** The RAW persona from the request — slugified here, so callers never pre-slugify. */
  persona: string;
  /** Mailbox slots per domain ordinal. Its LENGTH is the domain count. */
  distribution: readonly number[];
}

/**
 * ONE read of `domain_intents`, `domains` and `mailboxes`. Pure SELECTs — this
 * runs before the lifecycle/brand guards have spent anything, and a dry run
 * must not be able to trip or mutate one (design §7.16 #3).
 */
export function readProvisioningSnapshot(ctx: TenantContext): ProvisioningSnapshot {
  // Live domains, by name. `status != 'released'` is the same "live" predicate
  // every reader that ACTS on a domain uses; a third definition is how the two
  // guards in the 2026-08-13 P0 came to disagree. First row wins on a duplicate
  // name, matching the `LIMIT 1` this replaced.
  const liveDomainsByName = new Map<string, { id: string; domain: string }>();
  for (const row of ctx.sql
    .exec<{ id: string; domain: string }>(
      `SELECT id, domain FROM domains WHERE tenant_id = ? AND status != 'released' ORDER BY rowid`,
      ctx.tenantId,
    )
    .toArray()) {
    if (!liveDomainsByName.has(row.domain)) liveDomainsByName.set(row.domain, { id: row.id, domain: row.domain });
  }

  const intentsByOrdinal = new Map<number, OrdinalSnapshot>();
  let personaSlug: string | null = null;
  let personaUpdatedAt = -Infinity;
  for (const row of ctx.sql
    .exec<{
      key: string;
      candidate_domain: string;
      status: string;
      persona_slug: string | null;
      inboxes_each: number | null;
      updated_at: number;
    }>(
      `SELECT key, candidate_domain, status, persona_slug, inboxes_each, updated_at FROM domain_intents WHERE tenant_id = ? ORDER BY key`,
      ctx.tenantId,
    )
    .toArray()) {
    const ordinal = domainIntentOrdinal(ctx.tenantId, row.key);
    // A key this tenant's ordinal derivation never writes belongs to the
    // burn-replacement writer (`replacementDomainIntentKey`) and names no
    // ordinal of the managed fleet — the pre-extraction planner reached rows by
    // ordinal key alone and so never saw one either.
    if (ordinal === undefined) continue;
    intentsByOrdinal.set(ordinal, {
      candidateDomain: row.candidate_domain,
      status: row.status,
      updatedAt: row.updated_at,
      // Only a COMMITTED intent resolves to a live domain: 'intent' means the
      // buy was never confirmed and 'dangling' means it threw, and neither is
      // evidence this ordinal is done.
      live: row.status === "committed" ? (liveDomainsByName.get(row.candidate_domain) ?? null) : null,
      personaSlug: row.persona_slug,
      inboxesEach: row.inboxes_each,
    });
    if (row.persona_slug !== null && row.updated_at >= personaUpdatedAt) {
      personaSlug = row.persona_slug;
      personaUpdatedAt = row.updated_at;
    }
  }

  const liveMailboxAddresses = new Set(
    ctx.sql
      .exec<{ email: string }>(`SELECT email FROM mailboxes WHERE tenant_id = ? AND released_at IS NULL`, ctx.tenantId)
      .toArray()
      .map((r) => r.email),
  );

  return { intentsByOrdinal, liveMailboxAddresses, personaSlug };
}

/**
 * Reconciles a target against the snapshot (BLOCKING-1).
 *
 * The distribution is a TARGET, not a delta: the ordinals a prior call
 * committed resume, and only the shortfall is planned. Everything downstream
 * that needs to know "how much will THIS call add" reads it from here — the
 * plan cap, the quote, the candidate requirement — so a pure retry, which adds
 * nothing, cannot be rejected by a guard sized against the whole ask.
 */
export function planFor(snap: ProvisioningSnapshot, target: ProvisioningTarget): ProvisioningPlan {
  const personaSlug = slugify(target.persona);
  const satisfied = new Map<number, { id: string; domain: string }>();
  let newDomains = 0;
  let newMailboxes = 0;

  for (let domainIndex = 0; domainIndex < target.distribution.length; domainIndex++) {
    const slots = target.distribution[domainIndex] as number;
    const live = snap.intentsByOrdinal.get(domainIndex)?.live ?? null;
    if (!live) {
      newDomains++;
      newMailboxes += slots;
      continue;
    }
    satisfied.set(domainIndex, live);
    // Count the SLOTS, by their deterministic addresses — not the domain's live
    // mailbox count. A call that changes `persona` targets different addresses,
    // and counting rows would understate what it is about to buy, which is the
    // one direction a spend guard must never be wrong in.
    for (let mailboxIndex = 0; mailboxIndex < slots; mailboxIndex++) {
      if (!snap.liveMailboxAddresses.has(managedMailboxAddress(personaSlug, live.domain, domainIndex, mailboxIndex))) {
        newMailboxes++;
      }
    }
  }

  return { satisfied, newDomains, newMailboxes };
}
