import type { Clock } from "@coldstart/shared";

// ARCHITECTURE.md decision #4: nothing outside this file reads Date.now().
// RealClock is the only thing allowed to touch it.

export class RealClock implements Clock {
  now(): number {
    return Date.now();
  }
}

/**
 * VirtualClock — base + (elapsed x multiplier), per ARCHITECTURE.md #4.
 * "Elapsed" is a monotonic offset advanced explicitly via `advance()`
 * (called by the engine tick / by tests), NOT by sampling real wall-clock
 * deltas. That makes a 4-week warmup ramp deterministic and instant in
 * tests, and keeps a DO-alarm-driven tick (B2) free to advance the clock by
 * exactly the real interval between alarms x multiplier when that lands.
 *
 * `offsetMs` is persisted by the caller (TenantDO SQLite) so the clock
 * survives DO eviction/hibernation.
 */
export class VirtualClock implements Clock {
  constructor(
    private readonly baseMs: number,
    private offsetMs: number,
    private readonly multiplier: number,
  ) {}

  now(): number {
    return this.baseMs + this.offsetMs;
  }

  /** Advance by a real-world duration, scaled by the multiplier. Returns the new offset. */
  advance(realMs: number): number {
    if (realMs < 0) throw new RangeError("advance() requires a non-negative duration");
    this.offsetMs += realMs * this.multiplier;
    return this.offsetMs;
  }

  /**
   * Jump the virtual clock forward by an already-virtual duration (bypasses
   * the multiplier). This is the test/sandbox-control primitive — it's what
   * "advance virtual clock" in the walking-skeleton test calls, letting a
   * 4-week warmup ramp resolve without any real wall-clock wait. A future
   * DO-alarm-driven tick (B2) would instead call `advance(realIntervalMs)`.
   */
  advanceVirtual(virtualMs: number): number {
    if (virtualMs < 0) throw new RangeError("advanceVirtual() requires a non-negative duration");
    this.offsetMs += virtualMs;
    return this.offsetMs;
  }

  get offset(): number {
    return this.offsetMs;
  }
}
