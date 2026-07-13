import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DASHBOARD_LAYOUT_SCHEMA_VERSION } from "@coldstart/shared";
import { LayoutEditor } from "../src/dashboard/LayoutEditor";
import type { DashboardViewDetail } from "../src/api/types";

function makeView(): DashboardViewDetail {
  return {
    id: "default",
    name: "Default",
    isDefault: true,
    rev: 3,
    editedBy: "system",
    editedByNote: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    layout: {
      schemaVersion: DASHBOARD_LAYOUT_SCHEMA_VERSION,
      widgets: [
        { id: "w1", type: "kpi_row", gridPos: { x: 0, y: 0, w: 12, h: 2 }, visible: true, props: { refreshSeconds: 30, metrics: ["sent", "reply", "bounce"] } },
        { id: "w2", type: "quota_usage", gridPos: { x: 0, y: 2, w: 6, h: 3 }, visible: true, props: { refreshSeconds: 30 } },
      ],
    },
  };
}

// SPEC.md §19.4 [F5] / build brief item 5 — "on 409 show a 'view changed by
// your agent — reload?' conflict prompt."
describe("LayoutEditor stale-rev conflict", () => {
  it("shows a reload prompt on 409 and applies the server's current layout on reload", async () => {
    const view = makeView();
    const conflictBody = {
      error: "dashboard view default was edited since rev 3 (current rev 4) — refetch and rebase your change",
      currentRev: 4,
      currentLayout: {
        schemaVersion: DASHBOARD_LAYOUT_SCHEMA_VERSION,
        widgets: [{ ...view.layout.widgets[0], visible: false }, view.layout.widgets[1]],
      },
    };

    global.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") {
        return new Response(JSON.stringify(conflictBody), { status: 409 });
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <LayoutEditor view={view} onClose={() => {}} />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText(/this view changed by your agent/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /reload latest layout/i }));

    await waitFor(() => {
      const item = screen.getByText("Overview KPIs");
      expect(item.className).toMatch(/line-through/);
    });
  });
});
