---
name: fail-loud-throw-after-billed-vendor-call
description: CLASS — adding a "fail loud" validation throw AFTER a billed vendor call but BEFORE its durable marker manufactures a deterministic double-charge loop if graded retryable; grade it non-retryable and check what the marker write protects.
metadata:
  type: feedback
---

Before adding a validation throw to a vendor adapter, find where the CALLER writes the
durable "this vendor call already happened" marker. A throw between the vendor's 200 and
that marker re-runs the vendor call on retry.

**Why:** wave-2 §9-U1 asked for a `Number.isFinite` clamp on `RealMailboxPort.startWarmup`'s
`Date.parse` result. That parse sits AFTER `/warmup/add` has created a BILLED recurring
subscription and BEFORE `markMailboxIntent(ctx, key, "warming")`
(engine/mailbox-provisioning.ts) — the marker whose own comment says "repeating it is a
second monthly charge". A crash there is a bounded, rare window; a deterministic
validation throw is not: the vendor answers every retry with the same unparseable date,
so a `retryable: true` grade enrols and charges for a fresh subscription per attempt.
Graded `false` instead, matching the sibling malformed-response throw in `provision()`.

**How to apply:** for any new throw in a port method, ask (1) has money already moved?
(2) is the failure deterministic on retry? Both yes → non-retryable, and report the
residual (the created-but-unmarked resource) rather than silently accepting it. This is
the mirror image of [[persist-before-confirm-cross-boundary]]: there the marker is written
too EARLY; here a new throw is inserted too EARLY relative to the marker.
