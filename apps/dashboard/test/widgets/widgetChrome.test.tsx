import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { WidgetChrome } from "../../src/widgets/WidgetChrome";

// SPEC.md §19.3 — "Every widget defines loading skeleton, error, and empty
// states." All 8 widgets share this one chrome, so its four states (loading/
// error/empty/loaded) are the single point of truth to test.
describe("WidgetChrome", () => {
  it("renders a loading skeleton and not the children", () => {
    render(
      <WidgetChrome title="Test" isLoading isError={false}>
        <p>real content</p>
      </WidgetChrome>,
    );
    expect(screen.queryByText("real content")).not.toBeInTheDocument();
  });

  it("renders an error state with a retry button that calls onRetry", () => {
    const onRetry = vi.fn();
    render(
      <WidgetChrome title="Test" isLoading={false} isError errorMessage="boom" onRetry={onRetry}>
        <p>real content</p>
      </WidgetChrome>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("boom");
    screen.getByRole("button", { name: "Retry" }).click();
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("renders a designed empty state (an em dash + message), never a fake 0 or blank card", () => {
    render(
      <WidgetChrome title="Test" isLoading={false} isError={false} isEmpty emptyMessage="No campaigns launched yet.">
        <p>real content</p>
      </WidgetChrome>,
    );
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.getByText("No campaigns launched yet.")).toBeInTheDocument();
    expect(screen.queryByText("real content")).not.toBeInTheDocument();
  });

  it("renders children once loaded with no error/empty flags", () => {
    render(
      <WidgetChrome title="Test" isLoading={false} isError={false}>
        <p>real content</p>
      </WidgetChrome>,
    );
    expect(screen.getByText("real content")).toBeInTheDocument();
  });

  // M5 R2 item 4 — the internal-scroll sink carries the CSS-only bottom
  // fade (index.css's `.scroll-fade-b`) and row-snapping (`snap-y
  // snap-proximity`, paired with each row-level component's own `snap-start`)
  // so a scrolled widget clips at a row boundary, not mid-glyph.
  it("scroll container has the row-boundary snap + bottom fade classes", () => {
    render(
      <WidgetChrome title="Test" isLoading={false} isError={false}>
        <p>real content</p>
      </WidgetChrome>,
    );
    const scrollContainer = screen.getByText("real content").parentElement;
    expect(scrollContainer?.className).toMatch(/scroll-fade-b/);
    expect(scrollContainer?.className).toMatch(/snap-y/);
    expect(scrollContainer?.className).toMatch(/snap-proximity/);
  });
});
