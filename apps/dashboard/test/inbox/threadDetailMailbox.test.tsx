import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThreadDetailPane } from "../../src/inbox/ThreadDetailPane";
import type { InboxRow } from "../../src/api/types";

function seedRow(overrides: Partial<InboxRow> = {}): InboxRow {
  return {
    threadId: "t1",
    campaignId: "c1",
    campaignName: "Q1 outreach",
    leadEmail: "lead@example.com",
    subject: "Re: intro",
    snippet: "sounds good",
    mailboxEmail: null,
    mailboxDelivStatus: null,
    label: null,
    labelSource: null,
    lastEventType: "reply",
    lastEventTs: 1000,
    markStatus: "read", // avoid the "mark read on open" effect firing a second fetch
    ...overrides,
  };
}

function renderPane(row: InboxRow) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ThreadDetailPane
        row={row}
        isMobile={false}
        onBack={() => {}}
        onSetLabel={() => {}}
        labelPickerOpen={false}
        onToggleLabelPicker={() => {}}
      />
    </QueryClientProvider>,
  );
}

// Backend gaps brief item 2 / M4 — GET /threads/:id now carries its own
// mailboxEmail (apps/platform/src/engine/threads.ts). The composer must
// prefer THAT value over the inbox list row's (which may be stale, absent on
// a deep link, or simply not yet loaded) — the whole point of the backend
// fix landing here.
describe("ThreadDetailPane — mailboxEmail source (backend gaps brief item 2)", () => {
  it("uses GET /threads/:id's own mailboxEmail even when the list row has none (deep-link case)", async () => {
    global.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          threadId: "t1",
          campaignId: "c1",
          leadId: "l1",
          leadEmail: "lead@example.com",
          mailboxEmail: "fresh-from-thread-detail@tryacme.com",
          messages: [],
        }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;

    renderPane(seedRow({ mailboxEmail: null }));

    await waitFor(() => expect(screen.getByText("fresh-from-thread-detail@tryacme.com")).toBeInTheDocument());
  });

  it("falls back to the list row's mailboxEmail while the thread detail is still loading", () => {
    global.fetch = vi.fn(() => new Promise(() => {})) as unknown as typeof fetch; // never resolves

    renderPane(seedRow({ mailboxEmail: "from-list-row@tryacme.com" }));

    expect(screen.getByText("from-list-row@tryacme.com")).toBeInTheDocument();
  });
});
