import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { NextSteps } from "@coldstart/shared";
import { realNowMs } from "../src/engine/clamped-age.js";
import { deriveNextSteps, owedSignals } from "../src/engine/next-steps.js";
import { managedMailboxAddress } from "../src/engine/mailbox-provisioning.js";
import { domainIntentKey } from "../src/engine/provision-intents.js";
import { emitTenantMessage } from "../src/engine/tenant-messages.js";
import { activatePaidPlan, mintTenant, seedBenignSdnList, tenantStub, withTenantContext } from "./helpers.js";

// BLOCKING-2 (docs/adversarial/customer-continuity-build-gate-2026-08-19.md) —
// a stale SYSTEM message becomes a permanent `owed` step with no auto-resolution
// path. `read_at` has exactly one writer (`ackMessage`), so a `retry_setup` row
// written about a domain whose setup then FINISHED stays unacked forever: the
// tenant reads `status: "owed"`, `seat_headroom_free` is suppressed by the
// `owedCount === 0` predicate, the stuck-customer check goes unhealthy on the
// 48h owed-age bound, and the one-shot nudge eventually tells a customer their
// account "has not progressed in over a day" about work that completed.
//
// THE RULE. The kinds THIS platform writes ABOUT PROVISIONING STATE are
// RE-DERIVABLE: the same derivation that counts them also computes, from state,
// whether the condition they describe still holds. So they count as owed only
// while the setup-family reasons do — and when they do not, the row is EXPIRED
// durably so operator surfaces stop showing a dead action item too.

let seq = 0;

interface Seed {
  /** Live domain ordinals: `dnsReady: false` leaves a genuine `domain_dns_incomplete` owed. */
  ordinals: { domain: string; liveMailboxes: number; dnsReady?: boolean }[];
  billedQuantity?: number;
}

async function seedTenant(seed: Seed): Promise<string> {
  const persona = "mordytee";
  const { tenantId } = await mintTenant(`Stale Message Co ${++seq}`, "managed");
  await seedBenignSdnList();
  await activatePaidPlan(tenantId, "managed");
  await runInDurableObject(tenantStub(tenantId), (_instance, state) => {
    const sql = state.storage.sql;
    sql.exec(
      `UPDATE tenant_profile
          SET primary_domain = ?, physical_address = ?, sender_identity = ?, mailbox_qty_synced = ?, register_domains = 1
        WHERE id = ?`,
      "authorpitchdesk.com",
      "1 Press Way, Testville, CA 94000",
      "Press Outreach <hello@authorpitchdesk.com>",
      seed.billedQuantity ?? 5,
      tenantId,
    );
    seed.ordinals.forEach((ord, ordinal) => {
      sql.exec(
        `INSERT INTO domain_intents (key, tenant_id, candidate_domain, status, persona_slug, inboxes_each, created_at, updated_at)
         VALUES (?, ?, ?, 'committed', ?, ?, ?, ?)`,
        domainIntentKey(tenantId, ordinal),
        tenantId,
        ord.domain,
        persona,
        Math.max(1, ord.liveMailboxes),
        1000,
        1000 + ordinal,
      );
      const domainId = `dom_${ordinal}_${tenantId}`;
      sql.exec(
        `INSERT INTO domains (id, tenant_id, domain, status, purchased_at, dns_status) VALUES (?, ?, ?, 'active', ?, ?)`,
        domainId,
        tenantId,
        ord.domain,
        1000,
        ord.dnsReady === false ? "pending" : "ready",
      );
      for (let slot = 0; slot < ord.liveMailboxes; slot++) {
        const email = managedMailboxAddress(persona, ord.domain, ordinal, slot);
        sql.exec(
          `INSERT INTO mailboxes (id, tenant_id, domain_id, domain, email, daily_cap, warmup_started_at, created_at, provider)
           VALUES (?, ?, ?, ?, ?, 5, 1000, 1000, 'google')`,
          `mbx_${email}`,
          tenantId,
          domainId,
          ord.domain,
          email,
        );
      }
    });
  });
  return tenantId;
}

/** The gate's live row, verbatim in shape: unacked, action_required, about a domain that then finished. */
async function emitRetrySetup(tenantId: string, domain = "goauthorpitchdesk.com"): Promise<void> {
  await withTenantContext(tenantId, (ctx) =>
    emitTenantMessage(ctx, {
      kind: "retry_setup",
      severity: "action_required",
      body: `Setup for ${domain} has not finished yet — its mailbox purchase is still completing at the vendor.`,
      actionHint: { tool: "setup_infrastructure", idempotencyKey: null },
      dedupKey: `retry:${domain}`,
    }),
  );
}

function derive(tenantId: string): Promise<NextSteps> {
  return withTenantContext(tenantId, (ctx) => deriveNextSteps(ctx));
}

function messageRows(tenantId: string): Promise<{ kind: string; read_at: number | null; expires_at: number | null }[]> {
  return withTenantContext(tenantId, (ctx) =>
    ctx.sql
      .exec<{ kind: string; read_at: number | null; expires_at: number | null }>(
        `SELECT kind, read_at, expires_at FROM tenant_messages WHERE tenant_id = ? ORDER BY rowid`,
        ctx.tenantId,
      )
      .toArray(),
  );
}

const HEALTHY_FLEET: Seed = {
  ordinals: [
    { domain: "theauthorpitchdesk.com", liveMailboxes: 2 },
    { domain: "goauthorpitchdesk.com", liveMailboxes: 2 },
  ],
  billedQuantity: 5,
};

describe("B-2 — a re-derivable system message stops being owed once its condition resolves", () => {
  it("the Mordy walk lands where the design intended: owedCount 0, none_owed, seat_headroom_free PRESENT", async () => {
    const tenantId = await seedTenant(HEALTHY_FLEET);
    await emitRetrySetup(tenantId);

    const derived = await derive(tenantId);
    const signals = owedSignals(derived);

    expect(signals.owedCount).toBe(0);
    expect(signals.owedReasons).toEqual([]);
    expect(derived.status).toBe("none_owed");
    expect(derived.steps.find((s) => s.reason === "message_action_required")).toBeUndefined();
    expect(derived.steps.find((s) => s.reason === "seat_headroom_free")).toBeDefined();
  });

  it("STILL counts while the condition it describes genuinely holds", async () => {
    // Ordinal 1's DNS has not come up, so `domain_dns_incomplete` is owed from
    // STATE — the retry_setup row is describing something real and must stand.
    const tenantId = await seedTenant({
      ordinals: [
        { domain: "theauthorpitchdesk.com", liveMailboxes: 2 },
        { domain: "goauthorpitchdesk.com", liveMailboxes: 2, dnsReady: false },
      ],
      billedQuantity: 5,
    });
    await emitRetrySetup(tenantId);

    const derived = await derive(tenantId);
    expect(derived.status).toBe("owed");
    expect(owedSignals(derived).owedReasons).toContain("message_action_required");
    expect(owedSignals(derived).owedReasons).toContain("domain_dns_incomplete");
  });

  it("never silences a message the platform did NOT write about provisioning state", async () => {
    const tenantId = await seedTenant(HEALTHY_FLEET);
    await withTenantContext(tenantId, (ctx) =>
      emitTenantMessage(ctx, {
        kind: "mailbox_credentials",
        severity: "action_required",
        body: "A mailbox credential needs your attention.",
      }),
    );

    const derived = await derive(tenantId);
    expect(derived.status).toBe("owed");
    expect(owedSignals(derived).owedReasons).toContain("message_action_required");
  });

  it("honours an EXPIRED row — the operator's cheap resolution now reaches owedCount", async () => {
    const tenantId = await seedTenant(HEALTHY_FLEET);
    await withTenantContext(tenantId, (ctx) =>
      emitTenantMessage(ctx, {
        kind: "mailbox_credentials",
        severity: "action_required",
        body: "Already expired, and therefore invisible on every other surface.",
        expiresAt: realNowMs() - 1000,
      }),
    );

    expect((await derive(tenantId)).status).toBe("none_owed");
  });
});

describe("B-2 — the exclusion is banked durably, so operator surfaces stop showing a dead action item", () => {
  it("the ops fan-out expires the resolved row, and only that row", async () => {
    const tenantId = await seedTenant(HEALTHY_FLEET);
    await emitRetrySetup(tenantId);
    await withTenantContext(tenantId, (ctx) =>
      emitTenantMessage(ctx, {
        kind: "operator_reply",
        severity: "action_required",
        body: "A human wrote this; nothing re-derives it.",
        source: "operator",
      }),
    );

    expect((await messageRows(tenantId)).map((r) => r.expires_at)).toEqual([null, null]);
    await tenantStub(tenantId).opsSummary(realNowMs());

    const rows = await messageRows(tenantId);
    const retry = rows.find((r) => r.kind === "retry_setup");
    const human = rows.find((r) => r.kind === "operator_reply");
    expect(retry?.expires_at, "the re-derivable row is expired").not.toBeNull();
    expect(retry?.expires_at as number).toBeLessThanOrEqual(realNowMs());
    // ACK SEMANTICS ARE NOT TOUCHED: `read_at` keeps its single writer
    // (ackMessage), so an operator view never reads this as "the customer
    // acknowledged it".
    expect(retry?.read_at).toBeNull();
    expect(human?.expires_at, "a human-written action item is never expired by this").toBeNull();
  });

  it("does NOT expire a row whose condition still holds", async () => {
    const tenantId = await seedTenant({
      ordinals: [{ domain: "theauthorpitchdesk.com", liveMailboxes: 2, dnsReady: false }],
      billedQuantity: 5,
    });
    await emitRetrySetup(tenantId);
    await tenantStub(tenantId).opsSummary(realNowMs());
    expect((await messageRows(tenantId))[0]?.expires_at).toBeNull();
  });
});
