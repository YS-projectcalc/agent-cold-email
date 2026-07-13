import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CampaignPerformance } from "../../src/widgets/CampaignPerformance";
import type { WidgetOfType } from "../../src/widgets/types";

function widget(): WidgetOfType<"campaign_performance"> {
  return { id: "w1", type: "campaign_performance", gridPos: { x: 0, y: 0, w: 6, h: 4 }, visible: true, props: { refreshSeconds: 30 } };
}

function renderWidget() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <CampaignPerformance widget={widget()} />
    </QueryClientProvider>,
  );
}

// SPEC.md §19.3 — "Empty: render `—` not a fake 0" for a real "no data"
// widget state (as opposed to kpi_row, where 0 is legitimate real data).
describe("CampaignPerformance widget", () => {
  it("renders the designed empty state when there are no campaigns yet", async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify([]), { status: 200 })) as unknown as typeof fetch;
    renderWidget();
    expect(await screen.findByText("No campaigns launched yet.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("renders a table row per campaign when data is present", async () => {
    global.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify([{ campaignId: "camp_1", name: "Q1 outreach", status: "active", counts: { sent: 10, reply: 2, bounce: 1, complaint: 0, unsubscribe: 0, failed: 0, soft_bounce: 0 } }]),
          { status: 200 },
        ),
    ) as unknown as typeof fetch;
    renderWidget();
    expect(await screen.findByText("Q1 outreach")).toBeInTheDocument();
  });
});
