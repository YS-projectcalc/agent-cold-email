# Adversarial RE-ATTACK — directory-readiness readOnlyHint fixes (2026-07-16)

Frozen record. Reviewer: adversary (fresh context). Grounded HEAD `249d065c6ce687bcad1e19c22ac24c6a3b89d699` (verified unchanged start→close; in-scope files dirty-as-reviewed in the working tree). Git read-only throughout (status/diff/show/grep only).

Re-attack of the two fixes made after the prior NO-SHIP (`docs/adversarial/directory-readiness-2026-07-16.md`). Class under attack: **a tool annotated `readOnlyHint: true` whose handler writes.** Mandate: hunt the same class one layer up and try to break the fixes; a clean pass is the ship gate.

## Scope
Working-tree diff vs `249d065`, in-scope only:
- `apps/platform/src/engine/mailbox-state.ts` (pure `computeMailboxWarmupState` + read-only `computeMailboxWarmupSnapshot`)
- `apps/platform/src/engine/provisioning.ts` (`getInfrastructureStatus` now zero-write)
- `apps/platform/src/engine/dashboard-views.ts` (`virtualDefaultViewRow`; reads no longer seed)
- `apps/platform/src/mcp/tools.ts` + `handler.ts` (annotations)
- `apps/platform/test/mcp-tool-annotations.test.ts` (the write-detecting spy — the guard)
- `.claude-plugin/plugin.json`, root `README.md`
IGNORED per brief: all `apps/engine/**`.

## VERDICT: NO-SHIP — 1 BLOCKING (correctness regression introduced by Fix #2)

The **annotation-honesty class itself is CLOSED**: both `infrastructure_status` and `get_dashboard` are now genuinely write-free on every reachable read path (traced + spy-verified). Fix #1 is airtight. **But Fix #2's mechanism introduced a NEW, reachable correctness regression**: `get_dashboard('default')` returns a *fabricated* default view (instead of the correct 404) for a non-virgin tenant whose `default`-id view was legitimately deleted. It is read-only (no write, no data/security impact), so it does not reopen the write-class — but it is a reachable wrong-data-to-agent defect on the exact MCP surface the directory bundle certifies, the fix's own inline comment asserts a FALSE invariant, and it is the precise attack the brief flagged. Reported BLOCKING; a lead could reasonably downgrade to NON-BLOCKING for a local pilot given the edge sequence + zero data impact.

---

## Findings

### BLOCKING — Lens 2/6/7 (correctness regression / false invariant / regression ring). `get_dashboard('default')` masquerades a DELETED default view as a virgin virtual view.
- **The false claim:** `dashboard-views.ts:135-138` comment — "No row for id === 'default' always means a virgin tenant … deleteDashboardView refuses to ever delete the default, so once a write path seeds it, 'default' can never go missing again." **This is false.** `deleteDashboardView` (`dashboard-views.ts:234-246`) guards on `row.is_default === 1`, NOT on `id === 'default'`. The `default`-id row can be *demoted* (its `is_default` moved to another view by `promoteDashboardViewDefault`, `:224-230`) and THEN deleted.
- **Reachable sequence (all via MCP `configure_dashboard` + `get_dashboard`):**
  1. `create` name="myview" → `ensureDefaultViewSeeded` seeds `default` (is_default=1) + inserts `myview` (is_default=0).
  2. `promote` id="myview" → `UPDATE … is_default=0 WHERE is_default=1` demotes the `default`-id row; `myview` becomes is_default=1.
  3. `delete` id="default" → `getRow('default')` returns is_default=0 → passes the `is_default===1` guard; total=2 > 1 → passes the last-view guard → `DELETE WHERE id='default'`. The `default`-id row is gone; `myview` is the real default.
  4. `get_dashboard` id="default" → `getDashboardView(ctx,'default')`: `SELECT WHERE id='default'` → no row → `if (id === "default") return toDetail(virtualDefaultViewRow(ctx))` (`:139`) → **returns a fabricated starter-layout view {id:'default', name:'Default', is_default:1, rev:1}.**
- **Failure scenario:** an agent (or a UI deep-link `/dashboard/views/default`) that requests view `default` after this cleanup receives a phantom view claiming `isDefault:true` — while `list_campaigns`-style `listDashboardViews` correctly returns only `myview` (also `isDefault:true`). Two conflicting "the default" answers; the phantom carries the boilerplate starter layout, not the tenant's real default. A follow-up `configure_dashboard update id='default'` then 404s (no row), so the phantom is un-writable (no corruption path) — but the READ is fabricated data presented as real.
- **Regression proof (old vs new):** OLD `getDashboardView` (`git show 249d065:apps/platform/src/engine/dashboard-views.ts`) was `ensureDefaultViewSeeded(ctx); return toDetail(getRow(ctx,id));` → in this sequence `getRow('default')` throws `NotFoundError` → correct **404**. NEW code → fabricated phantom. The fix converted a correct 404 into wrong data.
- **Verification:** traced the full branch logic in source (delete guard `:237` is `is_default`, not `id`; promote demotes `:224`; getDashboardView fallback `:139`); confirmed `virtualDefaultViewRow` cannot throw on this tenant (`tenant_profile` row always exists, `.one()` succeeds). Confirmed the exact sequence is UNTESTED: `dashboard-views.test.ts:257` deletes a *created* (never-demoted-default) view; `:227` promotes but never then deletes the old default — so no test exercises delete-of-demoted-default + get. Full platform suite is green (361/361) *with this defect present*, which is why it slipped.
- **Note (does NOT rescue it):** rename alone does NOT trigger this — `updateDashboardView` COALESCEs `name` but never touches the `id`/slug (`:197`), so a renamed default keeps `id='default'` and is found as a real row. Only demote+delete removes the `default`-id row. So the brief's "renamed" concern is clean; the "deleted" concern is the live defect.
- **Fix direction (reviewer flags, does not implement):** either (a) `getDashboardView('default')` returns the virtual row ONLY when the tenant is genuinely virgin (`SELECT COUNT(*) FROM dashboard_views == 0`), else 404; or (b) make `deleteDashboardView` refuse to delete the literal `id='default'` row (not just the current default). Option (a) matches the list path's `rows.length === 0` virgin test and is the tighter invariant.

### NON-BLOCKING — Lens 5. Virtual-vs-seeded timestamp divergence (documented tradeoff, cosmetic).
- `virtualDefaultViewRow` (`:101-118`) anchors `updated_at`/`created_at` to `tenant_profile.created_at`; the real `ensureDefaultViewSeeded` INSERT (`:79-86`) stamps them with `ctx.clock.now()` at first-mutation time. So a client that reads `get_dashboard('default')` (createdAt = tenant-creation), then performs any mutation (which seeds the real `default` row), then re-reads, sees `detail.createdAt`/`updatedAt` jump forward to the mutation time.
- Ruled NON-BLOCKING: `toSummary` (the list path) omits `createdAt`, so `list` is unaffected; `rev` is `1` in BOTH the virtual row and the seed INSERT, so the rev-CAS base a client reads from the virtual row stays valid after the seed (verified: `updateDashboardView` seeds rev=1 then matches input.rev=1). Impact is a display-only timestamp shift on the detail view. Intentional and documented (`:94-99`).

---

## Attacks that FAILED (survived — this is what makes the PASS-parts meaningful)

- **Lens 1 — Fix #1 divergence hunt (infrastructure_status). SOLID, zero divergence.** `getInfrastructureStatus` (`provisioning.ts:186-233`) now calls `computeMailboxWarmupSnapshot` (read-only) instead of `refreshMailboxWarmupState` (persisting). Both compute via the SAME pure `computeMailboxWarmupState(row, now)` (`mailbox-state.ts:32`), over the SAME row set (both `SELECT … FROM mailboxes WHERE tenant_id = ?`, `:56` and `:98`), with the SAME `now = ctx.clock.now()`. Snapshot `sentToday = rolledOver ? 0 : row.sent_today` mirrors the persist path's rollover `sent_today = 0` exactly. Day-rollover / epoch-day / warmup-ramp math is untouched by the diff (same `epochDay`/`computeWarmupDay`/`warmupDailyCap`). So the snapshot returns byte-for-byte what the tick would persist. HELD.
- **Lens 1 — status column not stale in the response.** The returned `status` is `s.warmupStatus`, freshly computed by `gatherMailboxHealth` from `warmupStatus(warmupDay)` (`deliverability.ts:279`), never the possibly-stale DB `status` column; `sendReady`/`warmupDay` likewise fresh. Only `dailyCap`/`sentToday` are overridden from the snapshot (`provisioning.ts:210-211`), and those are the only warmup-derived fields `gatherMailboxHealth` read raw from the DB. Internally consistent. HELD.
- **Lens 4/7 — no OTHER consumer regressed by dropping the read-tool write.** The tick still persists via `refreshMailboxWarmupState` (`tick.ts:158`). The deliverability sweep reads raw `daily_cap` via `gatherMailboxHealth` (`deliverability-actions.ts:218`) but NEVER called `refreshMailboxWarmupState` first — even pre-fix — so it never depended on `infrastructure_status` opportunistically freshening the DB; its inputs are unchanged. Throttle persistence rides `cap_override` (`:48`), untouched. No path relied on a read tool's write. HELD.
- **Lens 3 (guard, one layer up) — the write-spy's SQL-only scope is adequate for THIS codebase.** The spy (`mcp-tool-annotations.test.ts:207-214`) patches only `state.storage.sql.exec`. Verified `ctx.sql === this.ctx.storage.sql` (`tenant-context.ts:250` = `requireContext`), so the monkey-patch intercepts EVERY engine `ctx.sql.exec` write — not a re-implementation. Enumerated non-SQL write channels for all 9 read-only tools by reading each DO wrapper (`tenant-do.ts:270-375`) transitively: none call `ctx.storage.put/delete/setAlarm` (DO KV/alarms), `env.DB` (control-plane D1), KV/R2, or queue sends — the wrappers are thin `return getX(requireContext())`. `getAccount` is pure SELECT (usageCents = `SUM(ledger_entries)`, not a metered-write; no Stripe report). Tenant data lives exclusively in SqlStorage (D1 is only the token→tenant index). So no read tool can reach a write channel the spy is blind to. HELD.
- **Revert-proof #1 reproducible (infrastructure_status).** The spy invokes `i.infrastructureStatus()` against a fixture with a REAL mailbox advanced past warmup (`:159-172`, comment `:154-158` explicitly guards the zero-mailbox false-green). On pre-fix code, `refreshMailboxWarmupState`'s `UPDATE mailboxes …` fires through the patched `ctx.sql.exec` → `seenWrites` non-empty → `expect(writes).toEqual([])` FAILS. Genuinely catches the original defect. HELD.
- **Revert-proof #2 reproducible (get_dashboard).** The spy invokes `i.dashboardViews()` against a genuinely VIRGIN tenant (comment `:192-196`: deliberately never seeds). On pre-fix code, `listDashboardViews`→`ensureDefaultViewSeeded`'s `INSERT INTO dashboard_views` fires → FAILS. Catches the original lazy-seed write. (Residual: the spy exercises only the no-id `dashboardViews()` list path, not `dashboardView('default')` — both are write-free by trace, but only `list` is spy-covered. Acceptable, because the masquerade above is a READ-correctness bug, not a write the spy could catch.)
- **Prior NON-BLOCKING items stayed addressed.** (a) `plugin.json:description` now carries "Free sandbox demo now; early access — real sending is not yet active. $99/mo for 5 mailboxes once live." — matches the disclosure `server.json` ("free sandbox now. Early access") and `server-card.json` (`status:"early-access"`, `statusNote:"Real sending is not active"`) carry. The Glama-kill shopfront-staleness regression is closed. (b) `setup_infrastructure`'s comment (`tools.ts:60-65`) is now truthful: it explicitly states `tenant_profile`'s brand/primaryDomain/physicalAddress/senderIdentity ARE overwritten on every call, no longer the imprecise "never overwrites." (c) No other annotation drifted: the 17-tool READ_ONLY/DESTRUCTIVE/ADDITIVE classification is unchanged and the exhaustiveness test (`:103-108`) still pins the full set.
- **Full verification RE-RAN clean.** platform `npm test` **361/361** (59 files); platform `typecheck` exit 0; cli `npm test` **9/9** (incl. the previously-flaky bridge lane) + cli `typecheck` exit 0; `claude plugin validate .` PASSES (name `coldrig`; only the pre-existing "CLAUDE.md at plugin root not loaded as context" warning, confirming plugin root = repo root).

---

## Correction to the PRIOR frozen doc (NOT edited there — recorded here per house rule)

`docs/adversarial/directory-readiness-2026-07-16.md` **line 39** ("Attacks that FAILED") listed `listDashboardViews`/`getDashboardView` among tools that "are all pure SELECT … HELD." **That was wrong at HEAD `249d065`.** At that commit both functions called `ensureDefaultViewSeeded(ctx)` at their top, which `INSERT`s a `default` row on a virgin tenant — i.e., they WROTE on first read. The prior review's BLOCKING was scoped only to `infrastructure_status` and MISSED that `get_dashboard` was a SECOND member of the very same `readOnlyHint:true`-but-writes class (a lazy INSERT via `ensureDefaultViewSeeded`). The builder's fix correctly addressed BOTH members (the spy's `get_dashboard` invocation + the `virtualDefaultViewRow` change are direct evidence they identified the `get_dashboard` write too) — so the fix set is MORE complete than the prior review demanded. The regression documented above is a side effect of Fix #2's mechanism, not of the prior miss.

## UNVERIFIABLE (not folded into the verdict)

- **Real-adapter `ctx.adapters.mailbox.getHealth` side effects.** `infrastructure_status` awaits an outbound `getHealth(email)` vendor fetch (`provisioning.ts:203`) that the SQL-only spy cannot see. In this build it is the sandbox mock (`realAdaptersActivated=false`, `tenant-do.ts:233`), semantically a READ, and it predates these fixes — so no NEW risk here. Whether the REAL Inboxkit adapter's `getHealth` is truly side-effect-free could not be verified (real adapters are dark/gated). Resolve at activation with a live-adapter read-only check.

## NEW / out-of-scope observations (no verdict weight)

- **List-vs-get inconsistency is intrinsic to the id==='default' fallback.** Even independent of the delete regression, `listDashboardViews` returns virtual only when `rows.length === 0`, whereas `getDashboardView('default')` returns virtual whenever the `default` row is individually absent. The two "is this tenant virgin?" tests differ (whole-table-empty vs one-row-absent), which is the root of the masquerade. A single shared virginity predicate would remove the divergence class.

---

# ADDENDUM — round-3 re-verdict (2026-07-16, after the masquerade fix)

Reviewer: adversary (fresh context, same session). Grounded HEAD still `249d065` (round-3 fix is uncommitted working-tree, verified dirty-as-reviewed). Git read-only. The original verdict above is preserved verbatim; this addendum records the re-verdict on the fix.

## ADDENDUM VERDICT: **SHIP**

The one BLOCKING finding (`get_dashboard('default')` phantom masquerade) is fully resolved by round-3 (option (a) as recommended). My exploit no longer reproduces; the new gate survived every fresh edge I threw at it; nothing else drifted. Fix #1 and the annotations remain as passed in the original verdict.

## The round-3 change (diff vs `249d065`, `dashboard-views.ts` `getDashboardView` only)
`getDashboardView` now returns the virtual default ONLY when `id === "default"` **AND** whole-table `SELECT COUNT(*) FROM dashboard_views === 0`. Any existing row → a missing id (including `'default'`) falls through to `throw new NotFoundError`, exactly as `249d065` behaved. The false invariant comment ("no 'default' row ⇒ virgin") is replaced with an accurate one that cites this frozen record.

## (1) Exploit re-run — the attack now FAILS (verified by trace against the fixed source)
Sequence create "myview" → promote "myview" → delete the demoted `default`-id row → `get_dashboard('default')`:
- `SELECT WHERE id='default'` → no row → `id === "default"` true → `isVirgin = (COUNT(*) === 0)`. After the sequence the table holds 1 row (`myview`), so `COUNT === 1` → `isVirgin === false` → skip the virtual branch → **`throw NotFoundError` (404).** No phantom. The exact old-`249d065` behavior is restored. Attack HELD-OFF.
- The new regression test (`test/dashboard-views.test.ts:273-311`) drives this exact sequence over the live HTTP surface and asserts `phantom.status === 404` + `list` returns only the survivor with no duplicate `isDefault:true`. Valid revert-proof: on the round-2 code the missing-`default` branch returned the phantom unconditionally (200), so the `=== 404` assertion goes RED there and GREEN here (builder-reported RED→GREEN, corroborated by trace of both code versions).

## (2) Fresh-edge probes on the new COUNT gate (all HELD)
- **All creation/mutation paths seed the real default FIRST** — verified in source, not taken on assertion: `createDashboardView` (`:148`), `updateDashboardView` (`:183`), `promoteDashboardViewDefault` (`:220`), `deleteDashboardView` (`:235`) each call `ensureDefaultViewSeeded(ctx)` at their top. So a non-virgin table ALWAYS contains the real `default` row unless it was deliberately demoted-then-deleted (which now correctly 404s). A tenant that created only a custom view therefore has BOTH `default` (seeded by the create write path) and its custom view → `get_dashboard('default')` returns the REAL default row, never the virtual. HELD.
- **`COUNT === 0` is UNREACHABLE once any write happens** — the strongest guarantee: `deleteDashboardView` refuses to delete the default (`is_default === 1`, `:237`) AND refuses to delete the last remaining view (`total <= 1`, `:241`). So the table can never be emptied below 1 row post-seed; the minimum steady state is exactly one row (the current default). Therefore `isVirgin === true` iff the tenant has genuinely never written — it can never be spoofed true on a live tenant. HELD.
- **Virgin tenant still renders** — `get_dashboard('default')` on a never-written tenant: `COUNT === 0` → returns the virtual default (correct, unchanged). A non-`default` id on a virgin tenant → `id !== "default"` → 404 (correct, matches `249d065`'s effective response). HELD.

## (3) COUNT query robustness (HELD)
- **No soft-deletes:** `dashboard_views` schema (`schema.ts:334-345`) has no `deleted_at`/`is_deleted` column; `deleteDashboardView` issues a hard `DELETE`. `COUNT(*)` counts exactly the live rows — nothing hidden can inflate it. HELD.
- **No TOCTOU:** `getDashboardView` is fully synchronous (the only `await` in the file is inside a comment on `promoteDashboardViewDefault`). The `SELECT WHERE id` and the `COUNT(*)` execute in the same DO input-gate turn with no yield between them, and the only virgin→non-virgin transition (a seed) runs on an equally-serialized mutating path. The DO single-threading the brief flagged does in fact serialize this. HELD.
- **Tenant scoping consistent:** the COUNT (like every other query in this per-tenant DO file) omits an explicit `tenant_id` filter because each DO's SQLite holds exactly one tenant's rows (ARCHITECTURE.md #3). No cross-tenant contamination. HELD.
- **Bonus:** the round-2 NEW observation (list-vs-get virginity-predicate divergence) is now RESOLVED — both `listDashboardViews` (`rows.length === 0`) and `getDashboardView` (`COUNT(*) === 0`) key on whole-table emptiness, so they can no longer disagree.

## (4) Nothing else drifted
Round-3 working-tree diff vs `249d065` touches only `dashboard-views.ts` (the `getDashboardView` gate + comment) and `test/dashboard-views.test.ts` (the +1 regression test). The rest of the bundle is byte-for-byte what the original verdict passed: `mailbox-state.ts`/`provisioning.ts` (Fix #1 snapshot), `tools.ts` (annotations), `handler.ts` (+3 lines = `annotations: t.annotations` passthrough into `tools/list`, benign). The round-3 COUNT is an extra READ on one branch — does not violate `readOnlyHint` (the write-spy stays green on the virgin path).

## Verification RE-RAN (round-3)
platform `npm test` **362/362** (59 files, +1 = the masquerade regression test); platform `typecheck` exit 0. (CLI + `claude plugin validate` unchanged from the original verdict — round-3 touched neither.)
