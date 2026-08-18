---
name: coldrig-search-coverage-ledger
description: Surfaces that UNDER-COUNT in ColdStart class sweeps — check these first before declaring an inventory complete
metadata:
  type: project
---

Search-coverage ledger for `~/dev/coldstart`. Cover these surfaces FIRST; each one has hidden or under-counted a sweep here.

**Tenant tables are NOT in `migrations/*.sql`.** `apps/platform/migrations/` is D1/platform-level ONLY (watchtower, stripe, sdn, sessions). Every per-tenant table (`domains`, `mailboxes`, `domain_intents`, `tenant_messages`, `mailbox_cred_pushes`) lives in the Durable Object: `src/schema.ts` (CREATE TABLE + the load-bearing column doc comments) and `src/tenant-do.ts`'s `ensureColumnMigrations()` / `addColumnIfMissing()` (the real "migration" list). A sweep that greps `migrations/` for a tenant column finds nothing and wrongly reports zero sites.

**Vendor-truth surfaces are three-layered.** The port contract (`packages/shared/src/vendor-ports.ts` — the TYPES that permit or forbid a conflation), the real adapter (`src/vendors/real/*.ts` — where a vendor status string collapses into a boolean/enum), and the sandbox adapter (`src/vendors/sandbox/*.ts` — always-succeeds, which is where a real vendor's contract goes to hide; a fault an engine test cannot express is a fault no suite catches). Check all three or the count is short.

**`docs/adversarial/` often already holds an executed proof.** Read the newest file(s) matching the wave before sweeping — they carry file:line + green-test output. Some are UNTRACKED (`git status --porcelain`); `git show`/`ls-files` misses them, plain `ls` does not.

**`ROADMAP.md` is ~78KB single-line entries.** Never dump it; grep narrowly and pipe through `cut -c1-220`. Actionable class items live under `## Now` / `## Open` with `[ORDER]`/`[ASK]` tags — a confirmed defect is usually already written there before the sweep starts.

**Bounded-pending prior art exists in FOUR places, not one.** When proposing a bound/escalation guard, cite all: BYO `dns_check_count`/`dns_first_checked_at` + 7-day abandon (`engine/byo-intake.ts`), `warmup_cancel_attempts` + `warmup_cancel_gave_up_at` + a founder signal (`engine/warmup-cancel.ts`, `admin/sweep-signals.ts`), `MAX_BUY_DISPATCHES` (`engine/provision-intents.ts`), and `AGING_CRED_PUSH_MS` + a per-entity watchtower check (`engine/ops-summary.ts`, `admin/watchtower.ts`). Naming only the first under-sells the codebase's own idiom.

**Escalation surfaces to check for facet-2 (unbounded) sweeps:** `admin/watchtower.ts` (per-entity check names), `admin/sweep-signals.ts` (`LEG_COUNTERS` auto-covers any new sweep leg that returns an `errors` field), `engine/ops-summary.ts` (`sendPipeline`), `engine/tenant-messages.ts` (dedup-refresh means a recurring condition never grows rows — and never escalates either).

Related: [[coldrig-vendor-truth-conflation-class]]
