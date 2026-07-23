# Hermetic test-env fix — adversarial review (2026-07-23)

- **Reviewed ref:** branch `worktree-test-env-hermetic-20260723` @ `284b96b` (base `6b420ef`;
  main has since advanced to `aa42b616` — irrelevant to this branch diff).
- **Scope:** test-harness only — `apps/platform/vitest.config.ts`, new `test/hermetic-env.ts` +
  `test/hermetic-env.test.ts`, `.dev.vars.example` canary, `test/README.md`. No `src/` change.
- **Method:** the failure mode here is SILENT OVER-NEUTRALIZATION, not breakage. This worktree's own
  `.dev.vars` happens to carry a truthy `STRIPE_SECRET_KEY` (the exact key that broke the battery on main)
  AND the `HERMETIC_LEAK_CANARY` — so running the suite HERE is a real end-to-end acceptance test, not a
  synthetic one.

## VERDICT: SHIP

Full platform suite **645 passed / 92 files** and `tsc --noEmit` clean, RUN in this worktree **with the
ambient truthy `STRIPE_SECRET_KEY` and truthy canary present in `.dev.vars`** — i.e. under the precise
condition that failed the battery on main. The mechanism is confirmed in the pool/miniflare source, not just
asserted. Every attack lane held. No BLOCKING finding.

---

## Attacks that failed (why the PASS is meaningful)

**(mechanism) — does `null` actually override the wrangler-injected `.dev.vars` value?** Confirmed in source,
not trusted. The pool calls `mergeWorkerOptions(workerOptions, options.miniflare)`
(`@cloudflare/vitest-pool-workers/dist/pool/index.mjs:2617`) — wrangler-derived bindings (incl. `.dev.vars`)
are the base `a`, our hermetic bindings are the override `b`. `mergeWorkerOptions`
(`miniflare/dist/src/index.js:89694`) merges the two `bindings` plain objects via `Object.assign(aValue,
bValue)` (line 89724). `Object.assign` copies `null`-valued own properties, so `b.STRIPE_SECRET_KEY = null`
overwrites the base's real string. Empirically confirmed: the end-to-end `hermetic-env.test.ts` asserts
`env.HERMETIC_LEAK_CANARY` and every `// spend-arming` field read falsy, and it passed with those keys truthy
in `.dev.vars`.

**(1) over-neutralization masking a legit test need — NONE.** The sweep enumerates key NAMES from
`.dev.vars` + `.dev.vars.example` only; `wrangler.toml`'s `[vars]` keys (`PUBLIC_BASE_URL`,
`OPS_ALERT_EMAIL`) are NOT in either file, so they are never swept and retain their committed `[vars]` values
in tests (verified: this `.dev.vars` holds only 4 keys, none of them a `[vars]` key). No test legitimately
needs a spend-arming gate SET via ambient env: `grep` for a per-test `env.STRIPE_SECRET_KEY|ENGINE_*|INBOXKIT
=` mutation is empty, and the tests that reference those keys (`spend-armed-env-coverage`,
`mailbox-credential-push`, `engine-mailbox-client`, `real-email-port`, `activation-gate`) pass CONSTRUCTED
`{...} as Env` objects or parse `env.ts?raw` — none read the ambient gate. The 645-pass run with the gates
neutralized is the proof: any test needing an ambient gate ON would have failed.

**(2) `null` vs `undefined` vs absent on consumers — all null-safe in the realistic sweep set.** Neutralized
keys reachable in this env are `STRIPE_SECRET_KEY` and the canary; the plausible developer-added set is
`ENGINE_*`/`INBOXKIT_*`/`GMAIL_OAUTH_GRANTS`/`PUBLIC_BASE_URL`. Every consumer guards before any string op:
`STRIPE_SECRET_KEY` → `Boolean(...)`/`if (!key)` (`billing.ts`); `ENGINE_*`/`INBOXKIT_*` → `Boolean(a && b)`
gates (`isRealSpendArmed`, `isCredentialPushConfigured`, factory); `GMAIL_OAUTH_GRANTS` → `if (!raw) return
{}` before `JSON.parse` (`mailbox-credential-push.ts` — `null` is falsy, caught before parse); `PUBLIC_BASE_URL`
→ `?? default` (`tick.ts` — `null` is nullish, triggers the fallback exactly as an unset var would). No
consumer of a neutralizable var does an unguarded `.toLowerCase()`/`typeof === "string"`/`in`-check/JSON
serialize. `STRIPE_WEBHOOK_SECRET` is allowlisted (fixed value), so its fail-closed webhook route still sees a
set secret.

**(3) `TOKEN_HASH_PEPPER` as a fixed allowlist value — sound.** No test hardcodes a pepper-derived hash or an
`api_token_hash` fixture (`grep` empty). Sign and verify both read `env.TOKEN_HASH_PEPPER` within a run, so a
fixed non-empty value is self-consistent; the allowlist value being non-empty is what a `""`-pepper would
weaken, hence its allowlisting rather than neutralization. 645-pass confirms behaviorally.

**(4) the guard is non-vacuous and reads the LIVE env.** The end-to-end leg imports `env` from
`cloudflare:test` — the actual test-runtime env, not the module's own output. It is non-vacuous HERE because
`.dev.vars` contains a truthy `HERMETIC_LEAK_CANARY` (and truthy `STRIPE_SECRET_KEY`): absent neutralization
wrangler WOULD inject them, and the assertion demands they read falsy — they did. The UNIT leg pins a novel
`REGISTRAR_API_KEY` → `null`, so swapping the allowlist-sweep for a per-var blocklist (which would let a
new key through) fails that assertion. The `spendArming` set is pinned non-vacuously against silent parser
drift.

**(5) cross-lane G5 (`REGISTRAR_*`).** The NEUTRALIZATION mechanism covers a future `REGISTRAR_*` binding with
ZERO edits to `hermetic-env.ts` — `buildHermeticBindings` neutralizes any non-allowlisted ambient key, and the
unit test already exercises `REGISTRAR_API_KEY → null`. See the NON-BLOCKING note below on the one guard-pin
G5 must update (by design, fail-closed).

**typecheck.** `tsc --noEmit -p tsconfig.json` clean (the vitest.config + new `.ts` test files included) — ran
it explicitly because esbuild-based vitest can be green while tsc is red on new `.ts`.

## Findings

### 1. NON-BLOCKING (cross-lane coordination, by-design fail-closed) — G5 must update TWO hardcoded spend-arming pins, not zero

`hermetic-env.test.ts:107` hardcodes `expect(spendArming).toEqual(["STRIPE_SECRET_KEY", "ENGINE_BASE_URL",
"ENGINE_AUTH_SECRET", "INBOXKIT_API_KEY", "INBOXKIT_WORKSPACE_ID"])`, duplicating the identical pin in the
pre-existing `spend-armed-env-coverage.test.ts:70`. When G5 adds a `// spend-arming`-tagged `REGISTRAR_*`
field to `env.ts`, BOTH pins trip RED. This is the leak-coverage guard working as intended (it forces the G5
author to acknowledge the new spend-arming binding), NOT a silent bypass — so it is not a defect in THIS lane.
But it qualifies the brief's "ZERO edits" framing: the neutralization needs zero edits; the spend-arming LEAK
pin needs a one-line update in G5, in two files. Failure scenario if unaddressed: after merging both lanes,
the battery goes RED on these two `toEqual`s until G5 updates them. Recommend the team ensure G5's own pass
updates both pinned lists (and consider deduping the two identical pins — CLAUDE.md rule c).

## UNVERIFIABLE

- I did NOT run a literally-reverted config (per-var blocklist / sweep removed) to watch the guard go RED,
  because that requires mutating this shared worktree (read-only-git + no-mutation rule). Instead I established
  the guard's revert-detection structurally (unit pins a novel key → null; e2e canary reads live env) AND its
  non-vacuousness empirically (canary + `STRIPE_SECRET_KEY` truthy in `.dev.vars`, both read falsy in the
  645-pass run). A `git revert`-and-rerun in a private sandbox copy would close this fully; the mechanism is
  otherwise confirmed in the pool/miniflare source.

## NEW (out of scope, no verdict weight)

- `hermetic-env.test.ts:107` duplicates the spend-arming field pin already in
  `spend-armed-env-coverage.test.ts:70`. Two sources of truth for the same 5-field set; both must move together
  on any spend-arming change. Minor (CLAUDE.md rule c).
- If a developer redundantly shadows a `[vars]` key (e.g. `OPS_ALERT_EMAIL`/`PUBLIC_BASE_URL`) INTO their
  `.dev.vars`, the sweep would neutralize it to `null`. `PUBLIC_BASE_URL` is `?? default`-safe; `OPS_ALERT_EMAIL`
  is a required `string` whose consumers (`watchtower`/`support-inbound`) would then see `null`. Not reachable
  via the documented `.dev.vars.example` (which omits both), so it is a non-standard-config edge, not a defect.
