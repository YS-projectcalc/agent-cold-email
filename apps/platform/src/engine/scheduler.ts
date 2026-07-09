// Pure scheduling helpers used by the tick (src/engine/tick.ts). Send-window
// enforcement is UTC-hour only for B0 — full IANA timezone conversion is
// deferred (YAGNI for the thin skeleton; campaigns default to a 0-23 window
// so this never blocks the walking-skeleton test).

export interface SendWindow {
  startHour: number;
  endHour: number;
}

export function isWithinSendWindow(nowMs: number, window: SendWindow): boolean {
  const hour = new Date(nowMs).getUTCHours();
  if (window.startHour <= window.endHour) {
    return hour >= window.startHour && hour <= window.endHour;
  }
  // wraps past midnight
  return hour >= window.startHour || hour <= window.endHour;
}

export interface CapacityCandidate {
  id: string;
  sentToday: number;
  dailyCap: number;
}

/** Least-loaded mailbox with remaining capacity today, or null if none. */
export function pickMailboxWithCapacity<T extends CapacityCandidate>(candidates: T[]): T | null {
  const eligible = candidates.filter((m) => m.sentToday < m.dailyCap);
  if (eligible.length === 0) return null;
  return eligible.reduce((best, m) => (m.sentToday < best.sentToday ? m : best), eligible[0]!);
}
