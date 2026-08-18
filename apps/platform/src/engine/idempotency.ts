import { RequestInProgressError, type Settled } from "@coldstart/shared";
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

/** Per-call-site options — see `recordedIsNonTerminal`. */
export interface RequestIdempotencyOptions<T> {
  /**
   * MIGRATION AFFORDANCE, and nothing more. Classifies an ALREADY-RECORDED
   * response as one that should never have been recorded.
   *
   * Rows written under the `Settled` contract below cannot be wrong: a
   * non-terminal outcome no longer writes a row at all, so `status='done'` now
   * MEANS terminal by construction. But rows written BEFORE this contract are
   * `done` regardless, and the population that needs the fix most is the one
   * already wedged in production — so the replay path asks this predicate about
   * the stored payload.
   *
   * SYNCHRONOUS by contract (it runs inside the claim-then-execute prefix,
   * before any await) and TOTAL (it is handed a `JSON.parse` of a row that may
   * predate the current result shape). Deletable once every pre-contract row
   * has aged out of REQUEST_IDEMPOTENCY_TTL_MS.
   */
  recordedIsNonTerminal?: (recorded: T) => boolean;
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
 * TERMINALITY IS ASSERTED, NOT INFERRED (docs/adversarial/
 * class-sweep-cached-terminal-2026-08-17.md; audit F1 is its member 1). THE
 * INVARIANT: a recorded outcome may be replayed for the row's life only if it
 * is TERMINAL. Control flow cannot decide that — "fn() returned" is not "the
 * work finished", and `runSetupInfrastructure` has THREE returns that owe work
 * (a `quoteOnly` preview that provisions nothing, a capacity-pending
 * back-pressure return, and the 202 SUCCESS-PENDING branch). Recording those as
 * ordinary replayable results made the platform's own retry instruction
 * ("retry with the same idempotency key to finish it") a guaranteed no-op:
 * every later same-key call replayed a stale response with zero vendor calls
 * and an empty messages[] — the exact eternal-"pending" shape
 * engine/domain-dns.ts's class fix closed INSIDE the saga and left open in
 * front of it.
 *
 * So `fn` returns `Settled<T>` and every call site must WRITE the word. A
 * `terminal: false` outcome is handed to THIS caller unchanged — the customer
 * still gets its 202 — and its claim is RELEASED, exactly as a throw releases
 * one: a result that owes work is no more cacheable than an error. Nothing
 * about the in-flight window changes, so two concurrent same-key calls still
 * resolve to one run; what changes is only that a SEQUENTIAL retry re-runs
 * instead of replaying, which is what makes the retry instruction true. That
 * re-run is safe by construction at the one site that can be non-terminal:
 * setup_infrastructure's purchases are gated by the ordinal-derived domain
 * intents, never by this key (tenant-do.ts).
 */
export async function withRequestIdempotency<T>(
  ctx: TenantContext,
  key: string | undefined,
  fn: () => Settled<T> | Promise<Settled<T>>,
  opts?: RequestIdempotencyOptions<T>,
): Promise<T> {
  if (!key) return (await fn()).value;

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
      // Under the Settled contract a 'done' row is terminal by construction, so
      // this replays. The predicate is asked only about rows written BEFORE
      // that contract existed — see RequestIdempotencyOptions.
      if (!(opts?.recordedIsNonTerminal?.(recorded) ?? false)) return recorded;
      // A pre-contract row recording work that was never finished. Re-claim IN
      // PLACE, synchronously, before any await below — the same "one input-gate
      // turn" guarantee the fresh-claim INSERT and the stale-claim reclaim rely
      // on. A concurrent same-key call can only observe this row AFTER the flip
      // lands (its own SELECT cannot run until this synchronous prefix yields
      // at fn()'s first await), so it reads 'pending' with a freshly-set
      // created_at and takes the conflict branch below — exactly one caller
      // ever proceeds to run fn(). The stale response is cleared with it: a
      // 'pending' row's body is never read, and either exit below removes the
      // row rather than resurrecting a response the retry has just disproved.
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
      //
      // Deliberately NOT guarded on `status='pending'` (cached-terminal member
      // 10's residual): this branch is reached only when the row is not a
      // replayable 'done', which includes the `done`+NULL row the schema's old
      // DEFAULT could mint. The old guard matched nothing for such a row, so
      // `created_at` was never re-stamped and every retry took the conflict
      // branch above for a full claim TTL — a spurious 409 with no serialized
      // winner. Re-stamping AND normalising the status repairs it in the same
      // one turn, without a separate repair pass.
      ctx.sql.exec(`UPDATE request_idempotency SET status = 'pending', created_at = ? WHERE key = ?`, now, key);
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
    const settled = await fn();
    if (!settled.terminal) {
      // Owes work: release the claim exactly as a throw does. THIS caller keeps
      // its value; no later caller inherits it as an answer. Recording it is
      // what froze a preview / a back-pressure return / a 202 as the permanent
      // reply to a key the agent was told to reuse.
      ctx.sql.exec(`DELETE FROM request_idempotency WHERE key = ? AND status = 'pending'`, key);
      return settled.value;
    }
    ctx.sql.exec(
      `UPDATE request_idempotency SET status = 'done', response_json = ? WHERE key = ?`,
      JSON.stringify(settled.value),
      key,
    );
    return settled.value;
  } catch (err) {
    // Clear the claim so a retry re-runs fn() (failures are not cached).
    ctx.sql.exec(`DELETE FROM request_idempotency WHERE key = ? AND status = 'pending'`, key);
    throw err;
  }
}
