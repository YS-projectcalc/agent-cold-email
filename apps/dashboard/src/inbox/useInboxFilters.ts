import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import type { InboxFilters } from "../api/queries";

/**
 * Filter state lives in the URL (shareable, survives refresh, and is how
 * `?thread=` deep-links already worked in the M2 placeholder). SPEC.md
 * §19.6 — "the explicit 'Bounces & OOO' toggle" backs `include_nonreply`;
 * absent from the URL means OFF (the SPA's own default), never the server's
 * backward-compat default of `true` — a bare `/app/inbox` visit must not
 * silently show bounces.
 */
export function useInboxFilters() {
  const [params, setParams] = useSearchParams();

  const filters: InboxFilters = useMemo(
    () => ({
      mailbox: params.get("mailbox") ?? undefined,
      campaign: params.get("campaign") ?? undefined,
      label: params.get("label") ?? undefined,
      read: params.get("read") === "true" ? true : params.get("read") === "false" ? false : undefined,
      includeNonreply: params.get("bounces") === "1",
    }),
    [params],
  );

  const setFilter = useCallback(
    (patch: Partial<{ mailbox: string | undefined; campaign: string | undefined; label: string | undefined; read: boolean | undefined; includeNonreply: boolean }>) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if ("mailbox" in patch) patch.mailbox ? next.set("mailbox", patch.mailbox) : next.delete("mailbox");
          if ("campaign" in patch) patch.campaign ? next.set("campaign", patch.campaign) : next.delete("campaign");
          if ("label" in patch) patch.label ? next.set("label", patch.label) : next.delete("label");
          if ("read" in patch) patch.read === undefined ? next.delete("read") : next.set("read", String(patch.read));
          if ("includeNonreply" in patch) patch.includeNonreply ? next.set("bounces", "1") : next.delete("bounces");
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  const selectedThreadId = params.get("thread");
  const setSelectedThreadId = useCallback(
    (id: string | null) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (id) next.set("thread", id);
          else next.delete("thread");
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  return { filters, setFilter, selectedThreadId, setSelectedThreadId };
}
