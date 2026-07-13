import { describe, expect, it, vi } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useInboxInfinite, useLabelThread } from "../../src/api/queries";

function makeWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

function seedRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    threadId: "t1",
    campaignId: "c1",
    campaignName: "Q1 outreach",
    leadEmail: "lead@example.com",
    subject: "Re: intro",
    snippet: "sounds good",
    mailboxEmail: "founder@tryacme.com",
    mailboxDelivStatus: "healthy",
    label: null,
    labelSource: null,
    lastEventType: "reply",
    lastEventTs: 1000,
    markStatus: "unread",
    ...overrides,
  };
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Build brief test requirement — "label set/clear optimistic update +
// rollback on error". SPEC.md §19.7 DoD. The mocked POST is deliberately
// delayed: a same-tick mock response would make the optimistic state and its
// resolution indistinguishable in a test (the whole onMutate→mutationFn→
// onError chain would settle within one microtask flush), which is exactly
// the failure mode this test needs to rule out.
describe("useLabelThread optimistic update", () => {
  it("applies the label to the cached row immediately, before the network call resolves — then rolls back on a failed request", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = makeWrapper(qc);

    global.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        await delay(80);
        return new Response(JSON.stringify({ error: "label rejected" }), { status: 500 });
      }
      return new Response(JSON.stringify({ threads: [seedRow()], nextCursor: null }), { status: 200 });
    }) as unknown as typeof fetch;

    const inbox = renderHook(() => useInboxInfinite({ includeNonreply: false }), { wrapper });
    await waitFor(() => expect(inbox.result.current.isSuccess).toBe(true));
    expect(inbox.result.current.data?.pages[0]?.threads[0]?.label).toBeNull();

    const labelMutation = renderHook(() => useLabelThread(), { wrapper });
    act(() => {
      labelMutation.result.current.mutate({ threadId: "t1", label: "interested" });
    });

    // Optimistic: visible while the (deliberately slow) POST is still pending.
    await waitFor(() => expect(inbox.result.current.data?.pages[0]?.threads[0]?.label).toBe("interested"));
    expect(labelMutation.result.current.isPending).toBe(true);

    // Rollback: once the failed request settles, the row reverts.
    await waitFor(() => expect(labelMutation.result.current.isError).toBe(true));
    await waitFor(() => expect(inbox.result.current.data?.pages[0]?.threads[0]?.label).toBeNull());
  });

  it("clearing a label (null) also applies optimistically and persists on success", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = makeWrapper(qc);

    // Stateful, not a static canned response: onSettled invalidates the
    // inbox-infinite query, triggering a real refetch — a mock that always
    // returned the ORIGINAL "not_now" row would silently overwrite the
    // already-committed clear back to "not_now" the moment that refetch
    // lands, masking the exact behavior this test exists to prove.
    let currentLabel: string | null = "not_now";
    global.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        await delay(80);
        currentLabel = (JSON.parse(String(init.body)) as { label: string | null }).label;
        return new Response(JSON.stringify({ label: currentLabel }), { status: 200 });
      }
      return new Response(JSON.stringify({ threads: [seedRow({ label: currentLabel, labelSource: "mcp" })], nextCursor: null }), { status: 200 });
    }) as unknown as typeof fetch;

    const inbox = renderHook(() => useInboxInfinite({ includeNonreply: false }), { wrapper });
    await waitFor(() => expect(inbox.result.current.isSuccess).toBe(true));
    expect(inbox.result.current.data?.pages[0]?.threads[0]?.label).toBe("not_now");

    const labelMutation = renderHook(() => useLabelThread(), { wrapper });
    act(() => {
      labelMutation.result.current.mutate({ threadId: "t1", label: null });
    });

    // Optimistic clear, visible before the (slow) POST resolves.
    await waitFor(() => expect(inbox.result.current.data?.pages[0]?.threads[0]?.label).toBeNull());
    expect(labelMutation.result.current.isPending).toBe(true);

    await waitFor(() => expect(labelMutation.result.current.isSuccess).toBe(true));
    expect(inbox.result.current.data?.pages[0]?.threads[0]?.label).toBeNull();
  });
});
