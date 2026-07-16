import type { TenantContext } from "../tenant-context.js";
import { computeWarmupDay, epochDay, warmupDailyCap, warmupStatus } from "./warmup.js";

export interface MailboxWarmupRow {
  warmup_started_at: number;
  sent_today_epoch_day: number;
  cap_override: number | null;
}

export interface MailboxWarmupState {
  dailyCap: number;
  status: "warming" | "active";
  /** True when the virtual day has rolled over since `sent_today_epoch_day` — the caller resets `sent_today` in that case. */
  rolledOver: boolean;
}

/**
 * PURE — computes ONE mailbox's live warmup daily_cap/status/rollover from
 * the injected clock. No I/O (no `ctx`, no DB). Shared by
 * `refreshMailboxWarmupState` (persists this) and `computeMailboxWarmupSnapshot`
 * (reads it without persisting, for `infrastructure_status` — MCP
 * `readOnlyHint: true` must not write).
 *
 * The effective `dailyCap` is MIN(warmup ramp cap, cap_override): a
 * deliverability throttle (engine/deliverability-actions.ts sets cap_override)
 * survives this recompute instead of being wiped back up to the ramp cap.
 */
export function computeMailboxWarmupState(row: MailboxWarmupRow, nowMs: number): MailboxWarmupState {
  const today = epochDay(nowMs);
  const day = computeWarmupDay(row.warmup_started_at, nowMs);
  const rampCap = warmupDailyCap(day);
  const dailyCap = row.cap_override === null ? rampCap : Math.min(rampCap, row.cap_override);
  return {
    dailyCap,
    status: warmupStatus(day),
    rolledOver: row.sent_today_epoch_day !== today,
  };
}

/**
 * Recomputes every mailbox's live warmup day/cap/status from the injected
 * clock and persists it, resetting `sent_today` when the virtual day has
 * rolled over. Called before anything that reads or enforces mailbox
 * capacity on the write path (currently just the tick — see
 * `computeMailboxWarmupSnapshot` for the read-only counterpart). This
 * function only touches the warmup `status` column; the separate
 * `deliv_status` (healthy/throttled/paused) is owned by the loop and is
 * deliberately left untouched here.
 */
export function refreshMailboxWarmupState(ctx: TenantContext): void {
  const now = ctx.clock.now();
  const today = epochDay(now);

  const rows = ctx.sql
    .exec<{ id: string; warmup_started_at: number; sent_today_epoch_day: number; cap_override: number | null }>(
      `SELECT id, warmup_started_at, sent_today_epoch_day, cap_override FROM mailboxes WHERE tenant_id = ?`,
      ctx.tenantId,
    )
    .toArray();

  for (const row of rows) {
    const state = computeMailboxWarmupState(row, now);

    if (state.rolledOver) {
      ctx.sql.exec(
        `UPDATE mailboxes SET sent_today = 0, sent_today_epoch_day = ?, daily_cap = ?, status = ? WHERE id = ?`,
        today,
        state.dailyCap,
        state.status,
        row.id,
      );
    } else {
      ctx.sql.exec(`UPDATE mailboxes SET daily_cap = ?, status = ? WHERE id = ?`, state.dailyCap, state.status, row.id);
    }
  }
}

export interface MailboxWarmupSnapshot {
  dailyCap: number;
  status: "warming" | "active";
  sentToday: number;
}

/**
 * READ-ONLY counterpart to `refreshMailboxWarmupState`: computes each
 * mailbox's live warmup dailyCap/status/sentToday from the injected clock
 * WITHOUT persisting — `infrastructure_status` is MCP `readOnlyHint: true`
 * and must not write. Returns exactly what `refreshMailboxWarmupState` would
 * have persisted (including the day-rollover `sentToday` reset), keyed by
 * mailbox id; the tick still owns the actual write, on its own cadence.
 */
export function computeMailboxWarmupSnapshot(ctx: TenantContext): Map<string, MailboxWarmupSnapshot> {
  const now = ctx.clock.now();

  const rows = ctx.sql
    .exec<{ id: string; warmup_started_at: number; sent_today: number; sent_today_epoch_day: number; cap_override: number | null }>(
      `SELECT id, warmup_started_at, sent_today, sent_today_epoch_day, cap_override FROM mailboxes WHERE tenant_id = ?`,
      ctx.tenantId,
    )
    .toArray();

  const snapshot = new Map<string, MailboxWarmupSnapshot>();
  for (const row of rows) {
    const state = computeMailboxWarmupState(row, now);
    snapshot.set(row.id, { dailyCap: state.dailyCap, status: state.status, sentToday: state.rolledOver ? 0 : row.sent_today });
  }
  return snapshot;
}
