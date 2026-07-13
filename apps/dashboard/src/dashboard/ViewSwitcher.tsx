import { useState } from "react";
import { starterDashboardLayout } from "@coldstart/shared";
import { ApiError } from "../api/client";
import { useCreateDashboardView, useDeleteView, useSetDefaultView, useUpdateDashboardView } from "../api/queries";
import type { DashboardViewDetail, DashboardViewSummary, RevConflictBody } from "../api/types";

interface ViewSwitcherProps {
  views: DashboardViewSummary[];
  activeId: string;
  /** The active view's full layout+rev (DashboardPage already loads this via
   * `useDashboardView`) — rename needs it because `PUT /dashboard/views/:id`
   * is a full-layout upsert (rev-CAS), not a name-only endpoint. Undefined
   * while that fetch is still in flight; the rename button is disabled then. */
  activeViewDetail: DashboardViewDetail | undefined;
  onSelect: (id: string) => void;
}

/**
 * §19.2/§19.4 view lifecycle: switch, create, set-default, delete, rename
 * (backend gaps brief item 6 — `PUT /dashboard/views/:id` now accepts an
 * optional `name`, same rev-CAS semantics as the layout upsert LayoutEditor
 * already uses).
 */
export function ViewSwitcher({ views, activeId, activeViewDetail, onSelect }: ViewSwitcherProps) {
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const [renameConflict, setRenameConflict] = useState<RevConflictBody | null>(null);
  const createView = useCreateDashboardView();
  const setDefaultView = useSetDefaultView();
  const deleteView = useDeleteView();
  const updateView = useUpdateDashboardView(activeId);

  async function handleCreate() {
    const name = newName.trim();
    if (!name) return;
    setActionError(null);
    try {
      const created = await createView.mutateAsync({ name, layout: starterDashboardLayout() });
      setCreating(false);
      setNewName("");
      onSelect(created.id);
    } catch (err) {
      setActionError(err instanceof ApiError ? String(err.body && (err.body as { error?: string }).error) : "Couldn't create that view.");
    }
  }

  async function handleSetDefault(id: string) {
    setActionError(null);
    try {
      await setDefaultView.mutateAsync(id);
    } catch {
      setActionError("Couldn't set that view as default.");
    }
  }

  async function handleDelete(id: string) {
    setActionError(null);
    try {
      await deleteView.mutateAsync(id);
      if (id === activeId) {
        const fallback = views.find((v) => v.id !== id);
        if (fallback) onSelect(fallback.id);
      }
    } catch (err) {
      // Server guards ("cannot delete the default view" / "cannot delete the
      // last remaining view") surface as a friendly inline message, not a
      // silent no-op.
      setActionError(err instanceof ApiError && err.body && typeof (err.body as { error?: unknown }).error === "string" ? (err.body as { error: string }).error : "Couldn't delete that view.");
    }
  }

  async function submitRename(rev: number, layout: DashboardViewDetail["layout"], name: string) {
    try {
      await updateView.mutateAsync({ rev, layout, name });
      setRenaming(false);
      setRenameConflict(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setRenameConflict(err.body as RevConflictBody);
        return;
      }
      setActionError(err instanceof ApiError && err.body && typeof (err.body as { error?: unknown }).error === "string" ? (err.body as { error: string }).error : "Couldn't rename that view.");
    }
  }

  async function handleRename() {
    const name = renameDraft.trim();
    if (!name || !activeViewDetail) return;
    setActionError(null);
    setRenameConflict(null);
    await submitRename(activeViewDetail.rev, activeViewDetail.layout, name);
  }

  // Same rev-CAS conflict shape as LayoutEditor's — this view was edited (by
  // an agent via MCP, most likely) since the rename was based on `rev`. A
  // rename has no draft content to reconcile, so retrying immediately with
  // the server's latest rev+layout (keeping the typed name) is simpler than
  // making the user re-click Save.
  async function handleRetryRenameAfterConflict() {
    if (!renameConflict) return;
    await submitRename(renameConflict.currentRev, renameConflict.currentLayout, renameDraft.trim());
  }

  const active = views.find((v) => v.id === activeId);

  return (
    <div className="mb-4">
      <div className="flex flex-wrap items-center gap-2">
        {views.map((view) => (
          <button
            key={view.id}
            type="button"
            onClick={() => onSelect(view.id)}
            aria-current={view.id === activeId ? "true" : undefined}
            aria-label={view.isDefault ? `${view.name} (default view)` : view.name}
            className={`rounded-full border px-3 py-1 text-sm font-medium ${
              view.id === activeId ? "border-accent bg-accent text-accent-contrast" : "border-line text-ink hover:bg-surface"
            }`}
          >
            {view.name}
            {/* M5 defect G — the default marker lives ON the pill (one clean
                rhythm) instead of a separate "Default view" chip underneath
                it, which read as a redundant second line saying the same
                thing as the pill row above. */}
            {view.isDefault && (
              <span aria-hidden="true" className="ml-1">
                ★
              </span>
            )}
          </button>
        ))}

        {creating ? (
          <span className="flex items-center gap-1">
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void handleCreate()}
              placeholder="View name"
              className="rounded-[var(--radius-card)] border border-line bg-canvas px-2 py-1 text-sm text-ink"
            />
            <button type="button" onClick={() => void handleCreate()} className="rounded-[var(--radius-card)] border border-accent bg-accent px-2 py-1 text-xs font-semibold text-accent-contrast">
              Add
            </button>
            <button type="button" onClick={() => setCreating(false)} className="rounded-[var(--radius-card)] border border-line px-2 py-1 text-xs text-ink">
              Cancel
            </button>
          </span>
        ) : (
          <button type="button" onClick={() => setCreating(true)} className="rounded-full border border-dashed border-line px-3 py-1 text-sm text-ink-muted hover:bg-surface">
            + New view
          </button>
        )}
      </div>

      {/* M5 defect F/G — a single tidy meta row: every action here (Rename /
          Set as default / Delete) is a proper subtle bordered button, not
          floating underlined text, and there's no separate "Default view"
          chip (the star on the active pill above already says that). */}
      {active && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {renaming ? (
            <span className="flex items-center gap-1">
              <label htmlFor="rename-view-input" className="sr-only">
                View name
              </label>
              <input
                id="rename-view-input"
                aria-label="View name"
                autoFocus
                value={renameDraft}
                onChange={(e) => setRenameDraft(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void handleRename()}
                className="rounded-[var(--radius-card)] border border-line bg-canvas px-2 py-1 text-sm text-ink"
              />
              <button type="button" onClick={() => void handleRename()} disabled={updateView.isPending} className="rounded-[var(--radius-card)] border border-accent bg-accent px-2 py-1 text-xs font-semibold text-accent-contrast disabled:opacity-60">
                Save
              </button>
              <button
                type="button"
                onClick={() => {
                  setRenaming(false);
                  setRenameConflict(null);
                }}
                className="rounded-[var(--radius-card)] border border-line px-2 py-1 text-xs text-ink"
              >
                Cancel
              </button>
            </span>
          ) : (
            <button
              type="button"
              disabled={!activeViewDetail}
              onClick={() => {
                setRenaming(true);
                setRenameDraft(active.name);
              }}
              className="rounded-[var(--radius-card)] border border-line px-2 py-1 text-xs font-medium text-ink hover:bg-surface disabled:opacity-50"
            >
              Rename
            </button>
          )}
          {!active.isDefault && (
            <button type="button" onClick={() => void handleSetDefault(active.id)} className="rounded-[var(--radius-card)] border border-line px-2 py-1 text-xs font-medium text-accent hover:bg-surface">
              Set as default
            </button>
          )}
          {!active.isDefault && views.length > 1 && (
            <button type="button" onClick={() => void handleDelete(active.id)} className="rounded-[var(--radius-card)] border border-line px-2 py-1 text-xs font-medium text-chip-danger-text hover:bg-surface">
              Delete view
            </button>
          )}
        </div>
      )}

      {renameConflict && (
        <div role="alert" className="mt-2 rounded-[var(--radius-card)] border border-warn-border bg-warn-bg px-3 py-2 text-sm text-warn-text">
          <strong className="block">This view changed by your agent.</strong>
          <p className="mb-2">Reload the latest layout before saving your rename, or it may conflict.</p>
          <button type="button" onClick={() => void handleRetryRenameAfterConflict()} className="rounded-[var(--radius-card)] border border-warn-border px-2.5 py-1 text-xs font-semibold text-warn-text hover:bg-canvas">
            Reload latest layout &amp; retry
          </button>
        </div>
      )}

      {actionError && (
        <p role="alert" className="mt-2 text-sm text-chip-danger-text">
          {actionError}
        </p>
      )}
    </div>
  );
}
