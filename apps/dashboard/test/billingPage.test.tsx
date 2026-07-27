import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BillingPage } from "../src/pages/BillingPage";

function accountResponse(overrides: Partial<{ mailboxes: number; billableMailboxes: number; activationState: string; billingState: string; plan: string }> = {}) {
  return {
    tenantId: "t1",
    brand: "Test Co",
    plan: "demo",
    status: "active",
    billingState: "none",
    activationState: "sandbox",
    domains: 0,
    mailboxes: 0,
    // Defaults to the same value as `mailboxes` unless a test explicitly
    // diverges them (the round-2 adversary finding: mailboxes = count-all,
    // billableMailboxes = released_at IS NULL — the two diverge whenever any
    // mailbox has been soft-released: removeMailboxes, deliverability
    // auto-replacement, or teardown/cancel).
    billableMailboxes: overrides.mailboxes ?? 0,
    campaigns: 0,
    leads: 0,
    sends: 0,
    usageCents: 0,
    quota: { domains: 5, mailboxes: 20 },
    deliverability: { pausedMailboxes: 0, throttledMailboxes: 0, burningDomains: 0, domainsReplaced: 0, recentActions: [] },
    teardown: null,
    ...overrides,
  };
}

function renderBilling(fetchMock: typeof fetch) {
  global.fetch = fetchMock;
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <BillingPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function accountFetchMock(overrides?: Parameters<typeof accountResponse>[0]) {
  return vi.fn(async () => new Response(JSON.stringify(accountResponse(overrides)), { status: 200, headers: { "content-type": "application/json" } }));
}

afterEach(() => {
  vi.restoreAllMocks();
});

// Adversary BLOCKING #1 (golive-ux-review-2026-07-27.md finding 1): the
// server bills `checkoutMailboxQuantity(ctx) = max(5, provisioned)`
// (billing.ts:151, ignores input.mailboxes entirely) — any free-form
// selector on this page is a money-path lie. The Go-live section must quote
// the SAME max(5, provisioned) formula from the tenant's real provisioned
// count, with NO user-editable count. The adversary's exact gap: the old
// fixture used mailboxes:0, so the default selection of 5 happened to equal
// the floor by coincidence — every case below uses a NON-ZERO provisioned
// count too (0, 5, 12, and 72 — above the 60 self-serve ceiling) so the
// floor can never accidentally mask a disconnected selector again.
// A decoy count-all value every case below sets `mailboxes` to — DIFFERENT
// from the real billable count — so a regression back to reading `mailboxes`
// (the round-2 adversary's exact bug) fails these tests immediately instead
// of passing by coincidence.
const DECOY_COUNT_ALL = 999;

describe("BillingPage — Go live quotes the ACTUAL charge (BLOCKING #1)", () => {
  it.each([
    [0, 5, 9900], // floor: 0 billable -> billed for 5 -> $99
    [5, 5, 9900],
    [12, 12, 16900], // 49 + 10*12
    [72, 72, 76900], // ABOVE the 60 self-serve ceiling — server has NO upper cap (billing.ts:93), so the quote must not silently clamp at 60 either
  ])("billable=%i renders billed=%i mailboxes at the true (uncapped) charge — reads billableMailboxes, NOT the count-all `mailboxes`", async (billable, billed, cents) => {
    renderBilling(accountFetchMock({ mailboxes: DECOY_COUNT_ALL, billableMailboxes: billable }) as unknown as typeof fetch);

    const goLive = await screen.findByRole("region", { name: /go live/i });
    expect(goLive).toHaveTextContent(`${billed} mailboxes`);
    expect(goLive).toHaveTextContent(`$${(cents / 100).toLocaleString("en-US")}`);
    // the pitch framing line stays, but never the $49 platform-fee decomposition
    expect(goLive).toHaveTextContent(/starts at \$99 for 5 mailboxes, ?\+?\$10 per additional/i);
    expect(goLive).not.toHaveTextContent(/\$49/);
    expect(goLive).not.toHaveTextContent(String(DECOY_COUNT_ALL));
  });

  // Round-2 adversary finding (golive-ux-review-2026-07-27.md) — a canceled
  // tenant whose mailboxes were ALL soft-released by teardown (rows persist
  // with released_at set, never DELETEd) still shows `mailboxes: 12`
  // (count-all) while the billing meter (`billableMailboxes`) correctly
  // reads 0. The Go-live quote and "Active mailboxes" line must both follow
  // the billing meter, not the stale count-all — this is the reactivation
  // flow the builder's own gating (NB#3) makes reachable. FAILS on the old
  // code (old code derives `provisioned` from `account.data.mailboxes`).
  it("a canceled tenant with all mailboxes torn down quotes $99/5 mailboxes, not the stale pre-teardown count", async () => {
    renderBilling(accountFetchMock({ activationState: "canceled", mailboxes: 12, billableMailboxes: 0 }) as unknown as typeof fetch);

    const goLive = await screen.findByRole("region", { name: /go live/i });
    expect(goLive).toHaveTextContent("5 mailboxes");
    expect(goLive).toHaveTextContent("$99");
    expect(goLive).not.toHaveTextContent("12 mailboxes");
    expect(goLive).not.toHaveTextContent("$169");

    // The aside's count line must ALSO follow the billing meter (renamed for
    // honesty — "Provisioned now" implied a live count; "12" would be
    // confidently wrong for a torn-down tenant). Exact-match the dt label
    // (NOT a substring check) — the go-live pitch copy above legitimately
    // still says "...provisioned now" in ordinary prose.
    expect(await screen.findByText("Active mailboxes")).toBeInTheDocument();
    expect(screen.queryByText("Provisioned now")).not.toBeInTheDocument();
  });

  it("has NO free-form mailbox count control — the charge is derived, not selected", async () => {
    renderBilling(accountFetchMock({ billableMailboxes: 12 }) as unknown as typeof fetch);
    const goLive = await screen.findByRole("region", { name: /go live/i });
    expect(within(goLive).queryByRole("spinbutton")).not.toBeInTheDocument();
    expect(goLive.querySelector("input")).toBeNull();
  });

  it("POSTs /checkout with a request-body mailbox count clamped into the 5-60 schema range (seeds the request only — the server re-reads the live provisioned count)", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/checkout") && init?.method === "POST") {
        return new Response(JSON.stringify({ mode: "simulated", url: "https://example.com/checkout/simulate?tenant=t1&session=cs_1", sessionId: "cs_1" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify(accountResponse({ mailboxes: DECOY_COUNT_ALL, billableMailboxes: 72 })), { status: 200, headers: { "content-type": "application/json" } });
    });
    renderBilling(fetchMock as unknown as typeof fetch);

    await screen.findByRole("region", { name: /go live/i });
    fireEvent.click(screen.getByRole("button", { name: /go live/i }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([i, init]) => String(i).endsWith("/checkout") && init?.method === "POST")).toBe(true));

    const checkoutCall = fetchMock.mock.calls.find(([reqInput, reqInit]) => String(reqInput).endsWith("/checkout") && reqInit?.method === "POST")!;
    const [, checkoutInit] = checkoutCall;
    // 72 billable clamps to the schema's 60-mailbox ceiling for the SEED value only.
    expect(JSON.parse(String(checkoutInit?.body))).toEqual({ mailboxes: 60, interval: "month" });
  });
});

describe("BillingPage — Go live section", () => {
  it("POSTs /checkout with the CSRF header and redirects the browser to the returned url", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/checkout") && init?.method === "POST") {
        return new Response(JSON.stringify({ mode: "simulated", url: "https://example.com/checkout/simulate?tenant=t1&session=cs_1", sessionId: "cs_1" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify(accountResponse()), { status: 200, headers: { "content-type": "application/json" } });
    });
    renderBilling(fetchMock as unknown as typeof fetch);

    await screen.findByRole("region", { name: /go live/i });
    const originalLocation = window.location;
    // jsdom's window.location isn't directly assignable — swap in a writable stub.
    Object.defineProperty(window, "location", { value: { ...originalLocation, href: "" }, writable: true });

    fireEvent.click(screen.getByRole("button", { name: /go live/i }));

    await waitFor(() => expect(window.location.href).toBe("https://example.com/checkout/simulate?tenant=t1&session=cs_1"));

    const checkoutCall = fetchMock.mock.calls.find(([reqInput, reqInit]) => String(reqInput).endsWith("/checkout") && reqInit?.method === "POST");
    expect(checkoutCall).toBeTruthy();
    const [, checkoutInit] = checkoutCall!;
    expect((checkoutInit?.headers as Record<string, string>)["X-Coldstart-Client"]).toBe("dashboard");
    expect(JSON.parse(String(checkoutInit?.body))).toEqual({ mailboxes: 5, interval: "month" });

    Object.defineProperty(window, "location", { value: originalLocation, writable: true });
  });

  it("surfaces an error and does not redirect when the checkout request 4xxs", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/checkout") && init?.method === "POST") {
        return new Response(JSON.stringify({ error: "invalid mailbox count" }), { status: 400, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify(accountResponse()), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    renderBilling(fetchMock);

    await screen.findByRole("region", { name: /go live/i });
    fireEvent.click(screen.getByRole("button", { name: /go live/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/invalid mailbox count/i);
  });

  it("shows the promo-code guidance directly under the go-live button", async () => {
    renderBilling(accountFetchMock() as unknown as typeof fetch);

    const goLive = await screen.findByRole("region", { name: /go live/i });
    expect(goLive).toHaveTextContent(/have a promo code\? add it on the payment page/i);
    expect(goLive).toHaveTextContent(/add promotion code/i);
  });
});

// Adversary NB#3 (finding 3, client half) — reactivation (canceled/suspended)
// is intended, but an already-live tenant must never see a control that
// re-triggers checkout (server also 400s it independently — see
// apps/platform/test/checkout.test.ts's "already active" guard tests).
describe("BillingPage — Go live section is gated by activation state (NB#3)", () => {
  it.each(["sandbox", "canceled", "suspended"])("shown while activationState is '%s' (reactivation intended)", async (activationState) => {
    renderBilling(accountFetchMock({ activationState }) as unknown as typeof fetch);
    expect(await screen.findByRole("region", { name: /go live/i })).toBeInTheDocument();
  });

  it.each(["active", "pending_provisioning", "capacity_pending"])("hidden while activationState is '%s' (already live/paying)", async (activationState) => {
    renderBilling(accountFetchMock({ activationState }) as unknown as typeof fetch);
    // Wait for the account fetch to resolve via a marker that's always present.
    await screen.findByText(/current account/i);
    expect(screen.queryByRole("region", { name: /go live/i })).not.toBeInTheDocument();
  });
});
