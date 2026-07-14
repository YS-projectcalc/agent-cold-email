import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type UseQueryOptions } from "@tanstack/react-query";
import type { DashboardLayout } from "@coldstart/shared";
import { apiRequest } from "./client";
import type {
  AccountSummary,
  ActivityPage,
  CampaignListItem,
  DashboardViewDetail,
  DashboardViewSummary,
  EventCounts,
  InboxPage,
  InboxRow,
  InfrastructureStatus,
  ReplyResult,
  SignupResult,
  ThreadDetail,
} from "./types";

// SPEC.md §19.1 — TanStack Query interval polling + refetch-on-focus, no SSE
// in v1. `refreshSeconds` is per-widget (packages/shared's DashboardLayout
// props); every query hook below takes it as a param so a widget's own
// layout-configured cadence drives its own polling, not a single global one.
function pollingOptions(refreshSeconds: number) {
  return {
    refetchInterval: refreshSeconds * 1000,
    refetchOnWindowFocus: true,
  } as const;
}

type QueryOpts<T> = Omit<UseQueryOptions<T>, "queryKey" | "queryFn">;

export function useLogin() {
  return useMutation({
    mutationFn: (token: string) =>
      apiRequest<{ tenantId: string }>("/dashboard/session", {
        method: "POST",
        body: { token },
        suppressUnauthorizedRedirect: true,
      }),
  });
}

export function useSignup() {
  return useMutation({
    mutationFn: (input: { brand: string; contactEmail: string }) =>
      apiRequest<SignupResult>("/signup", {
        method: "POST",
        body: input,
        suppressUnauthorizedRedirect: true,
      }),
  });
}

export function useLogout() {
  return useMutation({
    mutationFn: () => apiRequest<{ loggedOut: true }>("/dashboard/logout", { method: "POST" }),
  });
}

export function useDashboardViews(opts?: QueryOpts<DashboardViewSummary[]>) {
  return useQuery({
    queryKey: ["dashboard", "views"],
    queryFn: () => apiRequest<DashboardViewSummary[]>("/dashboard/views"),
    ...opts,
  });
}

export function useDashboardView(id: string | null) {
  return useQuery({
    queryKey: ["dashboard", "views", id],
    queryFn: () => apiRequest<DashboardViewDetail>(`/dashboard/views/${encodeURIComponent(id!)}`),
    enabled: id !== null,
  });
}

export function useCreateDashboardView() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; layout: DashboardLayout; note?: string }) =>
      apiRequest<DashboardViewDetail>("/dashboard/views", { method: "POST", body: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["dashboard", "views"] }),
  });
}

export function useUpdateDashboardView(id: string) {
  const qc = useQueryClient();
  return useMutation({
    // `name` optional (backend gaps brief item 6 — DashboardViewUpdateInput
    // accepts it now, same rev-CAS as the layout upsert): the ViewSwitcher's
    // rename flow sends it alongside the view's CURRENT rev+layout; a layout
    // edit (LayoutEditor) omits it and leaves the name untouched.
    mutationFn: (input: { rev: number; layout: DashboardLayout; name?: string; note?: string }) =>
      apiRequest<DashboardViewDetail>(`/dashboard/views/${encodeURIComponent(id)}`, { method: "PUT", body: input }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["dashboard", "views"] });
      qc.invalidateQueries({ queryKey: ["dashboard", "views", id] });
    },
  });
}

export function useSetDefaultView() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiRequest<DashboardViewSummary[]>(`/dashboard/views/${encodeURIComponent(id)}/default`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["dashboard", "views"] }),
  });
}

export function useDeleteView() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiRequest<{ deleted: true }>(`/dashboard/views/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["dashboard", "views"] }),
  });
}

export function useMetrics(refreshSeconds: number) {
  return useQuery({
    queryKey: ["metrics"],
    queryFn: () => apiRequest<EventCounts>("/metrics"),
    ...pollingOptions(refreshSeconds),
  });
}

export function useInfrastructureStatus(refreshSeconds: number) {
  return useQuery({
    queryKey: ["infrastructure-status"],
    queryFn: () => apiRequest<InfrastructureStatus>("/infrastructure-status"),
    ...pollingOptions(refreshSeconds),
  });
}

export function useCampaigns(refreshSeconds: number) {
  return useQuery({
    queryKey: ["campaigns"],
    queryFn: () => apiRequest<CampaignListItem[]>("/campaigns"),
    ...pollingOptions(refreshSeconds),
  });
}

export function useCampaignResults(campaignId: string, refreshSeconds: number) {
  return useQuery({
    queryKey: ["campaigns", campaignId, "results"],
    queryFn: () => apiRequest<{ campaignId: string } & EventCounts>(`/campaigns/${encodeURIComponent(campaignId)}/results`),
    ...pollingOptions(refreshSeconds),
  });
}

export function useActivity(limit: number, refreshSeconds: number) {
  return useQuery({
    queryKey: ["activity", limit],
    queryFn: () => apiRequest<ActivityPage>(`/activity?limit=${limit}`),
    ...pollingOptions(refreshSeconds),
  });
}

export function useInbox(params: { limit?: number; label?: string }, refreshSeconds: number) {
  const search = new URLSearchParams();
  if (params.limit) search.set("limit", String(params.limit));
  if (params.label) search.set("label", params.label);
  const qs = search.toString();
  return useQuery({
    queryKey: ["inbox", params.limit ?? null, params.label ?? null],
    queryFn: () => apiRequest<InboxPage>(`/inbox${qs ? `?${qs}` : ""}`),
    ...pollingOptions(refreshSeconds),
  });
}

export function useAccount(refreshSeconds: number) {
  return useQuery({
    queryKey: ["account"],
    queryFn: () => apiRequest<AccountSummary>("/account"),
    ...pollingOptions(refreshSeconds),
  });
}

// --- M3 unified inbox (SPEC.md §19.6/§19.4) ---

/** The v2 filter set the full inbox page exposes — a superset of the M2
 * `useInbox({limit, label})` params above, which stays untouched (still
 * backs the `inbox_preview` dashboard widget). Kept as its own type so the
 * infinite-query key below is a stable, serializable object. */
export interface InboxFilters {
  mailbox?: string;
  campaign?: string;
  label?: string;
  read?: boolean;
  /** SPEC.md §19.6 — the SPA defaults this to `false` itself (the server's
   * own backward-compat default is `true`); the filters bar's "Bounces &
   * OOO" toggle is what flips it on, styled as a visible chip. */
  includeNonreply: boolean;
}

const INBOX_INFINITE_KEY_ROOT = "inbox-infinite" as const;

function inboxInfiniteKey(filters: InboxFilters) {
  return [INBOX_INFINITE_KEY_ROOT, filters] as const;
}

function buildInboxSearch(filters: InboxFilters, cursor: string | null, limit: number): string {
  const search = new URLSearchParams();
  search.set("limit", String(limit));
  if (cursor) search.set("cursor", cursor);
  if (filters.mailbox) search.set("mailbox", filters.mailbox);
  if (filters.campaign) search.set("campaign", filters.campaign);
  if (filters.label) search.set("label", filters.label);
  if (filters.read !== undefined) search.set("read", String(filters.read));
  search.set("include_nonreply", String(filters.includeNonreply));
  // Backend gaps brief item 1 — server-side archived filter (default
  // "exclude" already matches this, but stating it explicitly documents the
  // SPA's reliance on it rather than an implicit default that could change).
  search.set("archived", "exclude");
  return search.toString();
}

/** Cursor-paginated, client-virtualized inbox list (§19.6). Page size 50
 * matches the server's own default (packages/shared/src/dashboard.ts
 * InboxQueryInput) so a bare first page and a "load more" page behave the
 * same. No interval polling here on purpose — refetch-on-focus only; a
 * ticking cursor list re-polling underneath an open detail pane would
 * reshuffle rows out from under the user's j/k position. */
export function useInboxInfinite(filters: InboxFilters, limit = 50) {
  return useInfiniteQuery({
    queryKey: inboxInfiniteKey(filters),
    queryFn: ({ pageParam }) => apiRequest<InboxPage>(`/inbox?${buildInboxSearch(filters, pageParam, limit)}`),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    refetchOnWindowFocus: true,
  });
}

/** Patches every cached inbox-infinite page whose row matches `threadId` —
 * shared by the optimistic label/mark mutations below so a change made from
 * the thread detail pane is instantly reflected in the list row (chip/bold
 * weight) without waiting on a refetch. Returns the previous snapshots so a
 * mutation's `onError` can restore them verbatim. */
function patchInboxRow(qc: ReturnType<typeof useQueryClient>, threadId: string, patch: Partial<InboxRow>) {
  const previous = qc.getQueriesData<{ pages: InboxPage[]; pageParams: unknown[] }>({ queryKey: [INBOX_INFINITE_KEY_ROOT] });
  qc.setQueriesData<{ pages: InboxPage[]; pageParams: unknown[] }>({ queryKey: [INBOX_INFINITE_KEY_ROOT] }, (data) => {
    if (!data) return data;
    return {
      ...data,
      pages: data.pages.map((page) => ({
        ...page,
        threads: page.threads.map((row) => (row.threadId === threadId ? { ...row, ...patch } : row)),
      })),
    };
  });
  return previous;
}

function restoreInboxQueries(qc: ReturnType<typeof useQueryClient>, previous: ReturnType<typeof qc.getQueriesData>) {
  for (const [key, data] of previous) qc.setQueryData(key, data);
}

export function useThread(threadId: string | null) {
  return useQuery({
    queryKey: ["threads", threadId],
    queryFn: () => apiRequest<ThreadDetail>(`/threads/${encodeURIComponent(threadId!)}`),
    enabled: threadId !== null,
  });
}

export function useReplyToThread(threadId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: string) => apiRequest<ReplyResult>(`/threads/${encodeURIComponent(threadId)}/reply`, { method: "POST", body: { body } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["threads", threadId] });
      qc.invalidateQueries({ queryKey: [INBOX_INFINITE_KEY_ROOT] });
    },
  });
}

/** Backs both "mark read on open" and the `u` toggle-unread shortcut, plus
 * archive (`e` / swipe-right — SPEC.md §19.6). Optimistic: the row's
 * `markStatus` (and, for archive, its removal from view — see
 * inbox/ThreadList.tsx's client-side archived filter, an M3 gap noted in the
 * build report: `InboxQueryInput`'s `read` filter has no third "archived"
 * state, so the server has nothing to exclude archived rows with) updates
 * instantly; a failed request rolls every patched query back verbatim. */
export function useMarkThread() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ threadId, status }: { threadId: string; status: "read" | "unread" | "archived" }) =>
      apiRequest(`/threads/${encodeURIComponent(threadId)}/mark`, { method: "POST", body: { status } }),
    onMutate: async ({ threadId, status }) => {
      await qc.cancelQueries({ queryKey: [INBOX_INFINITE_KEY_ROOT] });
      const previous = patchInboxRow(qc, threadId, { markStatus: status });
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) restoreInboxQueries(qc, context.previous);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: [INBOX_INFINITE_KEY_ROOT] }),
  });
}

/** Optimistic label set/clear (SPEC.md §19.7 DoD test: "label set/clear
 * optimistic update + rollback on error"). Supersedes the M2-era version of
 * this hook, which only invalidated-and-waited; the inbox row list here
 * needs the chip to appear/disappear instantly on both list row and detail
 * pane, matching the label picker's own optimistic local state. */
export function useLabelThread() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ threadId, label }: { threadId: string; label: string | null }) =>
      apiRequest(`/threads/${encodeURIComponent(threadId)}/label`, { method: "POST", body: { label } }),
    onMutate: async ({ threadId, label }) => {
      await qc.cancelQueries({ queryKey: [INBOX_INFINITE_KEY_ROOT] });
      const previous = patchInboxRow(qc, threadId, { label, labelSource: "dashboard" });
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) restoreInboxQueries(qc, context.previous);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: [INBOX_INFINITE_KEY_ROOT] }),
  });
}
