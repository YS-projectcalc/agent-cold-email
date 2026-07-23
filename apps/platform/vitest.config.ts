import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { buildHermeticBindings, parseDevVarKeys } from "./test/hermetic-env.js";

// Resolve a path next to THIS config file (apps/platform), robust to whether
// vitest loads the config from cwd or a bundled temp module.
function configRelative(name: string): string {
  const candidates: string[] = [];
  try {
    candidates.push(resolve(dirname(fileURLToPath(import.meta.url)), name));
  } catch {
    // import.meta.url unavailable (bundled config) — fall through to cwd.
  }
  candidates.push(resolve(process.cwd(), name));
  for (const p of candidates) if (existsSync(p)) return p;
  return candidates[candidates.length - 1] as string;
}

// HERMETIC TEST ENV (see test/hermetic-env.ts for the full WHY). The pool
// auto-loads apps/platform/.dev.vars via wrangler and injects every key as a
// test binding, so a developer's locally-wired real secret (e.g. a truthy
// STRIPE_SECRET_KEY wired for local E2E) would silently flip behavior gates
// under test (engine/billing.ts). We enumerate the KEYS present in .dev.vars
// (+ .dev.vars.example, which fresh worktrees copy to .dev.vars) and neutralize
// every non-allowlisted key, so AMBIENT state can never leak in. Values are
// never read or logged — only key NAMES are inspected.
const examplePath = configRelative(".dev.vars.example");
if (!existsSync(examplePath)) {
  // Fail loud rather than run non-hermetically: if we cannot see the documented
  // dev-var key set, an ambient secret could slip past the sweep.
  throw new Error(
    `[vitest hermetic env] cannot locate .dev.vars.example next to vitest.config.ts (looked at ${examplePath}). ` +
      `The hermetic binding sweep needs it to enumerate dev-var keys; refusing to run non-hermetically.`,
  );
}
const ambientKeys = new Set<string>();
for (const p of [configRelative(".dev.vars"), examplePath]) {
  if (existsSync(p)) for (const key of parseDevVarKeys(readFileSync(p, "utf8"))) ambientKeys.add(key);
}

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        // Constructed hermetic binding set (test/hermetic-env.ts): the
        // allowlisted test secrets (ADMIN_TOKEN, STRIPE_WEBHOOK_SECRET,
        // TOKEN_HASH_PEPPER — fixed in-repo values, never real secrets per
        // CLAUDE.md rule g) plus every other ambient .dev.vars key neutralized
        // to null. These OVERRIDE the pool's wrangler-derived .dev.vars
        // bindings, so no ambient value reaches the test env.
        bindings: buildHermeticBindings(ambientKeys),
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
