---
name: changed-detail-escape-storms-on-alternation
description: ⚠️ A "materially changed detail escapes the cooldown" fix compared against the PREVIOUS detail re-opens the alert storm — two alternating failure modes read as changed every tick. Measured 13 emails in 13 ticks.
metadata:
  type: project
---

**A changed-detail escape needs a per-episode ANNOUNCED SET, not a comparison
against the last detail.** Storing only `last_detail` makes alternation look like
novelty forever:

```
escape = (last_detail !== detail)
  A@t0 alert, last=A · B@t1 changed -> alert, last=B · A@t2 changed -> alert ...
```

Measured on ColdStart IN-17 (`ofac/sdn-alert.ts`): two alternating failure modes
produced **13 emails over 13 ticks** — the exact 160-emails-in-a-day class that
file was written to fix, re-opened by the fix for the opposite defect. My own
anti-storm test caught it; the naive version passed every "new mode alerts" test.

Re-anchoring the cooldown (`lastAlertTs = now`) does NOT help: the escape is an
`||` that bypasses the cooldown check entirely.

**What a correct escape needs, all three:**
1. A **materiality KEY**, not the raw detail string — raw vendor error text varies
   freely, so an unbounded key space means an email per variant.
2. A **per-streak set of already-announced keys**; escape only for a key not yet
   announced in this episode. Bounded by distinct modes, resets on recovery.
3. Durable storage for that set (a column + migration).

**How to apply:** before "escape the cooldown on a changed X", ask what happens
when X ALTERNATES, and write that test first. If the fix needs a per-episode
announced-set plus a materiality key, it is a design increment, not a patch —
return it rather than shipping the two-state version. The sibling members
(`watchtower-policy.ts`'s `suppressed` branch, `failure_signals`,
`warmup_cancel_gave_up`) need the same thing, and `failure_signals` is strictly
worse because its detail embeds a COUNT that changes every single tick.
Related: [[confirmation-guard-deletes-one-shot-signals]].
