import { RequestInProgressError } from "@coldstart/shared";
import type { TenantContext } from "../tenant-context.js";

// NB1 — request_idempotency rows are evicted at write time once older than this,
// so the table can't grow unbounded (one row per unique key would otherwise live
// forever, per-tenant DO). 30 days comfortably exceeds any realistic client/queue
// retry window. Measured on ctx.clock (the same clock that stamps created_at), so
// eviction and insertion stay on one time base.
const REQUEST_IDEMPOTENCY_TTL_MS = 30 * 24 * 60 * 60 * 1000;

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
 * Liveness note: a DO that dies mid-`fn` (after the claim is durable, before the
 * UPDATE/DELETE) leaves a 'pending' row that PERMANENTLY rejects retries of that
 * key — write-time eviction removes 'done' rows only, never an in-flight claim.
 * Not reachable in this build — the sandbox adapters do no real network I/O, so
 * `fn` cannot suspend across a crash. A stale-claim reclaim (TTL on 'pending') is
 * a required pre-activation item (ACTIVATION.md) before real vendor adapters.
 */
export async function withRequestIdempotency<T>(
  ctx: TenantContext,
  key: string | undefined,
  fn: () => T | Promise<T>,
): Promise<T> {
  if (!key) return fn();

  const existing = ctx.sql
    .exec<{ status: string; response_json: string | null }>(
      `SELECT status, response_json FROM request_idempotency WHERE key = ?`,
      key,
    )
    .toArray()[0];
  if (existing) {
    if (existing.status === "done" && existing.response_json !== null) {
      return JSON.parse(existing.response_json) as T;
    }
    // 'pending': another turn claimed this key and is still running fn(). Running
    // it again would double the side effect — reject with a retryable conflict.
    throw new RequestInProgressError();
  }

  // Claim BEFORE the first await (see the class doc): synchronous SELECT + INSERT
  // land in one input-gate turn, so the claim is durable before fn() can yield.
  const now = ctx.clock.now();
  ctx.sql.exec(
    `INSERT INTO request_idempotency (key, status, response_json, created_at) VALUES (?, 'pending', NULL, ?)`,
    key,
    now,
  );
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
