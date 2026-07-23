import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, fireEvent } from "@testing-library/react";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { AuthProvider, useAuth } from "../src/auth/AuthProvider";
import { LoginVerifyPage } from "../src/auth/LoginVerifyPage";

function DashboardProbe() {
  const { status, tenantId } = useAuth();
  return <div data-testid="dashboard-probe">status={status} tenant={tenantId}</div>;
}

function renderVerify(initialPath: string) {
  window.history.pushState({}, "", initialPath);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <BrowserRouter>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <Routes>
            <Route path="/login" element={<LoginVerifyPage />} />
            <Route path="/dashboard" element={<DashboardProbe />} />
          </Routes>
        </AuthProvider>
      </QueryClientProvider>
    </BrowserRouter>,
  );
}

// Every test's AuthProvider bootstrap probes GET /account on mount — always
// unauthed here so it never interferes with the consume assertions below.
function mockFetch(consumeResponse: () => Response) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith("/login/consume") && init?.method === "POST") return consumeResponse();
    return new Response(JSON.stringify({ error: "missing bearer token", code: "invalid_token" }), { status: 401 });
  });
}

describe("LoginVerifyPage — missing token", () => {
  it("shows an explanatory error when the page loads with no ?token", async () => {
    global.fetch = mockFetch(() => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    renderVerify("/login");
    expect(await screen.findByRole("heading", { name: /missing its token/i })).toBeInTheDocument();
  });
});

describe("LoginVerifyPage — single-tenant auto-complete (§1.4)", () => {
  it("consumes the token, strips it from the URL, completes the session, and lands on /dashboard", async () => {
    const fetchMock = mockFetch(() => new Response(JSON.stringify({ tenantId: "ten_verify_1" }), { status: 200, headers: { "content-type": "application/json" } }));
    global.fetch = fetchMock as unknown as typeof fetch;

    renderVerify("/login?token=raw-magic-token");

    const probe = await screen.findByTestId("dashboard-probe");
    expect(probe).toHaveTextContent("status=authed");
    expect(probe).toHaveTextContent("tenant=ten_verify_1");

    // §1.4/§1.8 — the token must never linger in the URL (back-button replay).
    expect(window.location.search).not.toContain("token");

    const consumeCall = fetchMock.mock.calls.find(([input]) => String(input).endsWith("/login/consume"));
    expect(JSON.parse(String(consumeCall?.[1]?.body))).toEqual({ token: "raw-magic-token" });
  });
});

describe("LoginVerifyPage — multi-tenant picker (§1.5)", () => {
  it("renders a picker list without navigating, then completes on pick", async () => {
    let pickCallCount = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/login/consume") && init?.method === "POST") {
        pickCallCount += 1;
        const body = JSON.parse(String(init.body)) as { token: string; tenantId?: string };
        if (body.tenantId) {
          return new Response(JSON.stringify({ tenantId: body.tenantId }), { status: 200, headers: { "content-type": "application/json" } });
        }
        return new Response(
          JSON.stringify({ tenants: [{ tenantId: "ten_a", brand: "Brand A" }, { tenantId: "ten_b", brand: "Brand B" }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ error: "missing bearer token", code: "invalid_token" }), { status: 401 });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    renderVerify("/login?token=raw-picker-token");

    expect(await screen.findByRole("heading", { name: /which account/i })).toBeInTheDocument();
    expect(screen.getByText("Brand A")).toBeInTheDocument();
    expect(screen.getByText("Brand B")).toBeInTheDocument();
    expect(pickCallCount).toBe(1);

    fireEvent.click(screen.getByText("Brand B"));

    const probe = await screen.findByTestId("dashboard-probe");
    expect(probe).toHaveTextContent("status=authed");
    expect(probe).toHaveTextContent("tenant=ten_b");
    expect(pickCallCount).toBe(2);
  });
});

describe("LoginVerifyPage — invalid/expired link", () => {
  it("shows the server's rejection message", async () => {
    global.fetch = mockFetch(() => new Response(JSON.stringify({ error: "invalid or expired sign-in link" }), { status: 401, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    renderVerify("/login?token=stale-token");

    expect(await screen.findByRole("heading", { name: /invalid or has expired/i })).toBeInTheDocument();
    expect(screen.getByText("invalid or expired sign-in link")).toBeInTheDocument();
  });
});
