import { describe, expect, it } from "vitest";
import { sanitizeAgentNote } from "../src/lib/sanitize";

// SPEC.md §19.7 DoD #6 — "agent_note with <script>/javascript: link/<img
// onerror> renders inert." These are the exact attack shapes named in the
// spec, plus data: URIs (the same href-scheme class).
describe("sanitizeAgentNote", () => {
  it("strips <script> tags entirely", () => {
    const html = sanitizeAgentNote("hello <script>alert(1)</script> world");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("alert(1)");
  });

  it("strips <img onerror> (no images allowed in v1 at all)", () => {
    const html = sanitizeAgentNote('<img src="x" onerror="alert(1)">');
    expect(html).not.toContain("<img");
    expect(html).not.toContain("onerror");
  });

  it("strips javascript: links", () => {
    const html = sanitizeAgentNote("[click me](javascript:alert(1))");
    expect(html).not.toContain("javascript:");
  });

  it("strips data: URIs", () => {
    const html = sanitizeAgentNote("[click me](data:text/html;base64,PHNjcmlwdD4=)");
    expect(html).not.toContain("data:");
  });

  it("strips relative/protocol-relative links (not on the https:/mailto: allowlist)", () => {
    const html = sanitizeAgentNote("[relative](/some/path) and [protocol-relative](//evil.example/x)");
    expect(html).not.toMatch(/href="\/some\/path"/);
    expect(html).not.toMatch(/href="\/\/evil\.example/);
  });

  it("keeps https: links and hardens them with target=_blank rel=noopener", () => {
    const html = sanitizeAgentNote("[docs](https://example.com/docs)");
    expect(html).toContain('href="https://example.com/docs"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("keeps mailto: links", () => {
    const html = sanitizeAgentNote("[email me](mailto:agent@example.com)");
    expect(html).toContain('href="mailto:agent@example.com"');
  });

  it("renders plain markdown formatting", () => {
    const html = sanitizeAgentNote("**bold** and a list:\n\n- one\n- two");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<li>one</li>");
  });

  it("strips inline event-handler and style attributes on otherwise-allowed tags", () => {
    const html = sanitizeAgentNote('<p onclick="alert(1)" style="color:red">hi</p>');
    expect(html).not.toContain("onclick");
    expect(html).not.toContain("style=");
  });
});
