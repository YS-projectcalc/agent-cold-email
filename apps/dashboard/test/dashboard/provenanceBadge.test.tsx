import { afterEach, describe, expect, it } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ProvenanceBadge } from "../../src/dashboard/ProvenanceBadge";
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

// SPEC.md §19.4 — provenance badge (mcp/api → agent note; dashboard → "by
// you"; system → none). M5 R2 item 5 — mobile gets a single-line, tappable,
// truncated pill instead of a wrapped multi-line label.
describe("ProvenanceBadge", () => {
  it("renders nothing for system provenance on either viewport", () => {
    setViewport(true);
    const { rerender } = render(<ProvenanceBadge editedBy="system" note={null} />);
    expect(document.body.textContent).toBe("");
    setViewport(false);
    rerender(<ProvenanceBadge editedBy="system" note={null} />);
    expect(document.body.textContent).toBe("");
  });

  it("renders a plain 'Edited by you' chip for dashboard provenance", () => {
    render(<ProvenanceBadge editedBy="dashboard" note={null} />);
    expect(screen.getByText("Edited by you")).toBeInTheDocument();
  });

  it("desktop: renders the full label as static text with a title tooltip", () => {
    setViewport(true);
    render(<ProvenanceBadge editedBy="mcp" note="width sweep w=4" />);
    expect(screen.getByText("Configured by your agent — width sweep w=4")).toHaveAttribute("title", "width sweep w=4");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("mobile: renders a single-line tappable pill (a <button>, not wrapped static text)", () => {
    setViewport(false);
    render(<ProvenanceBadge editedBy="mcp" note="a very long note an agent might leave describing exactly what it changed and why" />);
    const pill = screen.getByRole("button");
    expect(pill.className).toMatch(/truncate/);
    expect(pill.className).toMatch(/max-w-\[55vw\]/);
  });

  it("mobile: tapping the pill reveals the full note in a popover, tapping Close hides it again", () => {
    setViewport(false);
    render(<ProvenanceBadge editedBy="mcp" note="the full untruncated note text" />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByRole("dialog")).toHaveTextContent("the full untruncated note text");

    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("mobile: a note-less agent badge renders a non-interactive-feeling pill (no popover to open)", () => {
    setViewport(false);
    render(<ProvenanceBadge editedBy="api" note={null} />);
    fireEvent.click(screen.getByRole("button"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
