import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { sanitizeEmailHtml } from "../../src/lib/sanitizeEmailHtml";
import { MessageBody } from "../../src/inbox/MessageBody";
import type { ThreadMessage } from "../../src/api/types";

// SPEC.md §19.1 content-safety class 1 (email HTML) — the same attack shapes
// DoD #6 names for agent notes, applied to the OTHER raw-HTML sink.
describe("sanitizeEmailHtml", () => {
  it("strips <script> tags entirely", () => {
    const html = sanitizeEmailHtml("hi <script>alert(1)</script> there");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("alert(1)");
  });

  it("strips inline event-handler attributes", () => {
    const html = sanitizeEmailHtml('<p onclick="alert(1)">hi</p>');
    expect(html).not.toContain("onclick");
  });

  it("strips javascript: link hrefs", () => {
    const html = sanitizeEmailHtml('<a href="javascript:alert(1)">click</a>');
    expect(html).not.toContain("javascript:");
  });

  it("drops <img> entirely (verified DOMPurify does not reliably block data: on img[src] even under a strict custom ALLOWED_URI_REGEXP)", () => {
    const html = sanitizeEmailHtml('<img src="data:text/html;base64,x"><img src="https://example.com/x.png">');
    expect(html).not.toContain("<img");
    expect(html).not.toContain("data:");
  });

  it("keeps https: links and hardens them with target=_blank", () => {
    const html = sanitizeEmailHtml('<a href="https://example.com">docs</a>');
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("strips iframe/object/embed/form tags", () => {
    const html = sanitizeEmailHtml('<iframe src="https://evil.example"></iframe><object></object><form></form>');
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("<object");
    expect(html).not.toContain("<form");
  });
});

function message(overrides: Partial<ThreadMessage["metadata"]>): ThreadMessage {
  return { type: "reply", ts: Date.now(), messageId: "m1", metadata: overrides };
}

// SPEC.md §19.7 DoD #6 / build brief test requirement — "message HTML goes
// through the sanitized iframe path (script/js-URI inert)".
describe("MessageBody", () => {
  it("renders plain text messages as text, with no iframe and no dangerouslySetInnerHTML sink involved", () => {
    render(<MessageBody message={message({ body: "hello <script>alert(1)</script>" })} />);
    // Plain-text JSX interpolation is inert by construction — the literal
    // string (including the "<script>" characters) renders as visible text,
    // never as a parsed element.
    expect(screen.getByText(/hello <script>alert\(1\)<\/script>/)).toBeInTheDocument();
    expect(document.querySelector("iframe")).not.toBeInTheDocument();
  });

  it("renders HTML messages through the sanctioned sandboxed iframe, never inline into the app's own DOM", () => {
    render(<MessageBody message={message({ html: '<p>hi</p><script>alert(1)</script>' })} />);
    const frame = document.querySelector("iframe");
    expect(frame).toBeInTheDocument();
    expect(frame).toHaveAttribute("sandbox");
    // The dangerous script never reaches the app's OWN document — it only
    // ever exists (stripped) inside the iframe's srcDoc string.
    expect(frame?.getAttribute("sandbox")).not.toContain("allow-scripts");
    expect(document.body.innerHTML).not.toMatch(/<script>alert\(1\)<\/script>/);
  });

  it("renders a fallback message when no body/html is recorded", () => {
    render(<MessageBody message={message({})} />);
    expect(screen.getByText(/no message body recorded/i)).toBeInTheDocument();
  });
});
