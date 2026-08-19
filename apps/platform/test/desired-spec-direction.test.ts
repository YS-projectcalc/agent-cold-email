import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { activatePaidPlan, api, mintTenant, seedBenignSdnList, tenantStub, withTenantContext } from "./helpers.js";
import { runProvisioningReconcile } from "../src/engine/provisioning-reconcile.js";

// THE DESIRED-SPEC DIRECTION RULE (design §7.3's R5, §7.17.5's N5).
//
// `domain_intents.inboxes_each` is the DESIRED provisioning spec for an
// ordinal, and the dark reconciler re-drives toward it. So the column is not a
// record of what happened — it is a standing instruction to buy, executed by an
// UNATTENDED path. That makes its direction a consent question:
//
//   LOWERING is always allowed  — bill-neutral-or-lowering, nobody to ask.
//   RAISING is written ONLY by the customer's own call that raised it — the
//                                 call IS the consent.
//
// Today the column is INSERT-only (`recordDomainIntent`'s INSERT OR IGNORE), so
// nothing raises it and nothing lowers it either. That is safe in the direction
// that matters and stale in the other: a customer who NARROWS a distribution
// leaves the wider number stored, and an armed reconcile would re-drive toward
// it. The lowering-side writer is therefore assigned to this lane as a
// PRECONDITION OF ARMING `PROVISIONING_RECONCILE_ENABLED` — not of this wave.
// Harm is zero while that flag stays unset (prod-confirmed unset; the ops
// ledger carries a standing do-NOT-arm note, now at four blockers), and nothing
// in this wave depends on it.
//
// This file is the guard either way: it pins the direction rule so the NEXT
// writer of the column has to declare which way it moves.

const PLATFORM_SOURCES = import.meta.glob("../src/**/*.ts", { query: "?raw", eager: true, import: "default" }) as Record<
  string,
  string
>;

/**
 * Source sites that write `inboxes_each` OUTSIDE an INSERT — i.e. that can move
 * an already-stored desired spec. EMPTY TODAY, deliberately: adding one is the
 * event this guard exists to make loud, and the entry has to state its
 * direction. A RAISING writer on an unattended path (reconcile, tick, sweep)
 * must never be added here — it would autonomously re-buy toward a number the
 * customer never asked for, which is the bill-raising-on-an-unattended-path
 * shape the quantity-billing arc ratified against.
 */
const ALLOWED_DESIRED_SPEC_WRITERS: { file: string; direction: "lowering"; why: string }[] = [];

/** Strips line and block comments, so prose about the column never counts as a write. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("the desired provisioning spec moves in one direction only", () => {
  it("no source file UPDATEs `domain_intents.inboxes_each` outside the declared allowlist", () => {
    const offenders: string[] = [];
    for (const [path, source] of Object.entries(PLATFORM_SOURCES)) {
      const code = stripComments(source);
      // Any statement that both targets the table and sets the column, other
      // than an INSERT. The scan is lexical on purpose: it catches the shape a
      // developer plausibly writes, and its job is to make the honest mistake
      // loud rather than to be a capability boundary.
      for (const statement of code.split(";")) {
        if (!/UPDATE\s+domain_intents/i.test(statement)) continue;
        if (!/\binboxes_each\b/.test(statement)) continue;
        const file = path.replace("../src/", "");
        if (ALLOWED_DESIRED_SPEC_WRITERS.some((a) => a.file === file)) continue;
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the tripwire actually fires — it is not a no-op that passes because it matches nothing", () => {
    const planted = stripComments(`
      // UPDATE domain_intents SET inboxes_each = 9 -- a comment must NOT count
      ctx.sql.exec(\`UPDATE domain_intents SET inboxes_each = ? WHERE key = ?\`, n, key);
    `);
    const statements = planted.split(";").filter((s) => /UPDATE\s+domain_intents/i.test(s) && /\binboxes_each\b/.test(s));
    expect(statements).toHaveLength(1);
  });

  it("every allowlist entry declares a LOWERING direction — a raising writer can never be waved through", () => {
    for (const entry of ALLOWED_DESIRED_SPEC_WRITERS) {
      expect(entry.direction).toBe("lowering");
      expect(entry.why.length).toBeGreaterThan(20);
    }
  });
});

describe("no unattended path raises a stored desired spec", () => {
  async function readSpecs(tenantId: string): Promise<(number | null)[]> {
    return runInDurableObject(tenantStub(tenantId), (_i, state) =>
      state.storage.sql
        .exec<{ inboxes_each: number | null }>(
          `SELECT inboxes_each FROM domain_intents WHERE tenant_id = ? ORDER BY key`,
          tenantId,
        )
        .toArray()
        .map((r) => r.inboxes_each),
    );
  }

  function setupBody(over: Record<string, unknown>): string {
    return JSON.stringify({
      brand: "Spec Direction Co",
      primaryDomain: "specdirectionco.com",
      domains: 1,
      inboxesEach: 1,
      persona: "Sender",
      physicalAddress: "1 Main St",
      senderIdentity: "Sales Team",
      ...over,
    });
  }

  it("the RECONCILE re-drives toward the stored spec and never rewrites it", async () => {
    await seedBenignSdnList();
    const { token, tenantId } = await mintTenant("Spec Direction Co", "managed");
    await activatePaidPlan(tenantId, "managed");
    await api("/setup-infrastructure", { method: "POST", token, body: setupBody({ domains: 1, distribution: [2] }) });
    expect(await readSpecs(tenantId)).toEqual([2]);

    await withTenantContext(tenantId, (ctx) => runProvisioningReconcile(ctx));
    expect(await readSpecs(tenantId)).toEqual([2]);
  });

  it("a CUSTOMER call that raises the distribution still provisions the extra slots — the target is the call, not the row", async () => {
    await seedBenignSdnList();
    const { token, tenantId } = await mintTenant("Spec Direction Co", "managed");
    await activatePaidPlan(tenantId, "managed");
    await api("/setup-infrastructure", { method: "POST", token, body: setupBody({ domains: 1, distribution: [1] }) });

    const raised = await api<{ billing?: { provisionedAfter: number } }>("/setup-infrastructure", {
      method: "POST",
      token,
      body: setupBody({ domains: 1, distribution: [3] }),
    });
    expect(raised.body?.billing?.provisionedAfter).toBe(3);

    // The stored spec is INSERT-only, so it still reads 1 — the raise is
    // executed by the call and NOT durably re-instructed to the reconciler.
    // Recorded as the R5 gap, bounded by the reconcile flag staying unset.
    expect(await readSpecs(tenantId)).toEqual([1]);
  });
});
