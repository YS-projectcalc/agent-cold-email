// EXPERIMENT-ONLY (sweep-capacity lane, 2026-08-24). Not imported by src/.
//
// A discrete-event model of ONE cron tick's pre-send-pipeline fan-out phase.
//
// IT IS A MODEL, AND THE MODEL IS VALIDATED AGAINST THE SHIPPED CODE. Running
// the matrix below against the real `sweepTenants` would take real wall clock
// (15s per simulated tick x hundreds of cells), so the matrix runs on this
// simulator — and `sweepcap.test.ts` then pins the simulator to the real
// `sweepTenants` by replaying the REAL run's OBSERVED per-tenant durations
// through it and asserting exact agreement on visited/deferred/leastVisited.
// A model nobody cross-checked against the code it models is a plan.
//
// WHAT IT REPRODUCES from admin/tenant-slice.ts's `sweepTenants`:
//  - the deadline is checked BETWEEN tenants, never mid-tenant;
//  - index 0 is ALWAYS attempted (`i > 0 &&` in the guard), so a tick can never
//    make zero progress;
//  - `leastVisited` is the MINIMUM over legs;
//  - each leg re-iterates the SAME slice, so the legs are sequential and the
//    per-tenant RPCs inside one leg's callback are sequential too.

/** One fan-out leg: how many SEQUENTIAL DO RPCs its callback makes per tenant. */
export interface LegSpec {
  readonly name: string;
  readonly rpcsPerTenant: number;
}

export interface LegOutcome {
  readonly name: string;
  /** Tenants whose callback ran to completion (the shipped `visited`). */
  readonly visited: number;
  readonly deferred: number;
  /** Longest CONTIGUOUS prefix of slice indices that completed. */
  readonly prefix: number;
  readonly elapsedMsAtLegEnd: number;
}

export interface TickOutcome {
  readonly legs: readonly LegOutcome[];
  readonly wallMs: number;
  /** min over legs of `visited` — what the shipped cursor advances by. */
  readonly leastVisited: number;
  /** min over legs of the contiguous prefix — what a cursor MAY safely advance by. */
  readonly leastPrefix: number;
  /** DO RPCs actually issued this tick (the subrequest side of the budget). */
  readonly rpcsIssued: number;
}

export interface TickParams {
  readonly legs: readonly LegSpec[];
  readonly sliceSize: number;
  readonly concurrency: number;
  readonly deadlineMs: number;
  readonly rng: () => number;
  readonly sampleMs: (rng: () => number) => number;
  /**
   * How the concurrent loop treats a tenant still in flight when the deadline
   * arrives. `claim` = stop handing out NEW tenants, let in-flight finish (the
   * worker-pool discipline). `abandon` = race each tenant against the deadline
   * and drop whatever has not returned (the tighter-looking alternative).
   * The two differ in whether the completed set stays a PREFIX — which is the
   * property `commitSweepCursor` silently depends on.
   */
  readonly onDeadline?: "claim" | "abandon";
}

/**
 * Simulate ONE leg's pass over the slice at a given concurrency.
 *
 * Time is virtual: `now` is the elapsed ms since the tick's `startedAt`, so the
 * deadline comparison is the same `elapsed >= deadlineMs` the shipped loop makes.
 */
function simulateLeg(
  leg: LegSpec,
  startElapsedMs: number,
  params: TickParams,
  durations?: readonly number[],
): { outcome: LegOutcome; rpcs: number } {
  const { sliceSize, concurrency, deadlineMs, rng, sampleMs } = params;
  const mode = params.onDeadline ?? "claim";
  const done = new Array<boolean>(sliceSize).fill(false);
  let rpcs = 0;
  let visited = 0;
  let claimed = 0;
  let stoppedClaiming = false;

  // Each of `concurrency` workers is free at some elapsed time.
  const freeAt = new Array<number>(Math.max(1, Math.min(concurrency, Math.max(1, sliceSize)))).fill(startElapsedMs);
  const inFlight: { index: number; endsAt: number }[] = [];
  let lastEnd = startElapsedMs;

  while (!stoppedClaiming && claimed < sliceSize) {
    // The next worker to come free is the one that claims the next tenant.
    let w = 0;
    for (let i = 1; i < freeAt.length; i++) if ((freeAt[i] as number) < (freeAt[w] as number)) w = i;
    const claimAt = freeAt[w] as number;
    const index = claimed;

    // THE SHIPPED GUARD, in shape: `i > 0 && clock.now() - startedAt >= deadlineMs`.
    // Two details carried over deliberately:
    //  - the deadline is measured from the TICK's start, not this leg's, so
    //    `claimAt` (elapsed-since-tick-start) is already the right quantity;
    //  - index 0 is ALWAYS attempted, PER LEG. Each leg calls `sweepTenants`
    //    afresh with its own `i = 0`, so even a leg that starts past the
    //    deadline sweeps one tenant. That is why `leastVisited` is >= 1 for any
    //    leg that ran at all, and it is load-bearing: it is what stops a
    //    starved leg from pinning the rotation on the same head forever.
    if (index > 0 && claimAt >= deadlineMs) {
      stoppedClaiming = true;
      break;
    }

    let cost = 0;
    if (durations) {
      cost = durations[index] ?? 0;
      rpcs += leg.rpcsPerTenant;
    } else {
      for (let r = 0; r < leg.rpcsPerTenant; r++) {
        cost += sampleMs(rng);
        rpcs++;
      }
    }
    const endsAt = claimAt + cost;
    freeAt[w] = endsAt;
    inFlight.push({ index, endsAt });
    claimed++;
  }

  for (const item of inFlight) {
    if (mode === "abandon" && item.endsAt > deadlineMs) continue;
    done[item.index] = true;
    visited++;
    if (item.endsAt > lastEnd) lastEnd = item.endsAt;
  }
  if (mode === "claim") for (const item of inFlight) if (item.endsAt > lastEnd) lastEnd = item.endsAt;

  let prefix = 0;
  while (prefix < sliceSize && done[prefix]) prefix++;

  return {
    outcome: { name: leg.name, visited, deferred: sliceSize - visited, prefix, elapsedMsAtLegEnd: lastEnd },
    rpcs,
  };
}

export function simulateTick(params: TickParams, durationsPerLeg?: readonly (readonly number[])[]): TickOutcome {
  const legs: LegOutcome[] = [];
  let elapsed = 0;
  let rpcsIssued = 0;
  for (let i = 0; i < params.legs.length; i++) {
    const { outcome, rpcs } = simulateLeg(params.legs[i] as LegSpec, elapsed, params, durationsPerLeg?.[i]);
    legs.push(outcome);
    rpcsIssued += rpcs;
    elapsed = outcome.elapsedMsAtLegEnd;
  }
  return {
    legs,
    wallMs: elapsed,
    leastVisited: legs.reduce((m, l) => Math.min(m, l.visited), Number.POSITIVE_INFINITY),
    leastPrefix: legs.reduce((m, l) => Math.min(m, l.prefix), Number.POSITIVE_INFINITY),
    rpcsIssued,
  };
}
