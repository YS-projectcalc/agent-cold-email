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
- `tick.ts` — the engine tick: runs the deliverability sweep FIRST (so a
  degrading mailbox is throttled/paused before it sends more this tick), then
  sends every due `scheduled_send`, enforcing per-mailbox daily caps AND, at
  send time, lead/campaign status, the `suppressions` table, and the campaign
  send window. The send picker excludes `deliv_status='paused'` mailboxes,
  which is what realizes ROTATE. Claims each row atomically (`pending`→
  `sending`) before the network send so a concurrent/retried tick can't
  double-process it, and records usage before committing `sent`/cap so a row is
  never left sent-but-unbilled. The ledger usage entry is idempotent on
  `source_send_id`.
- `reply-processor.ts` — polls each mailbox's `EmailPort.poll()`, lands
  replies in the inbox (step cancellation is gated on the campaign's
  `stop_on_reply` flag) and bounces AND spam-complaints into `suppressions`
  (both always cancel remaining steps). Complaints carry the original send's
  message id so the deliverability loop can attribute them per-mailbox.
- `deliverability.ts` — B6 control loop, DECIDE half. A PURE
  `evaluate(mailboxHealth[], domainStats[], thresholds) -> Action[]`
  (unit-testable in isolation) + `gatherMailboxHealth`/`gatherDomainStats`
  which assemble first-party per-mailbox/per-domain bounce+complaint RATES
  (fractions, 0-1) from the event log — same units as reporting.ts and the
  vendor port; the Gmail 0.30% red line is 0.003, NOT 0.30 (the 100x trap).
- `deliverability-actions.ts` — B6 control loop, ACT half. `applyActions`
  mutates DO state (throttle cap via `cap_override`, pause via `deliv_status`,
  retire+replace a burning domain via `provisionDomainWithMailboxes`) and
  audits each to `deliverability_actions`; `runDeliverabilitySweep` is the one
  entry point the tick calls each cycle BEFORE scheduling. Replacements are
  rate-capped per window so a replacement that also burns can't spawn forever.
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
