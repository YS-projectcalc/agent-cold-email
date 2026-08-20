import type { Clock } from "@coldstart/shared";

// ARCHITECTURE.md decision #4: nothing outside this file reads Date.now().
// RealClock is the only thing allowed to touch it.
//
// WHICH CLOCK A TENANT GETS (founder ruling 2026-08-05, wave-2 design
// DECISION 2). RealClock is the clock of every NON-SANDBOX tenant: a paying
// tenant's mail goes out on real wall time, so every ramp/window/TTL it is
// measured against must be real too. VirtualClock is sandbox/demo-only — its
// whole purpose is letting a 4-week warmup ramp resolve inside a demo run.
// Every tenant signs up as `demo` (routes/signup.ts), so a tenant that later
// pays crosses that boundary exactly once, via the one-shot migration in
// engine/clock-migration.ts. TenantDO owns the selection; nothing else may
// construct a clock for a tenant.

export class RealClock implements Clock {
  now(): number {
    return Date.now();
  }
}

/**
 * The clock every `TenantContext` carries: a stable object that resolves the
 * DO's CURRENT clock on every `now()` call, rather than closing over whichever
 * clock existed when the context was built (wave-2 design v2 §4, closing
 * adversary finding 6).
 *
 * WHY: `switchToRealClock()` fires inside `completeCheckoutSimulated` /
 * `handleStripeWebhook`, both async RPCs, and the DO input gate opens at every
 * await. A multi-minute saga (setup_infrastructure) that captured its context
 * BEFORE the flip would otherwise keep stamping virtual times into rows the
 * one-shot migration has already normalized — permanently, since the migration
 * cannot be re-run. Delegation kills that whole class: the very next
 * `ctx.clock.now()` of any in-flight saga reads real time.
 *
 * It also removes the need to invalidate TenantDO's cached sandbox adapter
 * bundle on the flip — those ports hold this delegate, not a frozen clock.
 *
 * Residual (bounded, enumerated in the design): a value captured into a local
 * BEFORE an await and written after it still carries the pre-flip time. When
 * touching an engine file, audit for a new `const now = ctx.clock.now()` whose
 * value is written after an await.
 */
export class DelegatingClock implements Clock {
  constructor(private readonly resolve: () => Clock) {}

  /** The clock this delegate currently resolves to — see `requireVirtualClock`. */
  target(): Clock {
    return this.resolve();
  }

  now(): number {
    return this.resolve().now();
  }
}

/**
 * Structural guard for the sandbox-only virtual-clock controls (`advanceClock`,
 * demo runs). `TenantContext.clock` is a plain `Clock` — a paid tenant's is a
 * RealClock, which has no `advanceVirtual` — so every caller of a
 * VirtualClock-only method narrows through here and gets a loud throw instead
 * of a `TypeError` (or, worse, a silent no-op) if the tenant is on real time.
 * Resolves through a DelegatingClock so a context-carried clock narrows the
 * same way the DO's own field does.
 */
export function requireVirtualClock(clock: Clock): VirtualClock {
  const target = clock instanceof DelegatingClock ? clock.target() : clock;
  if (!(target instanceof VirtualClock)) {
    throw new Error("virtual-clock control is unavailable: this tenant runs on the real clock (see clock.ts)");
  }
  return target;
}

/**
 * VirtualClock — a base plus a monotonic offset that moves ONLY when something
 * explicitly jumps it (`advanceVirtual`), never by sampling real wall time.
 * That is what makes a 4-week warmup ramp deterministic and instant in a demo
 * run or a test.
 *
 * NO RATE MULTIPLIER (C-M3, docs/adversarial/sweep-completeness-pass-2026-08-17.md
 * §4(iii)). This class used to carry a `multiplier` and an `advance(realMs)`
 * that scaled by it, and `tenant-do.ts` stored 1440 for demo/free tenants — but
 * `advance()` had ZERO call sites anywhere in `apps/` or `packages/`, every real
 * advance went through `advanceVirtual`, and `now()` never consulted the
 * multiplier at all. A demo tenant's clock was FROZEN, not running at 1440x.
 * Dead config that read as a live rate is worse than no config: TWO independent
 * class sweeps built findings on the 1440x rate as if it were implemented (a
 * "30-day TTL expires in 30 real minutes" exposure that does not exist), and a
 * wave scoped to "remove the multiplier" would have fixed nothing. Deleted
 * rather than applied, per CLAUDE.md rule (a) — git remembers.
 *
 * `offsetMs` is persisted by the caller (TenantDO SQLite) so the clock
 * survives DO eviction/hibernation.
 */
export class VirtualClock implements Clock {
  constructor(
    private readonly baseMs: number,
    private offsetMs: number,
  ) {}

  now(): number {
    return this.baseMs + this.offsetMs;
  }

  /**
   * Jump the virtual clock forward by an already-virtual duration. This is the
   * test/sandbox-control primitive — it's what "advance virtual clock" in the
   * walking-skeleton test calls, letting a 4-week warmup ramp resolve without
   * any real wall-clock wait.
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
