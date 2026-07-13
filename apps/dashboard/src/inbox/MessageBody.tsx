import type { ThreadMessage } from "../api/types";
import { EmailHtmlFrame } from "./EmailHtmlFrame";

/**
 * Renders one thread message's content. Sandbox data is text-only today
 * (api/types.ts's ThreadMessage doc), so this feature-detects an `html`
 * field on the event metadata rather than assuming it's absent forever — the
 * day a real IMAP adapter starts forwarding HTML bodies, this file is the
 * only place that needs to already be ready (SPEC.md §19.1 class 1). Plain
 * text never touches `dangerouslySetInnerHTML`/`srcdoc` at all — JSX
 * text-child interpolation is inert by construction, so it needs no
 * sanitizer.
 */
export function MessageBody({ message }: { message: ThreadMessage }) {
  const html = typeof message.metadata.html === "string" ? message.metadata.html : null;
  if (html) return <EmailHtmlFrame html={html} />;

  const text = typeof message.metadata.body === "string" ? message.metadata.body : null;
  if (!text) return <p className="text-sm italic text-ink-muted">(no message body recorded for this event)</p>;
  return <p className="whitespace-pre-wrap text-sm text-ink">{text}</p>;
}
