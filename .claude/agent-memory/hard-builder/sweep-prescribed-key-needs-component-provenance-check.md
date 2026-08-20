---
name: sweep-prescribed-key-needs-component-provenance-check
description: A sweep that prescribes a synthesized dedup key names components without checking each one's PROVENANCE — ColdStart's `receivedAt` is POLL time, so the prescribed key would have re-fired on every re-poll.
metadata:
  type: feedback
---

**Check the provenance of every component of a prescribed key before building it.**
A class sweep is read-only and reasons about shapes; it can name a field that does
not mean what its name suggests.

**Why:** ColdStart IN-23 prescribed synthesizing a reply's missing dedup key as
`(threadId, receivedAt, sha256(body))`. But `apps/engine/src/engine.ts:258` passes
`this.now()` — `receivedAt` is the **POLL** time, not the message's date — and
`poll`'s own contract is that *"a lost response redelivers the exact same batch on
the next poll (the Worker dedupes on Message-ID)"*. A receivedAt-keyed id therefore
mints a FRESH key on every re-poll and files a duplicate reply every time. Building
the sketch verbatim would have shipped a new defect while closing the old one.

The key must be a function of the **message bytes alone**:
`synthetic:${sha256(rawSource)}`. Prefix it so a synthesized id can never collide
with a real RFC 5322 `<...>` msg-id, since both populations share one dedup index.

**How to apply:** when a sweep hands you a key/tuple, resolve each component to its
WRITE site and ask "is this stable across the retry/redelivery this key must
survive?" Then state the deviation and the evidence in the code comment, so the
next reader does not "restore" the sketch. Sibling: [[dedup-key-is-also-spent-at-the-vendor]].
