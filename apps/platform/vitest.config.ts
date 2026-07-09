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
  },
});
