import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MessagesPage } from "../src/pages/MessagesPage";

// W-M5 (docs/adversarial/sweep-completeness-pass-2026-08-17.md) — before this
// page existed, the dashboard had no field on its InfrastructureStatus DTO
// AND no component to render `tenant_messages` at all: an operator reply
// sent while the tenant's own agent session wasn't running had nowhere to
// surface for a human. This is the closure test for that data path.
function messagesResponse(messages: unknown[], nextCursor: string | null = null) {
  return { messages, nextCursor };
}

function anOperatorMessage(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "tmsg_1",
    kind: "operator_reply",
    severity: "info",
    body: "Your account is back in good standing — thanks for the update.",
    actionHint: null,
    source: "operator",
    createdAt: Date.now() - 60_000,
    readAt: null,
    ...overrides,
  };
}

function renderMessages(fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  global.fetch = vi.fn(fetchImpl) as unknown as typeof fetch;
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <MessagesPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("MessagesPage — the dashboard's human fallback onto tenant_messages", () => {
  it("renders an unread operator message with its body, an 'Acknowledge' action, and NOT the empty-state copy", async () => {
    renderMessages(async (input) => {
      if (String(input).startsWith("/messages?")) {
        return new Response(JSON.stringify(messagesResponse([anOperatorMessage()])), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected fetch: ${input}`);
    });

    expect(await screen.findByText(/back in good standing/i)).toBeInTheDocument();
    expect(screen.getByText("From operator")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /acknowledge/i })).toBeInTheDocument();
    expect(screen.queryByText(/no messages yet/i)).not.toBeInTheDocument();
  });

  it("shows the empty state when there are no messages", async () => {
    renderMessages(async () => new Response(JSON.stringify(messagesResponse([])), { status: 200, headers: { "content-type": "application/json" } }));
    expect(await screen.findByText(/no messages yet/i)).toBeInTheDocument();
  });

  it("clicking Acknowledge POSTs /messages/:id/ack and flips the row to acknowledged", async () => {
    const ackCalls: string[] = [];
    let acked = false; // stateful mock: the post-mutation refetch must reflect the real server state, not replay the original unread row
    renderMessages(async (input, init) => {
      const url = String(input);
      if (url.startsWith("/messages?")) {
        return new Response(JSON.stringify(messagesResponse([anOperatorMessage({ readAt: acked ? Date.now() : null })])), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.endsWith("/ack") && init?.method === "POST") {
        ackCalls.push(url);
        acked = true;
        return new Response(JSON.stringify({ acked: true, alreadyAcked: false }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    await screen.findByText(/back in good standing/i);
    fireEvent.click(screen.getByRole("button", { name: /acknowledge/i }));

    await waitFor(() => expect(ackCalls).toEqual(["/messages/tmsg_1/ack"]));
    await waitFor(() => expect(screen.getByText("Acknowledged")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /acknowledge/i })).not.toBeInTheDocument();
  });

  it("does not render an Acknowledge action for an already-read message", async () => {
    renderMessages(async (input) => {
      if (String(input).startsWith("/messages?")) {
        return new Response(JSON.stringify(messagesResponse([anOperatorMessage({ readAt: Date.now() - 1000 })])), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected fetch: ${input}`);
    });

    await screen.findByText(/back in good standing/i);
    expect(screen.queryByRole("button", { name: /acknowledge/i })).not.toBeInTheDocument();
    expect(screen.getByText("Acknowledged")).toBeInTheDocument();
  });
});
