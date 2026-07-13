import { describe, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useSwipeAction } from "../../src/inbox/useSwipeAction";

function touchEvent(clientX: number): React.TouchEvent {
  return { touches: [{ clientX, clientY: 0 }] } as unknown as React.TouchEvent;
}

// Regression test for a real bug found while screenshotting the live app
// (M3 build report): a live Playwright CDP touch-swipe sequence committed a
// true -90px drag past the 72px threshold, but `onTouchEnd` read a STALE
// -70px (the prior touchmove's value) off React state and silently failed to
// commit. Root cause: `onTouchEnd`'s closure over the `offsetX` STATE
// variable isn't guaranteed to reflect the immediately-preceding
// `onTouchMove`'s `setOffsetX` call if `touchend` fires before React
// flushes that update — exactly reproduced here by calling
// onTouchMove→onTouchMove→onTouchEnd inside ONE `act()` batch, so no render
// commits between them (the state closures the handlers were bound with are
// deliberately kept stale). Confirmed FAILING on the pre-fix
// state-only implementation, PASSING once `onTouchEnd` reads a
// synchronously-updated ref instead of state (src/inbox/useSwipeAction.ts).
describe("useSwipeAction — stale-closure race", () => {
  it("onTouchEnd commits using the LATEST touchmove distance even when no render has flushed in between", () => {
    const onSwipeLeft = vi.fn();
    const onSwipeRight = vi.fn();
    const { result } = renderHook(() => useSwipeAction({ onSwipeRight, onSwipeLeft, threshold: 72 }));

    act(() => {
      result.current.handlers.onTouchStart(touchEvent(334));
      // Two touchmoves back-to-back, no `act` boundary between them — the
      // FIRST move's `setOffsetX(-70)` has not committed to a render when
      // the second move and the touchend below execute.
      result.current.handlers.onTouchMove(touchEvent(264)); // dx = -70 (BELOW threshold)
      result.current.handlers.onTouchMove(touchEvent(244)); // dx = -90 (PAST threshold)
      result.current.handlers.onTouchEnd();
    });

    expect(onSwipeLeft).toHaveBeenCalledOnce();
    expect(onSwipeRight).not.toHaveBeenCalled();
  });

  it("does not commit when the latest distance is still under threshold", () => {
    const onSwipeLeft = vi.fn();
    const onSwipeRight = vi.fn();
    const { result } = renderHook(() => useSwipeAction({ onSwipeRight, onSwipeLeft, threshold: 72 }));

    act(() => {
      result.current.handlers.onTouchStart(touchEvent(334));
      result.current.handlers.onTouchMove(touchEvent(300)); // dx = -34
      result.current.handlers.onTouchEnd();
    });

    expect(onSwipeLeft).not.toHaveBeenCalled();
    expect(onSwipeRight).not.toHaveBeenCalled();
  });

  it("a rightward drag past threshold commits onSwipeRight, not onSwipeLeft", () => {
    const onSwipeLeft = vi.fn();
    const onSwipeRight = vi.fn();
    const { result } = renderHook(() => useSwipeAction({ onSwipeRight, onSwipeLeft, threshold: 72 }));

    act(() => {
      result.current.handlers.onTouchStart(touchEvent(100));
      result.current.handlers.onTouchMove(touchEvent(200)); // dx = +100
      result.current.handlers.onTouchEnd();
    });

    expect(onSwipeRight).toHaveBeenCalledOnce();
    expect(onSwipeLeft).not.toHaveBeenCalled();
  });
});
