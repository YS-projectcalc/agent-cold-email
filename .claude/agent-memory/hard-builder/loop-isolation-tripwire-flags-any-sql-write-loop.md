---
name: loop-isolation-tripwire-flags-any-sql-write-loop
description: ColdStart's loop-isolation tripwire fails the FULL platform suite on any new for/while loop whose body contains ctx.sql.exec or an await, unless allowlisted — targeted test runs never show it
metadata:
  type: project
---

`apps/platform/test/loop-isolation-coverage.test.ts` (+ `loop-isolation-scan.ts`)
scans ALL platform sources for `for`/`while` loops whose body has an `await` OR a
durable write (`ctx.sql.exec`), and fails unless the loop routes through
`forEachIsolated`, has its own try/catch, or is in `ALLOWED_UNISOLATED_LOOPS`.

**Why it costs time:** it only fires in a full-suite run (~10 min), so a
row-at-a-time INSERT loop added to a new engine module passes every targeted run
and every typecheck, then reddens the battery at the end.

**How to apply:** when writing a new engine module, either build ONE multi-row
statement (`VALUES ${rows.map(() => "(?, ?)").join(", ")}` + `flatMap` params —
usually better anyway: all-or-nothing) or run
`npx vitest run test/loop-isolation-coverage.test.ts` alongside your own file
before the battery. Adding an allowlist entry is the last resort, not the first.

Related: [[failing-by-construction-env-coverage-guard]] (same
scan-the-source-as-a-test idiom), [[backtick-inside-template-literal-sql]] (also
bit me in `schema.ts` on this build — no backticks inside TENANT_DO_SCHEMA, even
in SQL comments).
