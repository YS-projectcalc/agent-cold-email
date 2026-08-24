import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { insertTenantIndex } from "../src/db.js";
import {
  commitSweepCursor,
  newSweepFanout,
  readTenantSlice,
  sweepTenants,
  type SweepDeadline,
} from "../src/admin/tenant-slice.js";
import { RealClock } from "../src/clock.js";
import {
  SWEEP_FANOUT_CONCURRENCY,
  SWEEP_FANOUT_CONCURRENCY_MAX,
  SWEEP_FANOUT_RPCS_PER_TENANT,
  SWEEP_TENANT_SLICE,
  effectiveConcurrency,
  sweepFanoutConcurrency,
  sweepTenantSliceFor,
} from "../src/admin/sweep-budget.js";

// BOUNDED-CONCURRENCY FAN-OUT (lane feat/sweep-capacity-2026-08-24).
//
// The measurement that authorised this is
// docs/research/sweep-capacity-measurement-2026-08-24.md; this file pins the
// two properties the measurement said the BUILD has to carry, plus the
// rollback.
//
// §5 IS THE BLOCKING ONE. `commitSweepCursor` does `slice.ids[covered - 1]` —
// it indexes the slice by a COUNT, which is sound only while the covered set is
// a contiguous PREFIX. Sequentially that is free. Concurrently it is a property
// of the deadline discipline, and only one of the two candidate disciplines has
// it. The negative control below keeps the wrong one executable, because a
// constraint that exists only in a comment is one refactor from being lost.

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * THE DISCIPLINE THAT WAS REJECTED, kept as a NEGATIVE CONTROL.
 *
 * "Abandon": every tenant races the shared deadline and unfinished work is
 * dropped. It looks tighter — the leg never overruns — and it is wrong here.
 * This is not a strawman: it is the obvious way to make a concurrent loop
 * respect a deadline, and it is what the shipped code would look like if
 * someone "fixed" the one-round-trip overrun that `claim` accepts.
 */
async function sweepAbandoningInFlight(
  tenantIds: readonly string[],
  fanout: SweepDeadline,
  fn: (tenantId: string) => Promise<void>,
  concurrency: number,
): Promise<{ visited: number; prefix: number }> {
  const clock = new RealClock();
  const n = tenantIds.length;
  const done = new Array<boolean>(n).fill(false);
  let next = 0;
  let visited = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      if (index >= n) return;
      if (index > 0 && clock.now() - fanout.startedAt >= fanout.deadlineMs) {
        next = n;
        return;
      }
      next = index + 1;
      const remaining = fanout.deadlineMs - (clock.now() - fanout.startedAt);
      const abandoned = Symbol("abandoned");
      const outcome = await Promise.race([
        fn(tenantIds[index] as string).then(() => "done" as const),
        new Promise<typeof abandoned>((r) => setTimeout(() => r(abandoned), Math.max(0, remaining))),
      ]);
      if (outcome === abandoned) continue;
      done[index] = true;
      visited++;
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, n)) }, () => worker()));
  let prefix = 0;
  while (prefix < n && done[prefix]) prefix++;
  return { visited, prefix };
}

/** One slow tenant at the head, fast ones behind it — the shape a real slice
 * hits whenever one tenant's DO is cold, overloaded or wedged. */
const HEAD_SLOW = { ids: ["t00_slow", "t01", "t02", "t03", "t04", "t05"], delays: [900, 20, 20, 20, 20, 20] };

describe("§5 — the covered set must stay a contiguous PREFIX, or the cursor skips a live tenant", () => {
  it("the SHIPPED discipline leaves no hole: prefix === visited even with a slow head", async () => {
    const swept: string[] = [];
    const fanout = newSweepFanout(new RealClock().now(), 300, 3);
    const result = await sweepTenants(
      HEAD_SLOW.ids,
      fanout,
      async (id) => {
        await sleep(HEAD_SLOW.delays[HEAD_SLOW.ids.indexOf(id)] as number);
        swept.push(id);
      },
      () => {},
    );
    // The property, stated three ways so a partial regression cannot slip past.
    expect(result.prefix).toBe(result.visited);
    expect(swept).toContain("t00_slow");
    expect(HEAD_SLOW.ids.slice(0, result.prefix).every((id) => swept.includes(id))).toBe(true);
    // ...and the rotation advances by the prefix, never by a larger count.
    expect(fanout.leastVisited).toBe(result.prefix);
  });

  it("NEGATIVE CONTROL — the abandon discipline DOES leave a hole, and it is the slow tenant", async () => {
    const swept: string[] = [];
    const fanout = newSweepFanout(new RealClock().now(), 300, 3);
    const result = await sweepAbandoningInFlight(
      HEAD_SLOW.ids,
      fanout,
      async (id) => {
        await sleep(HEAD_SLOW.delays[HEAD_SLOW.ids.indexOf(id)] as number);
        swept.push(id);
      },
      3,
    );
    // Several tenants covered, and yet nothing at all is safely committable:
    // index 0 never finished, so the prefix is empty.
    expect(result.visited).toBeGreaterThan(0);
    expect(result.prefix).toBe(0);
    expect(swept).not.toContain("t00_slow");
    // THE DEFECT, made concrete rather than described: a cursor advanced by the
    // COUNT lands past a tenant that was never swept. The next tick reads
    // `WHERE id > ?`, so that tenant is skipped for the whole rotation — and it
    // is specifically the SLOW one, i.e. the likeliest to be the sick one this
    // sweep exists to notice.
    const cursorFromCount = HEAD_SLOW.ids[result.visited - 1] as string;
    expect(cursorFromCount > "t00_slow").toBe(true);
  });

  it("the prefix holds under randomized latency and concurrency (property)", async () => {
    for (const [concurrency, deadlineMs] of [
      [2, 120],
      [4, 90],
      [6, 150],
    ] as const) {
      const ids = Array.from({ length: 14 }, (_, i) => `p${String(i).padStart(2, "0")}`);
      const fanout = newSweepFanout(new RealClock().now(), deadlineMs, concurrency);
      const done = new Set<string>();
      const result = await sweepTenants(
        ids,
        fanout,
        async (id) => {
          await sleep(5 + ((id.charCodeAt(2) * 7) % 40));
          done.add(id);
        },
        () => {},
      );
      expect(result.prefix, `C=${concurrency}`).toBe(result.visited);
      for (const id of ids.slice(0, result.prefix)) expect(done.has(id), `${id} at C=${concurrency}`).toBe(true);
    }
  });

  it("an errored tenant is still covered — a hole here would strand it for a whole rotation", async () => {
    const ids = ["e0", "e1", "e2", "e3"];
    const fanout = newSweepFanout(new RealClock().now(), 5_000, 4);
    const seen: string[] = [];
    const result = await sweepTenants(
      ids,
      fanout,
      async (id) => {
        if (id === "e1") throw new Error("wedged DO");
        await sleep(5);
      },
      (id) => seen.push(id),
    );
    expect(result.errors).toBe(1);
    expect(seen).toEqual(["e1"]);
    expect(result.prefix).toBe(4);
    expect(result.visited).toBe(4);
  });
});

describe("C=1 reproduces the pre-concurrency LOOP exactly", () => {
  it("the serial slice is 4 — and the +1 over the shipped 3 is the DEDUPE, not the concurrency", () => {
    // Precision about what the rollback lever does and does not restore.
    // `SWEEP_FANOUT_CONCURRENCY=1` restores the serial loop verbatim; it does
    // NOT restore the slice of 3, because the ops-summary dedupe in the same
    // lane genuinely lowered the per-tenant cost (9 fan-out RPCs -> 7) and a
    // serial tick can now afford one more tenant. Pinned rather than described,
    // so the next change to either number has to say which one moved.
    expect(SWEEP_FANOUT_RPCS_PER_TENANT).toBe(7);
    expect(sweepTenantSliceFor(1)).toBe(4);
    // The concurrency is what does the heavy lifting, not the dedupe.
    expect(sweepTenantSliceFor(SWEEP_FANOUT_CONCURRENCY)).toBeGreaterThan(4 * sweepTenantSliceFor(1) - 1);
  });

  it("runs the serial loop: the deadline stops it BETWEEN tenants, and index 0 always runs", async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `s${String(i).padStart(2, "0")}`);
    const fanout = newSweepFanout(new RealClock().now(), 250, 1);
    const order: string[] = [];
    const result = await sweepTenants(
      ids,
      fanout,
      async (id) => {
        await sleep(60);
        order.push(id);
      },
      () => {},
    );
    expect(result.visited).toBeGreaterThanOrEqual(1);
    expect(result.deferred).toBe(ids.length - result.visited);
    expect(result.prefix).toBe(result.visited);
    // Serial means IN ORDER, which is the observable difference from the pool.
    expect(order).toEqual(ids.slice(0, order.length));
  });

  it("a past deadline still sweeps exactly one tenant, at either concurrency", async () => {
    for (const concurrency of [1, 6]) {
      const fanout = newSweepFanout(new RealClock().now() - 10_000, 1_000, concurrency);
      const result = await sweepTenants(["a", "b", "c"], fanout, async () => {}, () => {});
      expect(result.visited, `C=${concurrency}`).toBe(1);
      expect(result.prefix, `C=${concurrency}`).toBe(1);
    }
  });
});

describe("the knob is a rollback lever, and it is clamped", () => {
  it("defaults to the shipped concurrency and honours a sane override", () => {
    expect(sweepFanoutConcurrency({})).toBe(SWEEP_FANOUT_CONCURRENCY);
    expect(sweepFanoutConcurrency({ SWEEP_FANOUT_CONCURRENCY: "1" })).toBe(1);
    expect(sweepFanoutConcurrency({ SWEEP_FANOUT_CONCURRENCY: "8" })).toBe(8);
  });

  it("a nonsense value degrades to the default, never to 0 or to something unbounded", () => {
    for (const raw of ["", "0", "-3", "abc", "2.5", "1e9"]) {
      const resolved = sweepFanoutConcurrency({ SWEEP_FANOUT_CONCURRENCY: raw });
      expect(resolved, `raw=${JSON.stringify(raw)}`).toBeGreaterThanOrEqual(1);
      expect(resolved, `raw=${JSON.stringify(raw)}`).toBeLessThanOrEqual(SWEEP_FANOUT_CONCURRENCY_MAX);
    }
    expect(sweepFanoutConcurrency({ SWEEP_FANOUT_CONCURRENCY: "500" })).toBe(SWEEP_FANOUT_CONCURRENCY_MAX);
  });

  it("the efficiency discount is applied, not linear speedup (the 25-30% the harness measured)", () => {
    expect(effectiveConcurrency(1)).toBe(1);
    // If someone "simplifies" this to linear, the slice overshoots what the
    // deadline sustains and the achieved advance collapses to 1 (harness Table 1).
    expect(effectiveConcurrency(6)).toBeLessThan(6);
    expect(sweepTenantSliceFor(6)).toBeLessThan(6 * sweepTenantSliceFor(1));
  });
});

describe("EFFECT — concurrency actually shortens the rotation over the real cursor", () => {
  it("overlapping the waits cuts fan-out wall time by more than half", async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `w${String(i).padStart(2, "0")}`);
    const run = async (concurrency: number): Promise<number> => {
      const startedAt = new RealClock().now();
      // No deadline pressure — this measures the OVERLAP, not the clipping.
      const fanout = newSweepFanout(startedAt, 60_000, concurrency);
      await sweepTenants(ids, fanout, async () => await sleep(50), () => {});
      return new RealClock().now() - startedAt;
    };
    const serialMs = await run(1);
    const concurrentMs = await run(6);
    expect(serialMs).toBeGreaterThan(400);
    // Deliberately loose (a 6x-theoretical speedup asserted at >2x) so this is
    // an effect assertion, not a wall-clock flake.
    expect(concurrentMs).toBeLessThan(serialMs / 2);
  });

  it("a full rotation over the REAL keyset cursor completes in strictly fewer ticks", async () => {
    const total = 24;
    for (let i = 0; i < total; i++) {
      await insertTenantIndex(env, {
        id: `ten_rot_${String(i).padStart(3, "0")}`,
        apiTokenHash: `rot-hash-${i}`,
        brand: `Rot ${i}`,
        plan: "free",
        createdAt: 1_800_000_000_000,
        contactEmail: null,
      });
    }
    const seeded = (await env.DB.prepare(`SELECT id FROM tenants_index`).all<{ id: string }>()).results.map((r) => r.id);

    // A FULL ROTATION IS "every seeded tenant has been reached", counted in
    // ticks. NOT "the cursor returned null" — `commitSweepCursor` only wraps
    // when one slice covered the WHOLE index, so at any real tenant count the
    // wrap arrives as an empty keyset page that `readTenantSlice` restarts
    // internally. Measuring the wrong sentinel is how this test first ran 200
    // ticks and reported nothing.
    const rotate = async (concurrency: number): Promise<{ ticks: number; covered: Set<string> }> => {
      await env.DB.prepare(`DELETE FROM sweep_cursor`).run();
      const limit = sweepTenantSliceFor(concurrency);
      const covered = new Set<string>();
      let ticks = 0;
      while (ticks < 200 && covered.size < seeded.length) {
        ticks++;
        const slice = await readTenantSlice(env, limit);
        const fanout = newSweepFanout(new RealClock().now(), 60_000, concurrency);
        await sweepTenants(slice.ids, fanout, async (id) => void covered.add(id), () => {});
        await commitSweepCursor(env, slice, fanout.leastVisited ?? slice.ids.length, Date.now());
      }
      return { ticks, covered };
    };

    const serial = await rotate(1);
    const concurrent = await rotate(6);

    // EVERY tenant is still reached — the bound got wider, not leakier. This is
    // the assertion that a shape-check on the cursor would have agreed with the
    // 2026-08-20 bug about, so it is done by union-of-ids.
    for (const id of seeded) {
      expect(serial.covered.has(id), `serial missed ${id}`).toBe(true);
      expect(concurrent.covered.has(id), `concurrent missed ${id}`).toBe(true);
    }
    // Positive control: a rotation that completed in one tick would make the
    // comparison below meaningless.
    expect(serial.ticks).toBe(Math.ceil(seeded.length / sweepTenantSliceFor(1)));
    expect(concurrent.ticks).toBe(Math.ceil(seeded.length / sweepTenantSliceFor(6)));
    expect(concurrent.ticks).toBeLessThan(serial.ticks);
  });
});

describe("the shipped constant is the derivation at the shipped concurrency", () => {
  it("SWEEP_TENANT_SLICE === sweepTenantSliceFor(SWEEP_FANOUT_CONCURRENCY)", () => {
    expect(SWEEP_TENANT_SLICE).toBe(sweepTenantSliceFor(SWEEP_FANOUT_CONCURRENCY));
  });
});

// ── GATE ROUND 2026-08-24 ────────────────────────────────────────────────────

describe("NB-7 — the prefix oracle must not restate the implementation", () => {
  // THE GATE'S FINDING. Planting `prefix := visited` in the shipped pool left
  // 22/22 green: under the claim discipline the two are provably equal, so every
  // `expect(prefix).toBe(visited)` assertion is a tautology of the CURRENT pool
  // and cannot fail. The constraint's only executable oracle was the abandon
  // negative control, and that ran the EXPERIMENT's copy, not shipped code.
  //
  // Three replacements, none of which compare prefix to visited.

  it("the prefix is the longest prefix the TEST independently observed completing", async () => {
    for (const concurrency of [2, 4, 6]) {
      const ids = Array.from({ length: 25 }, (_, i) => `n7_${String(i).padStart(2, "0")}`);
      const completed = new Set<string>();
      const fanout = newSweepFanout(new RealClock().now(), 140, concurrency);
      const result = await sweepTenants(
        ids,
        fanout,
        async (id) => {
          // Wildly uneven latency, so completion ORDER is not claim order.
          await sleep(3 + ((id.charCodeAt(3) * 13) % 45));
          completed.add(id);
        },
        () => {},
      );
      // The oracle is computed from what the CALLBACK saw, not from the
      // primitive's own bookkeeping. An implementation that counted completions
      // without tracking WHICH ones fails this; `prefix === visited` does not.
      let expected = 0;
      while (expected < ids.length && completed.has(ids[expected] as string)) expected++;
      expect(result.prefix, `C=${concurrency}`).toBe(expected);
      // ...and every id inside the reported prefix really did run.
      for (const id of ids.slice(0, result.prefix)) expect(completed.has(id)).toBe(true);
    }
  });

  it("an errored tenant IN THE MIDDLE is still inside the prefix (a hole there strands it)", async () => {
    const ids = ["m0", "m1", "m2_throws", "m3", "m4"];
    const completed = new Set<string>();
    const fanout = newSweepFanout(new RealClock().now(), 60_000, 3);
    const result = await sweepTenants(
      ids,
      fanout,
      async (id) => {
        await sleep(id === "m2_throws" ? 40 : 5);
        if (id === "m2_throws") throw Object.assign(new Error("wedged"), { name: "StorageError" });
        completed.add(id);
      },
      () => {},
    );
    // Independently: the errored tenant did NOT complete its body, yet the
    // prefix must still cover it — errors are "reached", and excluding them
    // would strand the sick tenant for a whole rotation.
    expect(completed.has("m2_throws")).toBe(false);
    expect(result.errors).toBe(1);
    expect(result.prefix).toBe(ids.length);
  });

  it("TRIPWIRE — the shipped pool contains none of the abandon-discipline machinery", async () => {
    // The gate's point: the day someone adds a per-item timeout or a race to
    // `sweepConcurrently`, the hole reopens and the prefix assertions stay green
    // because they restate the pool. This looks at the shipped SOURCE for the
    // two constructs that would introduce it.
    const source = (await import("../src/admin/tenant-slice.ts?raw")).default as string;
    const body = source.slice(source.indexOf("async function sweepConcurrently"));
    const pool = body.slice(0, body.indexOf("\n}\n") + 3);
    expect(pool, "could not isolate sweepConcurrently's body — this tripwire would be vacuous").toContain("done[index] = true");
    for (const banned of ["Promise.race", "setTimeout"]) {
      expect(
        pool,
        `sweepConcurrently now contains \`${banned}\`. That is the ABANDON discipline: it drops in-flight work at the ` +
          "deadline, which leaves a HOLE in the covered set, and commitSweepCursor indexes the slice by the covered " +
          "count — the cursor then advances past a tenant that was never swept and skips it for the whole rotation. " +
          "If a bounded per-item timeout is genuinely needed, it must mark the item NOT-done and the cursor must be " +
          "fed the contiguous prefix, not the count.",
      ).not.toContain(banned);
    }
  });
});
