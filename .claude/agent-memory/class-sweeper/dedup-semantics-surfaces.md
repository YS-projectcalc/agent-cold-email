---
name: dedup-semantics-surfaces
description: ColdStart class-sweep — where undisclosed-collapse/dedup defects hide (engine-side drop-for-missing-key, disclosure boundary, alert flap-deletion, claim surfaces, tests pinning the defect). Cover these on any dedup/idempotency/alerting sweep.
metadata:
  type: reference
---

From the dedup-semantics sweep (2026-08-17, ref `9d3ec7e9`, 23 IN / 4 UNCERTAIN / 19 OUT —
`docs/adversarial/class-sweep-dedup-semantics-2026-08-17.md`).

**Sharpen the class first.** "Any dedup that can destroy a signal" over-catches every
rate cap in the repo. The real mechanism is the PAIRING: *a collapse taken on a key/window/view
coarser than the signal's identity, AND reported to the actor as an ordinary success.* A
coarse key that throws is immune (`campaigns.ts:93-108`); an exact key with a bare 201 is
immune. Score both halves per site.

- **The DISCLOSURE boundary is a separate surface from the dedup site, and no code grep
  finds it.** `contact-operator-guard.ts:126` decides; `routes/messages.ts:36-41` answers
  **201 Created** for the collapse; `mcp/tools.ts:376` passes it through; there is no
  `ContactOperatorResult` in `packages/shared` at all (declared inline at
  `contact-operator.ts:40-43`). Always walk decision → RPC → route → shared type → openapi.
- **A dedup REQUIREMENT can drop the signal outright — and it lives in the OTHER service.**
  `apps/engine/src/classify.ts:100-101` returns null when an inbound reply has no
  `Message-ID` ("no stable dedupe key -> can't safely emit"); `engine.ts:237-246` does
  `if (event) events.push(event)` with no counter/log and **still advances the cursor**. A
  real prospect reply is destroyed permanently. An `apps/platform/src`-only sweep misses it
  100%. Always sweep `apps/engine/src` + `packages/cli/src` (`apps/dashboard` has none).
- **Settle key-vs-signal-identity at the PORT CONTRACT, not the consumer.**
  `packages/shared/src/vendor-ports.ts:283-323`: `PolledReply.messageId` = the INBOUND id
  (exact → immune); `PolledBounce`/`PolledComplaint` carry only `originalMessageId` and NO
  id of their own, and `classify.ts:37-67` discards the DSN's own Message-ID — so two
  distinct DSNs for one send are indistinguishable from a re-poll. The sandbox
  (`vendors/sandbox/email-port.ts:45-107`) reuses `result.messageId` for every DSN, so this
  is untestable with current fixtures BY CONSTRUCTION (the sandbox-masking lesson again).
- **Alert debounce deletes FLAPS, not just one-shots.** The 2026-08-16 wave closed the
  never-re-observed half (`IMMEDIATE_ALERT_POLICY`). Still live: `watchtower-grading.ts:100-112`
  (`gradeStreak` resets `unhealthy` to 0 on any good tick → a leg failing every other tick
  NEVER alerts) and `watchtower-policy.ts:224-234` (`confirmAfterObservations=2` +
  `healthyState()` zeroing `unhealthyObs`). Also `:213-217` — `suppressed` has no
  changed-detail escape, so `domain_dns_aging` escalating "aging" → "GIVEN UP" waits up to
  the 24h steady step. Never accept "the debounce class is closed" without asking *which half*.
- **Re-stamping `created_at` breaks the KEYSET CURSOR too, not just the LIMIT-N preview.**
  The audit found the `LIMIT 5` eviction (`tenant-messages.ts:194-209`); one layer down,
  `listMessagesPage`'s `(unacked, created_at, rowid)` cursor doc claims a mid-pagination
  emit can't shift an issued page — true for INSERT, false for the dedup UPDATE at `:89-101`,
  which moves a row from below the cursor to above it and skips it for that whole pass.
- **Claim surfaces asserted the missing guarantee, again.** `mcp/tools.ts:86` +
  `openapi.yaml:1188` + `AGENTS.md:71` say *"poll this ... so you never miss one"* over the
  evictable view; `tools.ts:371` + `openapi.yaml:1250-1267` describe the F7 collapse as
  "safe". `openapi.yaml:1267` even documents the dedup hit while the response SCHEMA has no
  discriminator.
- **Tests PIN the defect**: `test/tenant-messages.test.ts:59` ("refreshes instead"),
  `test/contact-operator.test.ts:170,508`. A green suite at HEAD is evidence FOR the class.
  Say so, or the fixer will think they broke something.
- **Boot-time DDL is a retroactive amplifier.** `tenant-do.ts:514-526` `ensureDedupeIndex`
  DELETEs historical rows sharing the key on EVERY DO construction. A too-coarse key doesn't
  just decline future writes — it destroys the existing surplus.
- **Compliant in-repo templates for this class**: `campaigns.ts:93-108` (content hash +
  window, THROWS `DuplicateCampaignError` naming the prior id and the correct retry route)
  and `apps/engine/src/mailbox-store.ts:35-60` (content-hash dedup ORDERED by a monotonic
  `pushSeq`; same-seq-different-content is REJECTED loudly, plus tombstones). Cite these
  rather than inventing a shape. `ackMessage`'s `alreadyAcked` is the disclosure precedent.
- **Adjacent classes to hand back, not absorb**: threshold/dead-band silence
  (`gradeFailureSignals` holds at 1-2 failures/hour forever) and mixed time bases under
  dedup windows (demo/free VirtualClock at 1440× makes a "30 day" TTL ~30 real minutes —
  the OVER-count direction). See [[coverage-ledger]].
