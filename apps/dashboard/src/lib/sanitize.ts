import DOMPurify from "dompurify";
import { marked } from "marked";

// SPEC.md §19.1 content-safety class 2 (agent-authored strings). `marked`
// does NOT sanitize its output (its own README: use DOMPurify on the
// *output* HTML) — an attacker-controlled markdown source containing literal
// `<script>`/`<img onerror>`/etc. passes through `marked.parse` unchanged as
// HTML text. DOMPurify's strict allowlist below is what actually disables
// raw-HTML pass-through into the rendered DOM: anything outside ALLOWED_TAGS
// (script, img, style, iframe, svg, forms, event-handler attributes, ...) is
// stripped here, regardless of whether it came from real markdown syntax or
// an attacker typing raw HTML into the note. This function's return value
// feeds the ONE sanctioned `dangerouslySetInnerHTML` sink in this app
// (widgets/AgentNote.tsx) — the CI grep guard (scripts/check-dangerous-html.mjs)
// fails the build if any other file uses it.
const ALLOWED_TAGS = ["p", "br", "strong", "em", "b", "i", "ul", "ol", "li", "a", "code", "pre", "blockquote", "h1", "h2", "h3", "h4", "hr"];
const ALLOWED_ATTR = ["href", "title"];
// Link href scheme allowlist (§19.1): https:/mailto: only — no javascript:,
// data:, file:, or bare relative/protocol-relative paths.
const ALLOWED_URI_REGEXP = /^(?:https:|mailto:)/i;

let hookRegistered = false;
function ensureLinkHardeningHook(): void {
  if (hookRegistered) return;
  hookRegistered = true;
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "A" && node.hasAttribute("href")) {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
    }
  });
}

export function sanitizeAgentNote(markdown: string): string {
  ensureLinkHardeningHook();
  const rawHtml = marked.parse(markdown, { async: false, gfm: true, breaks: true }) as string;
  return DOMPurify.sanitize(rawHtml, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOWED_URI_REGEXP,
    FORBID_TAGS: ["img", "script", "style", "iframe", "object", "embed", "form", "svg"],
    FORBID_ATTR: ["style", "onerror", "onload", "onclick"],
  });
}
