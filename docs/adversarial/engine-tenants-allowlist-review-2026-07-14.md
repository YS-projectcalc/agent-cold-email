# Adversarial review — ENGINE_TENANTS per-tenant allowlist (Mordy-pilot activation lane)

Frozen record. Fresh-context adversarial gate. Read-only git in a shared live worktree.

- **Ground:** HEAD `aba755d3e7d1b79858a83e28def5b64ab4599da5`, branch `main`.
- **Diff (uncommitted):** `M apps/platform/src/{env.ts, tenant-do.ts, vendors/README.md, vendors/factory.ts}` + `?? apps/platform/test/engine-tenants-allowlist.test.ts`. `git status --short` matched the brief exactly — no stray files.
- **Suite evidence (all independently re-run):** `npm run typecheck` exit 0; full `npx vitest run` = 50 files / **284 passed**, exit 0 (128s, serial per `fileParallelism:false`); isolated `test/engine-tenants-allowlist.test.ts` = **21 passed**, exit 0. The `ValidationError: plan '…' allows at most N …` lines in suite output are pre-existing provisioning-cap assertions, unrelated to this diff.

## VERDICT: SHIP

No BLOCKING finding survived self-refutation. The lane is fully dark end-to-end (`realAdaptersActivated` hard-`false` at tenant-do.ts:232), and with that gate off the allowlist input has **zero** effect on any bundle — today's prod behavior is byte-identical to HEAD. The diff strictly *narrows* the path to `RealEmailPort`; it opens no new real-send/real-spend path.

## Attacks attempted and why each held

**Lens 1 — spec-vs-code.** ROADMAP.md:32 open item (1) is the exact requirement: "per-port activation factory change for the comped-pilot shape (`realAdaptersActivated` is global all-or-nothing — ENGINE_TENANTS lane)." Code implements precisely that: EmailPort-only real activation, domain/mailbox/billing/metrics pinned sandbox. Match confirmed by reading the ROADMAP, not the PR body.

**Guard 2 — parser total & fail-closed (`parseEngineTenants`, factory.ts:44-53).** Attacked: bare `*`, `**`, `*` mixed with valid entries, `?`, regex-ish tokens (`ten_.*`, `.`, `[a-z]`), prefix (`ten` vs `ten_abc`), suffix, an entry that is a substring of another, leading/trailing/double commas, whitespace-only tokens, embedded tabs/newlines, unicode confusables, case variance, `"0"` (truthy-string edge), absurdly long input. All held: membership is exact `Set.has` (no regex interpretation → no over-match), `*`/`?` tokens are dropped, blanks dropped individually (never blanks the whole var). No throw path (`split`/`trim`/`includes`/`add` are total) → cannot take the Worker down. `if (!raw)` catches both `undefined` and `""` → empty set. Empty-string `tenantId` can never match (blank tokens are never added, and buildAdapters guards `!this.tenantId` first at tenant-do.ts:216). Tests assert every one of these (10 parser cases) and are non-vacuous.

**Guard 3 — plan-check dominant.** `isDemoOrFree` appears in BOTH `useSandbox` (`isDemoOrFree || …`) and `useRealEmail` (`!isDemoOrFree && …`), so a demo/free tenant is forced sandbox even when allowlisted + activated + configured. The structural guard was **strengthened**, not weakened: email is now also gated by the `!isDemoOrFree` conjunct. `demo-adapter-guard.test.ts:15-21` (kind sandbox for demo/free+activated) still green; new guard-3 tests add the allowlisted-demo/free case.

**Guard 4 — global gate dominant + no regression.** With `realAdaptersActivated=false`: `useSandbox = D || true || L = true` always; `useRealEmail = !D && false && L = false` always → every tenant, allowlisted or not, gets `SandboxEmailPort`. So the allowlist changes NOTHING while the global flag is off (verified by the guard-4 "global off + allowlisted paid → sandbox" test). Non-allowlisted + global-on: no pre-existing test asserted the *email port* was Real for paid+activated — `demo-adapter-guard.test.ts:30` only asserts `bundle.kind === "real"` (still true; domain/mailbox/billing/metrics are Real stubs), and `real-email-port.test.ts` constructs `RealEmailPort` directly, never via the factory. Regression ring clean.

**Lens 5 — tenantId provenance (spoofing).** Only caller of `createVendorAdapters` is `buildAdapters` (tenant-do.ts:229), which passes `this.tenantId`. `this.tenantId` is set only from (a) the persisted `tenant_profile.id` row in the constructor (tenant-do.ts:89) or (b) `initTenant`'s `input.tenantId` (tenant-do.ts:190) — and the sole `initTenant` caller (`routes/signup.ts:54`) supplies a **server-minted** `newId("ten")` (signup.ts:41). `SignupInput` (intents.ts:8-11) is `{brand, contactEmail}` — no client tenantId field. Every authenticated route resolves tenantId from the credential via DB lookup (`require-auth.ts` `lookupTenantByTokenHash`/`lookupTenantById`), never a request param, and addresses the DO by `idFromName(tenant.id)`. A caller cannot set/override a DO's identity or reach `buildAdapters` with a spoofed id. Not spoofable.

**Lens 6 — hybrid coherence (real email + sandbox everything-else).** Grepped every `.kind` consumer in `src/`: all are unrelated fields (`lead.kind`, `query.kind`, `event.kind`) — **nothing reads `bundle.kind`**, so the intentional "kind:'sandbox' while `email` is real" mismatch has no downstream consumer to confuse. Sandbox billing/metrics for the pilot is the ratified "comped" design (ROADMAP:36). The real-send-needs-a-real-mailbox coherence is handled by a separate ratified lane (BYO-domain+BYO-mailbox intake, creds land on the engine directly), and is unreachable until arming anyway.

**Lens 7 — §0 safety net-net (ship-killer).** No env/plan/allowlist/request combination opens real spend/send beyond HEAD. The allowlist adds a required conjunct (`isEngineAllowlisted`) on top of the existing global gate — it can only narrow. `RealEmailPort` is doubly dark: it is only constructed when all four conjuncts hold (incl. `realAdaptersActivated`, hard-false), and even then its own dark-check requires both `ENGINE_BASE_URL`+`ENGINE_AUTH_SECRET` (guard-4 test line 120-123: allowlisted+activated but `engineConfig` absent → `RealEmailPort` constructed yet throws `NotActivatedError` on first use).

**Coverage-theater check.** The three email-gate tests (guard-1 undefined-allowlist → Sandbox; guard-4 not-on-list → Sandbox; guard-4 positive control all-four-true → Real) share every input except the one conjunct under test and assert distinct port classes, so each conjunct of `useRealEmail` is individually pinned — inverting any single conjunct fails exactly one test. Plus positive controls (a genuine `RealEmailPort`; a working sandbox send returning `@sandbox.local`). Non-vacuous.

## NON-BLOCKING observations (do not block the commit)

1. **Semantic shift, intended:** post-arm, a paid+activated tenant NOT on `ENGINE_TENANTS` now gets `SandboxEmailPort` (HEAD gave `RealEmailPort`). This is the whole point of the tracked ROADMAP item (email activation is now allowlist-gated, replacing global all-or-nothing). Unreachable in the deployed build; breaks no test. Observation, not a defect.
2. **Revocation latency (arm-phase only):** adapters are cached per DO (`this.adapters ??=`), so removing a tenant from `ENGINE_TENANTS` takes effect only on DO restart (which a `wrangler secret put` + deploy triggers). Same caching that already governs the sandbox ports; moot until arm. Worth a line in ACTIVATION Gate-2 alongside the other carried residuals.

## UNVERIFIABLE
- Physical revert-fail of the gate (mutating factory.ts) was not run — the shared live worktree is read-only and copying the full `vendors/` tree to sandbox for a `toBeInstanceOf` check was disproportionate. Non-vacuity was instead proven by input-differential analysis (each conjunct has a test that flips only that input and observes a distinct port class). Resolution if desired: copy `apps/platform/src/vendors/**` + shared types to a scratch dir, invert `useRealEmail`, confirm exactly the three gate tests go red.

VERDICT: SHIP
