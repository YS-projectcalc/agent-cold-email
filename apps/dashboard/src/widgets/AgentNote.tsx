import { useMemo } from "react";
import { sanitizeAgentNote } from "../lib/sanitize";
import { WidgetChrome } from "./WidgetChrome";
import type { WidgetOfType } from "./types";

/**
 * §19.1 signature widget — a note in the agent's own words, rendered through
 * the ONE sanctioned `dangerouslySetInnerHTML` sink in this app
 * (scripts/check-dangerous-html.mjs's CI grep guard enforces this). The
 * markdown string is the widget's OWN stored prop (no separate fetch — it
 * lives in the view's layout JSON), so there is no loading/error state here,
 * only empty-vs-loaded.
 */
export function AgentNote({ widget }: { widget: WidgetOfType<"agent_note"> }) {
  const { props } = widget;
  const html = useMemo(() => sanitizeAgentNote(props.markdown), [props.markdown]);
  const isEmpty = props.markdown.trim().length === 0;

  return (
    <WidgetChrome title={props.title ?? "Note from your agent"} isLoading={false} isError={false} isEmpty={isEmpty} emptyMessage="No notes from your agent yet.">
      <div
        className="prose-note text-sm text-ink [&_a]:text-accent [&_a]:underline [&_code]:rounded [&_code]:bg-surface-inset [&_code]:px-1 [&_h1]:text-base [&_h1]:font-semibold [&_h2]:text-sm [&_h2]:font-semibold [&_li]:ml-4 [&_ol]:list-decimal [&_ul]:list-disc"
        // eslint-disable-next-line react/no-danger -- sanctioned sink, see comment above
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </WidgetChrome>
  );
}
