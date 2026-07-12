---
name: coldstart-platform-battery
description: coldstart repo (apps/platform) verification battery — declared scripts, runtime, test count baseline
metadata:
  type: project
---

Monorepo root `~/dev/coldstart`: `npm run typecheck` / `npm test` / `npm run build` at root fan out via `--workspaces --if-present` to all 3 workspaces (apps/platform, agent-cold-email, packages/shared) — always use the root script, never bare `tsc --noEmit` inside apps/platform.

apps/platform full test lane: `npm test` (root) → `vitest run` under `@cloudflare/vitest-pool-workers`. Baseline as of 2026-07-12: 33 test files / 140 tests, ~20s test time but ~150-160s Miniflare/DO setup overhead (full `npm test` wall time ~20-35s reported by vitest but expect 2-3min real wall time incl. workspace fan-out). Expected non-failure noise: several "uncaught exception" lines print in the log from negative-path tests (RateLimitError, NotFoundError, TenantIsolationError, ValidationError) intentionally thrown inside the Workers RPC harness — these are NOT failures; only trust the final "Test Files X passed / Tests Y passed" summary line.

Deploy dry-run: from `apps/platform`, `npx wrangler deploy --dry-run --outdir <dir>` — verify by EFFECT: check the outdir actually contains `index.js`/`index.js.map`, not just exit 0 + the "--dry-run: exiting now." text.

vitest.config.ts (apps/platform) has no `include`/`exclude` override, so it uses vitest's default recursive `**/*.test.ts` glob — any new `test/*.test.ts` file is automatically wired in without config changes; confirm by counting files vs the reported "Test Files N passed" count.

No false-green trap hit this session — hard-builder's uncommitted engine-fix increment (bounce severity A1-A3, retry cap A4, dunning decline-codes A5, events/idempotency dedupe B1-B4, stable vendor key B3, Stripe usage idempotency B5, unsubscribe headers C1-C2) checked out complete against a 20-item scope checklist on file:line grounding, full battery green, and both G3 revert-fail-restore proofs (soft-bounce branch, events OR IGNORE dedupe) failed correctly on the reverted code and passed clean after byte-exact restore.
