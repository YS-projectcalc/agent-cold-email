import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../src/auth/AuthProvider";
import { RecoveryPage } from "../src/auth/RecoveryPage";

function renderRecovery() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={["/recover"]}>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <RecoveryPage />
        </AuthProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe("RecoveryPage — magic-link request form", () => {
  it("submits the email to POST /login and shows the enumeration-safe confirmation", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/login") && init?.method === "POST") {
        return new Response(JSON.stringify({ ok: true, message: "If an account exists for that email, we've sent a sign-in link." }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: "missing bearer token", code: "invalid_token" }), { status: 401 });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    renderRecovery();
    fireEvent.change(screen.getByLabelText(/account email/i), { target: { value: "  owner@northstar.example  " } });
    fireEvent.click(screen.getByRole("button", { name: /email me a sign-in link/i }));

    expect(await screen.findByRole("heading", { name: /sign-in link is on its way/i })).toBeInTheDocument();

    const requestCall = fetchMock.mock.calls.find(([input, init]) => String(input).endsWith("/login") && init?.method === "POST");
    // Trimmed before send — a copy-pasted trailing space must not become a
    // silently-different lookup key than the one that will be typed at login.
    expect(JSON.parse(String(requestCall?.[1]?.body))).toEqual({ email: "owner@northstar.example" });
  });

  it("shows the same confirmation copy regardless of whether the account exists (no UI enumeration signal)", async () => {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, message: "If an account exists for that email, we've sent a sign-in link." }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ) as unknown as typeof fetch;

    renderRecovery();
    fireEvent.change(screen.getByLabelText(/account email/i), { target: { value: "never-registered@northstar.example" } });
    fireEvent.click(screen.getByRole("button", { name: /email me a sign-in link/i }));

    expect(await screen.findByRole("heading", { name: /sign-in link is on its way/i })).toBeInTheDocument();
  });

  it("shows an error message when the request itself fails (e.g. rate limited)", async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ error: "rate limited — too many sign-in requests for this address, try again shortly" }), { status: 429 })) as unknown as typeof fetch;

    renderRecovery();
    fireEvent.change(screen.getByLabelText(/account email/i), { target: { value: "burst@northstar.example" } });
    fireEvent.click(screen.getByRole("button", { name: /email me a sign-in link/i }));

    await screen.findByRole("alert");
    expect(screen.getByRole("alert")).toHaveTextContent(/rate limited/i);
  });
});
