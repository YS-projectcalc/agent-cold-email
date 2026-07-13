import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      // ADMIN_TOKEN (D1/D2/D6 admin surface, src/admin/README.md) is a
      // SECRET — deliberately absent from wrangler.toml's committed `[vars]`
      // (CLAUDE.md rule g). This test-only binding is the equivalent of a
      // local `.dev.vars` value, scoped to the test runner, never checked in
      // as a real value. Every admin-route test presents this exact string
      // via `test/helpers.ts`'s `adminApi()`.
      // STRIPE_WEBHOOK_SECRET is likewise a test-only secret (never a real
      // value — CLAUDE.md rule g). The webhook route fails CLOSED when it is
      // unset (adversarial panel-03 finding #1: an unsigned event on an
      // unset-secret deployment forged any tenant's billing_state), so the
      // suite configures a test secret and signs its fixtures via
      // test/helpers.ts's `postWebhook()` — matching how a real deployment
      // MUST have the secret set before any webhook is trusted.
      miniflare: {
        bindings: {
          ADMIN_TOKEN: "test-admin-token-for-vitest",
          STRIPE_WEBHOOK_SECRET: "whsec_test_secret_for_vitest",
        },
      },
    }),
  ],
  test: {
    setupFiles: ["./test/setup.ts"],
    // CLASS FIX (full-suite flake, 2026-07): @cloudflare/vitest-pool-workers
    // runs every test file's runner against ONE shared per-project Miniflare
    // instance (dist/pool/index.d.mts: getProjectMiniflare/connectToMiniflare-
    // Socket) — a test FILE is a named worker connecting to that instance over
    // its own socket, not an independent workerd process. Vitest's default
    // `fileParallelism: true` opens ~40 of these connections at once; under
    // that load the pool intermittently failed to start a file's runner
    // at all ("[vitest-pool]: Failed to start cloudflare-pool worker for
    // test files X.test.ts — Caused by: Error: read ECONNRESET"), which
    // aborted whichever file(s) happened to be mid-connect — reproduced as
    // inbox-v2.test.ts/thread-labels.test.ts (the heaviest, most sequential-
    // await-chain files, so the first to blow a 5s test timeout under the
    // resulting CPU contention) failing ONLY in the full run, never alone.
    // Serializing file execution removes the connection race entirely — 3
    // consecutive full-suite runs are green at effectively the SAME wall time
    // (~105s) as a "parallel" run, since the shared single Miniflare instance
    // was already the real bottleneck and bought no genuine speedup.
    fileParallelism: false,
  },
});
