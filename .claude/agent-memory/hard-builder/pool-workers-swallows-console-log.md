---
name: pool-workers-swallows-console-log
description: ColdStart apps/platform — @cloudflare/vitest-pool-workers swallows console.log from inside the worker ENTIRELY (probed: a unique marker produced 0 hits in the run output), so any harness whose deliverable is a TABLE cannot emit it from a test; bundle a standalone Node reporter with esbuild instead.
metadata:
  type: project
---

Probed 2026-08-24 in `apps/platform`: a one-line test doing
`console.log("PROBE_MARKER_12345")` passed, and `grep -c` on the full run output
returned **0**. Not a reporter flag — `--silent` is already false, and
`--disable-console-intercept` is not a vitest-4 flag (passing it silently ate the
positional file filter and ran the WHOLE 240-file suite instead, ~10 min).

**How to apply.** Split a measurement harness in two: assertions stay in vitest,
NUMBERS come from a standalone script. There is no `tsx` in this repo, and Node's
native type-stripping will not resolve the `.js`-extension imports NodeNext
requires, so bundle first:

```
npx esbuild test/<dir>/report.ts --bundle --format=esm --platform=node \
  --outfile=/tmp/report.mjs && node /tmp/report.mjs
```

esbuild DOES resolve TypeScript's `./foo.js` -> `foo.ts` convention, so the source
can keep the extensions `tsc` demands. Two gotchas in the bundled script:
`import.meta.url` now points at the temp dir (resolve against `process.cwd()` and
throw loudly if the anchor file is missing), and it cannot import anything pulling
`cloudflare:` deps — read such constants out of the source text with a regex that
THROWS when it fails to match, so the reporter can never quietly grade against a
stale threshold.

Related: [[coldstart-vitest-binding-and-d1-isolation-gotchas]],
[[piped-test-runner-eats-failing-exit-code]].
