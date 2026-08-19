import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { NextSteps } from "@coldstart/shared";
import { realNowMs } from "../src/engine/clamped-age.js";
import { deriveNextSteps, owedSignals } from "../src/engine/next-steps.js";
import { managedMailboxAddress } from "../src/engine/mailbox-provisioning.js";
import { DEFAULT_PROVISIONING_ORPHAN_GRACE_MS } from "../src/engine/ops-summary.js";
import { domainIntentKey } from "../src/engine/provision-intents.js";
import { emitTenantMessage, pruneTenantMessages, READ_RETENTION_MS } from "../src/engine/tenant-messages.js";
import { activatePaidPlan, mintTenant, seedBenignSdnList, tenantStub, withTenantContext } from "./helpers.js";

// THE ROUND-2 BLOCKING (docs/adversarial/customer-continuity-build-gate-r2-
// 2026-08-19.md) — the B2 auto-expiry SILENCES and then DELETES a live
// `retry_setup` action item.
//
// THE STATE IT MISSES. `provisionMailboxesForDomain` runs a domain's mailbox
// slots through `forEachIsolated` and rethrows only after every slot has had
// its chance, so a retryable vendor failure leaves: intent 'committed', the
// `domains` row written, DNS 'ready', and SOME of the slots persisted. Against
// that state none of the four setup-family reasons fired — `ordinal_incomplete`
// needs `live === null`, `domain_dns_incomplete` needs a non-ready DNS,
// `paid_seats_unprovisioned` needs `billable === 0`, `setup_capacity_held`
// needs `capacity_pending` — so `setupFamilyOwed` was false, the `retry_setup`
// row was re-derived as RESOLVED, `expires_at` was banked on the 5-minute ops
// fan-out, and the deliverability sweep's prune then DELETED the only durable
// record of work the customer still has to redo. The same `owedCount === 0`
// disarmed `seat_headroom_free`'s E1 guard, the `customer_progress_*` checks
// and the one-shot nudge.
//
// THE FIX, in three parts, one per describe block below:
//   1. `ordinal_slot_shortfall` — the missing owed reason, derived from the
//      ordinal's own persisted ask (`domain_intents.inboxes_each`) against the
//      deterministic slot addresses `planFor` uses, so the family predicate is
//      true BY COVERAGE rather than by luck.
//   2. A MIN-AGE guard on the durable expiry: a row younger than the
//      provisioning orphan grace cannot be banked, so a `dangling` ordinal
//      inside its own 30-minute grace no longer loses the race to the 5-minute
//      sweep.
//   3. Expired rows get the SAME retention grace read rows already have, so an
//      expiry mistake is recoverable and the audit trail survives it.

let seq = 0;

interface Ordinal {
  domain: string;
  /** Slots this ordinal ACTUALLY holds (contiguous from 0). */
  liveMailboxes: number;
  /** `domain_intents.inboxes_each` — what the provisioning call ASKED for. Defaults to `liveMailboxes` (a finished ordinal). */
  requestedSlots?: number | null;
  status?: string;
  noDomainRow?: boolean;
  dnsReady?: boolean;
  source?: string;
  updatedAt?: number;
}

interface Seed {
  ordinals: Ordinal[];
  billedQuantity?: number;
}

const PERSONA = "mordytee";

async function seedTenant(seed: Seed): Promise<string> {
  const { tenantId } = await mintTenant(`Slot Shortfall Co ${++seq}`, "managed");
  await seedBenignSdnList();
  await activatePaidPlan(tenantId, "managed");
  const now = Date.now();
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
      const requested = ord.requestedSlots === undefined ? Math.max(1, ord.liveMailboxes) : ord.requestedSlots;
      sql.exec(
        `INSERT INTO domain_intents (key, tenant_id, candidate_domain, status, persona_slug, inboxes_each, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        domainIntentKey(tenantId, ordinal),
        tenantId,
        ord.domain,
        ord.status ?? "committed",
        requested === null ? null : PERSONA,
        requested,
        1000,
        ord.updatedAt ?? now - DEFAULT_PROVISIONING_ORPHAN_GRACE_MS * 10,
      );
      if (ord.noDomainRow) return;
      const domainId = `dom_${ordinal}_${tenantId}`;
      sql.exec(
        `INSERT INTO domains (id, tenant_id, domain, status, purchased_at, dns_status, source)
         VALUES (?, ?, ?, 'active', ?, ?, ?)`,
        domainId,
        tenantId,
        ord.domain,
        1000,
        ord.dnsReady === false ? "pending" : "ready",
        ord.source ?? "provisioned",
      );
      for (let slot = 0; slot < ord.liveMailboxes; slot++) {
        const email = managedMailboxAddress(PERSONA, ord.domain, ordinal, slot);
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

/** The gate's live row, verbatim in shape: the `action_required` emit at provisioning.ts:820-831. */
async function emitRetrySetup(tenantId: string, domain: string): Promise<void> {
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

function messageRows(tenantId: string): Promise<{ id: string; kind: string; expires_at: number | null }[]> {
  return withTenantContext(tenantId, (ctx) =>
    ctx.sql
      .exec<{ id: string; kind: string; expires_at: number | null }>(
        `SELECT id, kind, expires_at FROM tenant_messages WHERE tenant_id = ? ORDER BY rowid`,
        ctx.tenantId,
      )
      .toArray(),
  );
}

/** The post-slot-failure state: ordinal 0 asked for 3, holds 2; ordinal 1 finished. Billed 5, DNS ready everywhere. */
const SLOT_SHORTFALL_FLEET: Seed = {
  ordinals: [
    { domain: "theauthorpitchdesk.com", liveMailboxes: 2, requestedSlots: 3 },
    { domain: "goauthorpitchdesk.com", liveMailboxes: 2 },
  ],
  billedQuantity: 5,
};

describe("R2-BLOCKING part 1 — a live ordinal short of its requested slots is OWED", () => {
  it("the post-slot-failure state derives ordinal_slot_shortfall, owed", async () => {
    const tenantId = await seedTenant(SLOT_SHORTFALL_FLEET);
    const derived = await derive(tenantId);
    const step = derived.steps.find((s) => s.reason === "ordinal_slot_shortfall");

    expect(step, "a live, DNS-ready ordinal holding 2 of the 3 slots it asked for is owed work").toBeDefined();
    expect(step?.kind).toBe("owed");
    expect(step?.action.via).toBe("mcp_tool");
    expect(derived.status).toBe("owed");
    expect(owedSignals(derived).owedReasons).toContain("ordinal_slot_shortfall");
  });

  it("`seat_headroom_free` is SUPPRESSED — the account is never told 'nothing is required' in this state", async () => {
    const tenantId = await seedTenant(SLOT_SHORTFALL_FLEET);
    const derived = await derive(tenantId);
    expect(derived.steps.find((s) => s.reason === "seat_headroom_free")).toBeUndefined();
  });

  it("a live `retry_setup` row is NOT re-derived as resolved, and the ops fan-out does NOT expire it", async () => {
    const tenantId = await seedTenant(SLOT_SHORTFALL_FLEET);
    await emitRetrySetup(tenantId, "theauthorpitchdesk.com");

    // It still counts: the condition the message describes genuinely holds.
    expect(owedSignals(await derive(tenantId)).owedReasons).toContain("message_action_required");

    await tenantStub(tenantId).opsSummary(realNowMs());
    const rows = await messageRows(tenantId);
    expect(rows.find((r) => r.kind === "retry_setup")?.expires_at, "the row describes real outstanding work").toBeNull();
  });

  it("a genuinely FINISHED fleet (live === requested on every ordinal) derives no shortfall — the guard is not vacuous", async () => {
    const tenantId = await seedTenant({
      ordinals: [
        { domain: "fin0.com", liveMailboxes: 3, requestedSlots: 3 },
        { domain: "fin1.com", liveMailboxes: 2, requestedSlots: 2 },
      ],
      billedQuantity: 5,
    });
    const derived = await derive(tenantId);
    expect(derived.steps.find((s) => s.reason === "ordinal_slot_shortfall")).toBeUndefined();
    expect(owedSignals(derived).owedCount).toBe(0);
  });

  it("a legacy NULL-spec ordinal ABSTAINS rather than guessing an ask it has no record of", async () => {
    const tenantId = await seedTenant({
      ordinals: [{ domain: "legacy0.com", liveMailboxes: 2, requestedSlots: null }],
      billedQuantity: 5,
    });
    expect((await derive(tenantId)).steps.find((s) => s.reason === "ordinal_slot_shortfall")).toBeUndefined();
  });

  it("an ordinal whose DNS has not come up is `domain_dns_incomplete`'s, not this one's — one blocker, one sentence", async () => {
    const tenantId = await seedTenant({
      ordinals: [{ domain: "dnspending.com", liveMailboxes: 0, requestedSlots: 3, dnsReady: false }],
      billedQuantity: 5,
    });
    const derived = await derive(tenantId);
    expect(derived.steps.find((s) => s.reason === "domain_dns_incomplete")).toBeDefined();
    expect(derived.steps.find((s) => s.reason === "ordinal_slot_shortfall")).toBeUndefined();
  });

  it("a BYO ordinal is never told to buy a managed lookalike — the shortfall is scoped to provisioned domains", async () => {
    const tenantId = await seedTenant({
      ordinals: [{ domain: "byoshort.com", liveMailboxes: 1, requestedSlots: 3, source: "byo" }],
      billedQuantity: 5,
    });
    expect((await derive(tenantId)).steps.find((s) => s.reason === "ordinal_slot_shortfall")).toBeUndefined();
  });
});

describe("R2-BLOCKING part 2 — the durable expiry cannot outrun the orphan grace", () => {
  it("a `dangling` ordinal INSIDE its grace window keeps its message: the 5-minute sweep does not expire it", async () => {
    const tenantId = await seedTenant({
      ordinals: [
        { domain: "grace0.com", liveMailboxes: 2 },
        { domain: "grace1.com", liveMailboxes: 0, status: "dangling", noDomainRow: true, updatedAt: Date.now() - 1000 },
      ],
      billedQuantity: 5,
    });
    await emitRetrySetup(tenantId, "grace1.com");

    // Inside the grace, `ordinal_incomplete` has not matured — this is exactly
    // the window the sweep used to win.
    expect((await derive(tenantId)).steps.find((s) => s.reason === "ordinal_incomplete")).toBeUndefined();

    await tenantStub(tenantId).opsSummary(realNowMs());
    expect(
      (await messageRows(tenantId)).find((r) => r.kind === "retry_setup")?.expires_at,
      "a row younger than the orphan grace is never banked as resolved",
    ).toBeNull();
  });

  it("once the grace opens the reason fires and the SURVIVING row counts again", async () => {
    const tenantId = await seedTenant({
      ordinals: [
        { domain: "grace2.com", liveMailboxes: 2 },
        { domain: "grace3.com", liveMailboxes: 0, status: "dangling", noDomainRow: true },
      ],
      billedQuantity: 5,
    });
    await emitRetrySetup(tenantId, "grace3.com");
    await tenantStub(tenantId).opsSummary(realNowMs());

    const reasons = owedSignals(await derive(tenantId)).owedReasons;
    expect(reasons).toContain("ordinal_incomplete");
    expect(reasons).toContain("message_action_required");
    expect((await messageRows(tenantId)).find((r) => r.kind === "retry_setup")?.expires_at).toBeNull();
  });

  it("an `operator_pending` row is untouched — the control the severity scoping exists for", async () => {
    const tenantId = await seedTenant({
      ordinals: [{ domain: "opctl.com", liveMailboxes: 2 }],
      billedQuantity: 5,
    });
    await withTenantContext(tenantId, (ctx) =>
      emitTenantMessage(ctx, {
        kind: "setup_failed",
        severity: "operator_pending",
        body: "The platform has stopped on a step only an operator can clear.",
      }),
    );
    await tenantStub(tenantId).opsSummary(realNowMs());
    expect((await messageRows(tenantId))[0]?.expires_at).toBeNull();
  });

  it("a resolved row PAST the grace is still banked — the guard delays the expiry, it does not remove it", async () => {
    const tenantId = await seedTenant({
      ordinals: [
        { domain: "banked0.com", liveMailboxes: 2 },
        { domain: "banked1.com", liveMailboxes: 2 },
      ],
      billedQuantity: 5,
    });
    await emitRetrySetup(tenantId, "banked1.com");
    // Age the row past the grace without waiting for it.
    await withTenantContext(tenantId, (ctx) =>
      ctx.sql.exec(
        `UPDATE tenant_messages SET created_at = ? WHERE tenant_id = ?`,
        ctx.clock.now() - DEFAULT_PROVISIONING_ORPHAN_GRACE_MS * 2,
        ctx.tenantId,
      ),
    );

    await tenantStub(tenantId).opsSummary(realNowMs());
    expect((await messageRows(tenantId))[0]?.expires_at).not.toBeNull();
  });
});

describe("R2-BLOCKING part 3 — an expired row survives long enough for the mistake to be caught", () => {
  it("a just-expired row is NOT deleted by the prune sweep", async () => {
    const tenantId = await seedTenant({ ordinals: [{ domain: "prune0.com", liveMailboxes: 2 }], billedQuantity: 5 });
    await withTenantContext(tenantId, (ctx) =>
      emitTenantMessage(ctx, {
        kind: "retry_setup",
        severity: "action_required",
        body: "expired one second ago",
        expiresAt: ctx.clock.now() - 1000,
      }),
    );
    await withTenantContext(tenantId, (ctx) => pruneTenantMessages(ctx));
    expect((await messageRows(tenantId)).length, "the audit trail outlives the expiry decision").toBe(1);
  });

  it("a row expired past the retention window IS deleted — the sweep is still bounded", async () => {
    const tenantId = await seedTenant({ ordinals: [{ domain: "prune1.com", liveMailboxes: 2 }], billedQuantity: 5 });
    await withTenantContext(tenantId, (ctx) =>
      emitTenantMessage(ctx, {
        kind: "retry_setup",
        severity: "action_required",
        body: "expired long ago",
        expiresAt: ctx.clock.now() - READ_RETENTION_MS - 1000,
      }),
    );
    await withTenantContext(tenantId, (ctx) => pruneTenantMessages(ctx));
    expect((await messageRows(tenantId)).length).toBe(0);
  });
});
