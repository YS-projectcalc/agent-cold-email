// Hermetic test-env binding construction — shared by vitest.config.ts (which
// builds the pool's miniflare bindings) and hermetic-env.test.ts (which guards
// it). See test/README.md "Hermetic test env".
//
// WHY this exists: @cloudflare/vitest-pool-workers loads apps/platform/.dev.vars
// through wrangler (getVarsForDev -> unstable_getMiniflareWorkerOptions) and
// injects EVERY key in it as a binding on the test `env`. A developer's
// locally-wired real secret therefore silently flips behavior gates under test
// — e.g. a truthy STRIPE_SECRET_KEY makes engine/billing.ts's isRealSpendArmed
// return true, so the simulated-checkout tests get real-Stripe-mode behavior.
// The suite is only green in fresh worktrees because they copy the (empty-key)
// .dev.vars.example: the result depends on ambient machine state, which is the
// defect this module closes.
//
// HOW: the test env is CONSTRUCTED, not inherited. Tests see ONLY the
// allowlisted bindings below (fixed in-repo test values); every OTHER key a
// developer's .dev.vars carries is neutralized to `null`. New env vars are
// hermetic BY DEFAULT — a key that is not on the allowlist is neutralized no
// matter when it was added (there is no per-var blocklist to keep in sync, so a
// future binding, e.g. a REGISTRAR_* one, cannot silently bypass this).

/**
 * The ONLY secrets a test is allowed to see SET — with fixed, in-repo test
 * values (never a real secret; CLAUDE.md rule g). Whatever a developer's
 * .dev.vars holds for these keys is OVERRIDDEN by these values, so a test never
 * inherits an ambient value even for a var it legitimately needs.
 */
export const ALLOWLISTED_TEST_BINDINGS: Record<string, string> = {
  // Pepper mixed into token/session hashing and unsubscribe-token signing
  // (require-auth.ts, unsubscribe-token.ts). The value is arbitrary but must be
  // consistent within a run — sign and verify both read env.TOKEN_HASH_PEPPER
  // and no test asserts a specific hash — and MUST be non-empty (a "" pepper
  // would weaken hashing), which is why it is allowlisted, never neutralized.
  TOKEN_HASH_PEPPER: "test-only-pepper-for-vitest",
  // Bearer secret every /admin/* route test presents (helpers.ts adminApi()).
  ADMIN_TOKEN: "test-admin-token-for-vitest",
  // Webhook HMAC secret the suite signs its Stripe fixtures with (helpers.ts
  // postWebhook()); the webhook route fails CLOSED when it is unset, so the
  // suite must always have it set — matching a real deployment.
  STRIPE_WEBHOOK_SECRET: "whsec_test_secret_for_vitest",
};

/**
 * Extract the KEYS from a `.dev.vars`-format file's CONTENT. Values are never
 * returned or logged (the whole point is that ambient values must not surface).
 * Pure (takes the content string, not a path) so it is unit-testable without
 * touching the filesystem.
 */
export function parseDevVarKeys(content: string): string[] {
  const keys: string[] = [];
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue; // no '=', or an empty key before it
    keys.push(line.slice(0, eq).trim());
  }
  return keys;
}

/**
 * Build the hermetic miniflare bindings: every ambient key that is NOT
 * allowlisted is neutralized to `null`, then the allowlist is applied with its
 * fixed test values. `null` (not `""`) is the neutral value on purpose — it is
 * JSON-schema-valid for a miniflare binding AND nullish, so it stays falsy for
 * Boolean/`&&` gates (isRealSpendArmed, factory.ts) *and* falls through
 * `?? default` reads (tick.ts's PUBLIC_BASE_URL) exactly as an unset var would.
 * The pool merges these OVER wrangler's `.dev.vars`-derived bindings
 * (mergeWorkerOptions -> Object.assign), so an ambient value can never win.
 */
export function buildHermeticBindings(ambientKeys: Iterable<string>): Record<string, string | null> {
  const bindings: Record<string, string | null> = {};
  for (const key of ambientKeys) {
    if (key in ALLOWLISTED_TEST_BINDINGS) continue;
    bindings[key] = null;
  }
  return { ...bindings, ...ALLOWLISTED_TEST_BINDINGS };
}
