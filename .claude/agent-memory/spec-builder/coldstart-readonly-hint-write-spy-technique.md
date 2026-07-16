---
name: coldstart-readonly-hint-write-spy-technique
description: How to build a genuine write-detecting oracle for MCP readOnlyHint claims in this repo (tenant data lives in DO SqlStorage, not D1) — and that get_dashboard has the same defect class, deliberately not fixed.
metadata:
  type: project
---

Tenant data in `apps/platform` lives in each `TenantDO`'s own `ctx.storage.sql`
(Durable Object embedded SQLite, exposed to engine functions as
`TenantContext.sql: SqlStorage`) — there is no separate D1 database for
tenant data (`env.DB` / `src/db.ts` is only the tiny token→tenant
control-plane index). So a brief asking for a "D1 spy/wrapper (intercept
prepare/exec/batch)" on tenant writes should really target `SqlStorage.exec`
— the only write surface every `engine/*.ts` function uses (grepped `ctx.sql.`
across the whole engine dir; zero `.prepare()`/`.batch()` calls).

To genuinely intercept it in a vitest-pool-workers test: use
`runInDurableObject(stub, async (instance, state) => {...})` from
`cloudflare:test`. Inside that callback you have the REAL `state.storage.sql`
object (same reference `requireContext()` hands to engine functions), and
`state.storage.sql.exec = wrappedFn` monkey-patches it for that DO instance —
verified by spike test that the patch persists across subsequent calls
through the normal HTTP path too (same DO instance, resolved by name). Existing
precedent for this exact pattern already in the repo:
`apps/platform/test/inbox-v2.test.ts:239-250` (counts exec calls for an N+1
regression guard) — I extended the same technique to flag any
INSERT/UPDATE/DELETE/REPLACE statement text for a readOnlyHint-honesty oracle
in `apps/platform/test/mcp-tool-annotations.test.ts`.

**While building the oracle I found a SECOND instance of the same defect
class that the frozen adversarial doc (`docs/adversarial/directory-readiness-2026-07-16.md`)
incorrectly called "pure SELECT":** `get_dashboard` → `listDashboardViews`/
`getDashboardView` (`apps/platform/src/engine/dashboard-views.ts:85-102`) both
call `ensureDefaultViewSeeded(ctx)` first, which does an unconditional
`SELECT COUNT` then `INSERT` if the tenant has zero `dashboard_views` rows —
a genuine one-time write on a fresh tenant's first-ever `get_dashboard` call,
same as the `infrastructure_status` bug in miniature (idempotent, narrower
blast radius, but the same "readOnlyHint:true claims no writes and is
wrong" shape). I did NOT fix it — out of the assigned brief's scope
(explicitly infrastructure_status only, explicit "do not change any other
annotation"). My oracle test pre-seeds the default view before arming the
spy (mirrors existing convention in `mcp-dashboard-tools.test.ts`) so it
doesn't false-fail on this known, separately-flagged gap — documented inline
with a code comment, not silently hidden.

**Why:** the team-lead's brief and its underlying adversarial record can be
wrong about "which tools are pure" even after an adversary review — always
grep the ACTUAL handler chain (`ctx.sql.exec` sites) for every tool named
"pure read" before trusting the classification, especially when building the
oracle that's supposed to catch exactly this class of claim.

**How to apply:** next session that touches MCP tool annotations in this
repo, re-run/extend `apps/platform/test/mcp-tool-annotations.test.ts`'s spy
describe block rather than re-deriving the technique.

**Update 2026-07-16 (same session, follow-up round):** orchestrator ruled
`get_dashboard` in-class and had me fix it. Same fix shape as
`infrastructure_status`: `dashboard-views.ts`'s `listDashboardViews`/
`getDashboardView` no longer call `ensureDefaultViewSeeded` (moved to the
write paths only — create/update/promote/delete, unchanged there); they
return a new `virtualDefaultViewRow(ctx)` (computed in-memory, zero writes)
when the table is empty. Two non-obvious things that mattered:
1. The persisted default row's `id` was ALREADY a hardcoded literal
   `'default'` (never a `newId()`-random id) — so "use a deterministic
   sentinel ID" was a non-issue here, already true by construction. Check
   this FIRST before assuming you need a synthetic ID scheme.
2. Timestamps (`updated_at`/`created_at`) are the one non-constant field in
   the virtual row — anchoring them to `ctx.clock.now()` at call time would
   make them drift between successive reads (a subtle regression + would
   have broken an existing test asserting two pre-seed GETs return identical
   `updatedAt`). Fixed by anchoring to the tenant's own
   `tenant_profile.created_at` instead (one extra harmless SELECT) — stable
   across any number of reads before the first real write. General lesson:
   when materializing a "virtual" DB row for a read-only path, audit EVERY
   field for read-to-read stability, not just the ID.
Also: I un-masked the write-spy oracle (removed the pre-seed workaround I'd
added round 1) and re-proved red→green with the same cp-backed revert
technique — confirms the oracle is meant to run against a genuinely virgin
fixture, never pre-seeded, or it silently stops testing the exact case
(first-ever call) that this whole defect class lives in.

**Update 2026-07-16 round 3 (re-attack found MY fix #2 introduced a
regression):** `getDashboardView`'s `id === "default"` fallback fired
whenever the ROW for that specific id was missing — but a demoted default
row (`promoteDashboardViewDefault` moves `is_default` off it) CAN be
legitimately deleted afterward (`deleteDashboardView`'s guard checks
`row.is_default === 1`, not `id === "default"`), leaving a NON-virgin
tenant with no `default`-id row. My fallback then fabricated a phantom
virgin starter view instead of the correct 404 — HEAD `249d065` 404'd here,
my fix silently didn't. **Lesson: when gating a "virtual/synthetic row"
fallback on "is this specific lookup missing," check whether the SAME
condition can arise on a NON-virgin dataset via some OTHER code path (here:
promote-then-delete) — the correct gate is "is the WHOLE table empty"
(`COUNT(*) === 0`), matching the sibling list function's own
`rows.length === 0` invariant, not "is this one id absent." Two "is this
tenant virgin" tests that use different predicates for sibling functions
(list vs get) is itself a smell — should have unified them from round 2,
would have caught this without needing a round 3.** Also: a comment
asserting an invariant ("X can never happen") is itself a defect if unproven
— my round-2 comment claimed exactly the false invariant the adversary
disproved by reading the ACTUAL delete guard's condition, not the field name
it's named after. Verify invariant claims against the literal guard code,
never against what a name like `is_default` "should" mean.
