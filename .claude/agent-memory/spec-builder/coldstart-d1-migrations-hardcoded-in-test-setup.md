---
name: coldstart-d1-migrations-hardcoded-in-test-setup
description: apps/platform/test/setup.ts manually imports+applies each D1 migration file by name (not a directory scan) — a new migrations/NNNN_*.sql file is silently NOT applied in tests until you also add it there, producing a confusing "no such column"/"no such table" D1_ERROR that looks like a migration bug but is a test-wiring gap.
metadata:
  type: project
---

Adding `apps/platform/migrations/0017_foo.sql` (a real, correctly-formed D1
migration matching `wrangler.toml`'s `migrations_dir = "migrations"`) did NOT
make its new column visible in vitest — every test hitting it threw
`D1_ERROR: no such column: <col>: SQLITE_ERROR` / `table X has no column
named <col>`. Root cause: `apps/platform/test/setup.ts` does NOT read the
migrations directory at runtime — it has one `import migrationNSql from
"../migrations/000N_*.sql?raw"` line PER FILE (Vite `?raw`, baked at
transform time) plus a matching entry in the `statementsOf(...)` spread array
that actually executes them against `env.DB` in a `for` loop. A migration
file that exists on disk but isn't in BOTH lists is invisible to every test.
Clearing `node_modules/.vite` does NOT fix this (it's not a caching issue).

**Why:** `wrangler.toml`'s `migrations_dir` governs the REAL deploy path
(`wrangler d1 migrations apply`, run via `npm run deploy`), but the hermetic
vitest-pool-workers D1 in this repo is bootstrapped by this hand-maintained
list instead of scanning the directory — likely so the transform-time `?raw`
imports stay static/enumerable rather than needing dynamic `import.meta.glob`.

**How to apply:** whenever you add a new `migrations/NNNN_*.sql` file in this
repo, ALSO add its import + spread-array entry to `apps/platform/test/setup.ts`
in the same change — before assuming a "column doesn't exist" D1 error is a
migration SQL bug, check this file first. See [[coldstart-sqlstorage-row-typing-and-schema-template-literal]]
for the sibling TenantDO-local-SQLite (schema.ts) version of "a new table/column
needs wiring beyond just writing the SQL."
