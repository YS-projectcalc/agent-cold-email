import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DASHBOARD_LAYOUT_SCHEMA_VERSION } from "@coldstart/shared";
import { LayoutEditor } from "../src/dashboard/LayoutEditor";
import type { DashboardViewDetail } from "../src/api/types";

function makeView(): DashboardViewDetail {
  return {
    id: "default",
    name: "Default",
    isDefault: true,
    rev: 1,
    editedBy: "system",
    editedByNote: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    layout: {
      schemaVersion: DASHBOARD_LAYOUT_SCHEMA_VERSION,
      widgets: [
        { id: "w_kpi", type: "kpi_row", gridPos: { x: 0, y: 0, w: 12, h: 2 }, visible: true, props: { refreshSeconds: 30, metrics: ["sent"] } },
        { id: "w_mailbox", type: "mailbox_health", gridPos: { x: 0, y: 2, w: 6, h: 4 }, visible: true, props: { refreshSeconds: 30, showWarmup: true } },
        { id: "w_inbox", type: "inbox_preview", gridPos: { x: 6, y: 2, w: 6, h: 4 }, visible: true, props: { refreshSeconds: 30, limit: 5 } },
      ],
    },
  };
}

// Regression test — a real Playwright capture caught this: hiding ONE widget
// through the layout editor (no reorder at all) was collapsing the ENTIRE
// view to a single linear column, discarding the agent's 2-column gridPos
// arrangement for every OTHER widget too. A show/hide-only edit must leave
// gridPos untouched; only an ACTUAL up/down reorder should linearize.
describe("LayoutEditor save payload", () => {
  it("preserves every widget's original gridPos when only visibility changed (no reorder)", async () => {
    const view = makeView();
    let sentBody: unknown = null;

    global.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") {
        sentBody = JSON.parse(String(init.body));
        return new Response(JSON.stringify({ ...view, rev: view.rev + 1 }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <LayoutEditor view={view} onClose={() => {}} />
      </QueryClientProvider>,
    );

    const mailboxRow = screen.getByText("Mailbox health").closest("li")!;
    fireEvent.click(within(mailboxRow).getByRole("button", { name: "Hide" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(sentBody).not.toBeNull());
    const widgets = (sentBody as { layout: { widgets: typeof view.layout.widgets } }).layout.widgets;
    const mailbox = widgets.find((w) => w.id === "w_mailbox")!;
    const inbox = widgets.find((w) => w.id === "w_inbox")!;

    expect(mailbox.visible).toBe(false);
    expect(mailbox.gridPos).toEqual({ x: 0, y: 2, w: 6, h: 4 });
    expect(inbox.gridPos).toEqual({ x: 6, y: 2, w: 6, h: 4 }); // untouched — still the right column
  });

  it("linearizes to a single column only when an actual reorder happens", async () => {
    const view = makeView();
    let sentBody: unknown = null;

    global.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") {
        sentBody = JSON.parse(String(init.body));
        return new Response(JSON.stringify({ ...view, rev: view.rev + 1 }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <LayoutEditor view={view} onClose={() => {}} />
      </QueryClientProvider>,
    );

    // Move "Mailbox health" (index 1) up above "Overview KPIs" (index 0).
    const mailboxRow = screen.getByText("Mailbox health").closest("li")!;
    fireEvent.click(within(mailboxRow).getByRole("button", { name: /move mailbox health up/i }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(sentBody).not.toBeNull());
    const widgets = (sentBody as { layout: { widgets: typeof view.layout.widgets } }).layout.widgets;
    for (const w of widgets) {
      expect(w.gridPos.x).toBe(0);
      expect(w.gridPos.w).toBe(12);
    }
  });
});
