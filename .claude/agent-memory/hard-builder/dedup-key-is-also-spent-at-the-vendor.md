---
name: dedup-key-is-also-spent-at-the-vendor
description: Bounding a LOCAL dedup map does not un-dedup a call, because the same key is usually also cached by the vendor/port — fix the KEY, not the window.
metadata:
  type: project
---

**A dedup key you send outward is spent in more than one place.** Time-boxing or
deleting the row in OUR table changes nothing if the key is also the vendor's
idempotency key: the vendor answers from its own cache and no second call goes out.

Measured on ColdStart IN-7 (`engine/threads.ts`, `replyToThread`). The content-hash
fallback key `h:sha256(body)` was replayable for 30 days. Bounding the durable
`sent_message_keys` lookup to a 10-minute retry window looked correct and the unit
tests around it went green — **and the three-days-later follow-up still came back
with the first send's messageId**, because:

- `vendors/sandbox/email-port.ts:41` — `sentByIdempotencyKey` Map, no TTL, forever.
- `apps/engine/src/engine.ts:87` — `this.store.getSend(idempotencyKey)`, the REAL
  production daemon. So this is not a sandbox artifact.

**The fix shape:** separate the LOOKUP key (finds a prior send in our table) from
the VENDOR key (must actually differ for a genuinely new send). Discriminate the
vendor key with a **durable epoch derived from the recorded row**, never a
wall-clock bucket — a bucket boundary straddled by a crash-retry double-sends,
which is exactly what the pre-B3 `:${now}` key did. Epoch 0 = the bare lookup key,
so every already-recorded key keeps its meaning; a crash-retry re-reads the same
unchanged row, recomputes the same epoch, re-presents the same vendor key, and the
vendor collapses it. Upsert with `WHERE excluded.epoch > <table>.epoch` so a later
episode wins while a concurrent equal-epoch write never clobbers.

**How to apply:** before "fix" = shortening a dedup window, grep every consumer of
that key outward (adapter, port, daemon, vendor). If any of them caches it, the
window is not the defect — the key is. Related: [[persist-before-confirm-cross-boundary]],
[[half-a-vendor-contract-invoked-on-the-other-half]].
