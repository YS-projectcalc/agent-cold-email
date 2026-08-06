import { describe, expect, it } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import { activatePaidPlan, api, mintTenant, seedBenignSdnList, tenantStub } from "./helpers.js";

// WAVE 2 §1a — PER-MAILBOX SEND ELIGIBILITY.
//
// The defect this closes (adversary round-1, finding 1): a paid tenant that
// explored before paying holds real `mailboxes` rows created by the SANDBOX
// bundle. Nothing exists at any vendor for them, they never send, so their
// `sent_today` stays 0 forever — which makes them PERMANENTLY the least-loaded
// candidate `pickMailboxWithCapacity` sees. Armed, every due row in every tick
// would have been assigned to a phantom mailbox and drained to 'failed' while
// the real mailboxes sat idle.
//
// The eligibility rule is PLAN-gated, not adapter-gated, so these tests drive
// the tick directly against the sandbox bundle: for a paid tenant the same
// predicate runs either way, and the mailbox the tick CHOSE is recorded on the
// row (`scheduled_sends.mailbox_id`), which is the only observation that
// actually proves which one the picker picked.

interface SeedMailbox {
  email: string;
  provider: string;
  source?: string;
  releasedAt?: number;
  delivStatus?: string;
  pendingPush?: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Adds mailbox rows of arbitrary provenance to a tenant's existing domain. */
async function seedMailboxes(tenantId: string, mailboxes: SeedMailbox[]): Promise<void> {
  await runInDurableObject(tenantStub(tenantId), async (_i, state) => {
    const sql = state.storage.sql;
    const now = Date.now();
    const domainId = sql.exec<{ id: string }>(`SELECT id FROM domains WHERE tenant_id = ? LIMIT 1`, tenantId).one().id;
    const domain = sql.exec<{ domain: string }>(`SELECT domain FROM domains WHERE id = ?`, domainId).one().domain;
    for (const mb of mailboxes) {
      sql.exec(
        `INSERT INTO mailboxes
           (id, tenant_id, domain_id, domain, email, daily_cap, sent_today, sent_today_epoch_day, status,
            warmup_started_at, created_at, poll_cursor, source, provider, released_at, deliv_status)
         VALUES (?, ?, ?, ?, ?, 5, 0, ?, 'warming', ?, ?, -1, ?, ?, ?, ?)`,
        `mbx_${mb.email}`,
        tenantId,
        domainId,
        domain,
        mb.email,
        Math.floor(now / DAY_MS),
        now,
        now,
        mb.source ?? "provisioned",
        mb.provider,
        mb.releasedAt ?? null,
        mb.delivStatus ?? "healthy",
      );
      if (mb.pendingPush) {
        sql.exec(
          `INSERT INTO mailbox_cred_pushes (email, tenant_id, status, attempts, created_at, updated_at)
           VALUES (?, ?, 'pending', 0, ?, ?)`,
          mb.email,
          tenantId,
          now,
          now,
        );
      }
    }
  });
}

/** Removes the mailboxes `setup_infrastructure` created, so a test controls the whole fleet. */
async function clearProvisionedMailboxes(tenantId: string): Promise<void> {
  await runInDurableObject(tenantStub(tenantId), async (_i, state) => {
    state.storage.sql.exec(`DELETE FROM mailboxes WHERE tenant_id = ?`, tenantId);
  });
}

/** The mailbox EMAIL the tick assigned to each sent row — i.e. what the picker picked. */
async function sendingMailboxes(tenantId: string): Promise<string[]> {
  return runInDurableObject(tenantStub(tenantId), async (_i, state) =>
    state.storage.sql
      .exec<{ email: string }>(
        `SELECT m.email as email FROM scheduled_sends ss JOIN mailboxes m ON m.id = ss.mailbox_id
          WHERE ss.tenant_id = ? AND ss.status = 'sent'`,
        tenantId,
      )
      .toArray()
      .map((r) => r.email),
  );
}

async function paidTenantWithoutMailboxes(brand: string, domain: string, leads: number): Promise<{ tenantId: string; token: string }> {
  await seedBenignSdnList();
  const { tenantId, token } = await mintTenant(brand, "managed");
  await activatePaidPlan(tenantId, "managed");
  await api("/setup-infrastructure", {
    method: "POST",
    token,
    body: JSON.stringify({
      brand,
      primaryDomain: domain,
      domains: 1,
      inboxesEach: 1,
      persona: "Sender",
      physicalAddress: "1 Elig St",
      senderIdentity: `Sender <s@${domain}>`,
    }),
  });
  await clearProvisionedMailboxes(tenantId);
  await api("/campaigns", {
    method: "POST",
    token,
    body: JSON.stringify({
      name: `${brand} campaign`,
      offer: "x",
      leads: Array.from({ length: leads }, (_, i) => ({ email: `lead${i}@${domain}`, firstName: `L${i}`, company: "Co" })),
      sequence: [{ step: 1, subject: "Hi", body: "Hi", delayDays: 0 }],
    }),
  });
  return { tenantId, token };
}

describe("wave-2 §1a — a paid tenant sends only from an eligible mailbox", () => {
  it("excludes sandbox, retired, BYO, unclassified and pending-push rows; sends from the eligible one", async () => {
    const { tenantId } = await paidTenantWithoutMailboxes("Elig Co", "elig-co.test", 3);
    await seedMailboxes(tenantId, [
      // Every row below is HEALTHY and has capacity — the ONLY reason each is
      // skipped is its provenance. Ordered with the phantom first, which is
      // exactly the position that made it win every tie in the old picker.
      { email: "sandbox@elig-co.test", provider: "sandbox" },
      { email: "retired@elig-co.test", provider: "google", releasedAt: Date.now(), delivStatus: "paused" },
      { email: "byo@elig-co.test", provider: "byo", source: "byo_connected" },
      { email: "unclassified@elig-co.test", provider: "" },
      { email: "waiting@elig-co.test", provider: "google", pendingPush: true },
      { email: "real@elig-co.test", provider: "google" },
    ]);

    const tick = await tenantStub(tenantId).tick();
    expect(tick.sent).toBe(3);
    // All three rows went out through the ONE eligible mailbox.
    expect(await sendingMailboxes(tenantId)).toEqual(["real@elig-co.test", "real@elig-co.test", "real@elig-co.test"]);
  });

  it("one pending-push mailbox costs ONLY its own capacity — the rest keep sending", async () => {
    // This is the round-1 finding-3 fix: the guard used to be whole-TENANT, so
    // a single un-grantable mailbox held every send at zero, indefinitely and
    // silently. Per-mailbox means N-1 mailboxes carry on.
    const { tenantId } = await paidTenantWithoutMailboxes("Starve Co", "starve-co.test", 4);
    await seedMailboxes(tenantId, [
      { email: "waiting@starve-co.test", provider: "google", pendingPush: true },
      { email: "ready-a@starve-co.test", provider: "google" },
      { email: "ready-b@starve-co.test", provider: "google" },
    ]);

    const tick = await tenantStub(tenantId).tick();
    expect(tick.sent).toBe(4);
    const used = await sendingMailboxes(tenantId);
    expect(used).not.toContain("waiting@starve-co.test");
    expect(new Set(used)).toEqual(new Set(["ready-a@starve-co.test", "ready-b@starve-co.test"]));
  });

  it("the N4-shaped row — a live mailbox whose push can NEVER be granted — sits inert, not fatal", async () => {
    // ROADMAP N4: a billable row with no vendor mailbox behind it. Its
    // credential push can never succeed by construction, so under the old
    // whole-tenant guard it starved the tenant FOREVER. Now it is one excluded
    // mailbox and everything else proceeds.
    const { tenantId } = await paidTenantWithoutMailboxes("N4 Co", "n4-co.test", 2);
    await seedMailboxes(tenantId, [
      { email: "phantom@n4-co.test", provider: "google", pendingPush: true },
      { email: "real@n4-co.test", provider: "google" },
    ]);
    expect((await tenantStub(tenantId).tick()).sent).toBe(2);
    expect(await sendingMailboxes(tenantId)).toEqual(["real@n4-co.test", "real@n4-co.test"]);
  });

  it("a mailbox with NO push row at all stays eligible — the operator static-config path", async () => {
    // The polarity is NOT-pending, never requires-'pushed': the engine resolves
    // credentials from its static config OR the pushed store, and the Worker
    // cannot see the config half. Requiring a 'pushed' row would bench exactly
    // the mailboxes an operator wired by hand in an emergency.
    const { tenantId } = await paidTenantWithoutMailboxes("Static Co", "static-co.test", 1);
    await seedMailboxes(tenantId, [{ email: "static@static-co.test", provider: "google" }]);
    expect((await tenantStub(tenantId).tick()).sent).toBe(1);
    expect(await sendingMailboxes(tenantId)).toEqual(["static@static-co.test"]);
  });

  it("a tenant whose every mailbox is ineligible DEFERS — rows stay 'pending', attempts unburnt", async () => {
    // Never burn the 5-attempt cap against a mailbox we already know isn't
    // ready: a deferred row is recoverable, a 'failed' one is not.
    const { tenantId } = await paidTenantWithoutMailboxes("Defer Co", "defer-co.test", 2);
    await seedMailboxes(tenantId, [
      { email: "sandbox@defer-co.test", provider: "sandbox" },
      { email: "waiting@defer-co.test", provider: "google", pendingPush: true },
    ]);

    const tick = await tenantStub(tenantId).tick();
    expect(tick.sent).toBe(0);
    expect(tick.deferred).toBe(2);
    const rows = await runInDurableObject(tenantStub(tenantId), async (_i, state) =>
      state.storage.sql
        .exec<{ status: string; attempts: number }>(`SELECT status, attempts FROM scheduled_sends WHERE tenant_id = ?`, tenantId)
        .toArray(),
    );
    expect(rows.map((r) => r.status)).toEqual(["pending", "pending"]);
    expect(rows.map((r) => r.attempts)).toEqual([0, 0]);
  });

  it("a DEMO tenant's picker is byte-identical — sandbox mailboxes still send", async () => {
    // Regression guard: the provenance clauses are paid-only. A demo tenant's
    // entire fleet is provider='sandbox' by construction, so applying them to
    // demo would break every demo run on the platform.
    await seedBenignSdnList();
    const { tenantId, token } = await mintTenant("Demo Elig", "demo");
    await api("/setup-infrastructure", {
      method: "POST",
      token,
      body: JSON.stringify({
        brand: "Demo Elig",
        primaryDomain: "demo-elig.test",
        domains: 1,
        inboxesEach: 1,
        persona: "Sender",
        physicalAddress: "1 Demo St",
        senderIdentity: "Sender <s@demo-elig.test>",
      }),
    });
    await api("/campaigns", {
      method: "POST",
      token,
      body: JSON.stringify({
        name: "Demo campaign",
        offer: "x",
        leads: [{ email: "lead@demo-elig.test", firstName: "L", company: "Co" }],
        sequence: [{ step: 1, subject: "Hi", body: "Hi", delayDays: 0 }],
      }),
    });

    const provider = await runInDurableObject(tenantStub(tenantId), async (_i, state) =>
      state.storage.sql.exec<{ provider: string }>(`SELECT provider FROM mailboxes WHERE tenant_id = ?`, tenantId).toArray(),
    );
    expect(provider.map((p) => p.provider)).toEqual(["sandbox"]); // the port's honest answer, now recorded
    expect((await tenantStub(tenantId).tick()).sent).toBe(1);
  });
});

describe("wave-2 R4 — the alert and the picker share ONE predicate", () => {
  it("opsSummary's eligible count equals the set the picker actually sends from", async () => {
    // Two hand-maintained copies drift, and the drift mode is the worst one
    // available: the alert reports capacity while the picker finds none — a
    // silent zero-send with the alarm asleep. One fixture holding one row of
    // EVERY class is what makes a drift visible.
    const { tenantId } = await paidTenantWithoutMailboxes("Shared Co", "shared-co.test", 2);
    await seedMailboxes(tenantId, [
      { email: "sandbox@shared-co.test", provider: "sandbox" },
      { email: "retired@shared-co.test", provider: "google", releasedAt: Date.now(), delivStatus: "paused" },
      { email: "byo@shared-co.test", provider: "byo", source: "byo_connected" },
      { email: "waiting@shared-co.test", provider: "google", pendingPush: true },
      { email: "real-a@shared-co.test", provider: "google" },
      { email: "real-b@shared-co.test", provider: "google" },
    ]);

    const summary = await tenantStub(tenantId).opsSummary(0);
    expect(summary.sendPipeline.eligibleMailboxes).toBe(2);

    await tenantStub(tenantId).tick();
    const used = new Set(await sendingMailboxes(tenantId));
    expect(used).toEqual(new Set(["real-a@shared-co.test", "real-b@shared-co.test"]));
    // The number the ALERT would report and the number of mailboxes the PICKER
    // is willing to use are the same number, from the same SQL.
    expect(summary.sendPipeline.eligibleMailboxes).toBe(used.size);
  });

  it("reports ZERO eligible mailboxes for a tenant the picker cannot serve", async () => {
    const { tenantId } = await paidTenantWithoutMailboxes("Zero Co", "zero-co.test", 1);
    await seedMailboxes(tenantId, [{ email: "sandbox@zero-co.test", provider: "sandbox" }]);
    const summary = await tenantStub(tenantId).opsSummary(0);
    expect(summary.sendPipeline.eligibleMailboxes).toBe(0);
    expect(summary.sendPipeline.dueNonDemoPendingSends).toBe(1);
    expect((await tenantStub(tenantId).tick()).sent).toBe(0);
  });
});

describe("wave-2 §9-U2 — the pre-arm provenance read", () => {
  it("opsSummary lists every mailbox with the columns the arm-verification runbook checks", async () => {
    const { tenantId } = await paidTenantWithoutMailboxes("Provenance Co", "provenance-co.test", 1);
    const releasedAt = Date.now();
    await seedMailboxes(tenantId, [
      { email: "real@provenance-co.test", provider: "google" },
      { email: "old@provenance-co.test", provider: "sandbox", releasedAt, delivStatus: "paused" },
      { email: "byo@provenance-co.test", provider: "byo", source: "byo_connected" },
    ]);

    const rows = (await tenantStub(tenantId).opsSummary(0)).mailboxProvenance;
    const byEmail = new Map(rows.map((r) => [r.email, r]));
    expect(byEmail.get("real@provenance-co.test")).toMatchObject({ provider: "google", source: "provisioned", released_at: null });
    expect(byEmail.get("old@provenance-co.test")).toMatchObject({ provider: "sandbox", released_at: releasedAt });
    expect(byEmail.get("byo@provenance-co.test")).toMatchObject({ provider: "byo", source: "byo_connected" });
    for (const row of rows) expect(typeof row.warmup_started_at).toBe("number");
  });
});
