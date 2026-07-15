# apps/dashboard

SPEC.md §19 — the optional human dashboard SPA (Vite + React + React Router
+ TanStack Query + Tailwind v4). Built with `base: '/app/'`; its production
build lands in `apps/platform/public/app/` and is served same-origin by the
platform Worker's `[assets]` binding (see `apps/platform/wrangler.toml` and
`apps/platform/public/README.md`). The human surface now includes working
sandbox signup, token login/recovery guidance, dashboard + saved views,
unified inbox, agent setup, deterministic billing planning, and Settings.
Production payment mutations remain disabled until core quantity billing is
implemented; the interface says this rather than simulating success.

## What's here

- `src/api/` — `client.ts` (fetch wrapper: `credentials: "include"` for the
  httpOnly session cookie, `X-Coldstart-Client: dashboard` on every mutation,
  a 401 → `unauthorizedBus.ts` global-logout event), `queries.ts` (TanStack
  Query hooks, one per route), `types.ts` (response DTOs mirroring
  `apps/platform/src/engine/*.ts` — kept in sync by hand, see the file's own
  comment on why they aren't imported directly).
- `src/auth/` — `AuthProvider.tsx` (bootstraps auth by probing `/account`
  once, since the cookie is httpOnly/invisible to JS by design; subscribes to
  the unauthorized bus), `SignupPage.tsx` (real sandbox `POST /signup` with
  one-time token handling), `TokenGate.tsx` (paste-token login), and
  `RecoveryPage.tsx` (honest non-recoverability and rotation guidance).
- `src/shell/` — `AppShell.tsx` + `NavRail.tsx` (desktop ≥1024px) +
  `BottomTabs.tsx` (mobile <768px).
- `src/dashboard/` — `Grid.tsx` (12-col dense-packed desktop grid / single
  mobile column, both ordered by `(y, x)` — see its own comment for why row
  placement uses `grid-auto-flow: dense` + row *span* rather than an explicit
  row-start), `ViewSwitcher.tsx`, `LayoutEditor.tsx` (show/hide + reorder,
  handles the `PUT .../:id` 409 rev-conflict prompt), `ProvenanceBadge.tsx`.
- `src/widgets/` — the widget registry (`registry.tsx`) + all 8 widget
  components from `@coldstart/shared`'s `WIDGET_TYPES`, each wrapped in the
  shared `WidgetChrome.tsx` (loading skeleton / error / empty states).
  `AgentNote.tsx` is the ONE sanctioned `dangerouslySetInnerHTML` sink in this
  app (`lib/sanitize.ts` + `scripts/check-dangerous-html.mjs` CI guard).
- `src/lib/` — `sanitize.ts` (marked → DOMPurify strict allowlist, https:/
  mailto: link scheme allowlist), `format.ts`, `useMediaQuery.ts`, `ui.ts`
  (shared Tailwind class fragments), `brand.ts` (swappable brand constant,
  mirrors `site/assets/brand.js`), `icons.tsx`.
- `src/pages/SetupPage.tsx` — owner readiness checklist and copyable current
  MCP setup for Codex, Claude Code, Cursor, and Cline.
- `src/pages/BillingPage.tsx` — provisioned-mailbox quote and owner ceiling
  planner backed by `@coldstart/shared`; paid mutation controls are visibly
  disabled until the backend meter is migrated.

## How to run

```
npm install                       # from the repo root (workspaces)
npm run dev --workspace apps/dashboard      # Vite dev server (standalone, mocked-nothing — talks to whatever API origin you point it at via a dev proxy if needed)
npm run typecheck --workspace apps/dashboard
npm run test --workspace apps/dashboard
npm run build --workspace apps/dashboard    # builds into apps/platform/public/app/ + syncs public/index.html
npm run check:dangerous-html --workspace apps/dashboard
```

For a real end-to-end check, build this app first, then run
`apps/platform`'s `wrangler dev` (it serves the built assets same-origin) and
sign in through the live token-gate.

## Depends on

- `@coldstart/shared` (`packages/shared`) — the zod layout/widget schema,
  `Provenance`, `starterDashboardLayout()`. Never redefine these types here.
- `apps/platform`'s HTTP facade (SPEC.md §19.4) — this app has no state of
  its own; every read/write goes through the same routes MCP and bearer
  callers use (parity law, §19.0).

## Known gaps (flagged for a follow-up, not worked around here)

- Checkout, subscription quantity changes, payment methods, cancellation,
  and a persisted owner spend ceiling still use or depend on the legacy
  fixed-plan backend. The billing page is a deterministic planning surface,
  not a functioning paid account-management surface.
- The service stores token hashes, not recoverable plaintext. Automated
  owner-verified rotation is not implemented; recovery guidance routes to a
  fresh sandbox or support instead of pretending to email the old token.

- `mailboxes.last_polled_at` (SPEC.md §19.2/[F7]) is written server-side
  (`tenant-do.ts`, `engine/reply-processor.ts`) but never surfaced through
  `getInfrastructureStatus()` — the mailbox tables here render `—` until a
  backend change adds it.
- `PUT /dashboard/views/:id` has no way to rename an existing view (`name` is
  set only at creation) — the view switcher has no rename control for that
  reason; see `ViewSwitcher.tsx`'s comment.
- `GET /activity` has no server-side `kind` filter, so `agent_log` over-
  fetches and filters to `deliverability` client-side — see `AgentLog.tsx`.
