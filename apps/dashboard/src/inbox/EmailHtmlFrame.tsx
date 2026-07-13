import { useRef, useState } from "react";
import { buildEmailSrcdoc, sanitizeEmailHtml } from "../lib/sanitizeEmailHtml";

/**
 * The ONE sanctioned `iframe[srcdoc]` sink in this app for untrusted email
 * HTML (SPEC.md §19.1) — scripts/check-dangerous-html.mjs's CI guard fails
 * the build if `srcdoc={` appears anywhere else. `sandbox` deliberately
 * carries NO `allow-scripts` (nothing in this frame can ever execute JS,
 * regardless of what DOMPurify let through). `allow-same-origin` is included
 * WITHOUT `allow-scripts` — a safe combination (the dangerous case is the
 * two together) that lets the parent read `contentDocument.body.scrollHeight`
 * below to auto-size the frame instead of shipping a fixed-height box with a
 * second nested scrollbar. `allow-popups`(-to-escape-sandbox) lets a
 * `target="_blank"` link actually open a real, unsandboxed tab.
 */
export function EmailHtmlFrame({ html }: { html: string }) {
  const [height, setHeight] = useState(120);
  const frameRef = useRef<HTMLIFrameElement>(null);

  function handleLoad() {
    const doc = frameRef.current?.contentDocument;
    if (!doc?.body) return;
    setHeight(Math.min(Math.max(doc.body.scrollHeight + 24, 80), 2000));
  }

  const srcdoc = buildEmailSrcdoc(sanitizeEmailHtml(html));

  return (
    <iframe
      ref={frameRef}
      title="Email content"
      // eslint-disable-next-line react/no-danger -- sanctioned sink, see comment above
      srcDoc={srcdoc}
      onLoad={handleLoad}
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      style={{ height, width: "100%", border: "none", display: "block", maxHeight: "70vh" }}
      className="rounded-[var(--radius-card)] bg-white"
    />
  );
}
