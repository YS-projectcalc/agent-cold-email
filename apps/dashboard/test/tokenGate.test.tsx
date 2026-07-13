import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider } from "../src/auth/AuthProvider";
import { TokenGate } from "../src/auth/TokenGate";
import { emitUnauthorized } from "../src/api/unauthorizedBus";

function renderTokenGate() {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <TokenGate />
      </AuthProvider>
    </QueryClientProvider>,
  );
}

// SPEC.md §19.1/§19.6 — "401 from any API → return to token-gate with
// explanation." apps/platform/src/require-auth.ts's AuthFailureCode
// ('invalid_token' | 'expired_session' | 'account_suspended') is now a
// machine-readable `code` on every 401 body (backend gaps brief item 4) —
// TokenGate renders a DISTINCT, honest explanation per code instead of one
// generic "session ended" banner.
describe("TokenGate", () => {
  it("shows the login form once the initial /account probe resolves unauthed", async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ error: "missing bearer token", code: "invalid_token" }), { status: 401 })) as unknown as typeof fetch;
    renderTokenGate();
    expect(await screen.findByRole("heading", { name: /sign in to your dashboard/i })).toBeInTheDocument();
  });

  it("shows the server's rejection message after an invalid-token submit", async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        return new Response(JSON.stringify({ error: "invalid or inactive token", code: "invalid_token" }), { status: 401 });
      }
      return new Response(JSON.stringify({ error: "missing bearer token", code: "invalid_token" }), { status: 401 });
    }) as unknown as typeof fetch;

    renderTokenGate();
    await screen.findByRole("heading", { name: /sign in to your dashboard/i });

    fireEvent.change(screen.getByLabelText(/tenant token/i), { target: { value: "bad-token" } });
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("invalid or inactive token"));
  });

  it("shows an 'expired session' explanation for code=expired_session", async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ error: "missing bearer token", code: "invalid_token" }), { status: 401 })) as unknown as typeof fetch;
    renderTokenGate();
    await screen.findByRole("heading", { name: /sign in to your dashboard/i });

    emitUnauthorized("expired_session");

    expect(await screen.findByText(/session expired/i)).toBeInTheDocument();
  });

  it("shows an 'account suspended' explanation for code=account_suspended", async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ error: "missing bearer token", code: "invalid_token" }), { status: 401 })) as unknown as typeof fetch;
    renderTokenGate();
    await screen.findByRole("heading", { name: /sign in to your dashboard/i });

    emitUnauthorized("account_suspended");

    expect(await screen.findByText(/suspended/i)).toBeInTheDocument();
  });

  it("shows an 'invalid token' explanation (distinct from the other two) for code=invalid_token dropping mid-session", async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ error: "missing bearer token", code: "invalid_token" }), { status: 401 })) as unknown as typeof fetch;
    renderTokenGate();
    await screen.findByRole("heading", { name: /sign in to your dashboard/i });

    emitUnauthorized("invalid_token");

    const alert = await screen.findByRole("alert");
    expect(alert).not.toHaveTextContent(/suspended/i);
    expect(alert).not.toHaveTextContent(/expired/i);
  });
});
