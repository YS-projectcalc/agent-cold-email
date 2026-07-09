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
      miniflare: { bindings: { ADMIN_TOKEN: "test-admin-token-for-vitest" } },
    }),
  ],
  test: {
    setupFiles: ["./test/setup.ts"],
  },
});
