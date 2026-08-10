import { beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { SWEEP_STALE_MS } from "../src/admin/watchtower-grading.js";
import { api } from "./helpers.js";

// D6 — the public status surface, and (audit BLOCKING-2) the platform's
// external-prober dead-man leg.
//
// This route used to be a bare `SELECT 1` returning {status:"ok"}, which is
// green with a perfectly dead cron. ACTIVATION.md names a 5-minute external
// prober as the designed backstop for alert loss — but pointed at the old
// route it would have watched a completely silent platform and reported it
// healthy forever, because "the Worker and D1 are up" says nothing about
// whether anything is still SWEEPING.

interface StatusBody {
  status: string;
  reason?: string;
  sweepAgeSeconds?: number | null;
}

async function setLastSweep(ts: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO watchtower_cursor (id, last_sweep_ts) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET last_sweep_ts = excluded.last_sweep_ts`,
  )
    .bind(ts)
    .run();
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM watchtower_cursor").run();
});

describe("GET /status — public health check (D6)", () => {
  it("returns ok with no auth and no tenant data when sweeps are landing", async () => {
    await setLastSweep(Date.now());
    const res = await api<StatusBody>("/status");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.sweepAgeSeconds).toBeLessThan(60);
    // Operational metadata only — never a tenant, a count, or a brand.
    expect(Object.keys(res.body as object).sort()).toEqual(["status", "sweepAgeSeconds"]);
  });

  it("reports DEGRADED when no sweep has completed for longer than the staleness threshold", async () => {
    const staleBy = SWEEP_STALE_MS + 5 * 60_000;
    await setLastSweep(Date.now() - staleBy);

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await api<StatusBody>("/status");
    errSpy.mockRestore();

    // A 503, not "ok with a warning field": the consumer is an uptime probe
    // that alerts on status codes.
    expect(res.status).toBe(503);
    expect(res.body.status).toBe("degraded");
    expect(res.body.reason).toBe("sweep_stale");
    expect(res.body.sweepAgeSeconds).toBeGreaterThanOrEqual(Math.floor(staleBy / 1000));
  });

  it("reports DEGRADED when no sweep has EVER completed — absence is not health", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await api<StatusBody>("/status");
    errSpy.mockRestore();

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: "degraded", reason: "sweep_stale", sweepAgeSeconds: null });
  });

  it("is still green right up to the threshold (no false alarm on normal cron drift)", async () => {
    await setLastSweep(Date.now() - (SWEEP_STALE_MS - 60_000));
    const res = await api<StatusBody>("/status");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });
});
