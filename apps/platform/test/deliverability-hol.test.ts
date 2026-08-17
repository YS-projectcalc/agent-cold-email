// T2 instantiated for IN-2 of the head-of-line-blocking class
// (docs/adversarial/class-sweep-hol-blocking-2026-08-17.md).
//
// `applyActions` walked the sweep's remedies with no per-action isolation, and
// `applyReplaceDomain`'s `await releaseMailboxes(...)` sat OUTSIDE its own try.
// One mailbox the vendor would not release therefore escaped applyActions,
// escaped runDeliverabilitySweep, and escaped tick.ts's UNWRAPPED call — so a
// tenant with a burning domain lost every OTHER remedy in the sweep *and* its
// entire send loop, on every 5-minute cycle, while its reputation burned.

import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { VendorError } from "@coldstart/shared";
import { applyActions } from "../src/engine/deliverability-actions.js";
import { ONE_DAY_MS, WARMUP_RAMP_DAYS } from "../src/engine/warmup.js";
import { SandboxOpsMailer } from "../src/ops-mail/sandbox-ops-mailer.js";
import { api, signup, tenantStub, withTenantContext } from "./helpers.js";

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

interface MailboxLike {
  release: (email: string, key: string) => Promise<unknown>;
}

/** Attributed 'sent' rows for one mailbox, each carrying a matching complaint. */
function injectComplaints(sql: SqlStorage, tenantId: string, mailboxId: string, count: number): void {
  for (let i = 0; i < count; i++) {
    const msgId = `msg_hol_${mailboxId}_${i}`;
    const threadId = `t_hol_${mailboxId}_${i}`;
    sql.exec(
      `INSERT INTO scheduled_sends (id, tenant_id, campaign_id, lead_id, mailbox_id, step, variant, send_at, status, thread_id, message_id, sent_at)
       VALUES (?, ?, 'camp_hol', ?, ?, 1, 'a', 0, 'sent', ?, ?, 0)`,
      `ss_hol_${mailboxId}_${i}`,
      tenantId,
      `lead_hol_${mailboxId}_${i}`,
      mailboxId,
      threadId,
      msgId,
    );
    sql.exec(
      `INSERT INTO events (id, tenant_id, campaign_id, lead_id, type, step, message_id, thread_id, ts, metadata_json)
       VALUES (?, ?, 'camp_hol', ?, 'complaint', 0, ?, ?, 0, '{}')`,
      `evt_hol_${mailboxId}_${i}`,
      tenantId,
      `lead_hol_${mailboxId}_${i}`,
      msgId,
      threadId,
    );
  }
}

describe("IN-2 — a stuck REPLACE_DOMAIN must not withhold the remedies behind it", () => {
  it("applies the PAUSE on a healthy domain's mailbox even though the burning domain's release fails", async () => {
    const { tenantId } = await setupTenant("Actions Co", "actionsco.com", 2, 1);

    // Selected by domain_id, never by name order: the sandbox lookalike
    // generator picks its own prefixes, so the alphabetically-first EMAIL is not
    // necessarily on the alphabetically-first DOMAIN.
    const seed = await runInDurableObject(tenantStub(tenantId), (_i, state) => {
      const burning = state.storage.sql.exec<{ id: string; domain: string }>(`SELECT id, domain FROM domains ORDER BY domain LIMIT 1`).one();
      const mailboxes = state.storage.sql
        .exec<{ id: string; email: string; domain_id: string }>(`SELECT id, email, domain_id FROM mailboxes`)
        .toArray();
      return {
        burning,
        burningMailbox: mailboxes.find((m) => m.domain_id === burning.id)!,
        healthyMailbox: mailboxes.find((m) => m.domain_id !== burning.id)!,
      };
    });

    await withTenantContext(tenantId, async (base) => {
      const mailbox = base.adapters.mailbox;
      const ctx = {
        ...base,
        adapters: {
          ...base.adapters,
          mailbox: new Proxy(mailbox, {
            get(target, prop, receiver) {
              if (prop !== "release") return Reflect.get(target, prop, receiver);
              return async (email: string) => {
                if (email === seed.burningMailbox.email) {
                  throw new VendorError("inboxkit mailboxes/release -> HTTP 403: locked", false);
                }
                return { released: true, releasedAt: Date.now() };
              };
            },
          }),
        },
      };

      // The exact ordering the sweep emits: domain-burn first (deliverability.ts
      // decides domains before mailboxes), the independent mailbox PAUSE second.
      // Pre-fix, the release throw inside the FIRST action ended the loop and
      // the second remedy was never applied.
      await expect(
        applyActions(
          ctx,
          [
            { type: "REPLACE_DOMAIN", domainId: seed.burning.id, domain: seed.burning.domain, reason: "complaint rate" },
            { type: "PAUSE", mailboxId: seed.healthyMailbox.id, email: seed.healthyMailbox.email, reason: "bounce rate" },
          ],
          new SandboxOpsMailer(),
        ),
      ).resolves.toBeUndefined();
    });

    await withTenantContext(tenantId, (ctx) => {
      const paused = ctx.sql
        .exec<{ deliv_status: string }>(`SELECT deliv_status FROM mailboxes WHERE id = ?`, seed.healthyMailbox.id)
        .one().deliv_status;
      expect(paused).toBe("paused");

      // The replacement is WITHHELD rather than provisioned: §7.1 bill-neutrality
      // needs the burned mailboxes released first, and one of them was not.
      const actions = ctx.sql
        .exec<{ action: string }>(`SELECT action FROM deliverability_actions WHERE tenant_id = ?`, ctx.tenantId)
        .toArray()
        .map((r) => r.action);
      expect(actions).toContain("REPLACE_DOMAIN_WITHHELD_UNRELEASED");
      expect(actions).not.toContain("REPLACE_DOMAIN");
      expect(actions).toContain("MAILBOX_RELEASE_FAILED");
    });
  }, 30_000);

  it("the tenant's tick still SENDS when the burning domain's mailbox cannot be released", async () => {
    const { tenantId, token } = await setupTenant("Tick Lives Co", "ticklivesco.com", 2, 1);

    const seed = await runInDurableObject(tenantStub(tenantId), (_i, state) => {
      const mailboxes = state.storage.sql
        .exec<{ id: string; email: string }>(`SELECT id, email FROM mailboxes ORDER BY email`)
        .toArray();
      // Burn the FIRST mailbox's domain with injected complaints.
      injectComplaints(state.storage.sql, tenantId, mailboxes[0]!.id, 12);
      return { burningMailbox: mailboxes[0]!, healthyMailbox: mailboxes[1]! };
    });

    // Real pending work for the tick to do, on the healthy mailbox.
    await api("/campaigns", {
      method: "POST",
      token,
      body: JSON.stringify({
        name: "Still sending",
        offer: "x",
        leads: Array.from({ length: 4 }, (_v, i) => ({ email: `live${i}@leads-test.com`, firstName: `L${i}`, company: "Co" })),
        sequence: ONE_STEP,
        stopOnReply: true,
      }),
    });

    const result = await runInDurableObject(tenantStub(tenantId), async (instance) => {
      const adapters = (instance as unknown as { buildAdapters(): { mailbox: MailboxLike } }).buildAdapters();
      const realRelease = adapters.mailbox.release.bind(adapters.mailbox);
      adapters.mailbox.release = async (email: string, key: string) => {
        if (email === seed.burningMailbox.email) {
          throw new VendorError("inboxkit mailboxes/release -> HTTP 403: locked", false);
        }
        return realRelease(email, key);
      };
      // Pre-fix this REJECTS: the release throw escapes applyActions ->
      // runDeliverabilitySweep -> tick.ts:165, which is unwrapped. The tenant
      // sends nothing, on this cycle and every cycle after it.
      return instance.tick();
    });

    expect(result.sent).toBeGreaterThan(0);
  }, 30_000);
});
