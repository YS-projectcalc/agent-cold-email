import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useDashboardView, useDashboardViews } from "../api/queries";
import { DashboardGrid } from "../dashboard/Grid";
import { LayoutEditor } from "../dashboard/LayoutEditor";
import { ProvenanceBadge } from "../dashboard/ProvenanceBadge";
import { ViewSwitcher } from "../dashboard/ViewSwitcher";

function PageSkeleton() {
  return (
    <div className="animate-pulse space-y-4" aria-hidden="true">
      <div className="h-6 w-40 rounded bg-surface-inset" />
      <div className="grid grid-cols-12 gap-4">
        <div className="col-span-12 h-24 rounded-[var(--radius-card)] bg-surface-inset" />
        <div className="col-span-6 h-40 rounded-[var(--radius-card)] bg-surface-inset" />
        <div className="col-span-6 h-40 rounded-[var(--radius-card)] bg-surface-inset" />
      </div>
    </div>
  );
}

// §19.2/§19.6/[F6] — every dashboard page render starts from GET
// /dashboard/views, which lazily seeds a `default` view server-side, so a
// fresh tenant always renders instead of hitting an empty-state crash.
export function DashboardPage() {
  const viewsQuery = useDashboardViews();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  // Inbox's Cmd+K palette (SPEC.md §19.6 "saved-view switch") links here as
  // `?view=<id>`; a plain in-component `selectedId` click still wins once
  // the user picks something themselves this session.
  const [searchParams] = useSearchParams();

  const views = viewsQuery.data ?? [];
  const activeId = selectedId ?? searchParams.get("view") ?? views.find((v) => v.isDefault)?.id ?? views[0]?.id ?? null;
  const viewDetail = useDashboardView(activeId);

  if (viewsQuery.isLoading) return <PageSkeleton />;
  if (viewsQuery.isError) {
    return (
      <div role="alert" className="rounded-[var(--radius-card)] border border-line bg-surface px-4 py-6 text-sm text-chip-danger-text">
        Couldn't load your dashboard views.{" "}
        <button type="button" onClick={() => void viewsQuery.refetch()} className="underline">
          Retry
        </button>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-semibold tracking-[-0.02em] text-ink">Dashboard</h1>
          {viewDetail.data && <ProvenanceBadge editedBy={viewDetail.data.editedBy} note={viewDetail.data.editedByNote} />}
        </div>
        <button
          type="button"
          onClick={() => setEditing(true)}
          disabled={!viewDetail.data}
          className="rounded-[var(--radius-card)] border border-line px-3 py-1.5 text-sm font-medium text-ink hover:bg-surface disabled:opacity-50"
        >
          Edit layout
        </button>
      </div>

      {activeId && <ViewSwitcher views={views} activeId={activeId} activeViewDetail={viewDetail.data} onSelect={setSelectedId} />}

      {viewDetail.isLoading ? (
        <PageSkeleton />
      ) : viewDetail.isError ? (
        <div role="alert" className="rounded-[var(--radius-card)] border border-line bg-surface px-4 py-6 text-sm text-chip-danger-text">
          Couldn't load this view.{" "}
          <button type="button" onClick={() => void viewDetail.refetch()} className="underline">
            Retry
          </button>
        </div>
      ) : viewDetail.data ? (
        <DashboardGrid widgets={viewDetail.data.layout.widgets} />
      ) : null}

      {editing && viewDetail.data && <LayoutEditor view={viewDetail.data} onClose={() => setEditing(false)} />}
    </div>
  );
}
