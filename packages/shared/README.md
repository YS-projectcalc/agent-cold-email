# @coldstart/shared

Framework-free TypeScript shared by every app in the monorepo (currently just
`apps/platform`, later the CLI/MCP surface).

## What's here

- `src/types.ts` — domain types (Tenant, Domain, Mailbox, Campaign, Lead,
  ScheduledSend, PlatformEvent, Suppression, LedgerEntry) mirroring the table
  list in `ARCHITECTURE.md`.
- `src/clock.ts` — the `Clock` interface only (ARCHITECTURE.md decision #4).
  Concrete `RealClock`/`VirtualClock` implementations live in
  `apps/platform/src/clock.ts` since they're a runtime concern.
- `src/vendor-ports.ts` — the five `VendorPort` interfaces
  (`DomainPort`, `MailboxPort`, `EmailPort`, `BillingPort`, `MetricsPort`)
  every vendor integration sits behind (ARCHITECTURE.md decision #1). Every
  side-effecting method takes an `idempotencyKey`.
- `src/errors.ts` — shared error classes, notably `NotActivatedError` (thrown
  by every `real/` adapter stub), `TenantIsolationError`, and
  `RevConflictError` (SPEC.md §19.4 — a dashboard-view rev CAS mismatch;
  carries `currentRev`/`currentLayout` so an agent can rebase).
- `src/intents.ts` — zod request schemas + inferred types for the facade's
  ~12 core intents (SPEC.md §6). The Worker validates every request body
  against these at the boundary.
- `src/dashboard.ts` — SPEC.md §19 (dashboard + unified inbox): the
  layout-as-data zod schema (12-col grid, the 8-type widget registry v1),
  `Provenance` (`'dashboard' | 'mcp' | 'api' | 'system'`, server-derived from
  transport — never client-supplied), the canonical thread-label list
  (a UI recommendation, not a server-enforced enum), and the request/query
  schemas shared by the HTTP facade AND the MCP dashboard tools
  (`get_dashboard`/`configure_dashboard`/`label_thread`, `inbox` v2 filters).

## How to run

No build step — consumed directly as TypeScript source by `apps/platform`
via the npm workspace. `npm run typecheck` from the repo root or this
directory type-checks it in isolation.

## Depended on by

`apps/platform` (imports domain types, ports, errors, and intent schemas).
