---
name: adversarial-docs-map
description: Where ColdStart's frozen adversarial review records live and how to check coverage before assuming a directory is unswept
metadata:
  type: reference
---

`docs/adversarial/*.md` holds ~45 frozen adversarial records (design reviews, build reviews, "gate" re-attacks), one file per arc, dated in the filename. `.claude/agent-memory/class-sweeper/*.md` holds 5 standing class-sweep coverage ledgers (vendor-mutation-saga, idempotency-replay, idempotency-at-least-once, error-mapping, partial-state-saga/coverage-ledger) — read these FIRST, they're a pre-built "what's covered" index with file:line citations.

**Lesson from the 2026-08-05 full-boundary-audit task:** a brief claimed `apps/engine/src` (the droplet daemon) was "EXPLICITLY UNSWEPT by every prior sweeper." False — 4 frozen docs cover nearly all of it (`engine-host-review-2026-07-14` 2 rounds, `engine-tenants-allowlist-review-2026-07-14`, `engine-443-transports-2026-07-16`, `pre-send-intent-log-design-review-2026-07-27` + `intent-log-build-review-2026-07-27` with a real SIGKILL e2e proof). The brief's authors likely meant "the 5 class-sweep lanes didn't cover it" (true) and over-generalized to "no sweeper ever did" (false). **Always check `git log --oneline -1 -- <dir>` + `git diff <old-review-ref> HEAD -- <dir>` before trusting a claim that a directory is unswept** — a directory can be covered by non-class-sweep docs (engine-host-review, transport reviews, design+build review pairs) that a brief writer didn't enumerate. The one real gap found in apps/engine was `mailbox-store.ts` (I3 self-serve credential push) — named as a DESIGN risk in `selfserve-activation-design-review-2026-07-21.md:34` but never re-attacked as BUILT code (the build review for that arc, `selfserve-i1i2-build-review-2026-07-21.md`, covers only I1+I2, not I3).

Naming convention to search by: `<feature>-review-<date>.md` (build/code review), `<feature>-design-review-<date>.md` (pre-build design attack), `<feature>-<date>.md` (misc), `panel-NN/` (multi-agent panel verdicts, older format). A doc with "ROUND 2" appended at the bottom is a re-gate of a fix round — always read to the end for the final verdict, round 1 verdicts are frequently superseded.
