/**
 * Durable INTENT records for the two non-idempotent vendor purchases this
 * platform makes: a domain registration and a mailbox buy.
 *
 * WHY (INCIDENT 2026-08-05): neither vendor endpoint takes an idempotency key,
 * and the only local record of "we may have already bought this" used to be the
 * request-idempotency claim — which `withRequestIdempotency` DELETES when the
 * wrapped function throws, precisely so a retry re-runs. That is correct for a
 * pure retry and catastrophic for a purchase: the retry re-ran the buy. The
 * domain half of this cost $12.50 and stranded a customer's domain invisibly;
 * the mailbox half is the same defect one step later (a buy accepted, then a
 * throw at the immediately-following uid lookup, then a re-buy).
 *
 * An intent row is written BEFORE the purchase and is NEVER deleted, because a
 * deleted intent is indistinguishable from one that never ran. A retry reads it
 * and either resumes or asks the VENDOR what it holds — never re-buys blind and
 * never matches on vendor error text ("already exists"), the fragile pattern
 * this codebase has removed twice.
 */

import type { TenantContext } from "../tenant-context.js";

/** The two intent tables, as a closed set (interpolated into SQL — never caller input). */
type IntentTable = "domain_intents" | "mailbox_intents";

/**
 * 'intent'    — written; the purchase has not been confirmed.
 * 'dangling'  — the purchase call THREW; we may or may not own the resource.
 * 'bought'    — the vendor ACCEPTED the purchase (mailboxes only; a domain goes
 *               straight to 'committed' once its row lands).
 * 'warming'   — the mailbox's warmup subscription exists (mailboxes only).
 * 'committed' — fully provisioned, local row written.
 * 'released'  — the resource was torn down; a later provision must buy afresh.
 */
type ProvisionIntentStatus = "intent" | "dangling" | "bought" | "warming" | "committed" | "released";

export interface DomainIntentRow {
  key: string;
  candidate_domain: string;
  status: string;
  [column: string]: SqlStorageValue;
}

export interface MailboxIntentRow {
  key: string;
  email: string;
  status: string;
  provider: string | null;
  [column: string]: SqlStorageValue;
}

/**
 * H1 — the durable domain buy-intent record. Idempotent by construction: a retry
 * re-reads the EXISTING row (keeping the candidate name the first attempt
 * resolved) rather than overwriting it, which is what makes the retry converge
 * on the same domain instead of generating a fresh one. Tenant-scoped on read
 * (CLAUDE.md rule h) even though the key already embeds the tenant.
 */
export function recordDomainIntent(ctx: TenantContext, key: string, candidateDomain: string): DomainIntentRow {
  const now = ctx.clock.now();
  ctx.sql.exec(
    `INSERT OR IGNORE INTO domain_intents (key, tenant_id, candidate_domain, status, created_at, updated_at)
     VALUES (?, ?, ?, 'intent', ?, ?)`,
    key,
    ctx.tenantId,
    candidateDomain,
    now,
    now,
  );
  return ctx.sql
    .exec<DomainIntentRow>(
      `SELECT key, candidate_domain, status FROM domain_intents WHERE key = ? AND tenant_id = ?`,
      key,
      ctx.tenantId,
    )
    .one();
}

/**
 * L2 — the durable mailbox buy-intent record, keyed by the address itself.
 *
 * The key is derivable from the email ALONE (`mailboxIntentKey`) so teardown can
 * invalidate it without knowing which provisioning call created it — see
 * `markMailboxIntentsReleased`. The local part is deterministic
 * (persona + ordinals), so the address is known BEFORE the buy: unlike a domain,
 * there is no "which name did the first attempt resolve to?" question, only
 * "did our buy land?".
 */
export function recordMailboxIntent(ctx: TenantContext, key: string, email: string): MailboxIntentRow {
  const now = ctx.clock.now();
  ctx.sql.exec(
    `INSERT OR IGNORE INTO mailbox_intents (key, tenant_id, email, status, created_at, updated_at)
     VALUES (?, ?, ?, 'intent', ?, ?)`,
    key,
    ctx.tenantId,
    email,
    now,
    now,
  );
  return ctx.sql
    .exec<MailboxIntentRow>(
      `SELECT key, email, status, provider FROM mailbox_intents WHERE key = ? AND tenant_id = ?`,
      key,
      ctx.tenantId,
    )
    .one();
}

/** The mailbox intent + per-mailbox idempotency key for an address — derivable from the address alone. */
export function mailboxIntentKey(tenantId: string, email: string): string {
  return `mbx:${tenantId}:${email}`;
}

/**
 * Advances an intent's status. NEVER deletes — see the tables' schema comments.
 * The table name is a closed union, never caller input.
 */
function markIntent(ctx: TenantContext, table: IntentTable, key: string, status: ProvisionIntentStatus): void {
  ctx.sql.exec(
    `UPDATE ${table} SET status = ?, updated_at = ? WHERE key = ? AND tenant_id = ?`,
    status,
    ctx.clock.now(),
    key,
    ctx.tenantId,
  );
}

/**
 * Advances a domain intent, optionally correcting the domain it names.
 *
 * `actualDomain` (N1) is the resource genuinely acquired. The recorded name is
 * a claim about what we may own, so it has to match reality at commit time: a
 * fall-through buy acquires THIS call's candidate, which is not necessarily the
 * name the first attempt under this key resolved to.
 */
export function markDomainIntent(
  ctx: TenantContext,
  key: string,
  status: ProvisionIntentStatus,
  actualDomain?: string,
): void {
  if (actualDomain === undefined) {
    markIntent(ctx, "domain_intents", key, status);
    return;
  }
  ctx.sql.exec(
    `UPDATE domain_intents SET status = ?, candidate_domain = ?, updated_at = ? WHERE key = ? AND tenant_id = ?`,
    status,
    actualDomain,
    ctx.clock.now(),
    key,
    ctx.tenantId,
  );
}

/** Advances a mailbox intent, recording the vendor's provider on the leg that learns it. */
export function markMailboxIntent(
  ctx: TenantContext,
  key: string,
  status: ProvisionIntentStatus,
  provider?: string,
): void {
  if (provider === undefined) {
    markIntent(ctx, "mailbox_intents", key, status);
    return;
  }
  ctx.sql.exec(
    `UPDATE mailbox_intents SET status = ?, provider = ?, updated_at = ? WHERE key = ? AND tenant_id = ?`,
    status,
    provider,
    ctx.clock.now(),
    key,
    ctx.tenantId,
  );
}

/**
 * N4 — teardown invalidation. A released mailbox no longer exists at the vendor,
 * so BOTH durable "we already provisioned this" records must stop asserting that:
 * the intent row is marked 'released', and the per-mailbox request-idempotency
 * claim is dropped.
 *
 * Without this, a tenant who cancels and re-subscribes gets a local, BILLABLE
 * mailbox row with no vendor mailbox behind it: the claim outlives the teardown,
 * so the replay returns the recorded mailbox, skips the vendor buy entirely, and
 * the row is inserted anyway. The claim is a statement about a resource; when
 * the resource is destroyed the statement has to go with it.
 */
export function markMailboxIntentsReleased(ctx: TenantContext, emails: string[]): void {
  for (const email of emails) {
    const key = mailboxIntentKey(ctx.tenantId, email);
    markIntent(ctx, "mailbox_intents", key, "released");
    ctx.sql.exec(`DELETE FROM request_idempotency WHERE key = ?`, `provision:${key}`);
  }
}
