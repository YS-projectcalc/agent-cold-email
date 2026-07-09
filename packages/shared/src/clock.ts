// ARCHITECTURE.md decision #4: a single injected Clock. Nothing outside a
// Clock implementation may read Date.now() directly. This file defines only
// the interface — concrete RealClock / VirtualClock implementations live in
// apps/platform/src/clock.ts (kept out of `shared` since they're runtime
// concerns, not a contract other packages need).

export interface Clock {
  /** Current time in epoch milliseconds, per this clock's frame of reference. */
  now(): number;
}
