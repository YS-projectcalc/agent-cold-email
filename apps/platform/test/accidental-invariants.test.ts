/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { adminApi, activatePaidPlan, mintTenant, seedBenignSdnList, tenantStub } from "./helpers.js";
import { newId } from "../src/schema.js";
import { strippedSource } from "./source-text.js";
import { runInDurableObject } from "cloudflare:test";

// ACCIDENTAL INVARIANTS (docs/adversarial/sweep-completeness-pass-2026-08-17.md
// §4(i)) — "a correctness property that holds today only because of an
// unrelated implementation coincidence: no CHECK constraint, no type, no test,
// no comment pins it, so a future edit to the UNRELATED code silently breaks
// it, and the sweep that examined the site correctly recorded it as OUT."
//
// The class inverts where you look: an inventory's OUT column is normally
// treated as closed, and this says the OUT column is where the next incident
// lives. Its guard is uniform — every "unreachable today" ruling must either be
// made structurally impossible, or PINNED by a test that reds when the
// coincidence breaks. These are the pins.
//
// TRIPWIRES, NOT PROOFS, for the two source scans: they catch the honest
// mistake (a second writer, a new activation path in a new file), not every
// conceivable dodge — the same posture loop-isolation-scan.ts states for
// itself. That is what they are for.

const SRC = import.meta.glob("../src/**/*.ts", { query: "?raw", eager: true, import: "default" }) as Record<string, string>;

function strippedSources(): Array<[string, string]> {
  return Object.entries(SRC).map(([file, source]) => [file.replace("../", "apps/platform/"), strippedSource(source)]);
}

describe("member 1 — the dunning idempotency key omits `action`", () => {
  // `dunning_events UNIQUE(tenant_id, cycle)` (migrations/0002) and
  // `hasDunningEventForCycle` both ignore `action`, so an ESCALATION within one
  // cycle would be swallowed AND the suspend skipped (ops-sweep's
  // `alreadyActioned` pre-check). That is unreachable only because
  // `decideDunningAction` depends on `(cycle, declineCode)` and
  // `last_decline_code` is written at EXACTLY ONE site — inside the same
  // `invoice.payment_failed` branch that produces the cycle. A second writer
  // anywhere makes the decline code able to change WITHIN a cycle, which makes
  // two different actions owed for one key, which the key cannot express.
  it("`last_decline_code` still has exactly one writer, still inside invoice.payment_failed", () => {
    const writers: Array<{ file: string; enclosingCase: string | null }> = [];
    for (const [file, source] of strippedSources()) {
      for (const match of source.matchAll(/SET\s+last_decline_code\s*=/g)) {
        const before = source.slice(0, match.index);
        const cases = [...before.matchAll(/case\s+"([a-z_.]+)"/g)];
        writers.push({ file, enclosingCase: cases.length > 0 ? cases[cases.length - 1]![1]! : null });
      }
    }

    expect(
      writers,
      "a second writer of `last_decline_code` makes the decline code able to change WITHIN one dunning cycle. " +
        "`dunning_events UNIQUE(tenant_id, cycle)` cannot express two actions for one cycle, and " +
        "`hasDunningEventForCycle` would skip the second one — including a SUSPEND. Either add `action` to the key " +
        "(migration + hasDunningEventForCycle) or keep the single writer.",
    ).toEqual([{ file: "apps/platform/src/engine/billing.ts", enclosingCase: "invoice.payment_failed" }]);
  });
});

describe("member 2 — the support digest's two-status allowlist", () => {
  // Complete ONLY because `'closed'` exists in the TS union with zero writers.
  // The first close/snooze/reopen feature blinds the ticket LIST and its COUNTS
  // in the same commit, and the two agreed with each other while both were
  // blind — which is exactly why the digest could not detect its own narrowing.
  it("counts every ticket status, and says so when one is unaccounted for", async () => {
    await env.DB.prepare("DELETE FROM support_tickets").run();
    const insert = (status: string) =>
      env.DB.prepare(
        `INSERT INTO support_tickets (id, from_email, subject, body, tenant_id, category, draft, status, created_at, message_id, source, email_sent_at)
         VALUES (?, 'a@b.test', 's', 'b', NULL, 'other', NULL, ?, 1, NULL, 'email', NULL)`,
      )
        .bind(newId("tkt"), status)
        .run();

    await insert("open");
    await insert("escalated");
    // A status the triage path does not write today. Adding one must not
    // silently shrink the digest.
    await insert("snoozed");

    const { body } = await adminApi<{ counts: { open: number; escalated: number; closed: number; total: number; unaccounted: number }; tickets: unknown[] }>(
      "/admin/support/digest",
    );

    // REDS on the old code: `total` did not exist, and `open + escalated` was 2.
    expect(body.counts.total).toBe(3);
    expect(body.counts.open + body.counts.escalated + body.counts.closed).toBe(2);
    expect(body.counts.unaccounted).toBe(1);
    // The list is still narrowed — that part is by design. What changed is that
    // the response now says so instead of agreeing with itself.
    expect(body.tickets).toHaveLength(2);

    await env.DB.prepare("DELETE FROM support_tickets").run();
  });
});

describe("member 4 — `screening_status` DEFAULT 'clear'", () => {
  // The activation predicate requires `screening_status === 'clear'`
  // (engine/activation.ts), and the column DEFAULTS to 'clear'. So a tenant
  // that was never screened reads as screened-clean and ACTIVATES. That is safe
  // only because every path to `billing_state = 'active'` happens to screen.

  it("every source file that activates a tenant also screens it", () => {
    const activators = strippedSources()
      .filter(([, source]) => /billing_state\s*=\s*'active'/.test(source))
      .filter(([, source]) => !/screenTenant\s*\(/.test(source))
      .map(([file]) => file);

    expect(
      activators,
      "a file writes `billing_state = 'active'` without reaching the OFAC screen. `screening_status` DEFAULTs to " +
        "'clear' and the activation predicate reads it, so a tenant activated on this path is treated as screened " +
        "clean without ever having been screened. Screen on this path, or make the default non-activating.",
    ).toEqual([]);
  });

  it("a tenant activated through the real checkout path was ACTUALLY screened, not defaulted", async () => {
    // A list must be loaded, or screening fails CLOSED to 'review' — which is
    // the correct behaviour and would make this assertion pass for the wrong
    // reason (an unscreened tenant is not activatable either way).
    await seedBenignSdnList();
    const { tenantId } = await mintTenant("Accidental Invariant Co", "managed");
    await activatePaidPlan(tenantId, "managed");

    const profile = await runInDurableObject(tenantStub(tenantId), (_instance, state) =>
      state.storage.sql
        .exec<{ billing_state: string; screening_status: string; screened_at: number | null }>(
          `SELECT billing_state, screening_status, screened_at FROM tenant_profile WHERE id = ?`,
          tenantId,
        )
        .one(),
    );

    expect(profile.billing_state).toBe("active");
    // `screened_at` is NULL until `screenTenant` writes it, and NOTHING else
    // does — so a non-null value is proof the clean status was measured rather
    // than inherited from the column default.
    expect(profile.screened_at).not.toBeNull();
    expect(profile.screening_status).toBe("clear");
  });
});
