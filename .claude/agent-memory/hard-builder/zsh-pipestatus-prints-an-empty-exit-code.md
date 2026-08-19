---
name: zsh-pipestatus-prints-an-empty-exit-code
description: In the zsh tool shell `${PIPESTATUS[0]}` expands to NOTHING, so `cmd | tail; echo EXIT=${PIPESTATUS[0]}` prints a blank that reads like a pass
metadata:
  type: reference
---

The Bash tool runs **zsh**. zsh's array is `pipestatus` (lowercase) and its arrays are 1-INDEXED,
so the bash idiom `${PIPESTATUS[0]}` expands to the empty string — the verification line prints
`EXIT=` and a skimming reader takes it for `EXIT=0`. It is exit-code THEATER: worse than no check,
because it looks like one.

**How to apply:** never pipe a test/build runner when the exit code is the evidence
(this repo's [[piped-test-runner-eats-failing-exit-code]] class). Run it unpiped into a file and
read `$?` directly:

```
cmd > /path/out.txt 2>&1; echo "EXIT=$?"; tail -25 /path/out.txt
```

If a pipe is unavoidable in zsh, it is `${pipestatus[1]}`.
