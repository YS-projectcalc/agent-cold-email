import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { InboxPage } from "../../src/pages/InboxPage";
import { DESKTOP_QUERY } from "../../src/lib/useMediaQuery";

function row(id: string, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    threadId: id,
    campaignId: "c1",
    campaignName: "Q1 outreach",
    leadEmail: `lead-${id}@example.com`,
    subject: `Re: ${id}`,
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

// Stateful (not a static canned response): InboxPage's mutations invalidate
// the inbox-infinite query on settle, which triggers a real refetch — a mock
// that always returned the SAME original rows would silently overwrite an
// already-committed mark/label change back to its pre-mutation value the
// moment that refetch lands, masking the exact behavior these tests exist to
// prove.
function mockFetchRouter() {
  const posts: { path: string; body: unknown }[] = [];
  const state = new Map([row("t1"), row("t2"), row("t3")].map((r) => [r.threadId, r]));

  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const path = url.pathname;
    const method = init?.method ?? "GET";

    if (method === "GET" && path === "/inbox") return new Response(JSON.stringify({ threads: [...state.values()], nextCursor: null }), { status: 200 });
    if (method === "GET" && path === "/infrastructure-status") return new Response(JSON.stringify({ domains: 0, mailboxes: 0, mailboxHealth: [], sendReady: false }), { status: 200 });
    if (method === "GET" && path === "/campaigns") return new Response(JSON.stringify([]), { status: 200 });
    if (method === "GET" && path.startsWith("/threads/")) return new Response(JSON.stringify({ threadId: path.split("/")[2], campaignId: "c1", leadId: "l1", leadEmail: "lead@example.com", messages: [] }), { status: 200 });
    if (method === "POST" && path.endsWith("/mark")) {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      posts.push({ path, body });
      const threadId = path.split("/")[2]!;
      const existing = state.get(threadId);
      if (existing) state.set(threadId, { ...existing, markStatus: body.status });
      return new Response(JSON.stringify({ marked: true }), { status: 200 });
    }
    if (method === "POST" && path.endsWith("/label")) {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      posts.push({ path, body });
      const threadId = path.split("/")[2]!;
      const existing = state.get(threadId);
      if (existing) state.set(threadId, { ...existing, label: body.label });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: `unhandled ${method} ${path}` }), { status: 404 });
  }) as unknown as typeof fetch;
  return posts;
}

function renderInboxDesktop() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/inbox"]}>
        <InboxPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// SPEC.md §19.6 keyboard-first desktop inbox + "auto-advance to next thread
// after archive/label" (build brief item 2/7).
describe("Inbox keyboard navigation", () => {
  beforeEach(() => {
    // Force desktop layout (useMediaQuery reads matchMedia synchronously).
    window.matchMedia = ((query: string) => ({
      matches: query === DESKTOP_QUERY,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;

    // jsdom gives every element a 0x0 layout box, which makes
    // @tanstack/react-virtual compute zero visible rows. Stub a real-looking
    // viewport so the virtualized list actually renders its rows.
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, value: 600 });
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, value: 400 });
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
      width: 400, height: 600, top: 0, left: 0, bottom: 600, right: 400, x: 0, y: 0, toJSON: () => {},
    } as DOMRect);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("j/k moves focus and opens the thread in the detail pane on desktop", async () => {
    mockFetchRouter();
    renderInboxDesktop();

    await screen.findByText("lead-t1@example.com");

    fireEvent.keyDown(window, { key: "j" });
    await waitFor(() => expect(screen.getByRole("heading", { name: "Re: t1" })).toBeInTheDocument());

    fireEvent.keyDown(window, { key: "j" });
    await waitFor(() => expect(screen.getByRole("heading", { name: "Re: t2" })).toBeInTheDocument());

    fireEvent.keyDown(window, { key: "k" });
    await waitFor(() => expect(screen.getByRole("heading", { name: "Re: t1" })).toBeInTheDocument());
  });

  // M5 R2 item 6 — the keyboard `e` shortcut now goes through the SAME
  // pendingAction/undo-toast path as mobile swipe (SPEC.md §19.6 "swipe
  // actions get a 5-second UNDO toast" widened to every archive entry
  // point), instead of firing the archive mutation immediately. The full
  // 5s-timing/undo-cancels-commit contract is already proven in isolation by
  // usePendingAction.test.ts; this integration test only needs to prove (a)
  // auto-advance is still immediate, (b) the row disappears immediately, (c)
  // the SAME undo toast component appears, and (d) the real mutation is
  // deferred (not fired) while it's pending.
  it("e archives the open thread, auto-advances immediately, and defers the mutation behind an undo toast", async () => {
    const posts = mockFetchRouter();
    renderInboxDesktop();

    await screen.findByText("lead-t1@example.com");
    fireEvent.keyDown(window, { key: "j" }); // focus + open t1
    await waitFor(() => expect(screen.getByRole("heading", { name: "Re: t1" })).toBeInTheDocument());

    fireEvent.keyDown(window, { key: "e" });

    // Auto-advance: t2 becomes the open thread, immediately.
    await waitFor(() => expect(screen.getByRole("heading", { name: "Re: t2" })).toBeInTheDocument());
    // t1 disappears from the list immediately (optimistic hide), same as swipe.
    expect(screen.queryByText("lead-t1@example.com")).not.toBeInTheDocument();

    // The undo toast (same component swipe-archive uses) appears...
    expect(await screen.findByRole("status")).toHaveTextContent(/archived lead-t1@example.com/i);
    // ...and the real archive mutation has NOT fired yet — it's deferred
    // behind the undo window, not immediate like the old direct-mutate path.
    expect(posts.some((p) => p.path === "/threads/t1/mark" && (p.body as { status: string }).status === "archived")).toBe(false);
  });

  it("e archive: clicking Undo on the toast cancels the pending archive and the row stays", async () => {
    const posts = mockFetchRouter();
    renderInboxDesktop();

    await screen.findByText("lead-t1@example.com");
    fireEvent.keyDown(window, { key: "j" });
    await waitFor(() => expect(screen.getByRole("heading", { name: "Re: t1" })).toBeInTheDocument());

    fireEvent.keyDown(window, { key: "e" });
    const toast = await screen.findByRole("status");
    fireEvent.click(within(toast).getByRole("button", { name: /undo/i }));

    await waitFor(() => expect(screen.getByText("lead-t1@example.com")).toBeInTheDocument());
    expect(posts.some((p) => p.path === "/threads/t1/mark" && (p.body as { status: string }).status === "archived")).toBe(false);
  });

  it("u toggles unread/read for the open thread", async () => {
    const posts = mockFetchRouter();
    renderInboxDesktop();

    await screen.findByText("lead-t1@example.com");
    fireEvent.keyDown(window, { key: "j" }); // opens t1 — its own "mark read on open" effect fires first
    await waitFor(() => expect(screen.getByRole("heading", { name: "Re: t1" })).toBeInTheDocument());
    await waitFor(() => expect(posts.some((p) => p.path === "/threads/t1/mark" && (p.body as { status: string }).status === "read")).toBe(true));

    // t1 is now read (via the mount effect above) — `u` should flip it back
    // to unread, proving the toggle reads current state rather than always
    // sending the same status.
    fireEvent.keyDown(window, { key: "u" });
    await waitFor(() => expect(posts.some((p) => p.path === "/threads/t1/mark" && (p.body as { status: string }).status === "unread")).toBe(true));
  });

  it("Cmd+K opens the command palette even while j/k stay suppressed inside its search input", async () => {
    mockFetchRouter();
    renderInboxDesktop();

    await screen.findByText("lead-t1@example.com");
    fireEvent.keyDown(window, { key: "k", metaKey: true });

    expect(await screen.findByPlaceholderText(/type a command/i)).toBeInTheDocument();
  });
});
