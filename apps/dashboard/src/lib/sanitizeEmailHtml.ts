import DOMPurify from "dompurify";

// SPEC.md §19.1 content-safety class 1 (email message HTML — activation-era;
// sandbox is text only today, see api/types.ts's ThreadMessage doc). Two-layer
// defense: (1) DOMPurify strict pre-pass strips script/style/forms/event
// handlers and restricts links/images to https:/mailto: before the markup
// ever becomes a string, (2) the resulting string is placed in an iframe
// `srcdoc` (inbox/EmailHtmlFrame.tsx — the ONE sanctioned srcdoc sink in this
// app, enforced by scripts/check-dangerous-html.mjs) with `sandbox` carrying
// NO `allow-scripts`, plus an injected CSP `script-src 'none'` meta tag — so
// even markup that slipped past DOMPurify cannot execute. Layer 2 alone would
// still let a spoofed-looking phishing DOM render; layer 1 alone would still
// let a DOMPurify bypass execute in the app's own origin. Neither layer
// trusts the other.
// No `img` (or any other src-bearing tag) in v1 — same restriction the
// agent-note pipeline (lib/sanitize.ts) applies, and for the same reason:
// verified empirically that DOMPurify's `ALLOWED_URI_REGEXP` does NOT
// reliably block `data:` URIs on `img[src]` the way it blocks `javascript:`
// on `<a href>` (a `data:text/html;...` `img src` survives sanitization even
// with a strict custom regexp — see the sanitizeEmailHtml.test.ts case this
// guards). Rather than depend on a DOMPurify src-attribute subtlety, the
// whole tag class is dropped; `href` is still checked (and DOES filter
// correctly) since only `<a>` needs it.
const ALLOWED_TAGS = [
  "p", "br", "div", "span", "strong", "em", "b", "i", "u", "ul", "ol", "li", "a", "code", "pre", "blockquote",
  "h1", "h2", "h3", "h4", "h5", "h6", "hr", "table", "thead", "tbody", "tr", "td", "th",
];
const ALLOWED_ATTR = ["href", "title", "colspan", "rowspan"];
// https:/mailto: only — no javascript:, data:, file:, or bare relative/
// protocol-relative paths (the same class of link-scheme attack the
// agent-note pipeline, lib/sanitize.ts, guards against).
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

export function sanitizeEmailHtml(rawHtml: string): string {
  ensureLinkHardeningHook();
  return DOMPurify.sanitize(rawHtml, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOWED_URI_REGEXP,
    FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "form", "svg", "link", "meta", "base"],
    FORBID_ATTR: ["style", "onerror", "onload", "onclick", "srcset"],
  });
}

/** Wraps already-sanitized HTML into a full document for `iframe[srcdoc]`.
 * The CSP meta + `<base target="_blank">` are the SECOND independent layer
 * (§19.1) — belt-and-suspenders alongside the iframe's own `sandbox` (no
 * `allow-scripts`) and DOMPurify's own stripping above. */
export function buildEmailSrcdoc(sanitizedHtml: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="script-src 'none'"><base target="_blank"><style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;color:#16181d;margin:0;padding:12px;word-wrap:break-word;overflow-wrap:break-word;}</style></head><body>${sanitizedHtml}</body></html>`;
}
