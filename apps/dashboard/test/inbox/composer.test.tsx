import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Composer } from "../../src/inbox/Composer";

function renderComposer(mailboxEmail: string | null, onSent = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <Composer threadId="thr_1" mailboxEmail={mailboxEmail} onSent={onSent} />
    </QueryClientProvider>,
  );
}

// SPEC.md §19.6 — "explicitly states which mailbox it sends from
// ('Replying from founderoutreach11@… — the mailbox that owns this thread')".
describe("Composer", () => {
  it("states which mailbox the reply will send from", () => {
    renderComposer("founderoutreach11@tryacme.com");
    expect(screen.getByText(/replying from/i)).toBeInTheDocument();
    expect(screen.getByText("founderoutreach11@tryacme.com")).toBeInTheDocument();
    expect(screen.getByText(/the mailbox that owns this thread/i)).toBeInTheDocument();
  });

  it("disables the textarea and shows an explanatory line when no sending mailbox is on record", () => {
    renderComposer(null);
    expect(screen.getByPlaceholderText(/write a reply/i)).toBeDisabled();
    expect(screen.getByText(/no sending mailbox on record/i)).toBeInTheDocument();
  });

  it("sends a reply and calls onSent, clearing the textarea", async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ messageId: "m1" }), { status: 201 })) as unknown as typeof fetch;
    const onSent = vi.fn();
    renderComposer("founder@tryacme.com", onSent);

    const textarea = screen.getByPlaceholderText(/write a reply/i);
    fireEvent.change(textarea, { target: { value: "Thanks for the reply!" } });
    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));

    await waitFor(() => expect(onSent).toHaveBeenCalledOnce());
    expect((textarea as HTMLTextAreaElement).value).toBe("");
  });

  it("surfaces a send error instead of silently failing", async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ error: "vendor rejected the send" }), { status: 502 })) as unknown as typeof fetch;
    renderComposer("founder@tryacme.com");

    fireEvent.change(screen.getByPlaceholderText(/write a reply/i), { target: { value: "Hi there" } });
    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/vendor rejected the send/i);
  });
});
