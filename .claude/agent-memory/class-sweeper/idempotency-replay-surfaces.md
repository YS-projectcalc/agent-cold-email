---
name: idempotency-replay-surfaces
description: Search-coverage ledger — surfaces that UNDER-COUNT when sweeping the "idempotency key re-executes instead of replaying a recorded outcome" class in coldstart. Read FIRST.
metadata:
  type: reference
---

Sweeping "an idempotency key that fails to replay" in `~/dev/coldstart`. Grepping `idempot` finds the keys; these surfaces hide the members. Sibling of [[idempotency-at-least-once-surfaces]] (that one = inputs with NO key; this one = keys that exist and don't work).

1. **`_idempotencyKey` (underscore prefix) = ACCEPTED AND IGNORED.** Every `vendors/real/*.ts` InboxKit method takes an idempotency key and drops it — the vendor has no such primitive. `grep -n "_idempotencyKey"` is the single highest-yield pattern in this repo: it enumerates exactly the vendor calls whose retry-safety MUST live on our side. `packages/shared/src/vendor-ports.ts:4` ("Every side-effecting op takes an idempotencyKey so at-least-once retries…") reads as protection and is decorative.

2. **The MIRROR direction: claim kept, effect lost.** Don't only sweep "record deleted → re-execute". `INSERT OR IGNORE` claim-then-execute has the opposite failure when an `await` that can throw follows the claim: the claim commits, the work half-runs, the redelivery reads "duplicate" and skips forever. Test = for each of the 19 `INSERT OR IGNORE INTO` sites, does an `await` follow the claim in the same fn? (Only `billing.ts:348` webhook_events does; `events.ts:44` is sync-after and therefore immune.) A guard that only fixes re-execution leaves this live.

3. **First-party clients send NO key.** Sweep `packages/cli/src` + `apps/dashboard/src/api` too, not just the server. Neither ever sets `Idempotency-Key`; the server-side key is optional (`if (!key) return fn()`), so our own CLI's `infra setup` is unprotected by construction. Server-only sweeps score this path as "covered".

4. **A TEST can ENCODE the defect as intended behavior.** `apps/platform/test/idempotency.test.ts:241` asserts the claim IS deleted on throw ("error not cached"), using a side-effect-free fn. Always check whether the fix must CHANGE an existing green test — and whether the throw-path test uses an fn with no side effects (that is the blind spot, not coverage).

5. **Docs assert coverage the code doesn't have.** `ARCHITECTURE.md:46` claims "the sandbox simulates duplicate delivery + mid-step crash so idempotency is exercised in test mode" — zero crash/duplicate simulation exists in `vendors/sandbox/*` (grep `crash|duplicate|redeliver` → empty). `ROADMAP.md:31` had already recorded the exact live defect on 2026-07-29 and deferred it. Read ROADMAP `## Open` before declaring a finding novel.

6. **Dead-but-shipped schema carries unwired keys.** `followups.idempotency_key` (`schema.ts:674`) has no writer and NO unique index — a latent member that activates when `schedule_followup` is built.

7. **Keys derived from mutable state are unstable across retries.** `deliverability-actions.ts` builds `domainIndex` from `SELECT COUNT(*) FROM domains`, so the same logical retry mints a different key once a row lands. Read key CONSTRUCTION, never just the key's presence.
