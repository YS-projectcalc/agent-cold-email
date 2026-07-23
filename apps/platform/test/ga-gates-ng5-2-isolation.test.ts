import { describe, expect, it } from "vitest";
import { RegistrarUnarmedDomainPort } from "../src/vendors/real/domain-port.js";
import { runDeliverabilitySweep } from "../src/engine/deliverability-actions.js";
import { DEFAULT_THRESHOLDS } from "../src/engine/deliverability.js";
import { SandboxOpsMailer } from "../src/ops-mail/sandbox-ops-mailer.js";
import { WARMUP_RAMP_DAYS, ONE_DAY_MS } from "../src/engine/warmup.js";
import { api, signup, tenantStub, withTenantContext } from "./helpers.js";

// N-G5-2 (ga-gates G5 build review) — the deliverability REPLACE_DOMAIN path had
// NO VendorError isolation, so once the real registrar path is wired a burned
// domain's replacement (searchLookalikes → domain.buy) throwing
// RegistrarUnarmedError would crash the WHOLE tick with only a console.error.
// This proves the throw is now ISOLATED per-tenant: the burning domain is still
// retired, a founder alert fires, and the sweep RESOLVES (the tick continues).

// Inline copy of deliverability-loop.test.ts's injector: `sends` 'sent' rows for
// one mailbox, of which the last `complaints` carry a matching complaint event
// (message-id join attributes each to this mailbox).
function injectSends(sql: SqlStorage, tenantId: string, mailboxId: string, sends: number, complaints: number): void {
  for (let i = 0; i < sends; i++) {
    const msgId = `msg_ng52_${i}`;
    const threadId = `t_ng52_${i}`;
    sql.exec(
      `INSERT INTO scheduled_sends (id, tenant_id, campaign_id, lead_id, mailbox_id, step, variant, send_at, status, thread_id, message_id, sent_at)
       VALUES (?, ?, 'camp_ng52', ?, ?, 1, 'a', 0, 'sent', ?, ?, 0)`,
      `ss_ng52_${i}`,
      tenantId,
      `lead_ng52_${i}`,
      mailboxId,
      threadId,
      msgId,
    );
    if (i >= sends - complaints) {
      sql.exec(
        `INSERT INTO events (id, tenant_id, campaign_id, lead_id, type, step, message_id, thread_id, ts, metadata_json)
         VALUES (?, ?, 'camp_ng52', ?, 'complaint', 0, ?, ?, 0, '{}')`,
        `evt_ng52_c_${i}`,
        tenantId,
        `lead_ng52_${i}`,
        msgId,
        threadId,
      );
    }
  }
}

describe("N-G5-2 — a RegistrarUnarmedError in the REPLACE_DOMAIN path is isolated, not a tick crash", () => {
  it("burning domain retired + founder alert fired + sweep resolves (does not throw)", async () => {
    const { tenantId, token } = await signup("Burnco", "founder@burnco.com");
    const setup = await api("/setup-infrastructure", {
      method: "POST",
      token,
      body: JSON.stringify({
        brand: "Burnco",
        primaryDomain: "burnco.com",
        domains: 1,
        inboxesEach: 1,
        persona: "Ops",
        physicalAddress: "1 Test St",
        senderIdentity: "Ops <o@burnco.com>",
      }),
    });
    expect(setup.status, `setup-infrastructure failed: ${JSON.stringify(setup.body)}`).toBe(202);
    await tenantStub(tenantId).advanceClock((WARMUP_RAMP_DAYS + 1) * ONE_DAY_MS);

    const result = await withTenantContext(tenantId, async (baseCtx) => {
      const mailbox = baseCtx.sql.exec<{ id: string }>(`SELECT id FROM mailboxes LIMIT 1`).one();
      const domain = baseCtx.sql.exec<{ id: string; status: string }>(`SELECT id, status FROM domains LIMIT 1`).one();
      // 20 sends / 5 complaints = 0.25 domain complaintRate, far over burnComplaintRate (0.005), sends >= minSampleSends.
      injectSends(baseCtx.sql, tenantId, mailbox.id, 20, 5);

      // Force the real registrar seam (hard-block) — searchLookalikes throws
      // RegistrarUnarmedError inside the replacement, exactly the post-arming shape.
      const mailer = new SandboxOpsMailer();
      const ctx = { ...baseCtx, adapters: { ...baseCtx.adapters, kind: "real" as const, domain: new RegistrarUnarmedDomainPort() } };

      // MUST resolve, not throw — the isolation is the whole point.
      const sweep = await runDeliverabilitySweep(ctx, DEFAULT_THRESHOLDS, mailer);

      return {
        sweptActions: sweep.actions.map((a) => a.type),
        burningStatus: baseCtx.sql.exec<{ status: string }>(`SELECT status FROM domains WHERE id = ?`, domain.id).one().status,
        alertSubjects: mailer.sent.map((m) => m.subject),
        failedLogged: baseCtx.sql
          .exec<{ n: number }>(`SELECT COUNT(*) as n FROM deliverability_actions WHERE tenant_id = ? AND action = 'REPLACE_DOMAIN_FAILED'`, tenantId)
          .one().n,
        replacedLogged: baseCtx.sql
          .exec<{ n: number }>(`SELECT COUNT(*) as n FROM deliverability_actions WHERE tenant_id = ? AND action = 'REPLACE_DOMAIN'`, tenantId)
          .one().n,
      };
    });

    expect(result.sweptActions).toContain("REPLACE_DOMAIN"); // the decision was made
    expect(result.burningStatus).toBe("burning"); // burning domain STILL retired despite the failure
    expect(result.alertSubjects.some((s) => s.includes("registrar not armed"))).toBe(true); // founder alerted
    expect(result.failedLogged).toBe(1); // the withheld replacement is ops-visible
    expect(result.replacedLogged).toBe(0); // no successful replacement was logged
  });
});
