import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
// `?raw` (Vite import suffix) pulls the source text in at transform time — the
// same mechanism spend-armed-env-coverage.test.ts uses. We parse env.ts to
// enumerate the behavior-flipping (`// spend-arming`) bindings, so a NEW such
// binding is automatically covered by the end-to-end leak assertion below.
import envSource from "../src/env.ts?raw";
import { ALLOWLISTED_TEST_BINDINGS, buildHermeticBindings, parseDevVarKeys } from "./hermetic-env.js";

// Guards the test-env coupling defect class: "test assertions gated on ambient
// developer-environment secrets". The pool loads apps/platform/.dev.vars via
// wrangler and injects every key as a binding on `env`; a developer's
// locally-wired real secret (e.g. a truthy STRIPE_SECRET_KEY) then silently
// flips behavior gates under test. vitest.config.ts + hermetic-env.ts make the
// env HERMETIC — this file proves it stays that way, at two layers:
//   (1) UNIT: the constructed-env builder neutralizes ANY non-allowlisted key
//       (incl. a novel one) to null — fails-by-construction if anyone swaps the
//       allowlist sweep for a per-var blocklist a new binding could bypass.
//   (2) END-TO-END: the ambient-source canary (in .dev.vars.example, copied to
//       .dev.vars in a fresh worktree) does NOT reach `env`, and every
//       spend-arming env.ts binding reads falsy in `env`.

describe("hermetic-env — parseDevVarKeys (values never surface, keys only)", () => {
  it("extracts keys, ignores comments/blank lines, and never returns values", () => {
    const content = [
      "# a comment",
      "",
      "TOKEN_HASH_PEPPER=some-secret-value",
      "  STRIPE_SECRET_KEY = sk_live_should_never_be_read  ",
      "   # indented comment",
      "MALFORMED_NO_EQUALS",
      "=leading-equals-no-key",
    ].join("\n");
    const keys = parseDevVarKeys(content);
    expect(keys).toEqual(["TOKEN_HASH_PEPPER", "STRIPE_SECRET_KEY"]);
    // No value fragment leaks through the key list.
    expect(keys.join("|")).not.toMatch(/sk_live|some-secret-value/);
  });
});

describe("hermetic-env — buildHermeticBindings neutralizes ambient keys by default", () => {
  it("neutralizes EVERY non-allowlisted ambient key to null (incl. a never-before-seen binding)", () => {
    // A novel binding a future lane might add (the brief names a REGISTRAR_*
    // lane) MUST be hermetic without editing this builder. If someone replaces
    // the allowlist sweep with a per-var blocklist, REGISTRAR_API_KEY (or the
    // canary) would pass through truthy and this fails.
    const bindings = buildHermeticBindings([
      "STRIPE_SECRET_KEY",
      "ENGINE_BASE_URL",
      "REGISTRAR_API_KEY",
      "HERMETIC_LEAK_CANARY",
      "TOKEN_HASH_PEPPER", // allowlisted
      "ADMIN_TOKEN", // allowlisted
    ]);
    expect(bindings.STRIPE_SECRET_KEY).toBeNull();
    expect(bindings.ENGINE_BASE_URL).toBeNull();
    expect(bindings.REGISTRAR_API_KEY).toBeNull();
    expect(bindings.HERMETIC_LEAK_CANARY).toBeNull();
  });

  it("applies the allowlisted test values (fixed, not inherited)", () => {
    // Even if a developer's .dev.vars sets a DIFFERENT value for an allowlisted
    // key, the builder forces the fixed test value.
    const bindings = buildHermeticBindings(["ADMIN_TOKEN", "STRIPE_WEBHOOK_SECRET", "TOKEN_HASH_PEPPER"]);
    expect(bindings.ADMIN_TOKEN).toBe(ALLOWLISTED_TEST_BINDINGS.ADMIN_TOKEN);
    expect(bindings.STRIPE_WEBHOOK_SECRET).toBe(ALLOWLISTED_TEST_BINDINGS.STRIPE_WEBHOOK_SECRET);
    expect(bindings.TOKEN_HASH_PEPPER).toBe(ALLOWLISTED_TEST_BINDINGS.TOKEN_HASH_PEPPER);
    // No neutral null slipped onto an allowlisted key.
    for (const key of Object.keys(ALLOWLISTED_TEST_BINDINGS)) {
      expect(bindings[key]).not.toBeNull();
    }
  });
});

// Mirrors spend-armed-env-coverage.test.ts's env.ts field parser: pull the
// `// spend-arming`-tagged binding names straight from the source so a NEW
// spend-arming binding is covered by the leak assertion without editing a list.
function spendArmingEnvFields(source: string): string[] {
  const lines = source.split("\n");
  const start = lines.findIndex((l) => /interface Env\s*\{/.test(l));
  if (start === -1) throw new Error("could not locate `interface Env {` in env.ts");
  const fields: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^ {4}\}/.test(line)) break;
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
    const m = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*\??\s*:/);
    if (m?.[1] && /\/\/\s*spend-arming/.test(line)) fields.push(m[1]);
  }
  return fields;
}

describe("hermetic-env — the ambient .dev.vars does NOT leak into the live test env", () => {
  const ambientEnv = env as unknown as Record<string, unknown>;

  it("the ambient-source canary is neutralized (would be truthy if .dev.vars leaked)", () => {
    // In a fresh worktree, .dev.vars is a copy of .dev.vars.example, which sets
    // HERMETIC_LEAK_CANARY to a truthy value. If the harness were not hermetic,
    // wrangler would inject that truthy value here. It must read falsy.
    expect(ambientEnv.HERMETIC_LEAK_CANARY, "ambient .dev.vars content leaked into the test env").toBeFalsy();
  });

  it("every `// spend-arming` env.ts binding reads falsy in the live env (non-vacuous)", () => {
    const spendArming = spendArmingEnvFields(envSource);
    // Guard against the parser silently drifting to empty (vacuous pass).
    expect(spendArming).toEqual(["STRIPE_SECRET_KEY", "ENGINE_BASE_URL", "ENGINE_AUTH_SECRET", "INBOXKIT_API_KEY", "INBOXKIT_WORKSPACE_ID"]);
    for (const field of spendArming) {
      expect(ambientEnv[field], `env.${field} is truthy in the test env — ambient spend-arming state leaked`).toBeFalsy();
    }
  });

  it("the allowlisted secrets carry the fixed test values, not ambient .dev.vars values", () => {
    expect(ambientEnv.ADMIN_TOKEN).toBe(ALLOWLISTED_TEST_BINDINGS.ADMIN_TOKEN);
    expect(ambientEnv.STRIPE_WEBHOOK_SECRET).toBe(ALLOWLISTED_TEST_BINDINGS.STRIPE_WEBHOOK_SECRET);
    expect(ambientEnv.TOKEN_HASH_PEPPER).toBe(ALLOWLISTED_TEST_BINDINGS.TOKEN_HASH_PEPPER);
  });
});
