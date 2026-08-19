/// <reference types="vite/client" />
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { CapacityPendingError, NotActivatedError, OPERATOR_NOTIFIED, RegistrarUnarmedError } from "@coldstart/shared";
import { toErrorResponse } from "../src/error-response.js";
import { periodKey, withSpendCeiling } from "../src/engine/spend-ceiling.js";
import type { OpsEmailMessage, OpsMailer } from "../src/ops-mail/ops-mailer.js";
import { SandboxOpsMailer } from "../src/ops-mail/sandbox-ops-mailer.js";
import type { TenantContext } from "../src/tenant-context.js";
import { mintTenant, withTenantContext } from "./helpers.js";
import { strippedSource } from "./source-text.js";

// docs/adversarial/class-sweep-signal-inversion-2026-08-17.md, arm A: seven
// customer-facing surfaces asserted "The operator has been notified" as a
// CONSTANT, composed by the code path that REQUESTED a notification rather than
// by one that knew it happened. Every notifier behind them can decline: an
// unset OPS_ALERT_EMAIL, a swallowed send failure, an alert suppressed inside a
// 6h cooldown, an alert withheld pending a confirming observation — and for
// NotActivatedError, no notifier exists anywhere in the tree.
//
// The harm is specific: an agent told a human is already on it stops
// escalating, which is exactly what the contact_operator channel exists to
// prevent.
//
// Two halves, because neither holds alone: BEHAVIOUR (drive the real paths and
// read what the customer gets) and a SOURCE TRIPWIRE (the sentence cannot be
// re-introduced as a literal by the next surface that wants it).

describe("the notification claim is chosen by what happened", () => {
  async function seedCeiling(cents: number): Promise<void> {
    await env.DB.prepare(
      `INSERT OR REPLACE INTO vendor_spend_ledger (period_key, reserved_cents, committed_cents, ceiling_cents, updated_at)
       VALUES (?, 0, 0, ?, ?)`,
    )
      .bind(periodKey(Date.now()), cents, Date.now())
      .run();
  }

  /** Forces the 'real' bundle so the money choke-point actually engages. */
  function realCtx<T>(tenantId: string, fn: (ctx: TenantContext) => Promise<T>): Promise<T> {
    return withTenantContext(tenantId, (ctx) => fn({ ...ctx, adapters: { ...ctx.adapters, kind: "real" } }));
  }

  async function rejectedMessage(tenantId: string, mailer: OpsMailer): Promise<string> {
    return realCtx(tenantId, async (ctx) => {
      const err = await withSpendCeiling(ctx, "mailbox", async () => "unreachable", mailer).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CapacityPendingError);
      return (err as CapacityPendingError).message;
    });
  }

  it("a capacity rejection whose founder alert LANDED says the operator was notified", async () => {
    await env.DB.prepare("DELETE FROM vendor_spend_ledger").run();
    await env.DB.prepare("DELETE FROM vendor_spend_entries").run();
    const { tenantId } = await mintTenant("Notified Co", "managed");
    await seedCeiling(0);

    const mailer = new SandboxOpsMailer();
    const message = await rejectedMessage(tenantId, mailer);

    expect(mailer.sent).toHaveLength(1);
    expect(message).toContain(OPERATOR_NOTIFIED);
  });

  it("a capacity rejection whose founder alert FAILED does not claim it was notified", async () => {
    await env.DB.prepare("DELETE FROM vendor_spend_ledger").run();
    await env.DB.prepare("DELETE FROM vendor_spend_entries").run();
    const { tenantId } = await mintTenant("Unnotified Co", "managed");
    await seedCeiling(0);

    const throwing: OpsMailer = {
      async send(_msg: OpsEmailMessage) {
        throw new Error("E_SENDER_NOT_VERIFIED (dark)");
      },
    };
    const message = await rejectedMessage(tenantId, throwing);

    // THE CLAIM UNDER TEST. Pre-fix this sentence was a constant and said the
    // opposite of what had just happened.
    expect(message).not.toContain(OPERATOR_NOTIFIED);
    expect(message).toContain("contact_operator");
    // The rest of the body is unchanged — this is a truthfulness fix, not a
    // rewrite of what the tenant is told about their account.
    expect(message).toContain("Nothing was charged");
  });
});

describe("error bodies with no notifier behind them do not claim one", () => {
  it("NotActivatedError — nothing in the tree notifies for it", () => {
    const body = toErrorResponse(new NotActivatedError("email", "send")).body as { error: string };
    expect(body.error).not.toContain(OPERATOR_NOTIFIED);
    expect(body.error).toContain("contact_operator");
    // The pre-existing leak guard still holds: no env-var or runbook text.
    expect(body.error).not.toContain("ACTIVATION.md");
  });

  it("RegistrarUnarmedError — its notifier is wired at only three of its producers", () => {
    const body = toErrorResponse(new RegistrarUnarmedError("buy", "env")).body as {
      error: string;
    };
    expect(body.error).not.toContain(OPERATOR_NOTIFIED);
    expect(body.error).toContain("contact_operator");
    expect(body.error).not.toContain("REGISTRAR_PROVIDER");
  });
});

// The tripwire. Globs the tree rather than listing files: a hand-maintained
// SOURCES array is how test/spend-ceiling-coverage.test.ts went blind to call
// sites added elsewhere (coverage ledger), and this claim is exactly the kind
// a NEW surface reaches for.
const SOURCES = {
  ...(import.meta.glob("../src/**/*.ts", { query: "?raw", eager: true, import: "default" }) as Record<string, string>),
  ...(import.meta.glob("../../../packages/shared/src/**/*.ts", { query: "?raw", eager: true, import: "default" }) as Record<
    string,
    string
  >),
};

const normalize = (key: string) => key.replace(/^(\.\.\/)+/, "");

/**
 * The one file allowed to SPELL the sentence: it is where the constant and its
 * honest alternative live, as a pair, so the choice between them is one
 * greppable decision.
 */
const VOCABULARY_FILE = "packages/shared/src/provenance.ts";

/** Files with an emittable (non-comment) spelling of the claim. */
export function findUnbackedNotificationClaims(sources: Record<string, string>): string[] {
  return Object.entries(sources)
    .filter(([key, source]) => {
      const file = normalize(key);
      if (file === VOCABULARY_FILE) return false;
      const code = strippedSource(source);
      if (!/has been (notified|alerted|informed)/i.test(code)) return false;
      // Composing it through the vocabulary is the point of the vocabulary.
      return !/operatorNotifiedClause|OPERATOR_NOTIFIED/.test(code);
    })
    .map(([key]) => normalize(key));
}

describe("source tripwire — the claim cannot be re-introduced as a literal", () => {
  it("no source file spells a notification claim it cannot cite", () => {
    expect(findUnbackedNotificationClaims(SOURCES)).toEqual([]);
  });

  it("the tripwire actually fires (and not on comments)", () => {
    expect(
      findUnbackedNotificationClaims({ "../src/fake.ts": `const m = "The operator has been notified.";` }),
    ).toEqual(["src/fake.ts"]);
    // A comment explaining the rule must not trip it — a guard that cries wolf
    // gets silenced.
    expect(
      findUnbackedNotificationClaims({ "../src/fake.ts": `// never say the operator has been notified\nconst m = "ok";` }),
    ).toEqual([]);
    // Nor may citing the vocabulary be enough on its own to *spell* it: the
    // allowed shape is composing through the helper.
    expect(
      findUnbackedNotificationClaims({
        "../src/fake.ts": `const m = \`x \${operatorNotifiedClause(n)}\`; const y = "has been notified";`,
      }),
    ).toEqual([]);
  });
});
