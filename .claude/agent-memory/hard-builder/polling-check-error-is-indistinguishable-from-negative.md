---
name: polling-check-error-is-indistinguishable-from-negative
description: "CLASS: a polling/liveness check whose ERROR output looks identical to its NEGATIVE result (empty stdout + suppressed stderr) reports 'nothing happening' when it is actually broken; macOS find/bfs rejects relative -newermt."
metadata:
  type: feedback
---

CLASS: a polling check whose FAILURE renders identically to its NEGATIVE RESULT will
silently report "all clear." Never suppress stderr on a check whose empty output is
itself the finding, and prove the check can go POSITIVE before trusting a negative.

**Concrete instance (2026-08-02, ColdStart concurrent-agent detection):** polled for a
rival writer with

    find apps packages -type f -name '*.ts' -newermt '-90 seconds' 2>/dev/null

Six iterations of blank output read as "the tree is quiet, the other agent stopped."
It was still writing (`test/warmup-cancel.test.ts` landed mid-poll). macOS `find` is
**bfs**, which REJECTS relative timestamps — `bfs: error: Invalid timestamp. Supported
timestamp formats are ISO 8601-like` — so every iteration errored, and `2>/dev/null`
converted the error into a clean-looking negative. GNU-flavored `-newermt '-90 seconds'`
is not portable here.

**Why:** the check's own breakage and the answer "no activity" are the same bytes on
stdout. Nothing in the output distinguishes them, so confidence is unearned. This is the
same shape as a vacuous test guard passing on an empty set.

**How to apply:**
- Detecting a concurrent writer: poll `md5 -q <files>` and compare hashes, or
  `touch -t $(date -v-45S +%Y%m%d%H%M.%S) REF` then `find ... -newer REF`. Both were
  verified working; the md5 poll is what actually caught the live write
  (`schema.ts ec882ea6… -> 7cd6d8a7…`).
- Keep stderr visible (`2>&1`) on any check whose negative result is load-bearing.
- Before trusting a "quiet" reading, confirm the probe CAN fire — point it at a file you
  just touched. An unproven negative is not evidence.
- Corroborate a file-mtime "quiet" with a process check (`ps -p <pid>`): an agent waiting
  on a ~4min vitest run writes nothing and looks identical to a dead one. Quiet tree +
  live PID = verifying, not stopped.

Related: [[agent-error-death-can-resume]] — a "relieved"/silent agent can auto-resume on
its stale brief and rebuild the same task concurrently; mtime forensics is how you catch
it before double-editing. See also
[[coldstart-sibling-agent-pkill-vitest-collision]].
