import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env.js";

/**
 * RateLimiterDO — an ATOMIC per-key counter for unauthenticated endpoints
 * (adversarial panel-02: /signup had zero rate limit, the root DoS enabler).
 *
 * A Durable Object is single-threaded per id, and the input gate stays closed
 * across the storage awaits inside `hit()`, so the read-modify-write is
 * serialized — no lost-update race like the waitlist KV limiter. One instance
 * per IP (idFromName(ip)); a shared "__global__" instance backs a global daily
 * ceiling. Fixed minute/day buckets; a bucket rollover resets its counter.
 */
interface RateWindowState {
  minuteBucket: number;
  minuteCount: number;
  dayBucket: number;
  dayCount: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  scope: "minute" | "day" | null;
}

export class RateLimiterDO extends DurableObject<Env> {
  /**
   * Watchtower DO-storage probe (src/admin/watchtower.ts). A trivial durable-
   * storage read against a dedicated canary instance — proves the Durable
   * Object subsystem + its storage are reachable, touching NO tenant data
   * (RateLimiterDO holds only per-key rate counters). Returns true if the read
   * completes; the probe caller treats a throw as an unhealthy DO subsystem.
   */
  async ping(): Promise<boolean> {
    await this.ctx.storage.get("state");
    return true;
  }

  async hit(perMinuteCap: number, perDayCap: number): Promise<RateLimitDecision> {
    const now = Date.now();
    const minuteBucket = Math.floor(now / 60_000);
    const dayBucket = Math.floor(now / 86_400_000);

    const stored = await this.ctx.storage.get<RateWindowState>("state");
    const state: RateWindowState = stored ?? { minuteBucket, minuteCount: 0, dayBucket, dayCount: 0 };

    if (state.minuteBucket !== minuteBucket) {
      state.minuteBucket = minuteBucket;
      state.minuteCount = 0;
    }
    if (state.dayBucket !== dayBucket) {
      state.dayBucket = dayBucket;
      state.dayCount = 0;
    }

    if (state.dayCount >= perDayCap) return { allowed: false, scope: "day" };
    if (state.minuteCount >= perMinuteCap) return { allowed: false, scope: "minute" };

    state.minuteCount += 1;
    state.dayCount += 1;
    await this.ctx.storage.put("state", state);
    return { allowed: true, scope: null };
  }
}
