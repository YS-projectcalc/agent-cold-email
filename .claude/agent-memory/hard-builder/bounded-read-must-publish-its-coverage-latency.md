---
name: bounded-read-must-publish-its-coverage-latency
description: Bounding an O(N) sweep into a rotating slice trades per-tick cost for COVERAGE LATENCY — and a bound whose latency nobody publishes is the same blind spot pointing the other way. Publish ceil(total/ACHIEVED-advance), never ceil(total/slice), and skip a write only after the freshness signal it silently fed is published explicitly.
metadata:
  type: project
---

Two halves of the same lesson, both from ColdStart wave B (S1/S5).

**(a) Bounding creates a new unknown.** Replacing a full fan-out with a rotating
slice fixes the subrequest ceiling and introduces "a stuck tenant is now noticed
a rotation late". If nothing reports the rotation length, the platform has
traded a loud failure for a quiet one. Ship the bound WITH a check that alerts
when a full rotation exceeds a stated latency — and make its remedy explicit in
the alert body (here: the D1 read-model, NOT a bigger slice, because the slice
is what keeps the trailing legs reachable).

⚠️ **CORRECTED 2026-08-20 — this bullet used to say publish `ceil(total /
slice)`, and that is the wrong operand.** Shipping it that way is what produced
[[published-coverage-latency-must-use-the-achieved-advance]]: the cursor
advances by the LEAST-covered leg, which a shared deadline can drive far below
the slice, so the slice-based figure told the founder ~10 min while the real
rotation was ~315. Publish `ceil(total / achieved-advance)`, and pass the
achieved number to the check — never a struct that also carries the intended
one, or the next caller reads the wrong field off it.

**(b) A skipped write kills whatever was inferring freshness from it.** The
per-tick D1 write amplification fix ("don't upsert when state AND detail are
unchanged") is obviously safe — until you notice that `updated_at` freshness was
the de-facto dead-cron tell for the operator's poll endpoint, true only because
SOME row happened to be rewritten every tick. Nothing declared that dependency;
a class sweep had already flagged the same shape one layer up (the tell "rests
ENTIRELY on `do_storage` being pushed unconditionally — an undocumented single
point of dependence").

Fix the tell FIRST (publish `sweepAgeSeconds` from the cursor row every sweep
stamps unconditionally), then remove the side effect. Related:
[[capacity-counter-inside-a-failure-signal-pins-the-check]],
[[shared-primitive-caveat-wired-to-one-consumer]].

**How to apply:** before deleting or conditioning any write, grep for who reads
its TIMESTAMP or its mere existence, not just its value. A consumer of "this row
moved" is invisible to a search for the column name.
