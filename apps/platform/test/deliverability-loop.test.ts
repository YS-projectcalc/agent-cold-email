import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ONE_DAY_MS, WARMUP_RAMP_DAYS } from "../src/engine/warmup.js";
import { api, signup, tenantStub } from "./helpers.js";

// Integration tests for the B6 deliverability control loop driven through the
// real DO: setup -> warm -> (fault) -> tick runs the sweep BEFORE scheduling ->
// throttle/pause/rotate/replace. The headline test uses the genuine
// send/poll/reply-processor pipe (complaint-tagged recipients); the controlled
// tests inject attributed sent/complaint/bounce rows directly (same technique
// tick-correctness.test.ts uses for suppressions) so per-mailbox rates are
// deterministic without fighting the load-balancing send picker.

const ONE_STEP = [{ step: 1, subject: "Hi", body: "Hi", delayDays: 0 }];

async function setupTenant(brand: string, primaryDomain: string, domains: number, inboxesEach: number) {
  const { tenantId, token } = await signup(brand, `founder@${primaryDomain}`);
  await api("/setup-infrastructure", {
    method: "POST",
    token,
    body: JSON.stringify({
      brand,
      primaryDomain,
      domains,
      inboxesEach,
      persona: "Ops",
      physicalAddress: "1 Test St",
      senderIdentity: `Ops <o@${primaryDomain}>`,
    }),
  });
  await tenantStub(tenantId).advanceClock((WARMUP_RAMP_DAYS + 1) * ONE_DAY_MS);
  return { tenantId, token };
}

async function launch(token: string, name: string, leads: { email: string; firstName: string; company: string }[]) {
  return api<{ campaignId: string }>("/campaigns", {
    method: "POST",
    token,
    body: JSON.stringify({ name, offer: "x", leads, sequence: ONE_STEP, stopOnReply: true }),
  });
}

// Inserts `sends` attributed 'sent' rows for one mailbox, of which the first
// `bounces` carry a matching bounce event and the next `complaints` carry a
// matching complaint event (message ids match, so gatherMailboxHealth's
// message-id join attributes each to this exact mailbox).
function injectSends(
  sql: SqlStorage,
  tenantId: string,
  mailboxId: string,
  spec: { sends: number; bounces: number; complaints: number },
): void {
  for (let i = 0; i < spec.sends; i++) {
    const msgId = `msg_inj_${mailboxId}_${i}`;
    const threadId = `t_inj_${mailboxId}_${i}`;
    sql.exec(
      `INSERT INTO scheduled_sends (id, tenant_id, campaign_id, lead_id, mailbox_id, step, variant, send_at, status, thread_id, message_id, sent_at)
       VALUES (?, ?, 'camp_inj', ?, ?, 1, 'a', 0, 'sent', ?, ?, 0)`,
      `ss_inj_${mailboxId}_${i}`,
      tenantId,
      `lead_inj_${mailboxId}_${i}`,
      mailboxId,
      threadId,
      msgId,
    );
    if (i < spec.bounces) {
      sql.exec(
        `INSERT INTO events (id, tenant_id, campaign_id, lead_id, type, step, message_id, thread_id, ts, metadata_json)
         VALUES (?, ?, 'camp_inj', ?, 'bounce', 0, ?, ?, 0, '{}')`,
        `evt_inj_b_${mailboxId}_${i}`,
        tenantId,
        `lead_inj_${mailboxId}_${i}`,
        msgId,
        threadId,
      );
    } else if (i < spec.bounces + spec.complaints) {
      sql.exec(
        `INSERT INTO events (id, tenant_id, campaign_id, lead_id, type, step, message_id, thread_id, ts, metadata_json)
         VALUES (?, ?, 'camp_inj', ?, 'complaint', 0, ?, ?, 0, '{}')`,
        `evt_inj_c_${mailboxId}_${i}`,
        tenantId,
        `lead_inj_${mailboxId}_${i}`,
        msgId,
        threadId,
      );
    }
  }
}

interface DeliverabilityAccount {
  deliverability: {
    pausedMailboxes: number;
    throttledMailboxes: number;
    burningDomains: number;
    domainsReplaced: number;
    recentActions: { action: string; target: string }[];
  };
}

describe("B6 deliverability loop — end-to-end through the real send/poll pipe", () => {
  it("injected complaints PAUSE the mailbox, BURN + REPLACE the domain, and ROTATE pending sends to the replacement", async () => {
    const { tenantId, token } = await setupTenant("Burnco", "burnco.com", 1, 1);

    const before = await runInDurableObject(tenantStub(tenantId), async (_i, state) => ({
      mailbox: state.storage.sql.exec<{ id: string; email: string; domain: string }>(`SELECT id, email, domain FROM mailboxes`).one(),
      domain: state.storage.sql.exec<{ id: string; domain: string }>(`SELECT id, domain FROM domains`).one(),
    }));

    // 12 complaint leads (>= minSampleSends) through the genuine pipe.
    const complaintLeads = Array.from({ length: 12 }, (_, i) => ({ email: `complaint${i}@leads-test.com`, firstName: `C${i}`, company: "Co" }));
    await launch(token, "Complaint blast", complaintLeads);
    const tick1 = await tenantStub(tenantId).tick();
    expect(tick1.sent).toBe(12);
    const poll = await tenantStub(tenantId).pollInbox();
    expect(poll.complaints).toBe(12);

    // Pending sends that must rotate off the burning domain.
    const silentLeads = Array.from({ length: 6 }, (_, i) => ({ email: `silent${i}@leads-test.com`, firstName: `S${i}`, company: "Co" }));
    const camp2 = await launch(token, "Silent", silentLeads);

    // The sweep runs at the top of this tick -> domain burns, mailbox pauses,
    // replacement provisioned; then the send loop routes the pending sends to
    // the (warming, cap-5) replacement mailbox.
    const tick2 = await tenantStub(tenantId).tick();

    const after = await runInDurableObject(tenantStub(tenantId), async (_i, state) => {
      const sql = state.storage.sql;
      return {
        burningDomain: sql.exec<{ status: string }>(`SELECT status FROM domains WHERE id = ?`, before.domain.id).one().status,
        pausedOriginal: sql.exec<{ deliv_status: string }>(`SELECT deliv_status FROM mailboxes WHERE id = ?`, before.mailbox.id).one().deliv_status,
        domainCount: sql.exec<{ n: number }>(`SELECT COUNT(*) as n FROM domains`).one().n,
        silentSendDomains: sql
          .exec<{ domain: string }>(
            `SELECT DISTINCT m.domain as domain FROM scheduled_sends ss JOIN mailboxes m ON m.id = ss.mailbox_id
             WHERE ss.campaign_id = ? AND ss.status = 'sent'`,
            camp2.body.campaignId,
          )
          .toArray()
          .map((r) => r.domain),
      };
    });

    expect(after.burningDomain).toBe("burning");
    expect(after.pausedOriginal).toBe("paused");
    expect(after.domainCount).toBe(2); // original (burning) + 1 replacement
    expect(tick2.sent).toBe(5); // replacement is warming (cap 5): 5 of 6 go this tick
    // Every silent send went to the replacement domain — never the burning one.
    expect(after.silentSendDomains).toHaveLength(1);
    expect(after.silentSendDomains).not.toContain(before.domain.domain);

    const account = await api<DeliverabilityAccount>("/account", { token });
    expect(account.body.deliverability.burningDomains).toBe(1);
    expect(account.body.deliverability.domainsReplaced).toBe(1);
    expect(account.body.deliverability.pausedMailboxes).toBeGreaterThanOrEqual(1);
    expect(account.body.deliverability.recentActions.some((a) => a.action === "REPLACE_DOMAIN")).toBe(true);
  });
});

describe("B6 deliverability loop — controlled scenarios", () => {
  it("a throttle (cap_override) survives the per-tick warmup-cap recompute", async () => {
    const { tenantId } = await setupTenant("Throt", "throt.com", 1, 1);
    // Simulate the loop having throttled this warmed mailbox down to cap 5.
    await runInDurableObject(tenantStub(tenantId), async (_i, state) => {
      state.storage.sql.exec(`UPDATE mailboxes SET deliv_status = 'throttled', cap_override = 5, daily_cap = 5`);
    });
    // Advance a day + tick: refreshMailboxWarmupState runs. The warmed ramp cap
    // is 40 — without cap_override the throttle would be wiped back up to 40.
    await tenantStub(tenantId).advanceClock(ONE_DAY_MS);
    await tenantStub(tenantId).tick();
    const cap = await runInDurableObject(tenantStub(tenantId), async (_i, state) =>
      state.storage.sql.exec<{ daily_cap: number }>(`SELECT daily_cap FROM mailboxes`).one().daily_cap,
    );
    expect(cap).toBe(5); // throttle held, not lifted to the warmup ramp cap
  });

  it("PAUSE is idempotent: a bounce-paused mailbox is not re-paused (no duplicate action) on the next sweep", async () => {
    const { tenantId } = await setupTenant("Bnc", "bnc.com", 1, 2); // 1 domain, 2 mailboxes
    const boxes = await runInDurableObject(tenantStub(tenantId), async (_i, state) =>
      state.storage.sql.exec<{ id: string }>(`SELECT id FROM mailboxes ORDER BY rowid`).toArray(),
    );
    // box0: 10 bounces / 100 sends = 0.10 (>= hardBounceRate 0.05) -> PAUSE.
    // box1: 100 clean sends. Domain aggregate bounce 10/200 = 0.05 < burnBounceRate 0.15 (no burn),
    // so this isolates a per-mailbox pause without a whole-domain replace.
    await runInDurableObject(tenantStub(tenantId), async (_i, state) => {
      injectSends(state.storage.sql, tenantId, boxes[0]!.id, { sends: 100, bounces: 10, complaints: 0 });
      injectSends(state.storage.sql, tenantId, boxes[1]!.id, { sends: 100, bounces: 0, complaints: 0 });
    });

    await tenantStub(tenantId).tick();
    const first = await runInDurableObject(tenantStub(tenantId), async (_i, state) => ({
      pauseActions: state.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) as n FROM deliverability_actions WHERE action = 'PAUSE'`).one().n,
      box0: state.storage.sql.exec<{ deliv_status: string }>(`SELECT deliv_status FROM mailboxes WHERE id = ?`, boxes[0]!.id).one().deliv_status,
      box1: state.storage.sql.exec<{ deliv_status: string }>(`SELECT deliv_status FROM mailboxes WHERE id = ?`, boxes[1]!.id).one().deliv_status,
    }));
    expect(first.box0).toBe("paused");
    expect(first.box1).toBe("healthy");
    expect(first.pauseActions).toBe(1);

    // Second sweep: box0 already paused -> the conditional UPDATE writes nothing, logs nothing.
    await tenantStub(tenantId).tick();
    const second = await runInDurableObject(tenantStub(tenantId), async (_i, state) =>
      state.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) as n FROM deliverability_actions WHERE action = 'PAUSE'`).one().n,
    );
    expect(second).toBe(1); // no duplicate PAUSE
  });

  it("caps auto-replacements per window: four domains burning at once provisions the cap, then withholds", async () => {
    const { tenantId } = await setupTenant("Cap", "cap.com", 4, 1); // 4 domains, 1 mailbox each
    const boxes = await runInDurableObject(tenantStub(tenantId), async (_i, state) =>
      state.storage.sql.exec<{ id: string }>(`SELECT id FROM mailboxes ORDER BY rowid`).toArray(),
    );
    await runInDurableObject(tenantStub(tenantId), async (_i, state) => {
      for (const b of boxes) injectSends(state.storage.sql, tenantId, b.id, { sends: 12, bounces: 0, complaints: 12 });
    });

    await tenantStub(tenantId).tick(); // one sweep -> 4 REPLACE_DOMAIN decisions

    const counts = await runInDurableObject(tenantStub(tenantId), async (_i, state) => {
      const sql = state.storage.sql;
      return {
        replaced: sql.exec<{ n: number }>(`SELECT COUNT(*) as n FROM deliverability_actions WHERE action = 'REPLACE_DOMAIN'`).one().n,
        capped: sql.exec<{ n: number }>(`SELECT COUNT(*) as n FROM deliverability_actions WHERE action = 'REPLACE_DOMAIN_CAPPED'`).one().n,
        burning: sql.exec<{ n: number }>(`SELECT COUNT(*) as n FROM domains WHERE status = 'burning'`).one().n,
        totalDomains: sql.exec<{ n: number }>(`SELECT COUNT(*) as n FROM domains`).one().n,
      };
    });
    expect(counts.replaced).toBe(3); // MAX_REPLACEMENTS_PER_WINDOW
    expect(counts.capped).toBe(1); // 4th withheld -> no infinite spawn
    expect(counts.burning).toBe(4); // all four retired regardless of the cap
    expect(counts.totalDomains).toBe(7); // 4 original + 3 provisioned replacements
  });

  it("ROTATE effect: pending sends route to a healthy mailbox, never the paused one", async () => {
    const { tenantId, token } = await setupTenant("Rot", "rot.com", 2, 1); // 2 mailboxes
    const boxes = await runInDurableObject(tenantStub(tenantId), async (_i, state) =>
      state.storage.sql.exec<{ id: string }>(`SELECT id FROM mailboxes ORDER BY rowid`).toArray(),
    );
    await runInDurableObject(tenantStub(tenantId), async (_i, state) => {
      state.storage.sql.exec(`UPDATE mailboxes SET deliv_status = 'paused' WHERE id = ?`, boxes[0]!.id);
    });

    const leads = Array.from({ length: 5 }, (_, i) => ({ email: `silent${i}@leads-test.com`, firstName: `S${i}`, company: "Co" }));
    const camp = await launch(token, "Rotate", leads);
    const tick = await tenantStub(tenantId).tick();
    expect(tick.sent).toBe(5);

    const sendMailboxes = await runInDurableObject(tenantStub(tenantId), async (_i, state) =>
      state.storage.sql
        .exec<{ mailbox_id: string }>(`SELECT DISTINCT mailbox_id FROM scheduled_sends WHERE campaign_id = ? AND status = 'sent'`, camp.body.campaignId)
        .toArray()
        .map((r) => r.mailbox_id),
    );
    expect(sendMailboxes).toEqual([boxes[1]!.id]); // all from the healthy mailbox, none from the paused one
  });
});
