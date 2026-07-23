import { describe, expect, it } from "vitest";
// `?raw` (Vite import suffix) pulls the source text in at transform time — the
// same mechanism test/setup.ts uses for migrations, since workerd has no
// runtime filesystem. We parse the SOURCE (not a runtime value) because env.ts
// is a pure `declare global` type — there is nothing to reflect at runtime.
import billingSource from "../src/engine/billing.ts?raw";
import envSource from "../src/env.ts?raw";

// R3-1 (selfserve-i1i2-build-review round 3): a failing-by-construction guard
// for the free-money spend-bypass class. The I1 fix made simulated checkout
// self-disable once `isRealSpendArmed` is true; the hazard is that a FUTURE
// vendor env binding (a new INBOXKIT_*, a MAILFORGE_*, ...) gets added without
// being wired into isRealSpendArmed, silently reopening the bypass on that
// vendor. A doc comment is not a systemic guard. This test makes it MECHANICAL:
//   1. every env field is categorized (spend-arming or explicitly not) — a NEW
//      field that is neither trips RED until a human decides which it is;
//   2. every `// spend-arming`-tagged field is referenced by isRealSpendArmed.

// The only env fields that do NOT arm real vendor spend. A new binding must be
// added here (if inert) or tagged `// spend-arming` in env.ts (if it arms
// spend) — otherwise the exhaustiveness assertion below fails.
const KNOWN_NON_SPEND_ARMING = new Set([
  "DB",
  "TENANT",
  "SIGNUP_LIMITER",
  "TOKEN_HASH_PEPPER",
  "WAITLIST",
  "STRIPE_WEBHOOK_SECRET", // verifies inbound events; arms nothing
  "ADMIN_TOKEN",
  "OPS_EMAIL",
  "OPS_ALERT_EMAIL",
  "ASSETS",
  "PUBLIC_BASE_URL",
  "GMAIL_OAUTH_GRANTS", // I3 manual OAuth grants — inert without INBOXKIT_* + ENGINE_*, arms nothing itself
  "TURNSTILE_SECRET", // magic-link bot-defense (design §2.3) — auth infra, not a vendor-spend signal
  "TURNSTILE_SITE_KEY", // PUBLIC widget key, not a secret at all — arms nothing
  // GA gates G2/G4 spend BOUNDS, not spend ENABLERS — a ceiling/cost-table/
  // slot-cap with no armed vendor spends $0 (see env.ts's comment on why these
  // are deliberately NOT `// spend-arming`). isRealSpendArmed must NOT read them.
  "SPEND_CEILING_CENTS",
  "COST_MAILBOX_CENTS",
  "COST_DOMAIN_CENTS",
  "COST_PREWARM_MAILBOX_CENTS",
  "INBOXKIT_PLAN_SLOTS",
  "OFAC_LIST_URL", // G1a — a public, no-auth CSV download URL; fetching it costs nothing and arms no vendor spend
  "SDN_INGEST_TOKEN", // G1a droplet-relay — bearer secret gating POST /admin/sdn/ingest; ingesting a CSV costs nothing and arms no vendor spend
]);

function parseEnvFields(source: string): { all: Set<string>; spendArming: Set<string> } {
  const lines = source.split("\n");
  const start = lines.findIndex((l) => /interface Env\s*\{/.test(l));
  if (start === -1) throw new Error("could not locate `interface Env {` in env.ts");
  const all = new Set<string>();
  const spendArming = new Set<string>();
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^ {4}\}/.test(line)) break; // the interface's own closing brace
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
    const m = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*\??\s*:/);
    const field = m?.[1];
    if (!field) continue;
    all.add(field);
    if (/\/\/\s*spend-arming/.test(line)) spendArming.add(field);
  }
  return { all, spendArming };
}

function isRealSpendArmedBody(source: string): string {
  const m = source.match(/export function isRealSpendArmed\([\s\S]*?\n\}/);
  if (!m) throw new Error("could not locate isRealSpendArmed in billing.ts");
  return m[0];
}

describe("R3-1 — isRealSpendArmed covers every spend-arming env field", () => {
  const { all, spendArming } = parseEnvFields(envSource);
  const fnBody = isRealSpendArmedBody(billingSource);

  it("finds the vendor-arming bindings actually tagged in env.ts (non-vacuous)", () => {
    // If this ever reads empty, the parser drifted from env.ts's shape and the
    // whole guard would be silently vacuous — assert it caught the real ones.
    expect(spendArming).toEqual(
      new Set([
        "STRIPE_SECRET_KEY",
        "ENGINE_BASE_URL",
        "ENGINE_AUTH_SECRET",
        "INBOXKIT_API_KEY",
        "INBOXKIT_WORKSPACE_ID",
        "REGISTRAR_PROVIDER",
        "CLOUDFLARE_REGISTRAR_API_TOKEN",
      ]),
    );
  });

  it("every `// spend-arming` env field is referenced by isRealSpendArmed", () => {
    for (const field of spendArming) {
      expect(fnBody, `isRealSpendArmed must read env.${field} — a spend-arming binding is unguarded (free-money simulate bypass reopens on this vendor)`).toContain(`env.${field}`);
    }
  });

  it("EVERY env field is categorized (spend-arming OR explicitly non-arming) — a new binding trips RED until a human decides", () => {
    const uncategorized = [...all].filter((f) => !spendArming.has(f) && !KNOWN_NON_SPEND_ARMING.has(f));
    expect(uncategorized, `env.ts field(s) ${uncategorized.join(", ")} are uncategorized: tag them \`// spend-arming\` in env.ts (if they arm real vendor spend) or add them to KNOWN_NON_SPEND_ARMING (if inert). Do NOT skip this — an untagged vendor key reopens the spend-bypass class.`).toEqual([]);
  });

  it("the non-arming allowlist has no stale entries (a removed field can't linger)", () => {
    const stale = [...KNOWN_NON_SPEND_ARMING].filter((f) => !all.has(f));
    expect(stale, `KNOWN_NON_SPEND_ARMING lists field(s) ${stale.join(", ")} no longer in env.ts`).toEqual([]);
  });
});
