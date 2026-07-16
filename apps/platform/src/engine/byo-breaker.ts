// SPEC.md §20.2 — the primary-domain complaint-rate circuit breaker. §7's
// domain-burn thresholds (deliverability.ts) are a bare rate against an
// ALL-TIME domain aggregate, which is unimplementable at primary-domain
// volume: a single complaint on a low-volume day can read as 1%+, making a
// bare rate a one-click griefing vector (forward-and-complain a couple of
// times to sabotage someone else's real domain) as well as a false-pause
// hazard. This is a SEPARATE, stricter decision function over a TRAILING
// 7-DAY WINDOW (never all-time) that a primary domain's mailboxes route
// through instead of the generic burn thresholds (see deliverability.ts's
// `evaluate` — the isPrimary branch calls this instead of the bare-rate check).
//
// PURE — no I/O, no clock (the caller supplies already-windowed sends/
// complaints, exactly like deliverability.ts's `evaluate`).

export interface PrimaryBreakerInput {
  /** Trailing 7-day domain-aggregate send count (across every mailbox on the domain). */
  windowSends: number;
  /** Trailing 7-day domain-aggregate complaint count. */
  windowComplaints: number;
}

export type PrimaryBreakerVerdict =
  | { type: "hard_pause"; reason: string }
  | { type: "soft_response"; reason: string }
  | { type: "ok" };

// All three must hold together for a hard pause — see SPEC.md §20.2's
// arithmetic: the absolute floor is the binding constraint below ~3,000
// trailing-window sends (3 complaints alone already clears 0.10% below that
// volume); the rate leg becomes binding only above it.
const VOLUME_FLOOR = 100;
const ABSOLUTE_COMPLAINT_FLOOR = 3;
const RATE_FLOOR = 0.001; // 0.10% as a fraction (NOT 0.10 -- the 100x trap, see deliverability.ts's own warning)

export function evaluatePrimaryDomainBreaker(input: PrimaryBreakerInput): PrimaryBreakerVerdict {
  const { windowSends, windowComplaints } = input;
  const rate = windowSends > 0 ? windowComplaints / windowSends : 0;

  if (windowSends >= VOLUME_FLOOR && windowComplaints >= ABSOLUTE_COMPLAINT_FLOOR && rate >= RATE_FLOOR) {
    return {
      type: "hard_pause",
      reason:
        `primary-domain complaint breaker tripped: ${windowComplaints} complaint(s) / ${windowSends} send(s) ` +
        `(trailing 7d) = ${(rate * 100).toFixed(3)}% >= ${(RATE_FLOOR * 100).toFixed(2)}%, ` +
        `over the ${VOLUME_FLOOR}-send volume floor and ${ABSOLUTE_COMPLAINT_FLOOR}-complaint absolute floor`,
    };
  }

  // Below the volume floor a rate is statistical noise, not signal — but a
  // real complaint on a real business domain still deserves a look, just not
  // an automatic (and griefable) hard-pause.
  if (windowSends < VOLUME_FLOOR && windowComplaints >= 1) {
    return {
      type: "soft_response",
      reason:
        `${windowComplaints} complaint(s) on ${windowSends} trailing-7d send(s) — below the ${VOLUME_FLOOR}-send ` +
        `volume floor, so this is ambiguous rather than an automatic-pause signal: halving the daily cap + flagging for human review`,
    };
  }

  return { type: "ok" };
}
