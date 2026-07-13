import { useCallback, useEffect, useRef, useState } from "react";

export interface PendingAction {
  /** Row/thread this action targets — lets ThreadList optimistically hide it. */
  threadId: string;
  message: string;
  commit: () => void;
}

const UNDO_GRACE_MS = 5000;

/**
 * SPEC.md §19.6 — "Swipe actions get a 5-second UNDO toast." The real
 * archive/label mutation fires ONLY when the grace period elapses without an
 * undo; clicking Undo within the window cancels the timer and `commit` never
 * runs. If a second swipe starts while one is already pending, the first is
 * committed immediately (never silently dropped) rather than queued.
 *
 * `commit()` side effects are triggered from `start`/`undo`/the timeout
 * callback directly (never inside a state updater function) — React may
 * invoke a `setState` updater more than once per commit in concurrent mode,
 * which would double-fire a mutation if the side effect lived there.
 */
export function usePendingAction() {
  const [pending, setPending] = useState<PendingAction | null>(null);
  const pendingRef = useRef<PendingAction | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const start = useCallback(
    (action: PendingAction) => {
      clearTimer();
      // A second swipe arriving before the first's grace period elapsed
      // commits the first immediately — never silently dropped.
      pendingRef.current?.commit();
      pendingRef.current = action;
      setPending(action);
      timerRef.current = setTimeout(() => {
        action.commit();
        pendingRef.current = null;
        setPending(null);
      }, UNDO_GRACE_MS);
    },
    [clearTimer],
  );

  const undo = useCallback(() => {
    clearTimer();
    pendingRef.current = null;
    setPending(null);
  }, [clearTimer]);

  useEffect(() => clearTimer, [clearTimer]);

  return { pending, start, undo, graceMs: UNDO_GRACE_MS };
}
