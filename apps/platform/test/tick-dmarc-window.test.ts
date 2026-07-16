import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ONE_DAY_MS } from "../src/engine/warmup.js";
import { signup, tenantStub, withTenantContext } from "./helpers.js";

// SPEC.md §20.2 — the mandatory DMARC p=none observation window before first
// send. A domain's `first_send_eligible_at` (set at BYO intake) must exclude
// its mailboxes from the tick's capacity picker until the window elapses;
// NULL (every provisioned/non-gated domain) must never gate anything.

async function setupGatedDomainTenant(brand: string, contactEmail: string, domain: string, firstSendEligibleAt: number | null) {
  const { tenantId, token } = await signup(brand, contactEmail);
  await withTenantContext(tenantId, async (ctx) => {
    // CAN-SPAM fail-safe (tick.ts) requires these non-empty before ANY send
    // -- signup() alone leaves them blank (only setup_infrastructure sets
    // them normally); set directly so this test isolates the DMARC-window
    // gate, not the unrelated compliance guard.
    ctx.sql.exec(
      `UPDATE tenant_profile SET physical_address = '1 Test St', sender_identity = ? WHERE id = ?`,
      `Ops <o@${domain}>`,
      tenantId,
    );
    ctx.sql.exec(
      `INSERT INTO domains (id, tenant_id, domain, status, purchased_at, source, first_send_eligible_at)
       VALUES ('dom_gate_test', ?, ?, 'active', ?, 'byo', ?)`,
      tenantId,
      domain,
      ctx.clock.now(),
      firstSendEligibleAt,
    );
    ctx.sql.exec(
      `INSERT INTO mailboxes (id, tenant_id, domain_id, domain, email, daily_cap, sent_today, sent_today_epoch_day, status, warmup_started_at, created_at, poll_cursor)
       VALUES ('mbx_gate_test', ?, 'dom_gate_test', ?, ?, 40, 0, 0, 'active', ?, ?, -1)`,
      tenantId,
      domain,
      `ops@${domain}`,
      ctx.clock.now(),
      ctx.clock.now(),
    );
  });
  return { tenantId, token };
}

async function launchOneLead(tenantId: string, leadEmail: string): Promise<void> {
  await withTenantContext(tenantId, async (ctx) => {
    const now = ctx.clock.now();
    ctx.sql.exec(
      `INSERT INTO campaigns (id, tenant_id, name, status, sequence_json, stop_on_reply, send_window_json, timezone, created_at)
       VALUES ('camp_gate_test', ?, 'Gate Test', 'active', ?, 1, ?, 'UTC', ?)`,
      tenantId,
      JSON.stringify([{ step: 1, subject: "Hi", body: "Hi", delayDays: 0 }]),
      JSON.stringify({ startHour: 0, endHour: 23 }),
      now,
    );
    ctx.sql.exec(
      `INSERT INTO leads (id, tenant_id, campaign_id, email, first_name, company, global_status, created_at)
       VALUES ('lead_gate_test', ?, 'camp_gate_test', ?, 'Test', 'Co', 'active', ?)`,
      tenantId,
      leadEmail,
      now,
    );
    ctx.sql.exec(
      `INSERT INTO scheduled_sends (id, tenant_id, campaign_id, lead_id, step, variant, send_at, status, thread_id)
       VALUES ('ss_gate_test', ?, 'camp_gate_test', 'lead_gate_test', 1, 'a', ?, 'pending', 't_gate_test')`,
      tenantId,
      now,
    );
  });
}

describe("tick's DMARC p=none observation-window gate", () => {
  it("defers a due send whose domain's first_send_eligible_at is still in the future", async () => {
    const { tenantId } = await setupGatedDomainTenant(
      "Gate Future Co",
      "gate-future@example.com",
      "gate-future.com",
      Date.now() + 14 * ONE_DAY_MS, // 14 days out -- not yet eligible
    );
    await launchOneLead(tenantId, "target@leads-test.com");

    const tick = await tenantStub(tenantId).tick();
    expect(tick.sent).toBe(0);
    expect(tick.deferred).toBe(1);
  });

  it("sends once first_send_eligible_at has passed", async () => {
    const { tenantId } = await setupGatedDomainTenant(
      "Gate Past Co",
      "gate-past@example.com",
      "gate-past.com",
      Date.now() - ONE_DAY_MS, // already eligible
    );
    await launchOneLead(tenantId, "target2@leads-test.com");

    const tick = await tenantStub(tenantId).tick();
    expect(tick.sent).toBe(1);
  });

  it("never gates a domain with first_send_eligible_at = NULL (every existing/provisioned domain)", async () => {
    const { tenantId } = await setupGatedDomainTenant("Gate Null Co", "gate-null@example.com", "gate-null.com", null);
    await launchOneLead(tenantId, "target3@leads-test.com");

    const tick = await tenantStub(tenantId).tick();
    expect(tick.sent).toBe(1);
  });
});
