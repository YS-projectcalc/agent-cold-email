import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SandboxBanner } from "../../src/shell/SandboxBanner";

function accountResponse(activationState: string) {
  return {
    tenantId: "t1",
    brand: "Test Co",
    plan: activationState === "sandbox" ? "demo" : "managed",
    status: "active",
    billingState: activationState === "sandbox" ? "none" : "active",
    activationState,
    domains: 1,
    mailboxes: 4,
    campaigns: 1,
    leads: 10,
    sends: 20,
    usageCents: 0,
    quota: { domains: 5, mailboxes: 20 },
    deliverability: { pausedMailboxes: 0, throttledMailboxes: 0, burningDomains: 0, domainsReplaced: 0, recentActions: [] },
    teardown: null,
  };
}

function renderBanner(activationState: string) {
  global.fetch = vi.fn(async () => new Response(JSON.stringify(accountResponse(activationState)), { status: 200 })) as unknown as typeof fetch;
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <SandboxBanner />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// Founder ruling (mid-build addendum): "shouldn't go live be more prominent
// somewhere?" — a persistent, quiet, non-dismissable banner while the tenant
// is in sandbox (activationState === 'sandbox'), disappearing once billing
// goes active. Links to BillingPage's #go-live section rather than
// duplicating any checkout logic.
describe("SandboxBanner", () => {
  it("renders in sandbox state and links to the go-live checkout section", async () => {
    renderBanner("sandbox");
    expect(await screen.findByText(/sandbox mode/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /go live/i })).toHaveAttribute("href", "/billing#go-live");
  });

  // Second addendum (2026-07-27) — exactly ONE truthful activation-state
  // banner should exist; this one must never regress toward the retired
  // "not active yet" / "join the waitlist" framing (see staleCopyGuard.test.ts
  // for the repo-wide source sweep this pins down at the component level too).
  it("never uses the retired 'not active yet' / waitlist framing", async () => {
    renderBanner("sandbox");
    await screen.findByText(/sandbox mode/i);
    expect(screen.queryByText(/not active yet/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/join the waitlist/i)).not.toBeInTheDocument();
  });

  it("is absent once billing is active", async () => {
    renderBanner("active");
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText(/sandbox mode/i)).not.toBeInTheDocument();
  });

  it.each(["pending_provisioning", "capacity_pending", "screening_hold", "suspended", "canceled"])(
    "is absent in the post-checkout %s state (checkout already happened)",
    async (activationState) => {
      renderBanner(activationState);
      await new Promise((r) => setTimeout(r, 0));
      expect(screen.queryByText(/sandbox mode/i)).not.toBeInTheDocument();
    },
  );

  it("has no dismiss control", async () => {
    renderBanner("sandbox");
    await screen.findByText(/sandbox mode/i);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
