---
name: brief-orders-already-shipped-work
description: A "build X — last open item" brief can target work that already shipped; reproduce committed state before implementing to avoid duplicating/corrupting a shipped feature.
metadata:
  type: feedback
---

When a brief orders "build X" and cites a ROADMAP open item, DO NOT start implementing — first verify whether X already exists in the committed tree. Ledgers drift: an item can be BUILT+committed while an older, undrained ROADMAP entry still lists it as OPEN.

**Why:** On the coldstart ENGINE_TENANTS task (2026-07-20), the brief said "build the per-port activation factory change — last open code item." The feature was already fully committed at `f74687d` (factory + tenant-do wiring + env + tests + README), adversary-SHIP. Re-implementing would have duplicated committed logic (anti-slop rule c) and risked corrupting a shipped, dark feature. Reproduce-before-diagnose caught it: `git log -- <file>` + reading the caller wiring showed it done.

**How to apply:** Grounding order for any "build X" brief → (1) grep/read the target files, (2) `git log --oneline -- <file>` to see if the change landed, (3) check `git status` for whether it's committed vs uncommitted-in-worktree. If already committed: report that finding, do NOT rebuild, and instead deliver the genuine outstanding value (often the verification the prior pass deferred — here, the physical revert-fail-restore proof the adversary left UNVERIFIED). Related: [[coldstart-engine-tenants-lane-done]].
