// Shared suppression primitives (CLAUDE.md rule c — ONE implementation of
// "permanently suppress an address"). `suppress`/`cancelPendingSteps` were
// previously private to reply-processor.ts (bounce/complaint); extracted here
// so the B4 hosted RFC 8058 endpoint and the inbound typed-unsubscribe reply
// matcher can reuse the EXACT same write path instead of a second one.
import type { SuppressionReason, SuppressLeadInput } from "@coldstart/shared";
import { newId } from "../schema.js";
import type { TenantContext } from "../tenant-context.js";

/** Writes/updates the permanent (tenant, email) suppression row. Idempotent
 * (ON CONFLICT DO UPDATE) — suppressing an already-suppressed address, for
 * the same or a different reason, is never an error; it just records the
 * latest reason/timestamp. */
export function suppress(ctx: TenantContext, email: string, reason: SuppressionReason, ts: number): void {
  ctx.sql.exec(
    `INSERT INTO suppressions (tenant_id, email, reason, ts) VALUES (?, ?, ?, ?)
     ON CONFLICT (tenant_id, email) DO UPDATE SET reason = excluded.reason, ts = excluded.ts`,
    ctx.tenantId,
    email,
    reason,
    ts,
  );
}

/** Cancels every still-pending future step for ONE lead — the stop-on-reply /
 * bounce-suppression / unsubscribe guard. */
export function cancelPendingSteps(ctx: TenantContext, leadId: string): void {
  ctx.sql.exec(
    `UPDATE scheduled_sends SET status = 'skipped' WHERE lead_id = ? AND tenant_id = ? AND status = 'pending'`,
    leadId,
    ctx.tenantId,
  );
}

export interface UnsubscribeResult {
  suppressed: true;
  alreadySuppressed: boolean;
}

/**
 * The GLOBAL (tenant, email) opt-out — shared by BOTH the hosted RFC 8058
 * endpoint (routes/unsubscribe.ts via TenantDO.unsubscribeByEmail; no thread
 * in hand, only an email) and the inbound typed-unsubscribe reply matcher
 * (engine/reply-processor.ts, which DOES have a thread/lead but still
 * dispatches here so both paths converge on one opt-out implementation).
 *
 * Suppresses tenant-wide on the `suppressions` PK (matches the existing
 * bounce/complaint behavior), then walks EVERY lead row sharing this email —
 * across every campaign, since `leads.email` has no cross-campaign
 * uniqueness (the same address can be a separate lead row per launched
 * campaign) — cancelling its pending sends, setting its status to
 * 'suppressed' (mirroring processComplaint's terminal status), and recording
 * one 'unsubscribe' event per lead on its own thread (the `events` schema
 * requires a NOT NULL campaign_id/lead_id/thread_id, so a single tenant-wide
 * event isn't representable — a real thread must exist per lead already,
 * since campaign launch eagerly creates every step's scheduled_sends row).
 *
 * Idempotent by construction, NOT by a dedupe index: the per-lead
 * cancel+event work only runs the FIRST time an address is suppressed
 * (`alreadySuppressed` gates it) — the `events` dedupe index treats every
 * NULL message_id row as distinct (tenant-do.ts), so re-running this loop on
 * a repeat unsubscribe click would otherwise insert a fresh 'unsubscribe'
 * event on every call. `suppress()` itself still runs unconditionally so a
 * later manual/explicit unsubscribe can update the recorded reason.
 *
 * `reason` defaults to `"unsubscribe"` — the original hardcoded value both
 * pre-existing callers (the hosted RFC 8058 endpoint via
 * TenantDO.unsubscribeByEmail, and the inbound typed-unsubscribe reply
 * matcher, engine/reply-processor.ts's processReply) rely on unchanged.
 * SPEC.md §22's `suppress_lead` tool is the only caller that passes
 * `"manual"` — the parametrization the design calls for
 * (`suppression.ts:71`'s hardcoded reason).
 */
export function unsubscribeEmail(
  ctx: TenantContext,
  email: string,
  ts: number,
  reason: SuppressionReason = "unsubscribe",
): UnsubscribeResult {
  const alreadySuppressed = ctx.sql
    .exec<{ email: string }>(`SELECT email FROM suppressions WHERE tenant_id = ? AND email = ?`, ctx.tenantId, email)
    .toArray().length > 0;

  suppress(ctx, email, reason, ts);
  if (alreadySuppressed) return { suppressed: true, alreadySuppressed: true };

  const leads = ctx.sql
    .exec<{ id: string }>(`SELECT id FROM leads WHERE tenant_id = ? AND email = ?`, ctx.tenantId, email)
    .toArray();

  for (const lead of leads) {
    ctx.sql.exec(`UPDATE leads SET global_status = 'suppressed' WHERE id = ? AND tenant_id = ?`, lead.id, ctx.tenantId);
    cancelPendingSteps(ctx, lead.id);

    // A lead with no scheduled_sends row yet (launched-but-not-yet-ticked is
    // impossible today — launch eagerly inserts every step — but a lead
    // somehow created outside that path would have none) has no thread to
    // attach an event to; the suppression + cancellation above still apply.
    const ref = ctx.sql
      .exec<{ campaign_id: string; thread_id: string }>(
        `SELECT campaign_id, thread_id FROM scheduled_sends WHERE lead_id = ? AND tenant_id = ? LIMIT 1`,
        lead.id,
        ctx.tenantId,
      )
      .toArray()[0];
    if (!ref) continue;

    ctx.sql.exec(
      `INSERT INTO events (id, tenant_id, campaign_id, lead_id, type, step, message_id, thread_id, ts, metadata_json)
       VALUES (?, ?, ?, ?, 'unsubscribe', 0, NULL, ?, ?, ?)`,
      newId("evt"),
      ctx.tenantId,
      ref.campaign_id,
      lead.id,
      ref.thread_id,
      ts,
      JSON.stringify({ email }),
    );
  }

  return { suppressed: true, alreadySuppressed: false };
}

/**
 * SPEC.md §22 — `suppress_lead` MCP tool / REST route: the free-text "stop
 * emailing me" path the strict typed-unsubscribe matcher misses. Thin wrapper
 * over `unsubscribeEmail` with `reason` pinned to `"manual"` (the only value
 * an external caller can honestly claim — `bounce`/`complaint`/`unsubscribe`
 * are exclusively system-derived elsewhere; see `SuppressLeadInput`'s zod
 * schema, which accepts no other literal). `input.note` is accepted for
 * schema symmetry with the ratified design's `{email, reason?='manual',
 * note?}` shape but NOT persisted — `suppressions` carries no note column and
 * SPEC.md §22's data-model deltas name none; mirrors `ConfigureWebhookInput`'s
 * `note` field (mcp/schemas.ts), already accepted-but-ignored for the same
 * reason. Last-write-wins on `reason` (adversary amendment, `docs/
 * adversarial/warm-lead-thin-layer-design-2026-07-16.md` R2): re-suppressing
 * a `complaint`/`unsubscribe` row via this tool overwrites its reason to
 * `'manual'`, matching `unsubscribeEmail`'s pre-existing unconditional
 * `suppress()` call — inert today (every consumer is reason-blind) and there
 * is deliberately NO un-suppress tool in this design.
 */
export function suppressLead(ctx: TenantContext, input: SuppressLeadInput, ts: number): UnsubscribeResult {
  return unsubscribeEmail(ctx, input.email, ts, input.reason);
}
