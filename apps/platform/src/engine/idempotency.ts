import { RequestInProgressError } from "@coldstart/shared";
import type { TenantContext } from "../tenant-context.js";

// NB1 — request_idempotency rows are evicted at write time once older than this,
// so the table can't grow unbounded (one row per unique key would otherwise live
// forever, per-tenant DO). 30 days comfortably exceeds any realistic client/queue
// retry window. Measured on ctx.clock (the same clock that stamps created_at), so
// eviction and insertion stay on one time base.
const REQUEST_IDEMPOTENCY_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// ACTIVATION.md Gate 2 — bounds how long a 'pending' claim is trusted as
// "genuinely still running" before a retry of the SAME key may reclaim it
// (see the "Stale-claim reclaim" doc below). Sized against the single
// longest legitimate fn() this engine wraps: setup_infrastructure
// (engine/provisioning.ts) makes one real vendor round trip PER domain (buy
// + setDns) and PER mailbox (provision + startWarmup, + recordUsage on paid
// tiers) sequentially, up to the Scale tier's cap of 18 domains / 60
// mailboxes (packages/shared/src/pricing.ts) — up to ~156 sequential real
// vendor calls in one call to fn(). Even at a pessimistic several seconds
// per real registrar/mailbox-vendor API round trip, that whole chain
// finishes in low single-digit minutes; 10 minutes leaves multiples of
// headroom so no legitimate in-flight claim is ever reclaimed out from under
// it, while staying ~4300x shorter than REQUEST_IDEMPOTENCY_TTL_MS above, so
// a genuinely dead claim (crashed DO) unblocks a retry promptly instead of
// waiting anywhere near the 30-day full-eviction horizon.
const REQUEST_IDEMPOTENCY_PENDING_CLAIM_TTL_MS = 10 * 60 * 1000;

// How long an INCOMPLETE recorded outcome (see `isIncomplete` below) keeps
// replaying before a retry of the same key is allowed to re-run fn(). This is
// NOT the pending-claim TTL above: that one bounds a claim believed to be
// RUNNING, this one bounds a claim that has already FINISHED but finished
// owing work. Sized purely against a double-submit (a dropped response, an
// at-least-once queue re-delivery), which lands within seconds of the
// original, plus the ~32s async registrar registration a 202 provisioning-
// pending outcome is typically waiting on — so an immediate re-fire cannot do
// pointless vendor work. Past that, the retry the system's OWN message
// instructs must actually run, because re-running fn() is the only thing that
// can finish the work.
//
// Measured from `created_at`, which is stamped when the call CLAIMED the key,
// not when it finished — so a long fn() spends part of this window running, and
// a slow saga's recorded outcome can be replayable for less than a minute (or
// not at all). That is deliberate rather than papered over with a bigger
// number: erring short costs one redundant re-run, which is safe by
// construction here (setup_infrastructure's purchases are gated by the
// ordinal-derived domain intents, never by this key — see tenant-do.ts), while
// erring long re-opens the exact dead window F1 is about.
const REQUEST_IDEMPOTENCY_INCOMPLETE_REPLAY_MS = 60 * 1000;

/** Per-call-site options — see `isIncomplete`. */
export interface RequestIdempotencyOptions<T> {
  /**
   * Classifies a SUCCESSFUL result as still-unfinished work. SYNCHRONOUS by
   * contract (it runs inside the claim-then-execute prefix, before any await —
   * see the class doc) and TOTAL (it is handed a `JSON.parse` of whatever was
   * recorded, which may predate the current result shape).
   *
   * Opt-in, and deliberately owned by the caller rather than sniffed here: the
   * wrapper is generic and must not learn any intent's result semantics. An
   * intent whose fn() can return "accepted, not finished" MUST pass this or it
   * re-opens F1 below.
   */
  isIncomplete?: (result: T) => boolean;
}

/**
 * Request-level idempotency (B2, CLASS B). When a client presents an
 * idempotency `key` for a mutating intent, the FIRST call runs `fn` and records
 * its serialized result; a REPLAY with the same key returns that stored result
 * WITHOUT re-running `fn` — so a retried request (dropped response, at-least-once
 * client/queue delivery) can't create a second campaign, double-provision
 * infrastructure, or double-bill. Key absent -> `fn` runs and nothing is stored,
 * preserving behavior for existing clients that don't send a key.
 *
 * Scoped inside the tenant's own DO (one tenant per DO instance), so the DO
 * caller namespaces the key by intent (e.g. `launch_campaign:<key>`) to keep a
 * client that reuses one key across different intents from colliding.
 *
 * CLAIM-THEN-EXECUTE. A plain read-then-write is only atomic for a fully
 * synchronous `fn`: an intent that awaits vendor I/O (setup_infrastructure,
 * reply) reopens the DO input gate on the await, so two concurrent FIRST calls
 * could both pass the read and both execute. To close that, the first call
 * INSERTs a 'pending' claim row BEFORE the await — the input gate serializes RPCs
 * up to that await, so a concurrent same-key call can only interleave after the
 * claim is durable, sees 'pending', and is rejected with a RETRYABLE
 * RequestInProgressError. On completion the claim is UPDATEd to 'done' with the
 * response; if `fn` throws, the claim is DELETEd so a retry re-runs (failures are
 * never cached — error-replay semantics preserved).
 *
 * Stale-claim reclaim (ACTIVATION.md Gate 2): a DO that dies mid-`fn` (after
 * the claim is durable, before the UPDATE/DELETE) would otherwise leave a
 * 'pending' row that PERMANENTLY rejects retries of that key — write-time
 * eviction removes 'done' rows only, never an in-flight claim. Not reachable
 * with the sandbox adapters (no real network I/O, so `fn` cannot suspend
 * across a crash), but real vendor adapters can. A 'pending' claim older
 * than REQUEST_IDEMPOTENCY_PENDING_CLAIM_TTL_MS is presumed dead, and a retry
 * of the SAME key may reclaim it (re-stamp `created_at`, take over the run)
 * instead of conflicting — see the reclaim branch below for how this stays
 * atomic under a concurrent retry race. A 'pending' claim within the window
 * still rejects with the retryable conflict, unchanged.
 *
 * INCOMPLETE-outcome reclaim (F1, docs/adversarial/
 * agent-channel-product-audit-2026-08-17.md). THE INVARIANT: a recorded outcome
 * may be replayed forever only if it is TERMINAL. "fn() returned" is not the
 * same as "the work is finished" — setup_infrastructure's 202 SUCCESS-PENDING
 * branch RETURNS while the setup still owes a domain's DNS and its mailboxes.
 * Recording that as an ordinary replayable result made the system's own retry
 * instruction ("retry with the same idempotency key to finish it") a guaranteed
 * no-op: every later same-key call replayed a stale 202 with zero vendor calls
 * and an empty messages[], indefinitely — the exact eternal-"pending" shape
 * engine/domain-dns.ts's class fix closed INSIDE the saga and left open in
 * front of it. So an outcome the caller classifies as incomplete replays for
 * REQUEST_IDEMPOTENCY_INCOMPLETE_REPLAY_MS only; the next same-key call after
 * that re-claims the row and re-runs fn(). The classification is applied to the
 * RECORDED RESPONSE rather than to a status column, so rows written before this
 * fix are covered too — which is the whole point, since the population that
 * needs it is the one already wedged in production.
 */
export async function withRequestIdempotency<T>(
  ctx: TenantContext,
  key: string | undefined,
  fn: () => T | Promise<T>,
  opts?: RequestIdempotencyOptions<T>,
): Promise<T> {
  if (!key) return fn();

  const now = ctx.clock.now();
  const existing = ctx.sql
    .exec<{ status: string; response_json: string | null; created_at: number }>(
      `SELECT status, response_json, created_at FROM request_idempotency WHERE key = ?`,
      key,
    )
    .toArray()[0];
  if (existing) {
    if (existing.status === "done" && existing.response_json !== null) {
      const recorded = JSON.parse(existing.response_json) as T;
      // THE REPLAY DECISION (see "INCOMPLETE-outcome reclaim" above). A
      // terminal outcome replays for the row's whole life, exactly as before.
      // An outcome the caller classifies as unfinished replays only long
      // enough to absorb a double-submit; after that the retry has to do the
      // work, because nothing else will.
      const incomplete = opts?.isIncomplete?.(recorded) ?? false;
      if (!incomplete || now - existing.created_at < REQUEST_IDEMPOTENCY_INCOMPLETE_REPLAY_MS) {
        return recorded;
      }
      // Re-claim IN PLACE, synchronously, before any await below — the same
      // "one input-gate turn" guarantee the fresh-claim INSERT and the
      // stale-claim reclaim rely on. A concurrent same-key call can only
      // observe this row AFTER the flip lands (its own SELECT cannot run until
      // this synchronous prefix yields at fn()'s first await), so it reads
      // 'pending' with a freshly-set created_at and takes the conflict branch
      // below — exactly one caller ever proceeds to run fn(). The stale
      // response is cleared with it: a 'pending' row's body is never read, and
      // if fn() throws, the catch DELETEs the row rather than resurrecting a
      // 202 the retry has just disproved.
      ctx.sql.exec(
        `UPDATE request_idempotency SET status = 'pending', response_json = NULL, created_at = ? WHERE key = ? AND status = 'done'`,
        now,
        key,
      );
    } else if (now - existing.created_at < REQUEST_IDEMPOTENCY_PENDING_CLAIM_TTL_MS) {
      // 'pending': another turn claimed this key. Within the trust window it's
      // presumed genuinely still running fn() — running it again would double
      // the side effect, so reject with a retryable conflict.
      throw new RequestInProgressError();
    } else {
      // Past the window: presumed dead (the claiming DO crashed mid-fn — see
      // the class doc above). Same in-place, pre-await reclaim as the branch
      // above, and atomic under a concurrent retry for the same reason.
      ctx.sql.exec(`UPDATE request_idempotency SET created_at = ? WHERE key = ? AND status = 'pending'`, now, key);
    }
  } else {
    // Claim BEFORE the first await (see the class doc): synchronous SELECT + INSERT
    // land in one input-gate turn, so the claim is durable before fn() can yield.
    ctx.sql.exec(
      `INSERT INTO request_idempotency (key, status, response_json, created_at) VALUES (?, 'pending', NULL, ?)`,
      key,
      now,
    );
  }
  // NB1 write-time eviction — only completed rows, never an in-flight claim.
  ctx.sql.exec(
    `DELETE FROM request_idempotency WHERE status = 'done' AND created_at < ?`,
    now - REQUEST_IDEMPOTENCY_TTL_MS,
  );

  try {
    const result = await fn();
    ctx.sql.exec(
      `UPDATE request_idempotency SET status = 'done', response_json = ? WHERE key = ?`,
      JSON.stringify(result),
      key,
    );
    return result;
  } catch (err) {
    // Clear the claim so a retry re-runs fn() (failures are not cached).
    ctx.sql.exec(`DELETE FROM request_idempotency WHERE key = ? AND status = 'pending'`, key);
    throw err;
  }
}
