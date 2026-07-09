import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ONE_DAY_MS, WARMUP_RAMP_DAYS } from "../src/engine/warmup.js";
import { api, signup, tenantStub } from "./helpers.js";

interface CampaignResults {
  sent: number;
  reply: number;
  bounce: number;
}

// Signup + provision 1 mailbox + advance past warmup so the tenant can send.
async function setupReadyTenant(brand: string, primaryDomain: string) {
  const { tenantId, token } = await signup(brand, `founder@${primaryDomain}`);
  await api("/setup-infrastructure", {
    method: "POST",
    token,
    body: JSON.stringify({
      brand,
      primaryDomain,
      domains: 1,
      inboxesEach: 1,
      persona: "Sender",
      physicalAddress: "1 Test St",
      senderIdentity: `Sender <s@${primaryDomain}>`,
    }),
  });
  await tenantStub(tenantId).advanceClock((WARMUP_RAMP_DAYS + 1) * ONE_DAY_MS);
  return { tenantId, token };
}

const ONE_STEP = [{ step: 1, subject: "Hi", body: "Hi", delayDays: 0 }];

async function launch(token: string, name: string, email: string, extra: Record<string, unknown> = {}) {
  return api<{ campaignId: string }>("/campaigns", {
    method: "POST",
    token,
    body: JSON.stringify({
      name,
      offer: "x",
      leads: [{ email, firstName: "L", company: "Co" }],
      sequence: ONE_STEP,
      ...extra,
    }),
  });
}

// panel-02 correctness-engine: the tick only checked per-lead status, never the
// suppressions table, so a suppressed address in another campaign kept getting
// sent to. This FAILS on the old code (sends the suppressed address).
describe("tick honors the suppressions table at send time (finding #3)", () => {
  it("skips a due send whose address was suppressed after the campaign launched", async () => {
    const { tenantId, token } = await setupReadyTenant("Supp Co", "suppco.com");
    const email = "shared-target@leads-test.com";
    const launched = await launch(token, "Campaign B", email);

    // Simulate a suppression created after launch (e.g. another campaign's
    // bounce for the same address landed in the tenant-wide suppression list).
    await runInDurableObject(tenantStub(tenantId), async (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO suppressions (tenant_id, email, reason, ts) VALUES (?, ?, 'bounce', ?)`,
        tenantId,
        email,
        Date.now(),
      );
    });

    const tick = await tenantStub(tenantId).tick();
    expect(tick.sent).toBe(0);
    expect(tick.skipped).toBe(1);

    const results = await api<CampaignResults>(`/campaigns/${launched.body.campaignId}/results`, { token });
    expect(results.body.sent).toBe(0);
  });
});

// panel-02 correctness-engine: isWithinSendWindow was dead code; the tick sent
// at any hour. This FAILS on the old code (sends outside the window).
describe("tick enforces the campaign send window (finding #5)", () => {
  it("defers a send outside the window and sends one inside the window", async () => {
    const { tenantId } = await setupReadyTenant("Window Co", "windowco.com");

    await runInDurableObject(tenantStub(tenantId), async (instance, state) => {
      const { clock_base, clock_offset } = state.storage.sql
        .exec<{ clock_base: number; clock_offset: number }>(
          `SELECT clock_base, clock_offset FROM tenant_profile`,
        )
        .one();
      const currentHour = new Date(clock_base + clock_offset).getUTCHours();
      const excludedHour = (currentHour + 12) % 24; // a single-hour window that is NOT now

      // Campaign whose window excludes the current sim hour → must defer.
      await instance.launchCampaign({
        name: "windowed",
        offer: "x",
        leads: [{ email: "silent-window@leads-test.com", firstName: "S", company: "Co" }],
        sequence: ONE_STEP,
        timezone: "UTC",
        sendWindow: { startHour: excludedHour, endHour: excludedHour },
        stopOnReply: true,
      });
      const tick1 = await instance.tick();
      expect(tick1.sent).toBe(0);
      expect(tick1.deferred).toBe(1);

      // Control: a campaign whose window covers all hours sends immediately —
      // proving the window check isn't just blocking everything.
      await instance.launchCampaign({
        name: "open",
        offer: "x",
        leads: [{ email: "silent-open@leads-test.com", firstName: "O", company: "Co" }],
        sequence: ONE_STEP,
        timezone: "UTC",
        sendWindow: { startHour: 0, endHour: 23 },
        stopOnReply: true,
      });
      const tick2 = await instance.tick();
      expect(tick2.sent).toBe(1); // the open-window campaign sent
      expect(tick2.deferred).toBe(1); // the windowed campaign still deferred
    });
  });
});

// panel-02 correctness-engine: read-check-send-write was non-atomic, so a
// concurrent/retried tick could double-send + double-count. This FAILS on the
// old code (two sends, usage 4c) — the atomic claim makes it exactly one.
describe("tick claims each row atomically — no double-send on concurrent ticks (finding #6)", () => {
  it("processes a due row exactly once when two ticks race over it", async () => {
    const { tenantId, token } = await setupReadyTenant("Atomic Co", "atomicco.com");
    const launched = await launch(token, "Solo", "solo@leads-test.com");

    // Two ticks interleaved at the network await (direct in-process calls, so
    // they share the DO's SQLite and reproduce the race the real EmailPort's
    // fetch() would open).
    const [a, b] = await runInDurableObject(tenantStub(tenantId), async (instance) =>
      Promise.all([instance.tick(), instance.tick()]),
    );
    expect(a.sent + b.sent).toBe(1);

    const results = await api<CampaignResults>(`/campaigns/${launched.body.campaignId}/results`, { token });
    expect(results.body.sent).toBe(1);

    const account = await api<{ usageCents: number }>("/account", { token });
    expect(account.body.usageCents).toBe(2); // exactly one send billed, not two
  });
});

// panel-02 correctness-engine: 'sent'/cap/event were committed before
// recordUsage, and a recordUsage throw aborted the whole batch + lost usage.
// This FAILS on the old code (tick throws / leaves a sent-but-unbilled row).
describe("tick billing ordering — a recordUsage failure doesn't abort the batch (finding #7)", () => {
  it("retries only the failed row and never leaves a sent-but-unbilled row", async () => {
    const { tenantId } = await setupReadyTenant("Billing Co", "billingco.com");

    await runInDurableObject(tenantStub(tenantId), async (instance, state) => {
      // Two due rows in one batch.
      await instance.launchCampaign({
        name: "batch",
        offer: "x",
        leads: [
          { email: "batch-1@leads-test.com", firstName: "A", company: "Co" },
          { email: "batch-2@leads-test.com", firstName: "B", company: "Co" },
        ],
        sequence: ONE_STEP,
        timezone: "UTC",
        sendWindow: { startHour: 0, endHour: 23 },
        stopOnReply: true,
      });

      // Build adapters without sending, then inject a one-shot billing failure.
      await instance.infrastructureStatus();
      const billing = (instance as unknown as { adapters: { billing: Record<string, unknown> } }).adapters.billing;
      const orig = (billing.recordUsage as (...a: unknown[]) => Promise<unknown>).bind(billing);
      let calls = 0;
      billing.recordUsage = async (...args: unknown[]) => {
        calls += 1;
        if (calls === 1) throw new Error("sandbox injected billing failure");
        return orig(...args);
      };

      // Must NOT throw out of the batch.
      const tick = await instance.tick();
      expect(tick.sent).toBe(1);

      const one = (sql: string) => state.storage.sql.exec<{ n: number }>(sql).one().n;
      expect(one(`SELECT COUNT(*) as n FROM scheduled_sends WHERE status = 'sent'`)).toBe(1);
      expect(one(`SELECT COUNT(*) as n FROM scheduled_sends WHERE status = 'pending'`)).toBe(1); // reverted for retry
      expect(one(`SELECT COUNT(*) as n FROM ledger_entries WHERE kind = 'usage'`)).toBe(1);
      // The core invariant: no 'sent' row lacks its usage ledger entry.
      expect(
        one(
          `SELECT COUNT(*) as n FROM scheduled_sends ss
           WHERE ss.status = 'sent'
             AND NOT EXISTS (SELECT 1 FROM ledger_entries le WHERE le.source_send_id = ss.id AND le.kind = 'usage')`,
        ),
      ).toBe(0);
    });
  });
});
