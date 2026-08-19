import { describe, expect, it } from "vitest";
import type { DomainDnsResult, DomainPort, LookalikeCandidate, OwnedDomain, PurchasedDomain, ReleaseResult } from "@coldstart/shared";
import { VendorError } from "@coldstart/shared";
import { RegistrarUnarmedDomainPort } from "../src/vendors/real/domain-port.js";
import { runDeliverabilitySweep } from "../src/engine/deliverability-actions.js";
import { DEFAULT_THRESHOLDS } from "../src/engine/deliverability.js";
import { SandboxOpsMailer } from "../src/ops-mail/sandbox-ops-mailer.js";
import { WARMUP_RAMP_DAYS, ONE_DAY_MS } from "../src/engine/warmup.js";
import { api, signup, tenantStub, withTenantContext } from "./helpers.js";

// Item 4 (docs/adversarial/class-sweep-vendor-truth-2026-08-18.md, class B) — a
// plain VendorError (a transient InboxKit outage, not the registrar hard-block)
// on the SAME REPLACE_DOMAIN path. A test-double DomainPort whose
// searchLookalikes throws a retryable VendorError, exactly where
// RegistrarUnarmedDomainPort throws its own error above.
class TransientVendorErrorDomainPort implements DomainPort {
  async searchLookalikes(): Promise<LookalikeCandidate[]> {
    throw new VendorError("inboxkit domains/search unreachable: connect timeout", true);
  }
  async listOwnedDomains(): Promise<OwnedDomain[]> {
    throw new Error("not reached in this test");
  }
  async buy(): Promise<PurchasedDomain> {
    throw new Error("not reached in this test");
  }
  async setDns(): Promise<DomainDnsResult> {
    throw new Error("not reached in this test");
  }
  async release(): Promise<ReleaseResult> {
    throw new Error("not reached in this test");
  }
}

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
      const ctx = { ...baseCtx, adapters: { ...baseCtx.adapters, kind: "real" as const, domain: new RegistrarUnarmedDomainPort("env") } };

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

describe("Item 4 (class-sweep-vendor-truth-2026-08-18) — a plain VendorError on REPLACE_DOMAIN must ALSO alert the founder", () => {
  it("burning domain retired + founder alerted + sweep resolves, exactly like the RegistrarUnarmedError sibling", async () => {
    const { tenantId, token } = await signup("Transientco", "founder@transientco.com");
    const setup = await api("/setup-infrastructure", {
      method: "POST",
      token,
      body: JSON.stringify({
        brand: "Transientco",
        primaryDomain: "transientco.com",
        domains: 1,
        inboxesEach: 1,
        persona: "Ops",
        physicalAddress: "1 Test St",
        senderIdentity: "Ops <o@transientco.com>",
      }),
    });
    expect(setup.status, `setup-infrastructure failed: ${JSON.stringify(setup.body)}`).toBe(202);
    await tenantStub(tenantId).advanceClock((WARMUP_RAMP_DAYS + 1) * ONE_DAY_MS);

    const result = await withTenantContext(tenantId, async (baseCtx) => {
      const mailbox = baseCtx.sql.exec<{ id: string }>(`SELECT id FROM mailboxes LIMIT 1`).one();
      const domain = baseCtx.sql.exec<{ id: string; status: string }>(`SELECT id, status FROM domains LIMIT 1`).one();
      injectSends(baseCtx.sql, tenantId, mailbox.id, 20, 5);

      const mailer = new SandboxOpsMailer();
      const ctx = { ...baseCtx, adapters: { ...baseCtx.adapters, kind: "real" as const, domain: new TransientVendorErrorDomainPort() } };

      // MUST resolve, not throw — same isolation guarantee as the sibling above.
      const sweep = await runDeliverabilitySweep(ctx, DEFAULT_THRESHOLDS, mailer);

      return {
        sweptActions: sweep.actions.map((a) => a.type),
        burningStatus: baseCtx.sql.exec<{ status: string }>(`SELECT status FROM domains WHERE id = ?`, domain.id).one().status,
        alertsSent: mailer.sent.length,
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
    expect(result.failedLogged).toBe(1); // the withheld replacement is ops-visible
    expect(result.replacedLogged).toBe(0); // no successful replacement was logged
    // THE FIX: before it, only a RegistrarUnarmedError alerted the founder — a
    // plain VendorError (a transient vendor outage, a terminal DNS give-up)
    // alerted nobody, and the operator learned about it only from a server log
    // line nobody was watching.
    expect(result.alertsSent).toBeGreaterThan(0);
    expect(result.alertSubjects.some((s) => s.includes(tenantId) && s.toLowerCase().includes("domain"))).toBe(true);
  });
});
