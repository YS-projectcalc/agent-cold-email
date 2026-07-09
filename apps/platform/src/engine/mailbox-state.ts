import type { TenantContext } from "../tenant-context.js";
import { computeWarmupDay, epochDay, warmupDailyCap, warmupStatus } from "./warmup.js";

/**
 * Recomputes every mailbox's live warmup day/cap/status from the injected
 * clock and persists it, resetting `sent_today` when the virtual day has
 * rolled over. Called before anything that reads or enforces mailbox
 * capacity (tick, infrastructure_status) so callers can trust the columns.
 */
export function refreshMailboxWarmupState(ctx: TenantContext): void {
  const now = ctx.clock.now();
  const today = epochDay(now);

  const rows = ctx.sql
    .exec<{ id: string; warmup_started_at: number; sent_today_epoch_day: number }>(
      `SELECT id, warmup_started_at, sent_today_epoch_day FROM mailboxes WHERE tenant_id = ?`,
      ctx.tenantId,
    )
    .toArray();

  for (const row of rows) {
    const day = computeWarmupDay(row.warmup_started_at, now);
    const cap = warmupDailyCap(day);
    const status = warmupStatus(day);

    if (row.sent_today_epoch_day !== today) {
      ctx.sql.exec(
        `UPDATE mailboxes SET sent_today = 0, sent_today_epoch_day = ?, daily_cap = ?, status = ? WHERE id = ?`,
        today,
        cap,
        status,
        row.id,
      );
    } else {
      ctx.sql.exec(`UPDATE mailboxes SET daily_cap = ?, status = ? WHERE id = ?`, cap, status, row.id);
    }
  }
}
