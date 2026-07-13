import { useRef, useState } from "react";

interface SwipeGestureOptions {
  onSwipeRight: () => void;
  onSwipeLeft: () => void;
  /** Pixels of horizontal travel before a release commits the gesture. */
  threshold?: number;
}

/**
 * Mobile row swipe (SPEC.md §19.6): swipe right = archive, swipe left =
 * label sheet. This hook only detects the GESTURE and reports
 * direction+distance for visual feedback (a reveal/translate effect) — it
 * does NOT perform the archive/label mutation itself. The caller (ThreadRow)
 * wires `onSwipeRight`/`onSwipeLeft` to start the 5s undo-toast countdown;
 * the real API call only fires when that countdown expires (see UndoToast).
 *
 * `offsetXRef` (not the `offsetX` state value) is what `onTouchEnd` reads to
 * decide whether the gesture committed — a real device can fire `touchend`
 * within a couple milliseconds of the last `touchmove`, faster than React is
 * guaranteed to have flushed that touchmove's `setOffsetX` into a committed
 * render before `onTouchEnd`'s closure captured `offsetX`. That race
 * reproduced concretely: a live Playwright CDP touch-swipe sequence (see the
 * M3 build report) landed at true distance -90px past the 72px threshold,
 * but `onTouchEnd` read a stale -70px (the PRIOR touchmove's value) and
 * silently failed to commit. The ref is written in the same synchronous call
 * as the touch handler, so it can never lag behind like state can.
 */
export function useSwipeAction({ onSwipeRight, onSwipeLeft, threshold = 72 }: SwipeGestureOptions) {
  const [offsetX, setOffsetX] = useState(0);
  const offsetXRef = useRef(0);
  const [isDragging, setIsDragging] = useState(false);
  const startX = useRef(0);
  const startY = useRef(0);
  const axisLocked = useRef<"horizontal" | "vertical" | null>(null);

  function onTouchStart(e: React.TouchEvent) {
    const touch = e.touches[0];
    if (!touch) return;
    startX.current = touch.clientX;
    startY.current = touch.clientY;
    axisLocked.current = null;
    offsetXRef.current = 0;
    setIsDragging(true);
  }

  function onTouchMove(e: React.TouchEvent) {
    const touch = e.touches[0];
    if (!touch) return;
    const dx = touch.clientX - startX.current;
    const dy = touch.clientY - startY.current;

    if (axisLocked.current === null && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) {
      axisLocked.current = Math.abs(dx) > Math.abs(dy) ? "horizontal" : "vertical";
    }
    // A vertical scroll gesture must never be hijacked into a swipe reveal.
    if (axisLocked.current === "vertical") return;
    if (axisLocked.current === "horizontal") {
      offsetXRef.current = dx;
      setOffsetX(dx);
    }
  }

  function onTouchEnd() {
    setIsDragging(false);
    const finalOffset = offsetXRef.current;
    const committed = axisLocked.current === "horizontal" && Math.abs(finalOffset) >= threshold;
    if (committed) {
      if (finalOffset > 0) onSwipeRight();
      else onSwipeLeft();
    }
    offsetXRef.current = 0;
    setOffsetX(0);
    axisLocked.current = null;
  }

  return {
    offsetX,
    isDragging,
    handlers: { onTouchStart, onTouchMove, onTouchEnd },
  };
}
