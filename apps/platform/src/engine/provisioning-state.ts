/**
 * The operator's read-only view of one tenant's provisioning state — closes
 * UNVERIFIABLE-1/2/3 in `docs/adversarial/agent-channel-product-audit-2026-08-17.md`:
 * which FINISHED outcomes a `setup_infrastructure` idempotency key has recorded
 * (the Settled contract means unfinished outcomes are never recorded, so a
 * stale-replay can no longer exist by construction — the row list is the
 * proof), which ordinal a domain occupies, and a domain's real DNS standing. Nothing in this codebase read `domains`,
 * `domain_intents`, or `request_idempotency` from OUTSIDE the tenant's own DO
 * before this — the audit needed a throwaway sandbox clone to answer those
 * questions at all (F6's sibling gap, one table over from tenant_messages).
 *
 * PURE SELECT across all three tables — no write, no behavior change, same
 * posture as engine/tenant-messages.ts's listMessagesForOperator. Delivers
 * regardless of lifecycle state (there is nothing to gate on a read).
 */

import { domainIntentOrdinal } from "./provision-intents.js";
import type { TenantContext } from "../tenant-context.js";

export interface ProvisioningStateDomain {
  domain: string;
  status: string;
  source: string;
  dnsStatus: string;
  dnsFirstCheckedAt: number | null;
  dnsCheckCount: number;
  dnsGaveUpAt: number | null;
  purchasedAt: number;
}

// `ordinal` is null for a row whose key isn't `tenant:<id>#<n>`-shaped under
// the CURRENT derivation (domainIntentOrdinal) — chiefly a burn-replacement
// intent (provision-intents.ts's replacementDomainIntentKey, prefixed
// `replace:<tenantId>:`), which is real domain_intents data for this SAME
// tenant and still surfaced here, just not slotted at an ordinal.
export interface ProvisioningStateDomainIntent {
  key: string;
  ordinal: number | null;
  candidateDomain: string;
  status: string;
  personaSlug: string | null;
  inboxesEach: number | null;
  createdAt: number;
  updatedAt: number;
}

// NEVER `response_json` — it may embed tenant data (schema.ts's
// request_idempotency comment: the stored value is the serialized RESULT of
// whatever intent the key gated) this read has no reason to expose. The table
// has exactly one timestamp column (`created_at` — re-stamped in place on a
// stale-claim reclaim, engine/idempotency.ts's reclaim branch; there is no
// separate `updated_at`), so this shape has exactly one timestamp too.
export interface ProvisioningStateIdempotencyEntry {
  key: string;
  status: string;
  createdAt: number;
}

export interface ProvisioningState {
  domains: ProvisioningStateDomain[];
  domainIntents: ProvisioningStateDomainIntent[];
  requestIdempotency: ProvisioningStateIdempotencyEntry[];
}

interface DomainRow {
  domain: string;
  status: string;
  source: string;
  dns_status: string;
  dns_first_checked_at: number | null;
  dns_check_count: number;
  dns_gave_up_at: number | null;
  purchased_at: number;
  [column: string]: SqlStorageValue;
}

interface DomainIntentQueryRow {
  key: string;
  candidate_domain: string;
  status: string;
  persona_slug: string | null;
  inboxes_each: number | null;
  created_at: number;
  updated_at: number;
  [column: string]: SqlStorageValue;
}

interface IdempotencyQueryRow {
  key: string;
  status: string;
  created_at: number;
  [column: string]: SqlStorageValue;
}

export function getProvisioningStateForOperator(ctx: TenantContext): ProvisioningState {
  const domainRows = ctx.sql
    .exec<DomainRow>(
      `SELECT domain, status, source, dns_status, dns_first_checked_at, dns_check_count, dns_gave_up_at, purchased_at
       FROM domains
       WHERE tenant_id = ?
       ORDER BY purchased_at DESC, rowid DESC`,
      ctx.tenantId,
    )
    .toArray();

  const intentRows = ctx.sql
    .exec<DomainIntentQueryRow>(
      `SELECT key, candidate_domain, status, persona_slug, inboxes_each, created_at, updated_at
       FROM domain_intents
       WHERE tenant_id = ?
       ORDER BY created_at DESC, key DESC`,
      ctx.tenantId,
    )
    .toArray();

  // Tenant-scoped by the `setup_infrastructure:` prefix only, NOT by tenant_id
  // — request_idempotency has no tenant_id column (schema.ts: it lives inside
  // the tenant's own DO, one tenant per DO instance, so `key` alone is the
  // anchor). That IS the tenant scoping (CLAUDE.md rule h): this query can
  // only ever see rows written inside `ctx`'s own DO.
  const idempotencyRows = ctx.sql
    .exec<IdempotencyQueryRow>(
      `SELECT key, status, created_at
       FROM request_idempotency
       WHERE key LIKE 'setup_infrastructure:%'
       ORDER BY created_at DESC`,
    )
    .toArray();

  return {
    domains: domainRows.map((row) => ({
      domain: row.domain,
      status: row.status,
      source: row.source,
      dnsStatus: row.dns_status,
      dnsFirstCheckedAt: row.dns_first_checked_at,
      dnsCheckCount: row.dns_check_count,
      dnsGaveUpAt: row.dns_gave_up_at,
      purchasedAt: row.purchased_at,
    })),
    domainIntents: intentRows.map((row) => ({
      key: row.key,
      ordinal: domainIntentOrdinal(ctx.tenantId, row.key) ?? null,
      candidateDomain: row.candidate_domain,
      status: row.status,
      personaSlug: row.persona_slug,
      inboxesEach: row.inboxes_each,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
    requestIdempotency: idempotencyRows.map((row) => ({
      key: row.key,
      status: row.status,
      createdAt: row.created_at,
    })),
  };
}
