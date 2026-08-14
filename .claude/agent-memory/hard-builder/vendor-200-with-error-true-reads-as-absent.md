---
name: vendor-200-with-error-true-reads-as-absent
description: "ColdStart InboxKitClient rejects only on non-2xx, so a 200 body carrying {error:true} flows through as a normal response — /mailboxes/list then read as 'the vendor holds nothing', the one verdict that authorizes an automatic re-buy."
metadata:
  type: project
---

`InboxKitClient.request` (apps/platform/src/vendors/real/inboxkit-client.ts)
checks `res.ok` and NOTHING else. The InboxKit API answers HTTP 200 with
`{error: true, message: ...}` for workspace-level failures, so an errored body
returns to the adapter as an ordinary successful response.

Each adapter method therefore has to check `body.error` ITSELF, and they did not
all do it. `listDomainRecords` checked it (throws). `findExactMailbox` did not:
an errored body left `body.mailboxes` undefined, `mailboxes?.[0]` undefined, and
the function returned "no such mailbox" — i.e. `absent`.

**Why that specific one is a money bug.** `absent` is the ONE mailbox verdict
that can authorize the automatic re-buy (`engine/mailbox-acquisition.ts`:
repeated absent + past `ABSENCE_MIN_AGE_MS` -> `{kind:"absent"}` -> one guarded
re-buy). So a bad `/mailboxes/list` response could buy a second paid mailbox for
an address the vendor already held. This is the
[[polling-check-error-is-indistinguishable-from-negative]] class living inside a
vendor adapter: the lookup's ERROR was shaped exactly like its NEGATIVE.

Fixed 2026-08-14 by making the inner lookup return a three-way
`found | absent | inconclusive` and mapping the errored body to `inconclusive`
(and `resolveMailboxUid`'s inconclusive throw to RETRYABLE, unlike the
definite-absence permanent throw).

**How to apply:** when auditing any InboxKit adapter method, the first question
is "does this one check `body.error`?" — the client will not do it for you. And
when a lookup feeds a spend decision, its failure mode must be a THIRD value,
never folded into the negative.
