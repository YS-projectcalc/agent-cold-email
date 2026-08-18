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
 * PURE SELECT across all five tables — no write, no behavior change, same
 * posture as engine/tenant-messages.ts's listMessagesForOperator. Delivers
 * regardless of lifecycle state (there is nothing to gate on a read).
 *
 * ITEM 3 / D MINIMAL (docs/adversarial/class-sweep-vendor-truth-2026-08-18.md):
 *  (a) `requestIdempotency` used to be HARDCODED to `LIKE 'setup_infrastructure:%'`
 *      — invisible to per-mailbox `provision:mbx:` claims even though the
 *      table holds them (D1, live-confirmed on production: a tenant that
 *      demonstrably provisioned two mailboxes reported `requestIdempotency: []`).
 *      The default is now ALL prefixes; `idempotencyPrefix` narrows it back
 *      when an operator wants exactly one intent's claims. The response also
 *      gains `mailboxIntents` + `buyDispatches` — the two tables the incident
 *      needed and no admin surface exposed (D1's sibling gap).
 *  (b) every list carries its own `*Total` alongside the (limit-bounded) page
 *      — `limit` without `total` is silent truncation, D3's own class one
 *      layer down from D1.
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

/** Item 3a — the durable mailbox buy-intent record (provision-intents.ts's
 * `mailbox_intents`), previously invisible to every admin read surface. */
export interface ProvisioningStateMailboxIntent {
  key: string;
  email: string;
  status: string;
  provider: string | null;
  createdAt: number;
  updatedAt: number;
}

/** Item 3a — the guarded-re-buy dispatch ledger (provision-intents.ts's
 * `mailbox_buy_dispatches`) — how many `/mailboxes/buy` calls a given intent
 * has actually authorized, and when the last one went out. */
export interface ProvisioningStateBuyDispatch {
  intentKey: string;
  email: string;
  attempts: number;
  lastDispatchedAt: number;
  reconstructed: boolean;
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
  domainsTotal: number;
  domainIntents: ProvisioningStateDomainIntent[];
  domainIntentsTotal: number;
  mailboxIntents: ProvisioningStateMailboxIntent[];
  mailboxIntentsTotal: number;
  buyDispatches: ProvisioningStateBuyDispatch[];
  buyDispatchesTotal: number;
  requestIdempotency: ProvisioningStateIdempotencyEntry[];
  requestIdempotencyTotal: number;
}

export interface ProvisioningStateOptions {
  /** Caps EVERY list in the response — one shared cap, mirroring
   * routes/admin-messages.ts's `?limit=` convention. Absent/non-finite/non-positive
   * falls back to the default; never clamps to a truncating value on an empty
   * string (that was D9, the sibling bug this option is written to avoid repeating). */
  limit?: number;
  /**
   * Narrows `requestIdempotency` to keys starting with this prefix. Absent —
   * the default — returns EVERY prefix (item (a) above). Pass
   * `"setup_infrastructure:"` to reproduce the OLD hardcoded scope exactly.
   */
  idempotencyPrefix?: string;
}

const DEFAULT_PROVISIONING_STATE_LIMIT = 200;
const MAX_PROVISIONING_STATE_LIMIT = 1000;

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_PROVISIONING_STATE_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_PROVISIONING_STATE_LIMIT);
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

interface MailboxIntentQueryRow {
  key: string;
  email: string;
  status: string;
  provider: string | null;
  created_at: number;
  updated_at: number;
  [column: string]: SqlStorageValue;
}

interface BuyDispatchQueryRow {
  intent_key: string;
  email: string;
  attempts: number;
  last_dispatched_at: number;
  reconstructed: number;
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

export function getProvisioningStateForOperator(ctx: TenantContext, options: ProvisioningStateOptions = {}): ProvisioningState {
  const limit = clampLimit(options.limit);

  const domainRows = ctx.sql
    .exec<DomainRow>(
      `SELECT domain, status, source, dns_status, dns_first_checked_at, dns_check_count, dns_gave_up_at, purchased_at
       FROM domains
       WHERE tenant_id = ?
       ORDER BY purchased_at DESC, rowid DESC
       LIMIT ?`,
      ctx.tenantId,
      limit,
    )
    .toArray();
  const domainsTotal = ctx.sql.exec<{ n: number }>(`SELECT COUNT(*) as n FROM domains WHERE tenant_id = ?`, ctx.tenantId).one().n;

  const intentRows = ctx.sql
    .exec<DomainIntentQueryRow>(
      `SELECT key, candidate_domain, status, persona_slug, inboxes_each, created_at, updated_at
       FROM domain_intents
       WHERE tenant_id = ?
       ORDER BY created_at DESC, key DESC
       LIMIT ?`,
      ctx.tenantId,
      limit,
    )
    .toArray();
  const domainIntentsTotal = ctx.sql
    .exec<{ n: number }>(`SELECT COUNT(*) as n FROM domain_intents WHERE tenant_id = ?`, ctx.tenantId)
    .one().n;

  const mailboxIntentRows = ctx.sql
    .exec<MailboxIntentQueryRow>(
      `SELECT key, email, status, provider, created_at, updated_at
       FROM mailbox_intents
       WHERE tenant_id = ?
       ORDER BY updated_at DESC, key DESC
       LIMIT ?`,
      ctx.tenantId,
      limit,
    )
    .toArray();
  const mailboxIntentsTotal = ctx.sql
    .exec<{ n: number }>(`SELECT COUNT(*) as n FROM mailbox_intents WHERE tenant_id = ?`, ctx.tenantId)
    .one().n;

  const buyDispatchRows = ctx.sql
    .exec<BuyDispatchQueryRow>(
      `SELECT intent_key, email, attempts, last_dispatched_at, reconstructed, created_at, updated_at
       FROM mailbox_buy_dispatches
       WHERE tenant_id = ?
       ORDER BY last_dispatched_at DESC, intent_key DESC
       LIMIT ?`,
      ctx.tenantId,
      limit,
    )
    .toArray();
  const buyDispatchesTotal = ctx.sql
    .exec<{ n: number }>(`SELECT COUNT(*) as n FROM mailbox_buy_dispatches WHERE tenant_id = ?`, ctx.tenantId)
    .one().n;

  // Item 3a — no tenant_id column on this table (schema.ts: it lives inside
  // the tenant's own DO, one tenant per DO instance, so `key` alone is the
  // anchor — that IS the tenant scoping, CLAUDE.md rule h). DEFAULT scope is
  // now every prefix; `idempotencyPrefix` narrows it, replicating the OLD
  // hardcoded `LIKE 'setup_infrastructure:%'` exactly when set to that string.
  const idempotencyRows = options.idempotencyPrefix
    ? ctx.sql
        .exec<IdempotencyQueryRow>(
          `SELECT key, status, created_at FROM request_idempotency WHERE key LIKE ? ORDER BY created_at DESC LIMIT ?`,
          `${options.idempotencyPrefix}%`,
          limit,
        )
        .toArray()
    : ctx.sql.exec<IdempotencyQueryRow>(`SELECT key, status, created_at FROM request_idempotency ORDER BY created_at DESC LIMIT ?`, limit).toArray();
  const requestIdempotencyTotal = options.idempotencyPrefix
    ? ctx.sql.exec<{ n: number }>(`SELECT COUNT(*) as n FROM request_idempotency WHERE key LIKE ?`, `${options.idempotencyPrefix}%`).one().n
    : ctx.sql.exec<{ n: number }>(`SELECT COUNT(*) as n FROM request_idempotency`).one().n;

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
    domainsTotal,
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
    domainIntentsTotal,
    mailboxIntents: mailboxIntentRows.map((row) => ({
      key: row.key,
      email: row.email,
      status: row.status,
      provider: row.provider,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
    mailboxIntentsTotal,
    buyDispatches: buyDispatchRows.map((row) => ({
      intentKey: row.intent_key,
      email: row.email,
      attempts: row.attempts,
      lastDispatchedAt: row.last_dispatched_at,
      reconstructed: row.reconstructed === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
    buyDispatchesTotal,
    requestIdempotency: idempotencyRows.map((row) => ({
      key: row.key,
      status: row.status,
      createdAt: row.created_at,
    })),
    requestIdempotencyTotal,
  };
}
