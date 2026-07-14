import { defineConfig } from "vitest/config";

// Plain Node environment — the engine is a stand-alone Node service, NOT a
// Cloudflare Worker, so it does not use @cloudflare/vitest-pool-workers. The
// GreenMail end-to-end file self-skips unless ENGINE_E2E=1 (real Docker
// container required); everything else is pure-unit and always runs.
export default defineConfig({
  test: {
    environment: "node",
    fileParallelism: false,
  },
});
