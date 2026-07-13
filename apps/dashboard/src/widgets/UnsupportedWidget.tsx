import { WidgetChrome } from "./WidgetChrome";

/** A stored widget `type` this build of the SPA doesn't recognize (schema
 * drift — e.g. a newer registry entry written by a newer agent/MCP tool
 * against an older dashboard build). SPEC.md §19.3: "stored-but-unknown type
 * renders a graceful 'unsupported widget' card" — never a crash. */
export function UnsupportedWidget({ type }: { type: string }) {
  return (
    <WidgetChrome title="Unsupported widget" isLoading={false} isError={false}>
      <p className="text-sm text-ink-muted">
        This view has a widget of type <code className="font-mono">{type}</code>, which this dashboard build doesn't know how to render. Hide or remove it
        from the view, or update the dashboard.
      </p>
    </WidgetChrome>
  );
}
