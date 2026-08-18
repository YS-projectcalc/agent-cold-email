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
- **I3 credential push (F6, 2026-07-22).** A vendor-provisioned (BILLED) mailbox
  whose creds must be pushed to the droplet engine: if you push FIRST and only
  record on success, a failed push (or DO crash mid-push) leaves NO durable
  record ⇒ the billed mailbox is silently lost. FIX: `recordProvisionedMailboxForPush`
  writes a 'pending' `mailbox_cred_pushes` row BEFORE the push; the push marks
  'pushed' only on engine confirm, leaves 'pending' (+last_error) on failure and
  NEVER throws into the provisioning saga; a reconcile sweep retries 'pending'
  rows. RED-proof: remove the pre-push record ⇒ a failed push leaves status
  `undefined` instead of 'pending' (billed mailbox lost).

- **Alert state banked before the send (2026-08-18, wave-1+2 gate B2).** The
  DECIDER and the SENDER on opposite sides of an RPC: `WatchtowerDO.applyAlert`
  read prev, computed the transition, and `storage.put` it — then the WORKER
  sent. A failed send still stamped `lastAlertTs`/`alertCount`, so the next tick
  read an announced episode and SUPPRESSED for 6h, and recovery emailed the
  founder that an incident they were never told about was over. Same shape in
  the DO's own dead-man `alarm()`, which discarded `trySend`'s result entirely.
  FIX: split into `decideD1Alert` (read+decide, persists NOTHING) and
  `commitD1Alert(healthy, nowMs, notified)` (re-reads prev, re-derives the same
  pure transition, banks `delivered ? next : withheldAlertState(prev, next)`);
  the alarm does decide→send→bank in one method since it holds its own mailer.
  A caller that decides and never commits leaves state untouched ⇒ next tick
  re-attempts, which is the safe direction. See
  [[fix-shape-differs-when-decider-and-sender-split-across-rpc]] for why the
  Worker-side withhold pattern could NOT be pasted in here.

**THE MIRROR (2026-08-06, guarded mailbox re-buy).** For a NON-IDEMPOTENT PURCHASE
the rule inverts: the *risk* marker must be persisted BEFORE the call. A status
written after the vendor answers cannot distinguish "nothing was ever sent" from
"an accepted order whose status write a kill destroyed" — and the second read as
the first buys the thing twice (wave-integration gate #3; the same hole exists at
'dangling', where the buy THREW). FIX: a pre-call dispatch claim
(`mailbox_buy_dispatches.attempts`, incremented immediately before
`/mailboxes/buy`), which doubles as the crash-safe cap on retries. NOTE the two
rules do not conflict: persist-AFTER-confirm protects against *losing* work,
persist-the-RISK-BEFORE protects against *repeating* it — apply the second
whenever repeating the effect spends money or is otherwise unrepeatable. Its
timestamp must be a REAL clock (`RealClock`), not `ctx.clock`: the thing being
measured is the vendor's catch-up lag. And any such marker must be dropped at
teardown alongside the intent + idempotency claim, or a re-provision's FIRST buy
looks like a re-buy.

**The safe direction is vendor/effect AHEAD of the DB, never the reverse.**
provisioning.ts / lifecycle.ts / threads.ts are NOT members: they persist the DB
row only AFTER the vendor call confirms (idempotent-recoverable). **How to apply:**
before persisting a cursor/claim/status across an await to a vendor/HTTP/queue,
ask "if the effect never lands, is my durable state now lying?" If yes, either
persist-after-confirm or make the position consumer-owned + advanced only inside
the same transaction as the confirmed work. Relates to
[[async-tally-reset-on-triggering-action]] and [[sandbox-port-masks-real-server-contract]]
(the sandbox has no lost-response window, so this class is invisible in test mode).
