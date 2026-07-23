import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../src/auth/AuthProvider";
import { SignupPage } from "../src/auth/SignupPage";

function renderSignup() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={["/signup"]}>
      <QueryClientProvider client={queryClient}>
        <AuthProvider><SignupPage /></AuthProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe("SignupPage", () => {
  it("creates a sandbox and makes the one-time token warning unavoidable", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/signup") && init?.method === "POST") {
        return new Response(JSON.stringify({ tenantId: "tenant_test", token: "coldrig_test_secret" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: "missing bearer token", code: "invalid_token" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    renderSignup();
    fireEvent.change(screen.getByLabelText(/company or brand/i), { target: { value: "Northstar" } });
    fireEvent.change(screen.getByLabelText(/work email/i), { target: { value: "owner@northstar.example" } });
    fireEvent.click(screen.getByRole("button", { name: /free sign up/i }));

    expect(await screen.findByRole("heading", { name: /save your tenant token now/i })).toBeInTheDocument();
    expect(screen.getByText("coldrig_test_secret")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /open setup checklist/i })).toBeDisabled();

    const signupCall = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(String(signupCall?.[1]?.body))).toEqual({ brand: "Northstar", contactEmail: "owner@northstar.example" });
  });
});
