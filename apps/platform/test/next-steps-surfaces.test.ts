import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { NextSteps } from "@coldstart/shared";
import { isSetupProvisioningIncomplete } from "../src/engine/provisioning.js";
import { managedMailboxAddress } from "../src/engine/mailbox-provisioning.js";
import { domainIntentKey } from "../src/engine/provision-intents.js";
import { activatePaidPlan, api, mintTenant, seedBenignSdnList, tenantStub } from "./helpers.js";

// I8 — WIRING `nextSteps` INTO THE SEVEN RESPONSES (design §7.4).
//
// SEVEN, NOT EIGHT. The 502 `vendor_operator_blocked` row is DROPPED with a
// stated reason: `toErrorResponse` runs in the Worker's `app.onError` with only
// the error object and NO `ctx.sql`, so structured `nextSteps` there would mean
// deriving at throw time deep inside the saga. The body already states the next
// action in prose, which the vendor-truth wave shipped and this deferral does
// not regress.
//
// ADDITIVE ONLY. No existing field changes type, name or meaning — the whole
// point is that a caller reading `billing` or `jobId` today is untouched.

const BRAND = "Surfaces Co";
const PRIMARY_DOMAIN = "surfacesco.com";

function setupBody(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    brand: BRAND,
    primaryDomain: PRIMARY_DOMAIN,
    domains: 1,
    inboxesEach: 2,
    persona: "Sender",
    physicalAddress: "1 Main St",
    senderIdentity: "Sales Team",
    ...over,
  });
}

async function paidTenant(): Promise<{ tenantId: string; token: string }> {
  await seedBenignSdnList();
  const { tenantId, token } = await mintTenant(BRAND, "managed");
  await activatePaidPlan(tenantId, "managed");
  return { tenantId, token };
}

/** A tenant with live managed infrastructure, so the remove/launch surfaces have something to act on. */
async function provisionedTenant(liveMailboxes: number, billedQuantity = 5): Promise<{ tenantId: string; token: string }> {
  const { tenantId, token } = await paidTenant();
  await runInDurableObject(tenantStub(tenantId), (_i, state) => {
    const sql = state.storage.sql;
    sql.exec(
      `UPDATE tenant_profile SET primary_domain = ?, physical_address = ?, sender_identity = ?, mailbox_qty_synced = ?, register_domains = 1 WHERE id = ?`,
      PRIMARY_DOMAIN,
      "1 Main St",
      "Sales Team",
      billedQuantity,
      tenantId,
    );
    sql.exec(
      `INSERT INTO domain_intents (key, tenant_id, candidate_domain, status, persona_slug, inboxes_each, created_at, updated_at)
       VALUES (?, ?, 'surfaceslive.com', 'committed', 'sender', ?, 1000, ?)`,
      domainIntentKey(tenantId, 0),
      tenantId,
      liveMailboxes,
      Date.now(),
    );
    sql.exec(
      `INSERT INTO domains (id, tenant_id, domain, status, purchased_at, dns_status) VALUES (?, ?, 'surfaceslive.com', 'active', 1000, 'ready')`,
      `dom_surfaces_${tenantId}`,
      tenantId,
    );
    for (let slot = 0; slot < liveMailboxes; slot++) {
      const email = managedMailboxAddress("sender", "surfaceslive.com", 0, slot);
      sql.exec(
        `INSERT INTO mailboxes (id, tenant_id, domain_id, domain, email, daily_cap, warmup_started_at, created_at, provider)
         VALUES (?, ?, ?, 'surfaceslive.com', ?, 5, 1000, 1000, 'google')`,
        `mbx_${email}`,
        tenantId,
        `dom_surfaces_${tenantId}`,
        email,
      );
    }
  });
  return { tenantId, token };
}

function assertWellFormed(nextSteps: NextSteps | undefined): NextSteps {
  expect(nextSteps).toBeDefined();
  const value = nextSteps as NextSteps;
  expect(["owed", "none_owed"]).toContain(value.status);
  expect(Array.isArray(value.steps)).toBe(true);
  expect(value.computedAt).toBeGreaterThan(0);
  return value;
}

describe("I8 — the setup_infrastructure surfaces", () => {
  it("the TERMINAL 202 carries nextSteps alongside jobId and billing", async () => {
    const { token } = await paidTenant();
    const res = await api<{ jobId: string; billing: unknown; nextSteps?: NextSteps }>("/setup-infrastructure", {
      method: "POST",
      token,
      body: setupBody(),
    });
    expect(res.status).toBe(202);
    expect(res.body.jobId).toBeTruthy();
    expect(res.body.billing).toBeDefined();
    assertWellFormed(res.body.nextSteps);
  });

  it("the 200 quoteOnly preview carries the same guidance", async () => {
    const { token } = await paidTenant();
    const res = await api<{ quoteOnly: boolean; billing: unknown; nextSteps?: NextSteps }>("/setup-infrastructure", {
      method: "POST",
      token,
      body: setupBody({ quoteOnly: true }),
    });
    expect(res.status).toBe(200);
    expect(res.body.quoteOnly).toBe(true);
    assertWellFormed(res.body.nextSteps);
  });
});

describe("I8 — the poll surface", () => {
  it("infrastructure_status carries nextSteps beside messages[]", async () => {
    const { token } = await provisionedTenant(2);
    const res = await api<{ domains: number; messages: unknown[]; nextSteps?: NextSteps }>("/infrastructure-status", { token });
    expect(res.status).toBe(200);
    // Additive: everything that was there is still there.
    expect(res.body.domains).toBe(1);
    expect(Array.isArray(res.body.messages)).toBe(true);
    const nextSteps = assertWellFormed(res.body.nextSteps);
    // The floor-gap sentence — the one thing this tenant most wants to hear.
    expect(nextSteps.steps.map((s) => s.reason)).toContain("seat_headroom_free");
  });
});

describe("I8 — remove_mailboxes and launch_campaign", () => {
  it("remove_mailboxes carries nextSteps alongside its release counts", async () => {
    const { token } = await provisionedTenant(3);
    const res = await api<{ releasedCount: number; billing: unknown; nextSteps?: NextSteps }>("/remove-mailboxes", {
      method: "POST",
      token,
      body: JSON.stringify({ count: 1, acknowledged: true }),
    });
    expect(res.status).toBe(200);
    expect(res.body.releasedCount).toBe(1);
    expect(res.body.billing).toBeDefined();
    assertWellFormed(res.body.nextSteps);
  });

  it("launch_campaign carries nextSteps alongside its campaignId", async () => {
    const { token } = await provisionedTenant(2);
    const res = await api<{ campaignId: string; nextSteps?: NextSteps }>("/campaigns", {
      method: "POST",
      token,
      body: JSON.stringify({
        name: "Surfaces Launch",
        offer: "a genuinely useful thing",
        leads: [{ email: "lead@example.test", firstName: "Lee" }],
        sequence: [{ step: 1, subject: "Hello", body: "Body copy", delayDays: 0 }],
      }),
    });
    expect(res.status).toBe(201);
    expect(res.body.campaignId).toBeTruthy();
    assertWellFormed(res.body.nextSteps);
  });
});

describe("I8 — the terminality regression", () => {
  // `provisioning`'s PRESENCE means "still owes work", and
  // `isSetupProvisioningIncomplete` tests presence rather than enumerating
  // values. `nextSteps` is orthogonal metadata present on terminal AND
  // non-terminal outcomes alike, so it must NOT be read by that predicate —
  // otherwise every terminal setup response starts replaying as unfinished.
  it("a terminal { jobId, billing, nextSteps } still classifies COMPLETE", () => {
    const terminal = {
      jobId: "job_x",
      billing: { provisionedAfter: 5, projectedMonthlyCents: 3960, formula: "$49 platform + $10/mailbox, 5 minimum" },
      nextSteps: { status: "owed" as const, steps: [], computedAt: 1 },
    };
    expect(isSetupProvisioningIncomplete(terminal)).toBe(false);
  });

  it("a non-terminal outcome carrying nextSteps still classifies INCOMPLETE", () => {
    const pending = {
      jobId: "job_y",
      billing: { provisionedAfter: 2, projectedMonthlyCents: 3960, formula: "$49 platform + $10/mailbox, 5 minimum" },
      provisioning: "pending" as const,
      nextSteps: { status: "none_owed" as const, steps: [], computedAt: 1 },
    };
    expect(isSetupProvisioningIncomplete(pending)).toBe(true);
  });

  it("an `owed` nextSteps on a terminal outcome does not make it incomplete", () => {
    // The sharpest form: `status: "owed"` is exactly the value a shape-guessing
    // predicate would be tempted to read.
    const terminalButOwed = {
      jobId: "job_z",
      billing: { provisionedAfter: 2, projectedMonthlyCents: 3960, formula: "$49 platform + $10/mailbox, 5 minimum" },
      nextSteps: { status: "owed" as const, steps: [], computedAt: 1 },
    };
    expect(isSetupProvisioningIncomplete(terminalButOwed)).toBe(false);
  });
});
