---
name: fix-shape-differs-when-decider-and-sender-split-across-rpc
description: A class sweep that ENUMERATES its member sites can still be closed at one — and the other members may need a DIFFERENT fix shape, because the decider and the effect sit on opposite sides of an RPC (DO decides, Worker sends).
metadata:
  type: project
---

TWO lessons from ColdStart's cached-terminal member 5 (wave-1+2 gate B2, 2026-08-18).

**1. A sweep row's site list is a CHECKLIST, and "fixed" was claimed off one of
three.** `class-sweep-cached-terminal-2026-08-17.md:90` named its sites verbatim:
`admin/watchtower.ts:356-359`; *same shape at* `admin/watchtower-infra.ts:55`
*and* `watchtower-do.ts:147`. Only the first got `withheldAlertState`. Worse, the
untouched file's NEW comment claimed the parity it did not have ("a check
reported through two stores that describe the same non-delivery differently is
the reporting divergence this wave is about") — the `why` string was unified, the
STATE was not. Before accepting a class as closed, re-read the sweep row and
confirm each named site by grepping for the fix's own identifier.

**2. "Same shape" ≠ same fix.** The Worker-side site could withhold in place
(decide → send → one write, `withheld ? withheldAlertState(prev,t) : t.next`).
The other two could not:
- **`d1`** straddles the boundary: the DO owns the storage, the WORKER holds the
  OpsMailer. Pasting the in-place pattern is impossible — there is no send result
  in scope where the write happens. Needs TWO RPCs: `decideD1Alert` (read+decide,
  writes nothing) and `commitD1Alert(healthy, nowMs, notified)` which re-reads
  prev and RE-DERIVES the transition (`decideAlert` is pure and nothing was
  written between, so it is identical) rather than accepting caller-supplied
  state. A commit that throws after a delivered send is caught and logged
  separately, so the outcome still reports `emailSent: true` — un-banked state
  re-decides next tick, i.e. at worst a duplicate alert, never silence.
- **dead-man alarm** is local (the DO holds its own mailer) — decide → send →
  bank in one method, no second RPC.

Do NOT bank a pessimistic (withheld) state first and "promote" it on delivery:
the promotion logic is a second copy of `decideAlert`'s output, and re-deriving
from the just-written state double-counts the observation.

**Testing it.** Probes that fail on the old code: (i) dark channel, next tick's
action must be `alerted`, not `suppressed`; (ii) condition recovers while the
channel was dark ⇒ NO `RECOVERED` email (assert `action === "healthy"`);
(iii) DO alarm dark, channel restored, condition still bad ⇒ the next alarm
SENDS. Inject failure by installing a throwing `OpsMailer` — Worker-side as a
parameter, DO-side by assigning `instance.mailer` inside `runInDurableObject`.

Member of [[persist-before-confirm-cross-boundary]]; the enabler is the same one
in [[guards-inline-in-a-loop-are-not-a-policy]] — sweep the call sites of the
EFFECT, not of the guard.
