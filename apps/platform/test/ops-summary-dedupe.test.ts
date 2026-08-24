import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../src/env.js";
import { insertTenantIndex } from "../src/db.js";
import { newId } from "../src/schema.js";
import { mintTenant, tenantStub, withTenantContext } from "./helpers.js";
import { buildOpsDigest, DIGEST_WINDOW_HOURS, runOpsSummaryPrefetch } from "../src/admin/ops-sweep.js";
import { newSweepFanout, sweptSummary, type SweepScope } from "../src/admin/tenant-slice.js";
import { FAILURE_SIGNAL_WINDOW_MS } from "../src/admin/watchtower-grading.js";
import { runScheduledOpsSweep } from "../src/scheduled.js";
import { SandboxOpsMailer } from "../src/ops-mail/sandbox-ops-mailer.js";
import { LEG_SUBREQUEST_COSTS, SWEEP_RPCS_PER_TENANT } from "../src/admin/sweep-budget.js";

// THE opsSummary DEDUPE (lane feat/sweep-capacity-2026-08-24).
//
// Dunning, the digest and the watchtower each made their own `opsSummary` RPC:
// three round trips to the same Durable Object, in the same tick, for the same
// tenant. One shared prefetch replaces them, and the slice is derived from the
// result — so the saving has to be real in the WORST case, not the typical one.
//
// THE HAZARD THE MEASUREMENT FLAGGED (findings doc §8 R1). The three callers
// pass three DIFFERENT windows: dunning a zero-width one it never reads, the
// digest 24h, the watchtower 1h. The windowed fields are AGGREGATED at the DO —
// `actionsInWindow` and `failureSignalsInWindow` are counts, not rows — so no
// caller can re-window what it is handed. A memo keyed on tenant id would give
// two of the three a span they did not ask for, silently, and in the
// reassuring direction both ways: a 24h failure count graded against a 1h
// threshold reads as an incident, a 1h deliverability count reported as a day's
// worth reads as calm.

const HOUR = 60 * 60 * 1000;

describe("the shared summary carries BOTH windows, computed at the DO", () => {
  it("windows the two field groups independently in one call", async () => {
    const { tenantId } = await mintTenant("Dedupe Windows", "managed");
    const now = Date.now();

    // Two failure events: one inside the watchtower's 1h window, one only
    // inside the digest's 24h window. A single-window summary cannot tell the
    // two consumers apart; this one has to.
    const insertFailure = (ctx: { sql: { exec: (q: string, ...a: unknown[]) => unknown } }, tsMs: number) =>
      ctx.sql.exec(
        `INSERT INTO events (id, tenant_id, campaign_id, lead_id, type, thread_id, ts) VALUES (?, ?, 'cmp_x', 'lead_x', 'failed', 'thr_x', ?)`,
        newId("evt"),
        tenantId,
        tsMs,
      );
    await withTenantContext(tenantId, (ctx) => {
      insertFailure(ctx, now - 10 * 60 * 1000); // 10 minutes ago — inside both windows
      insertFailure(ctx, now - 5 * HOUR); // 5 hours ago — inside 24h, OUTSIDE 1h
    });

    const shared = await tenantStub(tenantId).opsSummaryForSweep({
      actionsSinceMs: now - DIGEST_WINDOW_HOURS * HOUR,
      failureSignalsSinceMs: now - FAILURE_SIGNAL_WINDOW_MS,
    });

    // The watchtower's field sees only the recent one...
    expect(shared.failureSignalsInWindow.failed).toBe(1);
    // ...and the object says which spans it was computed with, so a consumer
    // can assert rather than trust the plumbing.
    expect(shared.windows.failureSignalsSinceMs).toBe(now - FAILURE_SIGNAL_WINDOW_MS);
    expect(shared.windows.actionsSinceMs).toBe(now - DIGEST_WINDOW_HOURS * HOUR);

    // POSITIVE CONTROL: the 5-hour-old event is real and a 24h window finds it.
    // Without this, `failed === 1` above would also pass if the insert silently
    // failed or the events table were empty.
    const wide = await tenantStub(tenantId).opsSummaryForSweep({
      actionsSinceMs: now - DIGEST_WINDOW_HOURS * HOUR,
      failureSignalsSinceMs: now - DIGEST_WINDOW_HOURS * HOUR,
    });
    expect(wide.failureSignalsInWindow.failed).toBe(2);
  });
});

describe("a mis-windowed shared summary is REFUSED, not consumed", () => {
  it("sweptSummary throws when the map's window is not the one the caller needs", async () => {
    const { tenantId } = await mintTenant("Dedupe Mismatch", "managed");
    const now = Date.now();
    // The exact defect a naive memo produces: ONE summary, windowed for the
    // watchtower, handed to a caller that needs the digest's span.
    const watchtowerWindowed = await tenantStub(tenantId).opsSummaryForSweep({
      actionsSinceMs: now - FAILURE_SIGNAL_WINDOW_MS,
      failureSignalsSinceMs: now - FAILURE_SIGNAL_WINDOW_MS,
    });
    const scope: SweepScope = { summaries: new Map([[tenantId, watchtowerWindowed]]) };

    await expect(
      sweptSummary(env as Env, scope, tenantId, { actionsSinceMs: now - DIGEST_WINDOW_HOURS * HOUR }, now),
    ).rejects.toThrow(/windowed at actionsSinceMs/);

    // ...and the matching window is accepted, so the guard is not simply "always throw".
    const correct = await sweptSummary(env as Env, scope, tenantId, { failureSignalsSinceMs: now - FAILURE_SIGNAL_WINDOW_MS }, now);
    expect(correct?.tenantId).toBe(tenantId);
  });

  it("a tenant the prefetch could not supply is an ERROR for the consuming leg, never a silent skip", async () => {
    const { tenantId } = await mintTenant("Dedupe Missing", "managed");
    const now = Date.now();
    // Map PRESENT (so we are on the cron path) but this tenant ABSENT — what a
    // prefetch RPC that threw leaves behind. Falling back to a fetch here would
    // put the RPC back into the worst case the slice is derived from.
    const digest = await buildOpsDigest(env as Env, now, DIGEST_WINDOW_HOURS, {
      tenantIds: [tenantId],
      summaries: new Map(),
    });
    expect(digest.errors).toBe(1);
  });

  it("with NO map at all the legs still fetch — the on-demand path is untouched", async () => {
    const { tenantId } = await mintTenant("Dedupe OnDemand", "managed");
    const digest = await buildOpsDigest(env as Env, Date.now(), DIGEST_WINDOW_HOURS, { tenantIds: [tenantId] });
    expect(digest.errors).toBe(0);
    expect(digest.tenants.scanned).toBeGreaterThanOrEqual(1);
  });
});

describe("EFFECT — the tick really does make one ops-summary RPC per tenant, not three", () => {
  it("counts opsSummary-family calls on a real sweep", async () => {
    const seeded: string[] = [];
    for (let i = 0; i < 5; i++) {
      const id = `ten_dedupe_${String(i).padStart(3, "0")}`;
      await insertTenantIndex(env as Env, {
        id,
        apiTokenHash: `dedupe-hash-${i}`,
        brand: `Dedupe ${i}`,
        plan: "free",
        createdAt: 1_800_000_000_000,
        contactEmail: null,
      });
      seeded.push(id);
    }

    // COUNTED PER DURABLE OBJECT, not in total.
    //
    // A total is the wrong unit and the full suite proved it: `env.DB` writes
    // are not rolled back between test FILES, so `tenants_index` carries rows
    // other files left behind — including paying ones, which the new
    // priority prepend correctly sweeps ahead of the slice. Run alone this file
    // saw 5 calls; run in the full suite it saw 6, and the extra one was CORRECT
    // behaviour. The dedupe's claim was never "N calls per tick", it is "at most
    // ONE per tenant instead of three", so that is what is asserted.
    const callsByObject = new Map<string, string[]>();
    const real = env.TENANT;
    const countingEnv = {
      ...env,
      TENANT: {
        idFromName: (name: string) => real.idFromName(name),
        get: (id: DurableObjectId) => {
          const key = id.toString();
          const stub = real.get(id) as unknown as Record<string, unknown>;
          return new Proxy(stub, {
            get(target, prop, receiver) {
              const value = Reflect.get(target, prop, receiver);
              if (typeof value !== "function" || typeof prop !== "string") return value;
              return (...args: unknown[]) => {
                const list = callsByObject.get(key) ?? [];
                list.push(prop);
                callsByObject.set(key, list);
                return (target[prop] as (...a: unknown[]) => unknown)(...args);
              };
            },
          });
        },
      },
    } as unknown as Env;

    await runScheduledOpsSweep(countingEnv, { mailer: new SandboxOpsMailer(), sliceLimit: seeded.length });

    const all = [...callsByObject.values()].flat();
    // ZERO of the old per-leg fetches. This is the assertion that reds if any of
    // the three consumers quietly falls back to its own RPC — which is exactly
    // what would make the dedupe cosmetic while the slice stayed sized as though
    // it were real.
    expect(all.filter((m) => m === "opsSummary").length).toBe(0);

    // AT MOST ONE shared fetch per tenant. Three would be the pre-dedupe shape.
    for (const [object, methods] of callsByObject) {
      const n = methods.filter((m) => m === "opsSummaryForSweep").length;
      expect(n, `object ${object} received ${n} opsSummaryForSweep calls in one tick`).toBeLessThanOrEqual(1);
    }

    // Positive control: the tick really did sweep the tenants we seeded, so the
    // two assertions above are not passing on an empty run.
    const fetched = all.filter((m) => m === "opsSummaryForSweep").length;
    expect(fetched).toBeGreaterThanOrEqual(seeded.length);
  });

  it("the budget records the saving rather than merely claiming it", () => {
    const perTenant = Object.values(LEG_SUBREQUEST_COSTS).reduce((n, leg) => n + leg.perTenant, 0);
    expect(perTenant).toBe(SWEEP_RPCS_PER_TENANT);
    // 11 before the dedupe (-2, the two duplicate opsSummary calls), then 9
    // before the send pipeline moved off the slice (-2, its poll+tick pair).
    expect(SWEEP_RPCS_PER_TENANT).toBe(7);
    expect(LEG_SUBREQUEST_COSTS["digest"]?.perTenant).toBe(0);
    expect(LEG_SUBREQUEST_COSTS["opsSummary"]?.perTenant).toBe(1);
  });
});

describe("the prefetch is a slice leg like any other", () => {
  it("respects the shared deadline and folds into the rotation accumulator", async () => {
    const ids = ["ten_pf_a", "ten_pf_b", "ten_pf_c"];
    // A deadline already in the past: index 0 is still attempted (the shipped
    // rule), the rest are deferred, and the rotation advances by exactly one.
    const fanout = newSweepFanout(Date.now() - 60_000, 1_000, 6);
    const result = await runOpsSummaryPrefetch(
      env as Env,
      { actionsSinceMs: Date.now() - HOUR, failureSignalsSinceMs: Date.now() - HOUR },
      { tenantIds: ids, fanout },
    );
    expect(result.tenantsSwept).toBe(1);
    expect(result.deferred).toBe(2);
    expect(fanout.leastVisited).toBe(1);
  });
});
