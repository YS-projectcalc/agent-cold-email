import { describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useInboxInfinite, type InboxFilters } from "../../src/api/queries";

// One QueryClient per test, created ONCE and closed over — NOT recreated
// inside the wrapper component body. A `function wrapper({children}) { new
// QueryClient() ...}` form looks equivalent but isn't: React re-invokes that
// function component on every re-render of the tree (which `fetchNextPage`
// triggers), silently handing the hook a FRESH empty cache mid-test. This is
// the actual TanStack Query-recommended `renderHook` wrapper pattern.
function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

function mockFetchCapturingUrl() {
  const calls: string[] = [];
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return new Response(JSON.stringify({ threads: [], nextCursor: null }), { status: 200 });
  }) as unknown as typeof fetch;
  return calls;
}

// Build brief test requirement — "filter→query-param assembly incl.
// include_nonreply default false". SPEC.md §19.6 — the SPA's own default is
// OFF even though the server's own backward-compat default is `true`
// (packages/shared/src/dashboard.ts InboxQueryInput).
describe("useInboxInfinite query-param assembly", () => {
  it("sends include_nonreply=false when the filter is off (the SPA default)", async () => {
    const calls = mockFetchCapturingUrl();
    const filters: InboxFilters = { includeNonreply: false };
    const { result } = renderHook(() => useInboxInfinite(filters), { wrapper: makeWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(calls[0]).toContain("include_nonreply=false");
  });

  it("sends include_nonreply=true when the 'Bounces & OOO' toggle is on", async () => {
    const calls = mockFetchCapturingUrl();
    const filters: InboxFilters = { includeNonreply: true };
    const { result } = renderHook(() => useInboxInfinite(filters), { wrapper: makeWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(calls[0]).toContain("include_nonreply=true");
  });

  it("assembles mailbox/campaign/label/read into the query string, omitting unset filters", async () => {
    const calls = mockFetchCapturingUrl();
    const filters: InboxFilters = { includeNonreply: false, mailbox: "founder@tryacme.com", campaign: "camp_1", label: "interested", read: false };
    const { result } = renderHook(() => useInboxInfinite(filters), { wrapper: makeWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const url = new URL(calls[0]!, "http://localhost");
    expect(url.searchParams.get("mailbox")).toBe("founder@tryacme.com");
    expect(url.searchParams.get("campaign")).toBe("camp_1");
    expect(url.searchParams.get("label")).toBe("interested");
    expect(url.searchParams.get("read")).toBe("false");
    expect(url.searchParams.get("include_nonreply")).toBe("false");
  });

  it("omits mailbox/campaign/label/read entirely when unset (backward-compatible bare request)", async () => {
    const calls = mockFetchCapturingUrl();
    const { result } = renderHook(() => useInboxInfinite({ includeNonreply: false }), { wrapper: makeWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const url = new URL(calls[0]!, "http://localhost");
    expect(url.searchParams.has("mailbox")).toBe(false);
    expect(url.searchParams.has("campaign")).toBe(false);
    expect(url.searchParams.has("label")).toBe(false);
    expect(url.searchParams.has("read")).toBe(false);
  });

  // Backend gaps brief item 1/8 — inbox v2 gained a server-side `archived`
  // filter (default "exclude"); InboxPage's own client-side markStatus
  // filter used to be the ONLY thing excluding archived threads (wasting
  // page slots at scale). Sending `archived=exclude` explicitly documents
  // the SPA's reliance on it rather than leaning on an implicit server
  // default that could silently change later.
  it("always sends archived=exclude (the server-side filter InboxPage now relies on)", async () => {
    const calls = mockFetchCapturingUrl();
    const { result } = renderHook(() => useInboxInfinite({ includeNonreply: false }), { wrapper: makeWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const url = new URL(calls[0]!, "http://localhost");
    expect(url.searchParams.get("archived")).toBe("exclude");
  });

  it("passes the server's nextCursor forward on fetchNextPage", async () => {
    let call = 0;
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      call += 1;
      const url = new URL(String(input), "http://localhost");
      if (call === 1) {
        expect(url.searchParams.has("cursor")).toBe(false);
        return new Response(JSON.stringify({ threads: [{ threadId: "t1" }], nextCursor: "100:5" }), { status: 200 });
      }
      expect(url.searchParams.get("cursor")).toBe("100:5");
      return new Response(JSON.stringify({ threads: [], nextCursor: null }), { status: 200 });
    }) as unknown as typeof fetch;

    const { result } = renderHook(() => useInboxInfinite({ includeNonreply: false }), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    // Fire-and-let-`waitFor`-observe, rather than manually `act`-wrapping the
    // await: this was observed intermittently flaky under full-suite
    // parallel load with a manual `act(async () => await fetchNextPage())`
    // wrapper (the assertion below is what actually needs to retry, not the
    // call itself).
    void result.current.fetchNextPage();
    await waitFor(() => expect(result.current.data?.pages.length).toBe(2));
    expect(result.current.data?.pages[1]?.threads).toEqual([]);
  });
});
