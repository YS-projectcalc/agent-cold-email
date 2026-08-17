// The HEAD-OF-LINE-BLOCKING guard (class sweep 2026-08-17,
// docs/adversarial/class-sweep-hol-blocking-2026-08-17.md).
//
// THE CLASS, in one sentence: a sequential loop over a durably-selected,
// stably-ordered item list, where one item consumes the whole call (by throwing
// past the loop), and the next invocation re-selects the same list in the same
// order — so the head item's persistent failure is a permanent, silent denial
// of service to every item behind it, with no skip, reorder or quarantine path.
//
// The permanence comes from DETERMINISTIC RE-SELECTION, not from the loop: a
// loop only starves items within ONE call. What made the confirmed instance
// (setup_infrastructure's per-ordinal loop) permanent is that the next call
// re-derives the same ordinals in the same order and re-dies at the same head.
// That is why isolation here is a correctness fix and not a robustness nicety.
//
// WHY A SHARED PRIMITIVE RATHER THAN try/catch AT EACH SITE: the repo already
// invented this idiom twice and correctly (engine/warmup-cancel.ts's
// per-mailbox catch + `warmup_cancel_attempts` + `warmup_cancel_gave_up_at`
// give-up marker; engine/provision-intents.ts's MAX_BUY_DISPATCHES), and got it
// wrong at nine other sites. Consolidating it (CLAUDE.md rule c) gives the
// tripwire in test/loop-isolation-coverage.test.ts one shape to recognize, and
// makes `onItemError` MANDATORY so a future member cannot be written that
// isolates silently — a swallowed per-item failure is its own defect class.

/** One item's failure, with enough context for the caller to record/quarantine it. */
export interface IsolatedFailure<TItem> {
  /** Position in the input list (the ordinal, for an ordinal-derived list). */
  index: number;
  item: TItem;
  error: unknown;
}

export interface IsolatedOutcome<TItem, TResult> {
  /** One entry per SUCCEEDED item, in input order. */
  results: TResult[];
  /** One entry per FAILED item, in input order. Empty ⇒ every item completed. */
  failures: IsolatedFailure<TItem>[];
  /**
   * Set when `abortOn` stopped the loop early — the items after it were never
   * attempted, and the caller owes the reader an honest account of that.
   */
  abortedAt?: IsolatedFailure<TItem>;
}

export interface IsolatedOptions<TItem> {
  /**
   * MANDATORY. Called for every failed item before the loop moves on. This is
   * where a member records the failure durably (an ops-visible action row) and,
   * where the item has one, stamps its attempt counter / give-up marker — the
   * `warmup-cancel.ts` shape. There is deliberately no separate `quarantine`
   * hook: quarantining IS recording, and a second hook that can only do what
   * this one already can is speculative abstraction (CLAUDE.md rule i).
   *
   * It must not throw. If it does, the throw escapes the loop — which is the
   * honest outcome, since a bookkeeping write that fails means the isolation
   * itself is unrecorded.
   */
  onItemError: (failure: IsolatedFailure<TItem>) => void | Promise<void>;
  /**
   * TENANT-GLOBAL conditions, which are NOT this item's fault and must stop the
   * loop rather than be isolated: a spend-ceiling breach or an unarmed registrar
   * will reject every remaining item identically, so continuing only burns
   * reservations and re-fires one-shot alerts. Returning true records the
   * failure (via `onItemError`) and stops; the remaining items are untouched, so
   * the next invocation reaches them once the global condition clears.
   */
  abortOn?: (error: unknown) => boolean;
}

/**
 * Runs `fn` for every item SEQUENTIALLY (the ordering the members depend on —
 * these loops open the DO input gate on every await and their effects are
 * ordered), isolating each item's failure so one dead item cannot deny service
 * to the ones behind it.
 *
 * NEVER THROWS on an item failure — the caller decides what the CALL's outcome
 * is from `failures`. That decision is deliberately not made here: some members
 * must still surface a failure to the customer's agent (setup_infrastructure
 * re-throws the first one, so a permanently-dead ordinal never reads as a clean
 * success), others must not (the deliverability sweep runs inside the tick, and
 * a throw there stops the tenant's mail).
 */
export async function forEachIsolated<TItem, TResult>(
  items: readonly TItem[],
  fn: (item: TItem, index: number) => Promise<TResult>,
  opts: IsolatedOptions<TItem>,
): Promise<IsolatedOutcome<TItem, TResult>> {
  const results: TResult[] = [];
  const failures: IsolatedFailure<TItem>[] = [];

  for (let index = 0; index < items.length; index++) {
    const item = items[index] as TItem;
    try {
      results.push(await fn(item, index));
    } catch (error) {
      const failure: IsolatedFailure<TItem> = { index, item, error };
      failures.push(failure);
      await opts.onItemError(failure);
      if (opts.abortOn?.(error)) return { results, failures, abortedAt: failure };
    }
  }

  return { results, failures };
}
