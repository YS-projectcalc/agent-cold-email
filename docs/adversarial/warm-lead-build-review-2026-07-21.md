# Adversarial re-attack — warm-lead build (increments #1–#3, SPEC.md §22)

- **Target:** lane `worktree-agent-ab4beea4ab3f6cced`, HEAD `a8c728d` (3 commits: `9b98909` schema+tools, `7ce59dc` webhook-choke extraction, `a8c728d` agent-memory doc). Diffed against merge-base `5d900da`.
- **Ground truth:** main `e3f5962` (`git rev-parse HEAD`). Main has drifted past the merge-base **docs-only** (ACTIVATION/HANDOFF/ROADMAP/SPEC — the SPEC change is the §22 "RULED 2026-07-21" note, already factored in). The lane touches none of that drift — clean isolation.
- **Reviewed against:** SPEC.md §22 + its RULED note + design amendments R1–R4 (`warm-lead-thin-layer-design-2026-07-16.md`), the Q1–Q6 rulings (`warm-lead-q1-q6-recommendations-2026-07-21.md`), and the self-serve F3 cross-lane finding.
- **Posture:** refute-by-default; READ-ONLY git in the shared worktree; every candidate self-refuted before listing.

## VERDICT: **SHIP**

No blocking finding survived self-refutation. Tenant isolation is structural (DO-per-tenant) *and* belt-and-suspenders `tenant_id`-scoped in every new query, with a real cross-tenant test. The choke-point extraction is logic-identical. The `followups` table is genuinely inert (no writer anywhere — increment #4 confirmed out of scope; the F3/R1/R2 send-bypass hazard is unreachable in this lane). Enum enforced server-side on **both** transports. No public claim copy changed. Two non-blocking notes + one wave-level deploy gate below.

## Battery (my own numbers, run in the worktree)

- **Typecheck** (`npm run typecheck --workspaces`): **clean, all 5 workspaces** (dashboard, engine, platform, agent-cold-email, shared), zero errors.
- **Platform suite** (`npx vitest run`, apps/platform): **83 files / 597 tests, all passed** (194s). The `uncaught exception` lines in output are expected negative-path assertions (NotFoundError / plan-cap ValidationError), not failures.

## Findings

None blocking. Attack angles resolved as follows (one line each):

- **Tenant isolation (lens 8) — HELD.** Every new query (`list-leads.ts`, `lead-dispositions.ts`, `suppression.ts`, `routes/leads.ts`) is `tenant_id`-scoped; the DO is physically single-tenant so a dropped scope still can't cross a boundary. The cursor `(createdAt,rowid)` is regex+`Number()` parsed (injection-safe, parametrized) and only paginates the caller's own rows. `test/lead-dispositions.test.ts:200-232` proves B's suppress leaves A's row `undefined` and A's lead `active`, and B's list is empty.
- **JOIN fan-out (brief #4) — no fan-out.** Both `suppressions` and `lead_dispositions` are `PRIMARY KEY (tenant_id, email)` → 1:1 LEFT JOIN; `last_event` CTE is one row per `lead_id`; `campaigns` is one per `campaign_id`. Disposition rows are not duplicated.
- **Suppression semantics (brief #2, design R3) — inert, verified cannot clear a complaint.** `suppress_lead(reason='manual')` on an existing `complaint`/`unsubscribe` row relabels `reason→'manual'` (`suppression.ts:14-23` unconditional `ON CONFLICT DO UPDATE SET reason`, called before the `alreadySuppressed` early-return at `:84-85`). It **never un-suppresses** (row persists, `global_status` stays `suppressed`), **no consumer reads `suppressions.reason`** (grep-confirmed — the two `reason` hits are unrelated admin/lifecycle columns), and **no un-suppress path exists** (no `DELETE FROM suppressions`, no un-suppress tool/route). This is exactly the design-ruled-acceptable R3 residual; list_leads does not surface `reason`, so it stays inert.
- **Choke-point extraction (brief #3, `7ce59dc`) — logic-identical.** `recordEventIfNew` moved reply-processor→`engine/events.ts` with the ONLY change being `messageId: string → string | null` (a widening) and `export`. Dedup key `(tenant_id,type,message_id)` + `INSERT OR IGNORE`, the `rowsWritten===0` early-return, the best-effort `try/catch` enqueue, and `RealClock` timing are byte-preserved. reply-processor's callers are unchanged (same function, now imported). Fires once per new event; idempotent on repeat via `alreadySuppressed` (`test/unsubscribe-webhook-enqueue.test.ts:153-179` asserts one delivery across three clicks). Tick's suppression honoring (`tick.ts` LEFT JOIN, not in the diff) is untouched.
- **Enum enforcement (brief #5) — server-side, both transports.** MCP validates `matched.schema.safeParse` (`mcp/handler.ts:122`, bad value → `rpcError`, no stub call); REST via `parseJsonBody`/`safeParse`. Bad `interestStatus=do_not_contact` → 400 on update, list filter, and MCP; bad `reason` → 400. Tested.
- **Builder deviations (brief #4) — all acceptable.** (2) `note` accepted-but-dropped is **disclosed** in the tool description (`tools.ts:295`: "note (accepted, not persisted)") and the input-schema comment — not a silent lie to the agent. (3) `reason` pinned to `"manual"` is correct — the only value an external caller may honestly claim; system reasons stay system-derived; bad reason → 400. (4) `list_leads` returns per-campaign-lead rows with the contact-level disposition joined in consistently (a contact in N campaigns shows N rows, identical disposition/suppressed on each) — Q1 (contact-level disposition, tenant-wide suppress) survives; the shape is required for the `campaign` filter and disclosed in the tool description.
- **Claim surface (brief #6) — no public copy changed.** Only `packages/shared/README.md` (internal package README) plus the internal engine/mcp/routes READMEs and the `tools.ts` header changed. No `site/`, `AGENTS.md`, `llms.txt`, `server.json`, `server-card.json`, `og-image`, or root `README.md` touched.
- **Followups table (brief #7) — inert.** `grep` for any `INSERT INTO followups` / writer returns empty; no tool, no route, no tick path, no test insert. Schema-only, as R1/R2 require.
- **Tests (brief #8) — behavior, not existence.** Tenant-leak, dedup/idempotency, enum boundary (400), keyset pagination (no dupes/gaps), partial-patch carry-over, and a write-detecting spy proving `list_leads` issues zero writes. Each test does its own fresh `signup()` — no shared mutable-state coupling that could mask a regression.

## Attacks that FAILED (why the PASS is meaningful)

- **Cross-tenant read via `campaign` filter / cursor:** supplied another tenant's `campaign_id`/cursor — outer `WHERE l.tenant_id = ?` + single-tenant DO means you only ever page your own rows. Held.
- **Enum bypass through MCP:** MCP dispatch `safeParse`s before the stub call, same as REST — no unvalidated value reaches SQL. Held.
- **Choke-point behavior drift:** diffed the extraction character-by-character against the deleted original — no dedup-key, fan-out, or error-path change; typecheck + 597 tests confirm no caller broke. Held.
- **`manual` clearing a complaint:** traced the write path — it relabels but never removes the suppression, no reader consumes `reason`, no un-suppress exists. Held.
- **A latent `followups` send path re-arming F3/R1:** no writer, no send primitive — the table can't emit anything. Held.
- **`update_lead` provenance spoof:** `source` is a server-derived positional arg (`"mcp"` / cookie→`dashboard` else `api`); zod strips any client-supplied `source` key. Held.
- **CSRF on new mutating routes:** `/leads` + `/leads/*` are in `AUTHED_PATH_PATTERNS`, so `authed.use(pattern, requireAuth, csrfGuard)` (`index.ts:113`) covers the two cookie-authable POSTs. Held.

## NEW (out-of-scope) observations — no verdict weight

1. **[WAVE DEPLOY GATE — not a lane defect] Live tool count becomes 24; public copy still says 21.** `site/guide-mcp-tool-count.html`, `server.json`, `site/for-agents.html`, `README.md`, `llms-install.md` all assert "21 tools." The lane deliberately left public copy untouched (per brief + `tools.ts` header: "folded by the orchestrator, not updated here"). But once this deploys, that copy is factually wrong — an entire public *tool-count guide* included. The orchestrator must reconcile 21→24 (and re-run the claim-surface pass, `docs/adversarial/claim-surface-round2-2026-07-20.md`) **before/with the deploy**, not after. Flagging prominently because claim-honesty is a tracked project value.
2. **Multi-campaign opt-out fans out N webhook deliveries.** A contact in N campaigns has N `leads` rows; `unsubscribeEmail` walks each and `recordEventIfNew` enqueues per lead → N `unsubscribe` deliveries on one opt-out. Consistent with the existing per-lead event model (the old direct INSERT already wrote N events; only the webhook fan-out is new) and defensible (each campaign's integration learns of the opt-out). Not a defect; worth a deliberate ruling if a buyer expects one-per-contact.
3. **Citation drift (minor):** `suppression.ts:143` and `test/lead-dispositions.test.ts:169` cite the last-write-wins reason residual as "adversary **R2**," but the design doc numbers it **R3** (R2 is the `scheduled_sends`-drain duplication). Comment/test-name only; zero functional impact.
4. **Lenient boolean filter (minor):** `parseBoolQueryParam` (`validate.ts:25`) maps unrecognized values (`suppressed=yes`) to `undefined` → filter silently ignored (not a 400), diverging from the enum filter's strict 400. Result stays tenant-scoped and correct on recognized params — a caller who fat-fingers a bool gets a wider set, never wrong-tenant data. Shared helper, consistent with existing routes.

## UNVERIFIABLE

- **Live MCP/HTTP drive of the deployed surface** — reviewed against the in-worker test harness (597 tests) and source; no running prod service to curl. The harness exercises both transports end-to-end, so this is low residual risk. Resolution: a post-deploy smoke of `tools/list` count (=24) + one `suppress_lead`/`list_leads` round-trip.
