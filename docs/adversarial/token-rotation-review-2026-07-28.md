# Adversarial review — token prefix migration + `POST /token/rotate`

- **Reviewer:** adversary (fresh context)
- **Date:** 2026-07-28
- **Worktree:** `.claude/worktrees/agent-a2cb852d0853de94a` (branch `worktree-agent-a2cb852d0853de94a`)
- **Ground ref:** `git rev-parse HEAD` = `f52ee61cb5c790ce4e9c9c5ea100adcb45e993e7`; changes uncommitted on-disk.
- **Scope:** `cs_test_ → cr_live_` prefix migration (`auth.ts`); new `POST /token/rotate` (`routes/token-rotate.ts`, `db.ts`, `index.ts`); Settings "Rotate API token" card (`SettingsPage.tsx`, `queries.ts`, `types.ts`); MCP parity note (`mcp/tools.ts`); tests.

## VERDICT: SHIP (round 2, 2026-07-28)

Round 1 was **NO-SHIP** on verification integrity (below). The builder applied the F2 prescription (test-only) and I re-verified: **full platform suite 1101/1101 green, isolated `token-rotate.test.ts` stable 4/4, typecheck exit 0** (all RUN by me this round). The rewritten concurrency invariant is adversarially sound (proof below). Both blockers closed. The token/auth **code** never had a defect — it survived every attack in round 1 and is unchanged. SHIP.

### Round-2 re-verification
- **Evidence (RAN):** isolated `npx vitest run test/token-rotate.test.ts` ×4 → 6 passed each, stable. Full `npm test` → 121 files, **1101 passed (1101)**, exit 0. `npm run typecheck` → exit 0.
- **New invariant attacked (`token-rotate.test.ts:49-86`):** per-response `expect([200,401]).toContain(status)`; tokens read only from 200s; live-recheck asserts exactly one of the two concurrent calls holds a currently-valid token; pre-race token dead.
  - **Zero-alive impossible:** the final committed hash was written by whichever request's `UPDATE` landed last; that request passed auth (saw `H0`) so returned 200 with a token whose hash equals the stored hash → its `/account` recheck is 200 → alive. At least one always alive.
  - **Both-alive impossible:** the column holds exactly one hash; two distinct 256-bit random tokens can't both match it (`:66-68` asserts they differ when both minted). At most one alive.
  - **Both-401 impossible:** initially the stored hash *is* `H0`, so the first request to auth always succeeds → at least one 200. "Exactly one alive" is therefore *guaranteed*, not merely tolerated — strictly tighter than the old `okCount===1/deadCount===1`.
  - **No token-off-401 crash:** `:65` filters to 200 before reading `.token`; a 401 body (`{error,code}`) is never dereferenced.
  This subsumes the round-1 two-token-model assertion and correctly handles the ordering where the 401'd request minted nothing.
- **Comment-quote adjudication (my round-1 error, corrected):** my round-1 NEW-observation attributed `"...both succeed at the HTTP layer"` to the *test*; grep shows it lives in the **route docstring** `src/routes/token-rotate.ts:25`, not the test. Builder's substitution (delete the closest actually-wrong test comment, add a correct race explanation at `:56-61/:70-73`) is right. The route-docstring line remains but is NON-BLOCKING: it describes the benign both-200 ordering and correctly notes only the last-commit hash survives — incomplete (omits the one-401 ordering), not false, and non-functional.

---

## VERDICT (round 1, 2026-07-28): NO-SHIP — superseded by round 2 above

The token/auth **code** is sound — every auth/CSRF/atomicity/secret-hygiene/prefix attack I ran FAILED to break it. NO-SHIP is on **verification integrity**, not an auth defect: the builder's "platform suite 1101/1101 green, RED/GREEN proven" claim was **false in this worktree**, and the failing test was the lane's own concurrency test, flaky-by-construction (wrong expectation). [RESOLVED round 2.]

---

## Findings (most severe first)

### F1 — BLOCKING · lens 7 (regression ring) + lens 2 (run it) · False green claim: suite is RED
- **Failure:** Builder reported platform suite **1101/1101 green**. Fresh `npm test` in this worktree: **1 failed | 1100 passed (1101)**. The failure is the lane's own `test/token-rotate.test.ts`.
- **Verification:** RAN `npm test` (full suite, 236.9s) → 1 failed. Then RAN `npx vitest run test/token-rotate.test.ts` **3×** → deterministic fail 3/3. `npm run typecheck` → exit 0 (clean).
- **File:** `apps/platform/test/token-rotate.test.ts:57`
- Violates CLAUDE.md "Verification Before Completion" (evidence must back the claim) and the one-PR-per-wave "battery passes ONCE" gate.

### F2 — BLOCKING · lens 5 (fixture realism) + lens 2 · Concurrent-rotation test asserts a false premise
- **Failure scenario:** The test fires two concurrent `POST /token/rotate`, BOTH carrying the **same** original bearer token `token` (hash `H0`), then asserts `expect(a.status).toBe(200)` AND `expect(b.status).toBe(200)`. But rotation invalidates the very credential both requests authenticate with. If rotate A's `UPDATE tenants_index SET api_token_hash` (H0→H(tokenA)) commits **before** rotate B's `requireAuth` does its `lookupTenantByTokenHash(H0)`, then B's auth lookup finds no row → B returns **401**, never reaching the handler. The endpoint's own atomicity guarantee ("old token 401s on its very next use") directly contradicts the test's "both succeed at the HTTP layer" premise. The two race orderings give different outcomes:
  - both auth-resolve before either UPDATE → both 200 (test passes);
  - one UPDATE lands before the sibling's auth lookup → that sibling 401s (test fails).
  In this environment the second ordering is deterministic (`expected 401 to be 200`, 3/3).
- **Verification:** RAN it (see F1). Traced the ordering through `require-auth.ts:60-68` (auth lookup of `H0`) vs `routes/token-rotate.ts:40` → `db.ts:61` (blind `UPDATE`, no CAS on old hash).
- **File:** `apps/platform/test/token-rotate.test.ts:49-73` (fails at `:57`).
- **Scope note (I flag, not fix):** the ENDPOINT is correct and fail-closed — exactly one hash in the column at all times, no neither-works window, a raced-out token 401s safely. The defect is confined to the test's expectation. A correct test asserts only the surviving-token invariant (`okCount===1 && deadCount===1`, which is the test's own second half at `:67-68`) and tolerates each individual rotate being 200-or-401; or serializes the two rotates. The endpoint needs no change for F1/F2.

---

## Attacks that FAILED (the code held)

- **Lens 1/2 — rotation atomicity / neither-works window.** Traced `token-rotate.ts:38-41` → `db.ts:61`. A single `UPDATE ... SET api_token_hash = ? WHERE id = ?` is one atomic statement; the column always holds exactly one hash. A failed UPDATE (D1 error) throws before returning → old hash intact, old token still valid (no "neither works"). Held.
- **Lens 2 — AuthZ / cross-tenant.** `token-rotate.ts:37` reads `tenantId` from `c.get("tenantId")`, set by `requireAuth` from the *presented* credential (`require-auth.ts:104/119`). The route has **no** tenant selector in body or path — cross-tenant rotation is structurally impossible; there is no parameter to abuse. Held (no cross-tenant test exists because there is no cross-tenant surface).
- **Lens 8 — CSRF.** `/token/rotate` is in `AUTHED_PATH_PATTERNS` (`index.ts:112`) and the loop `authed.use(pattern, requireAuth, csrfGuard)` (`:127`) applies the **same** global CSRF guard as every other mutation. `csrf-guard.ts:27` requires `X-Coldstart-Client: dashboard` for cookie-authed non-safe methods; bearer exempt (no ambient cookie). Dashboard path: `apiRequest` attaches `X-Coldstart-Client` for every non-GET (`client.ts` `if (method !== "GET") Object.assign(headers, MUTATING_HEADER)`). Test `token-rotate.test.ts:77-88` proves 403-without-header AND token unchanged. Held.
- **Lens 8 — secret hygiene.** New token returned once in the JSON body (`token-rotate.ts:41`); server persists only the hash (`db.ts:61`). Dashboard holds it in a react-query `useMutation` `data` (in-memory only — dies on refresh/unmount), renders it in a `<code>` with a full-value CopyButton, no `console.log`, no localStorage. Held.
- **Lens 5 — prefix migration shape.** `cr_live_` (8 chars) is the **same length** as `cs_test_` (8 chars); body is 64 hex either way → total length identical. Grepped every reader/writer of `api_token_hash`: written only at signup (INSERT, `db.ts:24`) + rotate (UPDATE, `db.ts:61`), read only via `lookupTenantByTokenHash` in `resolveTenantFromToken`. No DO-side cache, no signing reuse. Nothing branches on the prefix (`generateApiToken` concatenates it; only unrelated `stripe-client.ts` checks `sk_test_`). `TokenGate.tsx` changed only its placeholder to `cr_live_…` — no client-side prefix validation, so pasted legacy `cs_test_` tokens still authenticate. Grandfathering RAN green on HTTP API, MCP JSON-RPC, and dashboard-session exchange (`token-prefix-legacy.test.ts`, all 3 pass). Held.
- **Lens 4 — deploy plumbing.** `/token/rotate` both added to `AUTHED_PATH_PATTERNS` and mounted; rebuilt SPA asset `SettingsPage-qZQ0jxQZ.js` contains "Rotate API token" / "New token — shown once" and `index.html` references the new `index-Ys7LCmn2.js`. The feature is actually wired into the shipped bundle, not just source. Held.
- **Lens 6 — MCP omission by design.** No `rotate_token` MCP tool (documented `mcp/tools.ts:166`), but rotation is still reachable by an agent via a raw bearer `POST /token/rotate`. Not a gap; footgun-avoidance. Held.

## UNVERIFIABLE
- **Real-D1 concurrency semantics.** The race in F2 is exercised against miniflare's D1; production D1's exact commit/visibility ordering under two genuinely-parallel Worker isolates may differ. This does not change the verdict (the test is wrong regardless of ordering, and the endpoint is safe under every ordering), but a live smoke of two concurrent rotates would confirm prod behavior matches the "exactly one survivor" invariant.
- **Lost-response recovery (non-blocking, reasoned not run).** If a rotate's `UPDATE` commits but the HTTP response carrying the new token is lost, the presented-once token is unrecoverable — but the tenant still holds its dashboard session (rotation does not kill it; proven `token-rotate.test.ts:153`) and can re-rotate, or magic-link a fresh session. Recoverable; not a brick.

## NEW (out-of-scope) observations — no verdict weight
- The concurrent-rotation test's inline comment ("Two concurrent rotations for the same tenant both succeed at the HTTP layer") is itself the false premise that produced F2 — worth deleting alongside the fix so the wrong mental model doesn't propagate.
