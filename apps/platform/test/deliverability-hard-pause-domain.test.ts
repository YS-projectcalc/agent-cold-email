import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { runDeliverabilitySweep } from "../src/engine/deliverability-actions.js";
import { SandboxOpsMailer } from "../src/ops-mail/sandbox-ops-mailer.js";
import { signup, tenantStub, withTenantContext } from "./helpers.js";

// SPEC.md §20.2/B1 — end-to-end through the REAL DO: a primary domain's
// windowed complaint breaker trips -> the domain hard-pauses (never
// REPLACE_DOMAIN), its mailboxes pause, and BOTH required alerts fire
// (customer contact email + owner/founder copy) — mirrors
// admin-dunning-email.test.ts's exact assertion style for the dunning-notice
// pair this pattern is modeled on.

async function setupPrimaryDomainTenant(brand: string, contactEmail: string, domain: string) {
  const { tenantId, token } = await signup(brand, contactEmail);
  await withTenantContext(tenantId, async (ctx) => {
    // Direct SQL setup (there is no facade intent yet that flips an EXISTING
    // provisioned domain to primary+breaker-tier -- this isolates the
    // deliverability-actions.ts wiring from the intake pipeline that will
    // normally set these).
    ctx.sql.exec(
      `INSERT INTO domains (id, tenant_id, domain, status, purchased_at, source, is_primary, breaker_tier)
       VALUES ('dom_primary_test', ?, ?, 'active', ?, 'byo', 1, 'primary')`,
      tenantId,
      domain,
      ctx.clock.now(),
    );
    ctx.sql.exec(
      `INSERT INTO mailboxes (id, tenant_id, domain_id, domain, email, daily_cap, sent_today, sent_today_epoch_day, status, warmup_started_at, created_at, poll_cursor)
       VALUES ('mbx_primary_test', ?, 'dom_primary_test', ?, ?, 20, 0, 0, 'active', ?, ?, -1)`,
      tenantId,
      domain,
      `ops@${domain}`,
      ctx.clock.now(),
      ctx.clock.now(),
    );
    // 5000 trailing-window sends + 10 complaints -- trips the hard-pause
    // breaker (>=100 sends, >=3 complaints, >=0.10% rate) exactly like
    // deliverability-primary-breaker.test.ts's unit-level fixture.
    for (let i = 0; i < 5000; i++) {
      ctx.sql.exec(
        `INSERT INTO scheduled_sends (id, tenant_id, campaign_id, lead_id, mailbox_id, step, variant, send_at, status, thread_id, message_id, sent_at)
         VALUES (?, ?, 'camp_primary_test', ?, 'mbx_primary_test', 1, 'a', 0, 'sent', ?, ?, ?)`,
        `ss_primary_${i}`,
        tenantId,
        `lead_primary_${i}`,
        `t_primary_${i}`,
        `msg_primary_${i}`,
        ctx.clock.now(),
      );
      if (i < 10) {
        ctx.sql.exec(
          `INSERT INTO events (id, tenant_id, campaign_id, lead_id, type, step, message_id, thread_id, ts, metadata_json)
           VALUES (?, ?, 'camp_primary_test', ?, 'complaint', 0, ?, ?, ?, '{}')`,
          `evt_primary_${i}`,
          tenantId,
          `lead_primary_${i}`,
          `msg_primary_${i}`,
          `t_primary_${i}`,
          ctx.clock.now(),
        );
      }
    }
  });
  return { tenantId, token };
}

describe("HARD_PAUSE_DOMAIN — end-to-end through the real DO", () => {
  it("hard-pauses the primary domain + its mailboxes and dispatches BOTH required alerts, never REPLACE_DOMAIN", async () => {
    const contactEmail = "primary-notify@example.com";
    const { tenantId } = await setupPrimaryDomainTenant("Primary Pause Co", contactEmail, "primary-pause-co.com");

    const mailer = new SandboxOpsMailer();
    const sweep = await withTenantContext(tenantId, (ctx) => runDeliverabilitySweep(ctx, undefined, mailer));

    expect(sweep.actions).toHaveLength(1);
    expect(sweep.actions[0]).toMatchObject({ type: "HARD_PAUSE_DOMAIN", domain: "primary-pause-co.com" });
    expect(sweep.actions.some((a) => a.type === "REPLACE_DOMAIN")).toBe(false);

    const after = await runInDurableObject(tenantStub(tenantId), async (_i, state) => ({
      domainStatus: state.storage.sql.exec<{ status: string }>(`SELECT status FROM domains WHERE id = 'dom_primary_test'`).one().status,
      mailboxDelivStatus: state.storage.sql
        .exec<{ deliv_status: string }>(`SELECT deliv_status FROM mailboxes WHERE id = 'mbx_primary_test'`)
        .one().deliv_status,
      loggedAction: state.storage.sql
        .exec<{ action: string; target: string }>(`SELECT action, target FROM deliverability_actions WHERE action = 'HARD_PAUSE_DOMAIN'`)
        .toArray(),
    }));
    expect(after.domainStatus).toBe("paused_primary");
    expect(after.mailboxDelivStatus).toBe("paused");
    expect(after.loggedAction).toHaveLength(1);
    expect(after.loggedAction[0]!.target).toBe("primary-pause-co.com");

    const tenantNotice = mailer.sent.find((m) => m.to === contactEmail);
    const founderCopy = mailer.sent.find((m) => m.to === env.OPS_ALERT_EMAIL);
    expect(tenantNotice).toBeDefined();
    expect(tenantNotice?.subject).toContain("primary-pause-co.com");
    expect(tenantNotice?.text).toContain("never auto-replaced");
    expect(founderCopy).toBeDefined();
    expect(founderCopy?.subject).toContain("Primary Pause Co");
    expect(founderCopy?.text).toContain(`tenant notified at ${contactEmail}`);
  });

  it("is idempotent — a second sweep never re-sends the alert or re-logs the action", async () => {
    const { tenantId } = await setupPrimaryDomainTenant("Primary Pause Idem Co", "idem-notify@example.com", "primary-pause-idem.com");

    const mailer1 = new SandboxOpsMailer();
    await withTenantContext(tenantId, (ctx) => runDeliverabilitySweep(ctx, undefined, mailer1));
    expect(mailer1.sent.length).toBeGreaterThan(0);

    const mailer2 = new SandboxOpsMailer();
    const sweep2 = await withTenantContext(tenantId, (ctx) => runDeliverabilitySweep(ctx, undefined, mailer2));
    expect(sweep2.actions).toHaveLength(0); // already paused_primary — status != 'active', skipped entirely
    expect(mailer2.sent).toHaveLength(0);

    const actionCount = await runInDurableObject(tenantStub(tenantId), async (_i, state) =>
      state.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) as n FROM deliverability_actions WHERE action = 'HARD_PAUSE_DOMAIN'`).one().n,
    );
    expect(actionCount).toBe(1);
  });
});
