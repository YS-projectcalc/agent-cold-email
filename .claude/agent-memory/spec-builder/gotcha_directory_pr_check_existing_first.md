---
name: gotcha-directory-pr-check-existing-first
description: before opening a new awesome-list/directory PR or submission issue for a repo, check gh pr list --author <you> and gh issue list --author <you> on the target upstream first — a prior attempt may already be open
metadata:
  type: feedback
---

Before pushing a branch or opening a PR/issue to submit a project to a third-party
directory (awesome-list PR, mcp.so issue, etc.), run `gh pr list --repo <upstream>
--author <you> --state all` (and the issue equivalent) first. On the coldrig
awesome-mcp-servers task (2026-08-16) a from-scratch fork clone still had a stale
local branch name collision because PR #10106 was already open upstream from
2026-07-14 — same repo, same author, but a DIFFERENT category (Marketing vs the
newly-briefed Communication) and a different badge/description. The push got
rejected on the branch-name collision, which is how it surfaced; it would have been
silent if I'd picked a fresh branch name.

**Why:** opening a second PR for the same repo/author to a different category on the
same upstream reads as spam/duplicate to list maintainers and risks both being closed,
including a legitimate month-old one nobody remembered. This is exactly the kind of
outward-facing, hard-to-reverse action the standing rule says to confirm on, and the
brief author (team-lead) had no way to know about the prior PR — it wasn't in their
ground-truth facts.

**How to apply:** for any "submit X to directory Y" brief, do the existing-submission
check as step zero, before cloning/branching. If a prior open submission turns up
that the brief didn't account for, stop and surface it (with the PR/issue URL and
what it did differently) rather than silently opening a competing one — this is a
scope question for whoever owns the public-facing decision, not something to resolve
unilaterally.
