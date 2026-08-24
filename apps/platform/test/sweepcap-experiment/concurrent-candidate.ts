// EXPERIMENT-ONLY (sweep-capacity lane, 2026-08-24). Not imported by src/.
//
// The bounded-concurrency drop-in this lane is measuring, written here rather
// than in src/ because the lane is MEASUREMENT-phase: the orchestrator owns the
// decision to build it. It exists so the simulator has something real to be
// validated against, and so the two deadline disciplines below can be compared
// by EFFECT rather than by argument.
//
// THE ONE PROPERTY THAT DECIDES THE SHAPE. `commitSweepCursor` does
// `slice.ids[covered - 1]` — it treats the covered count as a CONTIGUOUS
// PREFIX of the slice. Sequentially that is free. Concurrently it is a
// constraint the primitive has to honour, and the two obvious implementations
// differ on exactly it:
//
//   "claim"   — the deadline stops handing out NEW tenants; whatever is already
//               in flight is awaited. Completed set stays a prefix.
//   "abandon" — each tenant races the deadline and unfinished work is dropped.
//               Tighter wall clock, and it can leave a HOLE: a slow tenant at
//               index i abandoned while i+1..i+k completed. Feeding that count
//               to `commitSweepCursor` skips tenant i for the whole rotation.
//
// `sweepcap.test.ts` demonstrates the hole rather than asserting it cannot
// happen.

import { RealClock } from "../../src/clock.js";
import type { SweepDeadline, TenantSweepResult } from "../../src/admin/tenant-slice.js";

export interface ConcurrentSweepResult extends TenantSweepResult {
  /** Longest contiguous prefix of `tenantIds` that completed — the ONLY number
   * a keyset cursor may advance by. */
  prefix: number;
}

export async function sweepTenantsConcurrentCandidate(
  tenantIds: readonly string[],
  fanout: SweepDeadline | undefined,
  fn: (tenantId: string) => Promise<void>,
  onError: (tenantId: string, err: unknown) => void,
  concurrency: number,
  mode: "claim" | "abandon" = "claim",
): Promise<ConcurrentSweepResult> {
  const clock = new RealClock();
  const n = tenantIds.length;
  const done = new Array<boolean>(n).fill(false);
  let next = 0;
  let visited = 0;
  let errors = 0;

  const pastDeadline = () => fanout !== undefined && clock.now() - fanout.startedAt >= fanout.deadlineMs;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      if (index >= n) return;
      // Index 0 is always attempted — the shipped rule, kept.
      if (index > 0 && pastDeadline()) {
        next = n; // stop every OTHER worker from claiming too
        return;
      }
      next = index + 1;
      const tenantId = tenantIds[index] as string;
      try {
        if (mode === "abandon" && fanout) {
          const remaining = fanout.deadlineMs - (clock.now() - fanout.startedAt);
          const abandoned = Symbol("abandoned");
          const raced = await Promise.race([
            fn(tenantId).then(() => "done" as const),
            new Promise<typeof abandoned>((r) => setTimeout(() => r(abandoned), Math.max(0, remaining))),
          ]);
          if (raced === abandoned) continue; // NOT marked done — this is the hole
        } else {
          await fn(tenantId);
        }
      } catch (err) {
        errors++;
        onError(tenantId, err);
      }
      done[index] = true;
      visited++;
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, n || 1)) }, () => worker()));

  let prefix = 0;
  while (prefix < n && done[prefix]) prefix++;
  return { visited, deferred: n - visited, errors, prefix };
}
