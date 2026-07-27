import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SetupPage } from "../src/pages/SetupPage";

function accountResponse(overrides: Partial<{ activationState: string; mailboxes: number; campaigns: number }>) {
  return {
    tenantId: "t1",
    brand: "Test Co",
    plan: "demo",
    status: "active",
    billingState: "none",
    activationState: "sandbox",
    domains: 0,
    mailboxes: 3,
    campaigns: 1,
    leads: 0,
    sends: 0,
    usageCents: 0,
    quota: { domains: 5, mailboxes: 20 },
    deliverability: { pausedMailboxes: 0, throttledMailboxes: 0, burningDomains: 0, domainsReplaced: 0, recentActions: [] },
    teardown: null,
    ...overrides,
  };
}

function renderSetup(activationState: string) {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).endsWith("/infrastructure-status")) {
      return new Response(JSON.stringify({ mailboxes: 3, domains: 1, mailboxHealth: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify(accountResponse({ activationState })), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <SetupPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function goLiveListItem() {
  await screen.findByText(/the isolated account and browser session exist/i);
  return screen.getByText("Go live").closest("li")!;
}

// Founder ruling (mid-build addendum) — the readiness checklist's final step
// is "Go live" (linking to BillingPage's #go-live), so the onboarding path
// ends at conversion instead of trailing off after the sandbox is proven out.
describe("SetupPage readiness checklist — Go live final step", () => {
  it("shows an incomplete 'Go live' step linking to the checkout section while still in sandbox", async () => {
    renderSetup("sandbox");
    const li = await goLiveListItem();
    const link = li.querySelector("a");
    expect(link).toHaveAttribute("href", "/billing#go-live");
    // The checkmark used elsewhere in this list is "✓"; incomplete steps show "·".
    expect(li.querySelector("span")?.textContent).toBe("·");
  });

  it("marks 'Go live' done ONLY once billing is truly active (not merely non-sandbox)", async () => {
    renderSetup("active");
    const li = await goLiveListItem();
    expect(li.querySelector("span")?.textContent).toBe("✓");
    expect(li).toHaveTextContent(/real sending is live/i);
  });
});

// Adversary BLOCKING #2 (golive-ux-review-2026-07-27.md finding 2): the
// done-predicate gated on `activationState !== "sandbox"` and the done-copy
// was a flat "real sending is live" — false for every paid-but-not-fully-live
// state (pending_provisioning/screening_hold/capacity_pending) and for
// suspended/canceled (where even "billing is active" is false). Each
// post-checkout state gets its OWN honest, non-done copy — testing the COPY
// itself, not just the checkmark glyph (the adversary's exact gap).
describe("SetupPage readiness checklist — per-state copy truth (BLOCKING #2)", () => {
  const CASES: Array<[state: string, mustContain: RegExp, mustNotContain: RegExp[]]> = [
    ["pending_provisioning", /provisioning|not yet live|still simulated/i, [/real sending is live/i]],
    ["capacity_pending", /capacity/i, [/real sending is live/i]],
    ["screening_hold", /review/i, [/real sending is live/i, /billing is active/i]],
    ["suspended", /attention|resolve|reactivate/i, [/real sending is live/i, /billing is active/i]],
    ["canceled", /cancel/i, [/real sending is live/i, /billing is active/i]],
  ];

  it.each(CASES)("activationState=%s renders honest, non-done copy", async (state, mustContain, mustNotContain) => {
    renderSetup(state);
    const li = await goLiveListItem();
    // None of these paid-but-not-fully-live/frozen states are "done" — the
    // checklist never claims real sending is live when it isn't.
    expect(li.querySelector("span")?.textContent).toBe("·");
    expect(li).toHaveTextContent(mustContain);
    for (const forbidden of mustNotContain) expect(li).not.toHaveTextContent(forbidden);
  });
});

// Round-3 fold-in (adversary-ruled fix-in-same-cut, golive-ux-review-
// 2026-07-27.md ruling on builder-flagged deviation (c)): the header chip
// hardcoded "Sandbox · no real sends" regardless of real state — FALSE once
// `active` becomes reachable (unreachable today in this unarmed deploy, but
// latent). State-derived exactly like BillingPage's HEADER_CHIP map.
describe("SetupPage header chip — state-derived (round-3 fold-in)", () => {
  it("reads 'Sandbox · no real sends' while genuinely in sandbox", async () => {
    renderSetup("sandbox");
    await goLiveListItem();
    expect(screen.getByText(/sandbox · no real sends/i)).toBeInTheDocument();
  });

  it("does NOT claim 'no real sends' once billing is truly active — the chip changes with the state", async () => {
    renderSetup("active");
    await goLiveListItem();
    expect(screen.queryByText(/sandbox · no real sends/i)).not.toBeInTheDocument();
  });

  it("does NOT claim 'no real sends' while pending_provisioning either (paid, real send path not yet live, but not 'sandbox')", async () => {
    renderSetup("pending_provisioning");
    await goLiveListItem();
    expect(screen.queryByText(/sandbox · no real sends/i)).not.toBeInTheDocument();
  });
});
