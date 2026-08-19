/**
 * The one-shot `domain_intents.persona_slug` backfill
 * (docs/adversarial/customer-continuity-build-gate-2026-08-19.md BLOCKING-1).
 *
 * WHY IT EXISTS. `persona_slug` was added later by `addColumnIfMissing` — a
 * plain `ALTER TABLE ADD COLUMN` with a literal default, which cannot compute —
 * and it is written INSERT-only (`recordDomainIntent`'s `INSERT OR IGNORE`), so
 * it is permanently NULL for every intent row written before it existed and no
 * later call updates it. That is the ENTIRE pre-column paying population.
 * `readProvisioningSnapshot` sources the persona from that column alone, so the
 * recommendation planned against `slugify("")` = `"hello"`, matched none of the
 * tenant's real mailboxes, counted every slot as NEW, and priced a $16/mo
 * increase beside prose reading "your bill is unchanged".
 *
 * WHAT IT RECOVERS FROM. The persona is not lost: it is spelled out in every
 * mailbox the intent produced. `managedMailboxAddress` is
 * `${persona}${ordinal+1}${slot+1}@${domain}`, so a live mailbox on the
 * intent's own domain, at a known ordinal, inverts to exactly one persona
 * (`personaSlugFromManagedAddress`, verified by round trip rather than by
 * parsing).
 *
 * WHAT IT REFUSES TO DO. It writes only when the recovery is UNAMBIGUOUS: every
 * live mailbox on that domain must invert, and all of them must agree. A domain
 * with no live mailboxes, an address this platform never derived (a hand-made
 * `sales@`), or two mailboxes naming different personas all leave the column
 * NULL — the reconciler's own posture for a NULL spec
 * (`provisioning-reconcile.ts`'s `skippedNoSpec`: "not safely completable —
 * abstain"). `deriveNextSteps` then abstains from PRICING the plan rather than
 * inventing a persona, which is the other half of the same fix.
 *
 * SHAPE. Self-applying on every DO construction, idempotent by the
 * `persona_slug IS NULL` predicate — the `grandfatherActiveScreening` /
 * `backfillFirstPaidAt` precedent. Two SELECTs and at most one UPDATE, all
 * synchronous, with every per-row decision made in memory: no `sql.exec` inside
 * any loop (test/loop-isolation-coverage.test.ts).
 */

import { MAILBOXES_PER_DOMAIN } from "@coldstart/shared";
import { personaSlugFromManagedAddress } from "./mailbox-provisioning.js";
import { domainIntentOrdinal } from "./provision-intents.js";

/**
 * Rows recovered per construction. The statement binds `3n + 1` parameters and
 * the SQLite ceiling here is 100 (admin/db.ts's chunk-boundary note), so 32 is
 * the largest safe batch. A tenant carrying more NULL-persona ordinals than
 * that — 32 is already above the `MAX_SELF_SERVE_MAILBOXES / MAILBOXES_PER_DOMAIN`
 * ceiling on ordinals, so it is unreachable today — converges over successive
 * constructions rather than needing a chunk LOOP, which would be a new
 * unisolated write loop.
 */
const PERSONA_BACKFILL_BATCH = 32;

export interface PersonaBackfillResult {
  /** Intents whose persona was recovered and written. */
  recovered: number;
  /** NULL-persona ordinal intents this pass could not recover unambiguously. */
  abstained: number;
}

/**
 * The persona every live mailbox on `domain` agrees on, or `undefined` when the
 * evidence is absent or ambiguous.
 *
 * Ambiguity is checked in BOTH directions: one address that inverts under two
 * different slots (possible only with multi-digit slot numbers) is as unusable
 * as two addresses naming different personas, and an address that inverts under
 * no slot at all means this domain carries mail this platform did not derive —
 * in which case the ones that DO invert are not evidence about the whole set.
 */
export function recoverPersonaSlug(emails: readonly string[], domain: string, domainOrdinal: number): string | undefined {
  if (emails.length === 0) return undefined;
  const slots = Math.max(MAILBOXES_PER_DOMAIN, emails.length);
  let agreed: string | undefined;
  for (const email of emails) {
    let candidate: string | undefined;
    for (let slot = 0; slot < slots; slot++) {
      const inverted = personaSlugFromManagedAddress(email, domain, domainOrdinal, slot);
      if (inverted === undefined) continue;
      if (candidate !== undefined && candidate !== inverted) return undefined;
      candidate = inverted;
    }
    if (candidate === undefined) return undefined;
    if (agreed === undefined) agreed = candidate;
    else if (agreed !== candidate) return undefined;
  }
  return agreed;
}

export function backfillPersonaSlugs(storage: DurableObjectStorage, tenantId: string): PersonaBackfillResult {
  const sql = storage.sql;
  const orphans = sql
    .exec<{ key: string; candidate_domain: string }>(
      `SELECT key, candidate_domain FROM domain_intents WHERE tenant_id = ? AND persona_slug IS NULL ORDER BY key`,
      tenantId,
    )
    .toArray();
  if (orphans.length === 0) return { recovered: 0, abstained: 0 };

  // ONE read of the live mailboxes, bucketed by domain in memory. `released_at
  // IS NULL` is the same "live" predicate every other reader of this table
  // uses — a released mailbox keeps its address forever and is not evidence of
  // the CURRENT scheme.
  const liveByDomain = new Map<string, string[]>();
  for (const row of sql
    .exec<{ domain: string; email: string }>(
      `SELECT domain, email FROM mailboxes WHERE tenant_id = ? AND released_at IS NULL`,
      tenantId,
    )
    .toArray()) {
    const bucket = liveByDomain.get(row.domain);
    if (bucket) bucket.push(row.email);
    else liveByDomain.set(row.domain, [row.email]);
  }

  const recovered: { key: string; personaSlug: string }[] = [];
  let abstained = 0;
  for (const orphan of orphans) {
    // A key the current derivation never writes belongs to the burn-replacement
    // writer (`replacementDomainIntentKey`) and names no ordinal of the managed
    // fleet, so there is no ordinal to invert against. Left alone, exactly as
    // `readProvisioningSnapshot` leaves it.
    const ordinal = domainIntentOrdinal(tenantId, orphan.key);
    if (ordinal === undefined) continue;
    const slug = recoverPersonaSlug(liveByDomain.get(orphan.candidate_domain) ?? [], orphan.candidate_domain, ordinal);
    if (slug === undefined) {
      abstained++;
      continue;
    }
    if (recovered.length < PERSONA_BACKFILL_BATCH) recovered.push({ key: orphan.key, personaSlug: slug });
  }
  if (recovered.length === 0) return { recovered: 0, abstained };

  // ONE statement. `persona_slug IS NULL` is re-asserted in the WHERE so a
  // concurrent write (a real provisioning call landing between the read and
  // this update) always wins over the recovery — the house conditional-UPDATE
  // pattern, and the same direction `backfillFirstPaidAt` takes.
  const result = sql.exec(
    `UPDATE domain_intents
        SET persona_slug = CASE key ${recovered.map(() => "WHEN ? THEN ?").join(" ")} END
      WHERE tenant_id = ? AND persona_slug IS NULL AND key IN (${recovered.map(() => "?").join(", ")})`,
    ...recovered.flatMap((r) => [r.key, r.personaSlug]),
    tenantId,
    ...recovered.map((r) => r.key),
  );
  return { recovered: result.rowsWritten, abstained };
}
