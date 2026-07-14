---
name: persist-before-confirm-cross-boundary
description: The defect CLASS "durable state advanced before the cross-boundary effect is confirmed" — cursors/claims/statuses that move ahead of a vendor call / HTTP response / DO commit, silently losing work on a crash or lost response.
metadata:
  type: project
---

CLASS (ColdStart, adversary-named 2026-07-14): a cursor / claim / status is
persisted BEFORE the cross-boundary effect it represents is confirmed. On a
crash or lost response the durable state is ahead of reality, so work is
silently dropped or a row is stuck forever. Known members + fixes:

- **Poll cursor loss (engine).** The engine advanced its own per-mailbox IMAP
  high-water THEN returned events over HTTP; a lost response ⇒ events gone
  forever (missed reply ⇒ stop-on-reply never fires). FIX: move cursor ownership
  to the CONSUMER — the Worker DO stores `mailboxes.poll_cursor`, passes it as
  `EmailPort.poll(mbx, sinceCursor)`, and persists the returned `cursor` in the
  SAME synchronous DO stretch as the event processing. Engine becomes
  cursor-stateless. A lost response leaves the cursor un-advanced ⇒ redelivery,
  made safe by the events unique-index dedupe on `message_id`.
- **tick.ts unguarded send() on a 'sending' row.** The row was claimed 'sending'
  before `await email.send()`; the real port throws (sandbox never did, so it was
  latent) ⇒ propagates out of runTick ⇒ row stuck 'sending' forever. FIX: try/catch
  grading the VendorError (transient⇒pending+attempts under cap; permanent⇒failed)
  PLUS a TTL-bounded stuck-'sending' reclaim (`sending_since` column) mirroring the
  idempotency 'pending' reclaim.
- **Idempotency 'pending' claim** (fixed earlier): TTL reclaim.

**The safe direction is vendor/effect AHEAD of the DB, never the reverse.**
provisioning.ts / lifecycle.ts / threads.ts are NOT members: they persist the DB
row only AFTER the vendor call confirms (idempotent-recoverable). **How to apply:**
before persisting a cursor/claim/status across an await to a vendor/HTTP/queue,
ask "if the effect never lands, is my durable state now lying?" If yes, either
persist-after-confirm or make the position consumer-owned + advanced only inside
the same transaction as the confirmed work. Relates to
[[async-tally-reset-on-triggering-action]] and [[sandbox-port-masks-real-server-contract]]
(the sandbox has no lost-response window, so this class is invisible in test mode).
