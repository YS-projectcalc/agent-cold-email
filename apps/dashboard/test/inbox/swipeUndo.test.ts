import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { usePendingAction } from "../../src/inbox/usePendingAction";

// SPEC.md §19.6 — "Swipe actions get a 5-second UNDO toast." The build
// brief's own test requirement: "swipe-undo grace (action fires only after
// toast expires; undo cancels)".
describe("usePendingAction", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does NOT commit immediately when a pending action starts", () => {
    const commit = vi.fn();
    const { result } = renderHook(() => usePendingAction());

    act(() => {
      result.current.start({ threadId: "t1", message: "Archived x", commit });
    });

    expect(commit).not.toHaveBeenCalled();
    expect(result.current.pending?.threadId).toBe("t1");
  });

  it("commits only after the full 5s grace period elapses", () => {
    const commit = vi.fn();
    const { result } = renderHook(() => usePendingAction());

    act(() => {
      result.current.start({ threadId: "t1", message: "Archived x", commit });
    });

    act(() => {
      vi.advanceTimersByTime(4999);
    });
    expect(commit).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(commit).toHaveBeenCalledOnce();
  });

  it("undo cancels the pending action — commit never fires", () => {
    const commit = vi.fn();
    const { result } = renderHook(() => usePendingAction());

    act(() => {
      result.current.start({ threadId: "t1", message: "Archived x", commit });
    });
    act(() => {
      result.current.undo();
    });
    expect(result.current.pending).toBeNull();

    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(commit).not.toHaveBeenCalled();
  });

  it("a second swipe starting before the first's grace elapsed commits the first immediately (never silently dropped)", () => {
    const firstCommit = vi.fn();
    const secondCommit = vi.fn();
    const { result } = renderHook(() => usePendingAction());

    act(() => {
      result.current.start({ threadId: "t1", message: "Archived x", commit: firstCommit });
    });
    act(() => {
      vi.advanceTimersByTime(1000);
      result.current.start({ threadId: "t2", message: "Archived y", commit: secondCommit });
    });

    expect(firstCommit).toHaveBeenCalledOnce();
    expect(secondCommit).not.toHaveBeenCalled();
    expect(result.current.pending?.threadId).toBe("t2");
  });
});
