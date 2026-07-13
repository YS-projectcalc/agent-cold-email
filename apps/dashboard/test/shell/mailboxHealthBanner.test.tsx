import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MailboxHealthBanner } from "../../src/shell/MailboxHealthBanner";
import { DESKTOP_QUERY } from "../../src/lib/useMediaQuery";

function setViewport(isDesktop: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: isDesktop && query === DESKTOP_QUERY,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

afterEach(() => {
  setViewport(false);
});

function accountResponse(overrides: Partial<{ pausedMailboxes: number; throttledMailboxes: number }>) {
  return {
    tenantId: "t1",
    brand: "Test Co",
    plan: "starter",
    status: "active",
    billingState: "ok",
    domains: 1,
    mailboxes: 4,
    campaigns: 1,
    leads: 10,
    sends: 20,
    usageCents: 0,
    quota: { domains: 5, mailboxes: 20 },
    deliverability: { pausedMailboxes: 0, throttledMailboxes: 0, burningDomains: 0, domainsReplaced: 0, recentActions: [], ...overrides },
    teardown: null,
  };
}

function renderBanner() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <MailboxHealthBanner />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// SPEC.md §19.6 [F7] — "persistent banner when any mailbox paused/throttled."
describe("MailboxHealthBanner", () => {
  it("renders nothing when no mailbox is paused or throttled", async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify(accountResponse({})), { status: 200 })) as unknown as typeof fetch;
    renderBanner();
    // Give the query a tick to resolve, then assert the banner never appears.
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("shows a paused-mailbox message and links to Settings (desktop: full label)", async () => {
    setViewport(true);
    global.fetch = vi.fn(async () => new Response(JSON.stringify(accountResponse({ pausedMailboxes: 2 })), { status: 200 })) as unknown as typeof fetch;
    renderBanner();
    expect(await screen.findByText(/2 mailboxes paused — sending stopped/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /review mailboxes/i })).toHaveAttribute("href", "/settings");
  });

  // M5 R2 item 1 nit — the message + link together used to truncate the
  // message mid-word at 390px; the link shortens to "Review" off desktop so
  // the (more important) message gets the room instead.
  it("mobile: shortens the link to 'Review' so the message doesn't have to compete for room", async () => {
    setViewport(false);
    global.fetch = vi.fn(async () => new Response(JSON.stringify(accountResponse({ pausedMailboxes: 2 })), { status: 200 })) as unknown as typeof fetch;
    renderBanner();
    expect(await screen.findByText(/2 mailboxes paused — sending stopped/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Review" })).toHaveAttribute("href", "/settings");
  });

  it("shows a throttled-mailbox message when only throttling applies", async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify(accountResponse({ throttledMailboxes: 1 })), { status: 200 })) as unknown as typeof fetch;
    renderBanner();
    expect(await screen.findByText(/1 mailbox throttled — sending slowed/i)).toBeInTheDocument();
  });

  it("shows both messages together when paused AND throttled", async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify(accountResponse({ pausedMailboxes: 1, throttledMailboxes: 3 })), { status: 200 })) as unknown as typeof fetch;
    renderBanner();
    expect(await screen.findByText(/1 mailbox paused — sending stopped/i)).toBeInTheDocument();
    expect(screen.getByText(/3 mailboxes throttled — sending slowed/i)).toBeInTheDocument();
  });

  it("has no dismiss control — it is non-dismissable while the condition holds", async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify(accountResponse({ pausedMailboxes: 1 })), { status: 200 })) as unknown as typeof fetch;
    renderBanner();
    await screen.findByRole("status");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
