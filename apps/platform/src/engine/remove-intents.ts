/**
 * The durable RELEASE intent for a keyed `remove_mailboxes` call — the
 * destructive mirror of provision-intents.ts, and it exists for the mirror-image
 * reason.
 *
 * A buy intent exists because a retry that re-resolves buys a SECOND resource.
 * A release intent exists because a retry that re-resolves destroys a DIFFERENT
 * one: "release N" is relative, so the second pass under the same key selects
 * the N newest mailboxes that are live NOW — which, after a partial release,
 * are N healthy mailboxes the customer never asked to lose.
 *
 * N1, docs/adversarial/wave-1-2-integration-gate-2026-08-18.md round 2. A
 * mailbox the vendor permanently refuses can never leave `released_at IS NULL`,
 * so `failedCount >= 1` is permanent, so the outcome is permanently non-terminal
 * (remove-mailboxes-terminality.ts), so the key never freezes, so the retry the
 * platform's own docs instruct has NO terminating condition — and each pass of
 * it destroyed `count - failedCount` more healthy mailboxes. Measured: 15 live,
 * one stuck, ask 3, six retries, 12 destroyed. Irreversible in the way that
 * matters: a released mailbox loses its warmup reputation, which costs real
 * money and this platform's own documented four-week ramp to rebuild.
 *
 * So the resolution happens ONCE, at the first execution under a key, and is
 * written down before any vendor call. Every later same-key call re-drives the
 * recorded members that are still live — never a fresh selection, never an
 * address outside the set. Terminality then falls out of the intent: when every
 * member is released, `failedCount` is 0 and the key freezes on its own.
 */

import type { TenantContext } from "../tenant-context.js";

/** One address a keyed downgrade resolved — the unit the retry re-drives. */
export interface RemoveIntentMember {
  mailboxId: string;
  email: string;
}

/**
 * The `count` newest live mailboxes, newest first — the selection a downgrade
 * means by "release N", and the ONLY place it is made.
 *
 * It used to live inside `releaseMailboxes` as a `limit` scope, which put a
 * relative, destructive selection inside the shared executor every retry re-ran.
 * Here it can be resolved once and recorded (`recordRemoveIntent`), which is
 * what makes a keyed retry absolute. The unkeyed path (a browser submit, which
 * carries no key) still resolves per call: with no key there is nothing to
 * anchor an intent to, and "release one more" is genuinely what a second unkeyed
 * call says — see tenant-do.ts's guards for what does protect that path.
 */
export function resolveRemoveTargets(ctx: TenantContext, count: number): RemoveIntentMember[] {
  return ctx.sql
    .exec<{ id: string; email: string }>(
      `SELECT id, email FROM mailboxes
        WHERE tenant_id = ? AND released_at IS NULL
        ORDER BY created_at DESC
        LIMIT ?`,
      ctx.tenantId,
      count,
    )
    .toArray()
    .map((row) => ({ mailboxId: row.id, email: row.email }));
}

/**
 * The target set for `key`: the recorded one if this key has run before,
 * otherwise a fresh resolution written down before it is acted on.
 *
 * INSERT OR IGNORE + read-back, exactly like `recordDomainIntent`: the recorded
 * set WINS over anything a later call asks for. A same-key retry carrying a
 * different `count` therefore re-drives the original addresses rather than
 * resolving a new set — deliberately not a 409, matching what this codebase's
 * other intent-anchored surface already does (setup_infrastructure's ordinal
 * intents, where "no key permutation can change what gets purchased"). Refusing
 * the call would also punish the one agent behaviour the pre-fix docs asked for
 * — retrying with `count` reduced to `failedCount` — and leave the stragglers
 * live, which is the failure this closes. The mismatch is not silent: the
 * response's `releasedCount`/`failedCount`/`unreleased` describe the recorded
 * intent, so a caller that asked for something else can see it did not happen.
 *
 * Synchronous, and called BEFORE the first vendor release, so the record is
 * durable in the same input-gate turn that resolves it: a crash mid-release
 * cannot leave the set un-recorded and let the retry pick a different one.
 */
export function recordRemoveIntent(ctx: TenantContext, key: string, count: number): RemoveIntentMember[] {
  const recorded = readRemoveIntent(ctx, key);
  if (recorded.length > 0) return recorded;

  const targets = resolveRemoveTargets(ctx, count);
  if (targets.length === 0) return [];
  const now = ctx.clock.now();
  // ONE statement for the whole set, not a row-at-a-time loop: a half-written
  // intent is a smaller target set, and the point of recording it is that what
  // the retry drives cannot differ from what the first call resolved.
  ctx.sql.exec(
    `INSERT OR IGNORE INTO mailbox_release_intents (key, tenant_id, mailbox_id, email, created_at)
     VALUES ${targets.map(() => "(?, ?, ?, ?, ?)").join(", ")}`,
    ...targets.flatMap((target) => [key, ctx.tenantId, target.mailboxId, target.email, now]),
  );
  return readRemoveIntent(ctx, key);
}

/** This key's recorded members, oldest-recorded first. Empty for a key that has never run. */
function readRemoveIntent(ctx: TenantContext, key: string): RemoveIntentMember[] {
  return ctx.sql
    .exec<{ mailbox_id: string; email: string }>(
      `SELECT mailbox_id, email FROM mailbox_release_intents WHERE key = ? AND tenant_id = ? ORDER BY rowid`,
      key,
      ctx.tenantId,
    )
    .toArray()
    .map((row) => ({ mailboxId: row.mailbox_id, email: row.email }));
}

/**
 * The members of `targets` that are STILL LIVE — what the downgrade still owes,
 * and the exact set the next attempt drives.
 *
 * Read from `mailboxes.released_at` rather than from a per-call tally, so it is
 * true across attempts and across crashes: a member released by an earlier
 * attempt (or by a teardown in between) is finished no matter which call
 * finished it, and nothing further is owed for it.
 */
export function stillLiveTargets(ctx: TenantContext, targets: readonly RemoveIntentMember[]): RemoveIntentMember[] {
  if (targets.length === 0) return [];
  const placeholders = targets.map(() => "?").join(", ");
  const live = new Set(
    ctx.sql
      .exec<{ id: string }>(
        `SELECT id FROM mailboxes
          WHERE tenant_id = ? AND released_at IS NULL AND id IN (${placeholders})`,
        ctx.tenantId,
        ...targets.map((t) => t.mailboxId),
      )
      .toArray()
      .map((row) => row.id),
  );
  return targets.filter((t) => live.has(t.mailboxId));
}
