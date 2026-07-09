# src/engine

The native-sandbox sequencing + reply engine (modeled on cold-cli's shapes
per the B0 brief), split into small single-purpose modules so no file grows
into a god file:

- `warmup.ts` — pure warmup-ramp math (day -> daily cap / status). No I/O.
- `mailbox-state.ts` — persists live warmup day/cap/status + resets daily
  send counters on a virtual-day rollover. Called before anything that
  reads/enforces mailbox capacity.
- `scheduler.ts` — pure send-window + least-loaded-mailbox-with-capacity
  helpers used by `tick.ts`.
- `provisioning.ts` — `setup_infrastructure` (buys domains, DNS, provisions
  mailboxes, starts warmup) + `infrastructure_status`.
- `campaigns.ts` — `launch_campaign` (schedules every sequence step for
  every non-suppressed lead up front) + `pause`/`pause_all`.
- `tick.ts` — the engine tick: sends every due `scheduled_send`, enforcing
  per-mailbox daily caps and skipping leads that are no longer `active`
  (stop-on-reply/suppression already applied). Records a ledger usage entry
  per send.
- `reply-processor.ts` — polls each mailbox's `EmailPort.poll()`, lands
  replies in the inbox (stop-on-reply cancels remaining steps) and bounces
  into `suppressions` (cancels remaining steps too).
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
