import { describe, expect, it } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import { WARMUP_RAMP_DAYS, ONE_DAY_MS } from "../src/engine/warmup.js";
import { activatePaidPlan, api, mintTenant, postWebhook, signup, tenantStub } from "./helpers.js";

interface WebhookResponse {
  applied: boolean;
  duplicate: boolean;
  frozen?: boolean;
}

function billingStateOf(tenantId: string): Promise<string> {
  return runInDurableObject(tenantStub(tenantId), async (_i, state) =>
    state.storage.sql
      .exec<{ billing_state: string }>(`SELECT billing_state FROM tenant_profile WHERE id = ?`, tenantId)
      .one().billing_state,
  );
}

async function provisionAndLaunch(token: string, brand = "Freeze Co", primaryDomain = "freeze-co.com"): Promise<void> {
  await api("/setup-infrastructure", {
    method: "POST",
    token,
    body: JSON.stringify({
      brand,
      primaryDomain,
      domains: 1,
      inboxesEach: 2,
      persona: "Sender",
      physicalAddress: "1 Freeze St",
      senderIdentity: `Sender <s@${primaryDomain}>`,
    }),
  });
  await api("/campaigns", {
    method: "POST",
    token,
    body: JSON.stringify({
      name: "Freeze campaign",
      offer: "x",
      leads: [{ email: "lead@freeze-leads.com", firstName: "L", company: "Co" }],
      sequence: [{ step: 1, subject: "Hi", body: "Hi", delayDays: 0 }],
    }),
  });
}

function disputeCreated(tenantId: string) {
  return {
    id: `evt_${crypto.randomUUID()}`,
    type: "charge.dispute.created",
    data: { object: { id: `dp_${crypto.randomUUID()}`, charge: "ch_1", amount: 9900, reason: "fraudulent", metadata: { tenantId } } },
  };
}

// Adversarial panel-03 finding #2 (LIVE-PROVEN): a chargeback freeze
// (billing_state='disputed') was silently lifted by routine
// checkout.session.completed / customer.subscription.updated(active) /
// invoice.payment_failed writes. 'disputed' is now sticky — only a won dispute
// exits it. Each case FAILS on the old code (old code flips back to
// active/past_due and the tick resumes sending).
describe("chargeback freeze is sticky against routine billing events (finding #2)", () => {
  it("checkout.session.completed does NOT lift a dispute freeze; tick still sends 0", async () => {
    const { tenantId, token } = await mintTenant("Freeze Co", "managed");
    await activatePaidPlan(tenantId, "managed");
    await provisionAndLaunch(token);

    const created = await postWebhook<WebhookResponse>(disputeCreated(tenantId));
    expect(created.body.frozen).toBe(true);
    expect(await billingStateOf(tenantId)).toBe("disputed");

    // A checkout completion arriving during the open dispute must NOT reactivate.
    await postWebhook({
      id: `evt_${crypto.randomUUID()}`,
      type: "checkout.session.completed",
      data: { object: { metadata: { tenantId, plan: "managed" } } },
    });
    expect(await billingStateOf(tenantId)).toBe("disputed"); // still frozen

    const tick = await tenantStub(tenantId).tick();
    expect(tick.sent).toBe(0);
  });

  it("customer.subscription.updated(active) does NOT lift a dispute freeze; tick still sends 0", async () => {
    const { tenantId, token } = await mintTenant("Freeze Sub Co", "managed");
    await activatePaidPlan(tenantId, "managed");
    await provisionAndLaunch(token, "Freeze Sub Co", "freezesub.com");

    await postWebhook<WebhookResponse>(disputeCreated(tenantId));
    expect(await billingStateOf(tenantId)).toBe("disputed");

    // A routine renewal event (subscription stays 'active' at Stripe during a dispute).
    await postWebhook({
      id: `evt_${crypto.randomUUID()}`,
      type: "customer.subscription.updated",
      data: { object: { status: "active", metadata: { tenantId } } },
    });
    expect(await billingStateOf(tenantId)).toBe("disputed"); // still frozen

    const tick = await tenantStub(tenantId).tick();
    expect(tick.sent).toBe(0);
  });

  it("invoice.payment_failed does NOT overwrite a dispute freeze with past_due", async () => {
    const { tenantId } = await mintTenant("Freeze Inv Co", "managed");
    await activatePaidPlan(tenantId, "managed");
    await postWebhook<WebhookResponse>(disputeCreated(tenantId));
    expect(await billingStateOf(tenantId)).toBe("disputed");

    await postWebhook({
      id: `evt_${crypto.randomUUID()}`,
      type: "invoice.payment_failed",
      data: { object: { metadata: { tenantId } } },
    });
    expect(await billingStateOf(tenantId)).toBe("disputed"); // not 'past_due'
  });
});

// Adversarial panel-03 finding #5 (LIVE-PROVEN): a canceled tenant kept full
// write access — setup_infrastructure / launchCampaign had no lifecycle guard
// and the tick freeze didn't cover canceled/canceling, so a canceled paid
// tenant re-provisioned + relaunched + (once armed) sent, all on a
// stopped-paying account. Each rejection FAILS on the old code (old code
// returns 202/201).
describe("a canceled tenant cannot re-provision, relaunch, or send (finding #5)", () => {
  it("cancel -> setup_infrastructure rejected, launch_campaign rejected, tick sends 0", async () => {
    const { tenantId, token } = await mintTenant("Canceled Write Co", "managed");
    await activatePaidPlan(tenantId, "managed");
    await provisionAndLaunch(token, "Canceled Write Co", "canceledwrite.com");

    // Immediate cancel -> billing_state='canceled'.
    const cancel = await api<{ billingState: string }>("/cancel", {
      method: "POST",
      token,
      body: JSON.stringify({ immediate: true }),
    });
    expect(cancel.body.billingState).toBe("canceled");

    // Re-provision attempt -> rejected (frozen), not 202.
    const setup = await api("/setup-infrastructure", {
      method: "POST",
      token,
      body: JSON.stringify({
        brand: "Canceled Write Co",
        primaryDomain: "canceledwrite.com",
        domains: 1,
        inboxesEach: 1,
        persona: "Sender",
        physicalAddress: "1 Canceled St",
        senderIdentity: "Sender <s@canceledwrite.com>",
      }),
    });
    expect(setup.status).toBe(400);

    // Relaunch attempt -> rejected (frozen), not 201.
    const launch = await api("/campaigns", {
      method: "POST",
      token,
      body: JSON.stringify({
        name: "Relaunch",
        offer: "x",
        leads: [{ email: "new@canceled-leads.com", firstName: "N", company: "Co" }],
        sequence: [{ step: 1, subject: "Hi", body: "Hi", delayDays: 0 }],
      }),
    });
    expect(launch.status).toBe(400);

    // Tick sends nothing.
    const tick = await tenantStub(tenantId).tick();
    expect(tick.sent).toBe(0);

    // Read routes still work (account reflects the canceled state).
    const account = await api<{ billingState: string }>("/account", { token });
    expect(account.status).toBe(200);
    expect(account.body.billingState).toBe("canceled");
  });
});

// Inject `sends` attributed 'sent' rows for one mailbox, the first `complaints`
// of which carry a matching complaint event (message-id join attributes them),
// so the domain's complaint rate crosses the burn threshold deterministically.
function injectBurningSends(sql: SqlStorage, tenantId: string, mailboxId: string, sends: number, complaints: number): void {
  for (let i = 0; i < sends; i++) {
    const msgId = `msg_burn_${mailboxId}_${i}`;
    const threadId = `t_burn_${mailboxId}_${i}`;
    sql.exec(
      `INSERT INTO scheduled_sends (id, tenant_id, campaign_id, lead_id, mailbox_id, step, variant, send_at, status, thread_id, message_id, sent_at)
       VALUES (?, ?, 'camp_burn', ?, ?, 1, 'a', 0, 'sent', ?, ?, 0)`,
      `ss_burn_${mailboxId}_${i}`,
      tenantId,
      `lead_burn_${mailboxId}_${i}`,
      mailboxId,
      threadId,
      msgId,
    );
    if (i < complaints) {
      sql.exec(
        `INSERT INTO events (id, tenant_id, campaign_id, lead_id, type, step, message_id, thread_id, ts, metadata_json)
         VALUES (?, ?, 'camp_burn', ?, 'complaint', 0, ?, ?, 0, '{}')`,
        `evt_burn_${mailboxId}_${i}`,
        tenantId,
        `lead_burn_${mailboxId}_${i}`,
        msgId,
        threadId,
      );
    }
  }
}

// Adversarial panel-03 finding #3: the standalone deliverabilitySweep() RPC +
// the cron lane bypassed the tick's freeze guard, so a frozen tenant's burning
// domain still triggered REPLACE_DOMAIN -> buys a new domain + mailboxes (real
// vendor spend). The guard now lives INSIDE runDeliverabilitySweep. FAILS on
// the old code (old code replaces the domain -> domainCount becomes 2).
describe("deliverabilitySweep is lifecycle-frozen (finding #3)", () => {
  it("a frozen tenant's burning domain triggers ZERO REPLACE_DOMAIN and buys no new domain", async () => {
    const { tenantId, token } = await signup("Sweep Freeze Co", "founder@sweepfreeze.com");
    await api("/setup-infrastructure", {
      method: "POST",
      token,
      body: JSON.stringify({
        brand: "Sweep Freeze Co",
        primaryDomain: "sweepfreeze.com",
        domains: 1,
        inboxesEach: 1,
        persona: "Ops",
        physicalAddress: "1 Sweep St",
        senderIdentity: "Ops <o@sweepfreeze.com>",
      }),
    });
    await tenantStub(tenantId).advanceClock((WARMUP_RAMP_DAYS + 1) * ONE_DAY_MS);

    // Inject a burning domain (12 sends, all complaints) AND freeze the tenant
    // (billing_state='canceled') — the exact state where the standalone sweep
    // used to spend on a REPLACE_DOMAIN.
    const before = await runInDurableObject(tenantStub(tenantId), async (_i, state) => {
      const mailbox = state.storage.sql.exec<{ id: string }>(`SELECT id FROM mailboxes`).one();
      injectBurningSends(state.storage.sql, tenantId, mailbox.id, 12, 12);
      state.storage.sql.exec(`UPDATE tenant_profile SET billing_state = 'canceled' WHERE id = ?`, tenantId);
      return { domainCount: state.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) as n FROM domains`).one().n };
    });
    expect(before.domainCount).toBe(1);

    // Call the STANDALONE sweep RPC directly (the cron lane's entry point).
    const sweep = await tenantStub(tenantId).deliverabilitySweep();
    expect(sweep.actions).toHaveLength(0);

    const after = await runInDurableObject(tenantStub(tenantId), async (_i, state) => ({
      domainCount: state.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) as n FROM domains`).one().n,
      replaceActions: state.storage.sql
        .exec<{ n: number }>(`SELECT COUNT(*) as n FROM deliverability_actions WHERE action = 'REPLACE_DOMAIN'`)
        .one().n,
      burningDomains: state.storage.sql
        .exec<{ n: number }>(`SELECT COUNT(*) as n FROM domains WHERE status = 'burning'`)
        .one().n,
    }));
    // No replacement domain bought, no REPLACE_DOMAIN action, domain untouched.
    expect(after.domainCount).toBe(1);
    expect(after.replaceActions).toBe(0);
    expect(after.burningDomains).toBe(0);
  });
});
