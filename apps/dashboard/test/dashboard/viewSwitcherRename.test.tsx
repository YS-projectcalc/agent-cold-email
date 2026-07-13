import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ViewSwitcher } from "../../src/dashboard/ViewSwitcher";
import type { DashboardViewDetail, DashboardViewSummary } from "../../src/api/types";

function summary(overrides: Partial<DashboardViewSummary> = {}): DashboardViewSummary {
  return {
    id: "default",
    name: "Default",
    isDefault: true,
    rev: 3,
    editedBy: "system",
    editedByNote: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function detail(overrides: Partial<DashboardViewDetail> = {}): DashboardViewDetail {
  return {
    ...summary(),
    layout: { schemaVersion: 1, widgets: [] },
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function renderSwitcher(views: DashboardViewSummary[], activeViewDetail: DashboardViewDetail | undefined, onSelect = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ViewSwitcher views={views} activeId={activeViewDetail?.id ?? views[0]!.id} activeViewDetail={activeViewDetail} onSelect={onSelect} />
    </QueryClientProvider>,
  );
}

// Backend gaps brief item 6 — the PUT /dashboard/views/:id backend gap is
// closed (DashboardViewUpdateInput.name, same rev-CAS semantics); this wires
// the rename UI the M2 report's comment explicitly flagged as blocked on it.
describe("ViewSwitcher — rename (backend gaps brief item 6)", () => {
  it("renames the active view via PUT with its current rev + layout + the new name", async () => {
    let putBody: unknown = null;
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") {
        putBody = JSON.parse(String(init.body));
        return new Response(JSON.stringify({ ...detail({ name: "Renamed View" }), rev: 4 }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    renderSwitcher([summary()], detail());

    fireEvent.click(screen.getByRole("button", { name: /rename/i }));
    const input = screen.getByLabelText(/view name/i);
    fireEvent.change(input, { target: { value: "Renamed View" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(putBody).not.toBeNull());
    expect(putBody).toEqual({ rev: 3, layout: { schemaVersion: 1, widgets: [] }, name: "Renamed View" });
  });

  it("surfaces the structured 409 as a reload-and-retry prompt (same conflict flow as layout edits)", async () => {
    let attempt = 0;
    global.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") {
        attempt += 1;
        if (attempt === 1) {
          return new Response(
            JSON.stringify({ error: "stale rev", currentRev: 9, currentLayout: { schemaVersion: 1, widgets: [] } }),
            { status: 409 },
          );
        }
        return new Response(JSON.stringify({ ...detail({ name: "Renamed Twice" }), rev: 10 }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    renderSwitcher([summary()], detail());

    fireEvent.click(screen.getByRole("button", { name: /rename/i }));
    fireEvent.change(screen.getByLabelText(/view name/i), { target: { value: "Renamed Twice" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    expect(await screen.findByText(/changed by your agent/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /reload.*retry|retry.*reload/i }));

    await waitFor(() => expect(attempt).toBe(2));
  });
});
