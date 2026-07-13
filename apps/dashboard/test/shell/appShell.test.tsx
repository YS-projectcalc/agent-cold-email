import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Widget } from "@coldstart/shared";
import { AppShell } from "../../src/shell/AppShell";
import { MailboxHealthBanner } from "../../src/shell/MailboxHealthBanner";
import { DashboardGrid } from "../../src/dashboard/Grid";

function accountResponse(paused: number) {
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
    deliverability: { pausedMailboxes: paused, throttledMailboxes: 0, burningDomains: 0, domainsReplaced: 0, recentActions: [] },
    teardown: null,
  };
}

function renderShellAt(path: string, paused: number) {
  global.fetch = vi.fn(async () => new Response(JSON.stringify(accountResponse(paused)), { status: 200 })) as unknown as typeof fetch;
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<AppShell />}>
            <Route path="dashboard" element={<div>Dashboard content</div>} />
            <Route path="inbox" element={<div>Inbox content</div>} />
            <Route path="settings" element={<div>Settings content</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// SPEC.md §19.6 [F7] — the failsafe banner lives in AppShell itself (above
// the routed Outlet), not any one page, so it must show up regardless of
// which of the three routes is active.
describe("AppShell mailbox-health failsafe banner", () => {
  it.each([
    ["/dashboard", "Dashboard content"],
    ["/inbox", "Inbox content"],
    ["/settings", "Settings content"],
  ])("renders alongside the page at %s", async (path, marker) => {
    renderShellAt(path, 2);
    expect(await screen.findByText(marker)).toBeInTheDocument();
    expect(await screen.findByRole("status")).toHaveTextContent(/2 mailboxes paused/i);
  });

  it("is absent on every page when no mailbox is paused/throttled", async () => {
    renderShellAt("/settings", 0);
    await screen.findByText("Settings content");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});

function hiddenMailboxWidget(): Widget {
  return {
    id: "w_mailbox",
    type: "mailbox_health",
    gridPos: { x: 0, y: 0, w: 6, h: 4 },
    visible: false, // an agent (or human) hid the WIDGET via configure_dashboard
    props: { refreshSeconds: 30, showWarmup: true },
  };
}

// M5 R2 item 1 — "It must be INDEPENDENT of dashboard layout config (cannot
// be hidden by configure_dashboard)." The banner reads /account directly; it
// has no idea the mailbox_health WIDGET even exists.
describe("failsafe banner independence from dashboard layout config", () => {
  it("still renders when the mailbox_health widget itself is hidden (visible: false)", async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify(accountResponse(1)), { status: 200 })) as unknown as typeof fetch;
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <MailboxHealthBanner />
          <DashboardGrid widgets={[hiddenMailboxWidget()]} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByRole("status")).toHaveTextContent(/1 mailbox paused/i);
    // The widget is correctly hidden by DashboardGrid's own visible-filter —
    // proving the banner does not depend on (and cannot be suppressed via) it.
    expect(screen.queryByText("Mailbox health")).not.toBeInTheDocument();
  });
});
