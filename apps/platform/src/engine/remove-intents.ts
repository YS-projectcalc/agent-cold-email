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

// Rows per INSERT statement in recordRemoveIntent's multi-row write. R3-1
// (gate finding, wave-1-2-integration-gate): DO SqlStorage enforces the same
// 100-bound-parameter ceiling D1 does (ofac/sdn-list.ts's INSERT_BATCH_SIZE
// precedent, empirically confirmed: 100 params OK, 101 throws "too many SQL
// variables"). This INSERT binds 5 params/row with no fixed params ahead of
// them, so floor(100 / 5) = 20 is the exact ceiling, not an approximation —
// unlike sdn-list.ts's 16 (6 cols) there is no remainder to round away.
// RemoveMailboxesInput.count allows up to 60 (packages/shared/src/intents.ts),
// so an unchunked write threw at 21+ targets on the documented self-serve path.
const RELEASE_INTENT_CHUNK_SIZE = 20;

/** One address a keyed downgrade resolved — the unit the retry re-drives. */
export interface RemoveIntentMember {
  mailboxId: string;
  email: string;
}

/**
 * A key's target set, plus whether this call RESOLVED it or merely found the one
 * an earlier call under the same key already recorded.
 *
 * The flag exists because those two cases are otherwise indistinguishable to the
 * caller and produce identical-looking success (NB-R3-1, docs/adversarial/
 * wave-1-2-integration-gate-2026-08-18.md): `request_idempotency` rows age out
 * after 30 days and these intent rows never do, so a key reused past the ageout
 * misses the response replay, re-runs, re-drives an intent whose members are all
 * already released, and reports the ORIGINAL downgrade's counts as if it had
 * just performed a second one.
 */
export interface RemoveIntent {
  members: RemoveIntentMember[];
  /** true = this call re-drove an intent an earlier same-key call recorded. */
  replayed: boolean;
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
export function recordRemoveIntent(ctx: TenantContext, key: string, count: number): RemoveIntent {
  const recorded = readRemoveIntent(ctx, key);
  if (recorded.length > 0) return { members: recorded, replayed: true };

  const targets = resolveRemoveTargets(ctx, count);
  if (targets.length === 0) return { members: [], replayed: false };
  const now = ctx.clock.now();
  // Chunked at RELEASE_INTENT_CHUNK_SIZE rows/statement (see the constant's
  // comment) rather than one statement for the whole set. That does NOT
  // reopen the half-written-intent risk the single-statement design was
  // guarding against: the guarantee was never "one SQL statement", it's the
  // Durable Object's INPUT GATE. This whole function is synchronous — no
  // `await` between chunks, or anywhere in it — so a CRASH cannot land between
  // two chunks: the turn never commits and nothing is written.
  //
  // What the input gate does NOT cover is a CAUGHT throw (R4-1, docs/adversarial/
  // wave-1-2-integration-gate-2026-08-18.md, measured): DO SqlStorage writes
  // survive an exception raised later in the same turn and caught, which is
  // precisely what `withRequestIdempotency` does with any throw out of `fn`. So
  // a chunk that landed before one that did not would leave a SHORT set — and
  // `readRemoveIntent`'s early return would adopt it as the whole downgrade on
  // the retry, completing short while reporting `failedCount: 0` and freezing as
  // terminal. That is an under-release reported as success, on the one path here
  // whose mistakes are irreversible.
  for (let i = 0; i < targets.length; i += RELEASE_INTENT_CHUNK_SIZE) {
    const chunk = targets.slice(i, i + RELEASE_INTENT_CHUNK_SIZE);
    ctx.sql.exec(
      `INSERT OR IGNORE INTO mailbox_release_intents (key, tenant_id, mailbox_id, email, created_at)
       VALUES ${chunk.map(() => "(?, ?, ?, ?, ?)").join(", ")}`,
      ...chunk.flatMap((target) => [key, ctx.tenantId, target.mailboxId, target.email, now]),
    );
  }

  // READ BACK WHAT LANDED, and refuse to hand back a partial intent. The rows
  // are deleted first so the key carries NOTHING rather than a short set: a
  // retry must re-resolve from scratch, which is the whole point of recording
  // the set. Loud beats short — the caller has not released anything yet at this
  // point, so a throw here costs a retry, while a short set costs mailboxes.
  const recordedNow = readRemoveIntent(ctx, key);
  if (recordedNow.length !== targets.length) {
    ctx.sql.exec(`DELETE FROM mailbox_release_intents WHERE key = ? AND tenant_id = ?`, key, ctx.tenantId);
    throw new Error(
      `release intent for key ${key} recorded ${recordedNow.length} of ${targets.length} targets; ` +
        `the partial intent was discarded so a retry re-resolves the downgrade`,
    );
  }
  return { members: recordedNow, replayed: false };
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
