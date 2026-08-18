---
name: idempotency-replays-a-non-terminal-outcome-forever
description: "CLASS: a request-idempotency wrapper that records any RETURN as replayable turns a 202 'accepted, not finished' into an eternal no-op — the invariant is 'replay forever only if TERMINAL', and the classifier must read the RECORDED RESPONSE so already-wedged rows are covered."
metadata:
  type: project
---

`withRequestIdempotency` recorded `status='done'` for whatever `fn()` returned, so
`runSetupInfrastructure`'s 202 SUCCESS-PENDING branch — which RETURNS while still
owing a domain's DNS and its mailboxes — replayed forever. Every later same-key
call, including the one the platform's own `retry_setup` message instructs, got a
stale 202 with zero vendor calls and an empty `messages[]`. It is the exact
eternal-"pending" shape the vendor-verdict wave closed INSIDE the saga, left open
in front of it.

**Why:** "fn returned" is not "the work finished". A wrapper that cannot tell those
apart re-creates the bug the inner fix deleted, one layer up.

**How to apply:** on any dedup/idempotency/caching wrapper, ask whether the wrapped
call has an "accepted, not complete" return. If yes it needs an opt-in
`isIncomplete` predicate bounding replay to a short double-submit window (60s here;
measured from CLAIM time, so a slow fn spends part of it — err short, since a
re-run is spend-safe when purchases are gated elsewhere). Two non-obvious musts:
(1) classify the RECORDED RESPONSE, not a new status value — a new status only
covers rows written after deploy, and the wedged population predates it;
(2) the re-claim must be an in-place synchronous UPDATE before the first `await`
(same one-input-gate-turn rule as the fresh-claim INSERT), or two racing retries
both run the saga. Put the predicate in the file that PRODUCES the shape, not at
the call site — see [[caller-side-effect-gated-on-callee-result-field]].
Sibling call sites to re-check when adding one: `launch_campaign`, `reply`,
`remove_mailboxes`, `provision:<intentKey>` — all terminal today.
