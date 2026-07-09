# src/engine

The native-sandbox sequencing + reply engine (modeled on cold-cli's shapes
per the B0 brief), split into small single-purpose modules so no file grows
into a god file:

- `warmup.ts` — pure warmup-ramp math (day -> daily cap / status). No I/O.
- `mailbox-state.ts` — persists live warmup day/cap/status + resets daily
  send counters on a virtual-day rollover. Called before anything that
  reads/enforces mailbox capacity.
- `scheduler.ts` — pure send-window + least-loaded-mailbox-with-capacity
  helpers used by `tick.ts` (`isWithinSendWindow` is wired into the tick).
- `brand-guard.ts` — the lookalike third-party-brand hard-reject validator
  (`assertBrandOwnership`), called at the `setup_infrastructure` boundary
  before any domain purchase: a well-known-brand denylist + a
  brand↔primaryDomain ownership-consistency check (SPEC.md §8, panel-02).
- `provisioning.ts` — `setup_infrastructure` (validates brand ownership, then
  buys domains, DNS, provisions mailboxes, starts warmup) + `infrastructure_status`.
- `campaigns.ts` — `launch_campaign` (schedules every sequence step for
  every non-suppressed lead up front; `is_demo` marks demo-run campaigns) +
  `pause`/`pause_all`. The tick is the actual send-time guard, not launch.
- `tick.ts` — the engine tick: sends every due `scheduled_send`, enforcing
  per-mailbox daily caps AND, at send time, lead/campaign status, the
  `suppressions` table, and the campaign send window. Claims each row
  atomically (`pending`→`sending`) before the network send so a
  concurrent/retried tick can't double-process it, and records usage before
  committing `sent`/cap so a row is never left sent-but-unbilled. The ledger
  usage entry is idempotent on `source_send_id`.
- `reply-processor.ts` — polls each mailbox's `EmailPort.poll()`, lands
  replies in the inbox (step cancellation is gated on the campaign's
  `stop_on_reply` flag) and bounces into `suppressions` (always cancels
  remaining steps).
- `demo.ts` — `demo_run`: the sandbox accelerated pipeline. Resets prior demo
  state each run so DO storage stays bounded; per-tenant throttled in `tenant-do.ts`.
- `threads.ts` — `inbox()` / `thread(id)` / `reply(thread, body)` /
  `mark(thread, status)`.
- `reporting.ts` — `campaign_results()` / `metrics()` / `account()`. Opens
  are never tracked anywhere in the schema (SPEC.md §6: opens OFF by
  default), so there is nothing to leak.

Every function here takes a `TenantContext` (`../tenant-context.ts`): the
DO's own `SqlStorage` handle, tenant id, injected `Clock`, and the tenant's
`VendorAdapterBundle`. `tenant-do.ts` assembles the context once per RPC
call and dispatches into these modules — it holds no business logic itself.

## Why the tick/poll are directly-callable methods, not real alarms

B2 (ROADMAP.md) is where resumable, DO-alarm-driven scheduling lands. B0's
job is to prove the pipe end-to-end with an honest, directly-callable
`tick()`/`pollInbox()` RPC pair that a real alarm would call later — this
keeps the walking-skeleton test deterministic (no real waiting) without
overbuilding a scheduling system this phase doesn't need (CLAUDE.md rule i,
YAGNI).

## How to run

Part of `apps/platform`; exercised by `apps/platform/test/*.test.ts`.
