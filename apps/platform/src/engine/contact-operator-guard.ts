// msgchannel Inc5 storm guard — the ADMISSION DECISION behind contact_operator
// (engine/contact-operator.ts), split out because it has exactly one job and
// one invariant that has to stay auditable at a glance:
//
//   THIS FILE CONTAINS NO `await`, AND MUST NOT GROW ONE.
//
// A Durable Object serializes concurrent calls only while the input gate stays
// closed, and the gate opens at every await (clock.ts:33). DO SQLite
// (`ctx.sql`) is synchronous, so a decide-and-write block over it is atomic —
// the property rate-limiter-do.ts:8-11 documents ("no lost-update race like
// the waitlist KV limiter") and the property TenantDO.enforceDemoRunThrottle
// (tenant-do.ts) and increment 1's tenant_messages dedup both rely on. D1
// (`env.DB`) is an external binding: `await env.DB...` reopens the gate.
//
// The first cut of contact_operator made all three of these decisions against
// D1 — read the window, decide, then insert several awaits later. Under 100
// concurrent calls from one tenant every caller read the window BEFORE any of
// them wrote, so 96 tickets and 96 ops emails went out against a cap of 5 and
// a ~1-per-10-minutes email throttle: the exact cry-wolf incident the guard
// exists to prevent, reproduced by the guard itself (gate
// docs/adversarial/msgchannel-inc5-gate-2026-08-11.md finding #1). Moving the
// state into the DO's own storage is the house fix for that class; the D1
// support_tickets row is still written, but it is the operator-visible RECORD
// now, never the thing a decision reads.

import type { ContactOperatorInput } from "@coldstart/shared";
import { newId } from "../schema.js";
import type { TenantContext } from "../tenant-context.js";

// Every window below is REAL wall-clock (the caller passes RealClock's now) —
// a demo/free tenant's VirtualClock runs up to 1440x accelerated, so gating on
// ctx.clock would let it blow through all of these in real seconds.
export const RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour
export const MAX_CALLS_PER_WINDOW = 5;
// Dedup shares the rate window on purpose — one read answers both.
const DEDUP_WINDOW_MS = RATE_WINDOW_MS;
export const EMAIL_THROTTLE_MS = 10 * 60 * 1000; // 10 minutes
// How long a decided call stays on the log. Well past the rate window so the
// throttle clock survives an idle stretch, and it bounds DO storage: at 5
// admissions/hour the table cannot exceed ~120 rows.
const LOG_RETENTION_MS = 24 * 60 * 60 * 1000;
// Ceiling on how many held bodies one email carries. Unreachable in practice
// (the cap admits 5/hour and any send drains everything held), but an ops
// email must have a bounded size no matter what the log looks like.
const MAX_HELD_BODIES_PER_EMAIL = 10;

export interface HeldMessage {
  id: string;
  body: string;
  urgency: ContactOperatorInput["urgency"];
  createdAt: number;
}

export type ContactAdmission =
  /** Identical (body, urgency) already filed inside the window — a safe replay. */
  | { kind: "duplicate"; ticketId: string }
  | { kind: "rate_limited"; retryAfter: number }
  | {
      kind: "admitted";
      ticketId: string;
      /** True when this call also CLAIMED the tenant's ops-email slot. */
      emailNow: boolean;
      /** Earlier held messages whose bodies this email must carry (claimed with it). */
      held: HeldMessage[];
      /** Held messages beyond MAX_HELD_BODIES_PER_EMAIL, left for the next send. */
      heldOverflow: number;
    };

// A type alias, not an interface: SqlStorage's row generic wants an implicit
// index signature, which only object-literal types get.
type LogRow = {
  id: string;
  body: string;
  urgency: ContactOperatorInput["urgency"];
  created_at: number;
};

/**
 * Decides dedup / rate cap / email-slot in ONE synchronous, uninterruptible
 * step and records the outcome. Concurrent callers queue behind each other in
 * the DO, so the Nth caller of a burst sees the first N-1 rows.
 *
 * The email slot is CLAIMED here (emailed_at stamped before the send) rather
 * than stamped on success — claiming is what makes "exactly one email" hold
 * under a burst. `releaseEmailClaim` puts it back if the send then fails.
 */
export function admitContactOperatorCall(ctx: TenantContext, input: ContactOperatorInput, now: number): ContactAdmission {
  const { sql, tenantId } = ctx;

  // Prune on the created_at AND emailed_at cutoffs together: a row held for
  // hours and only emailed recently is still the tenant's most recent send,
  // and dropping it would reset the throttle clock.
  const retentionCutoff = now - LOG_RETENTION_MS;
  sql.exec(
    `DELETE FROM agent_contact_log WHERE tenant_id = ? AND created_at < ? AND (emailed_at IS NULL OR emailed_at < ?)`,
    tenantId,
    retentionCutoff,
    retentionCutoff,
  );

  const windowRows = sql
    .exec<LogRow>(
      `SELECT id, body, urgency, created_at FROM agent_contact_log
       WHERE tenant_id = ? AND created_at > ? ORDER BY created_at DESC`,
      tenantId,
      now - DEDUP_WINDOW_MS,
    )
    .toArray();

  // Dedup FIRST, ahead of the rate limit — an identical resend is a safe
  // replay (this codebase's idempotency-key convention: "the first call runs,
  // a replay returns the recorded result without re-executing"), so it must
  // succeed even for a tenant that is currently rate-limited, and must never
  // burn a second email. Keyed on (body, urgency), not body alone: re-sending
  // the same text at raised urgency is an ESCALATION — the natural gesture of
  // a stuck agent — and swallowing it as a replay silently drops the one
  // signal that says a human is now needed (gate finding #6).
  const dupe = windowRows.find((r) => r.body === input.body && r.urgency === input.urgency);
  if (dupe) return { kind: "duplicate", ticketId: dupe.id };

  if (windowRows.length >= MAX_CALLS_PER_WINDOW) {
    // Ordered DESC, so the last row is the oldest in the window and sets when
    // the window next has room.
    const oldest = windowRows[windowRows.length - 1]!;
    return { kind: "rate_limited", retryAfter: Math.ceil((oldest.created_at + RATE_WINDOW_MS - now) / 1000) };
  }

  // `needs_human` bypasses the throttle — that is what the flag is FOR. The
  // 5/hour cap above still gates it (every email requires an admission), so
  // the bypass cannot exceed 5 emails/hour even under a deliberate burst.
  const lastEmailAt =
    sql.exec<{ last: number | null }>(`SELECT MAX(emailed_at) as last FROM agent_contact_log WHERE tenant_id = ?`, tenantId).one().last;
  const emailNow =
    Boolean(ctx.env.OPS_ALERT_EMAIL) &&
    (input.urgency === "needs_human" || lastEmailAt === null || now - lastEmailAt >= EMAIL_THROTTLE_MS);

  // Everything the throttle has held since the last real send, oldest first —
  // their BODIES ride along on this email. A count alone leaves the actual
  // message reachable only by pulling the digest, so a suppressed "sending is
  // down for all mailboxes" would never be pushed to anyone (gate finding #2).
  const heldRows = emailNow
    ? sql
        .exec<LogRow>(
          `SELECT id, body, urgency, created_at FROM agent_contact_log
           WHERE tenant_id = ? AND emailed_at IS NULL ORDER BY created_at ASC`,
          tenantId,
        )
        .toArray()
    : [];
  const held: HeldMessage[] = heldRows
    .slice(0, MAX_HELD_BODIES_PER_EMAIL)
    .map((r) => ({ id: r.id, body: r.body, urgency: r.urgency, createdAt: r.created_at }));

  const ticketId = newId("sup");
  sql.exec(
    `INSERT INTO agent_contact_log (id, tenant_id, body, urgency, created_at, emailed_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ticketId,
    tenantId,
    input.body,
    input.urgency,
    now,
    emailNow ? now : null,
  );
  if (held.length > 0) stampEmailed(ctx, held.map((h) => h.id), now);

  return { kind: "admitted", ticketId, emailNow, held, heldOverflow: heldRows.length - held.length };
}

/**
 * Undoes an admission whose D1 support_tickets record could not be written,
 * so the tenant's state reverts to "this call never happened".
 *
 * The admission is committed here BEFORE the record it authorizes exists —
 * that ordering is what makes the cap atomic, and it cannot be reversed. So
 * the seam needs a compensation: without one, a partial D1 degradation (reads
 * healthy, the ticket write failing) left a committed log row with no ticket,
 * and since dedup reads this table the retry was answered from that phantom —
 * a 201 carrying "their reply will arrive" for a message no operator would
 * ever see, sticky for the full dedup hour (gate
 * docs/adversarial/msgchannel-inc5-gate-2026-08-11.md ROUND 2, N-1).
 *
 * Synchronous, like everything else here: it must not introduce an await
 * between the admission and its undo.
 *
 * KNOWN RESIDUAL, deliberately not closed here. Compensation is after-the-
 * fact, so a CONCURRENT identical (body, urgency) call that dedups against
 * this row in the window before it is revoked still receives its id. Closing
 * that needs a two-phase confirmed flag (dedup ignores unconfirmed rows and
 * asks the caller to retry), which costs an extra DO write on every
 * successful call and a new tenant-visible error — a design change, not a
 * patch. The sequential retry path the gate blocked on IS closed: it now
 * fails loudly instead of returning a phantom.
 */
export function revokeAdmission(ctx: TenantContext, ticketId: string, heldIds: string[]): void {
  ctx.sql.exec(`DELETE FROM agent_contact_log WHERE tenant_id = ? AND id = ?`, ctx.tenantId, ticketId);
  // Deleting the row above frees this call's own rate slot and, if it had
  // claimed the email slot, the throttle clock with it. The messages it was
  // going to carry have to go back on the held list separately.
  releaseEmailClaim(ctx, heldIds);
}

/**
 * Returns claimed rows to "held" after a send actually failed, so their bodies
 * roll into the next successful email instead of being silently marked
 * delivered — the durable-record posture registrar-alert.ts/support-inbound.ts
 * already take for their own best-effort sends.
 */
export function releaseEmailClaim(ctx: TenantContext, ids: string[]): void {
  if (ids.length === 0) return;
  ctx.sql.exec(
    `UPDATE agent_contact_log SET emailed_at = NULL WHERE tenant_id = ? AND id IN (${ids.map(() => "?").join(", ")})`,
    ctx.tenantId,
    ...ids,
  );
}

function stampEmailed(ctx: TenantContext, ids: string[], at: number): void {
  ctx.sql.exec(
    `UPDATE agent_contact_log SET emailed_at = ? WHERE tenant_id = ? AND id IN (${ids.map(() => "?").join(", ")})`,
    at,
    ctx.tenantId,
    ...ids,
  );
}
