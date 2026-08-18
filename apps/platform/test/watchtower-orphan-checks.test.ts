import { beforeEach, describe, expect, it } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import {
  domainOrphanCheckName,
  mailboxOrphanCheckName,
  reconcileAlerts,
  readReportedCheckNames,
  sendPipelineChecks,
} from "../src/admin/watchtower.js";
import { WATCHTOWER_COOLDOWN_MS } from "../src/admin/watchtower-policy.js";
import { DEFAULT_PROVISIONING_ORPHAN_GRACE_MS, type TenantOpsSummary } from "../src/engine/ops-summary.js";
import { SandboxOpsMailer } from "../src/ops-mail/sandbox-ops-mailer.js";
import { activatePaidPlan, mintTenant, tenantStub } from "./helpers.js";

// Item 2 (docs/adversarial/class-sweep-vendor-truth-2026-08-18.md, class C
// stage 1) — "every health signal derives from a platform ROW; vendor-vs-
// platform divergence is undetectable". A mailbox_intents/domain_intents row
// past a post-purchase status with no matching live row, past the grace
// bound, is now an unhealthy PER-ENTITY check — exactly the domain_dns_aging
// idiom (test/send-pipeline-alerts.test.ts's own pattern, mirrored here).

const T0 = 1_800_000_000_000;

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM watchtower_state").run();
  await env.DB.prepare("DELETE FROM watchtower_cursor").run();
});

/** A summary carrying only what `sendPipelineChecks` reads. */
function summaryWith(overrides: Partial<TenantOpsSummary["sendPipeline"]> = {}): TenantOpsSummary {
  return {
    brand: "Orphan Co",
    sendPipeline: {
      activated: true,
      dueNonDemoPendingSends: 0,
      eligibleMailboxes: 1,
      agingPendingPushes: [],
      agingPendingDomains: [],
      provisionedDomains: [],
      credentialPushes: [],
      mailboxOrphans: [],
      mailboxIntentEmails: [],
      domainOrphans: [],
      domainIntentCandidates: [],
      ...overrides,
    },
    mailboxProvenance: [],
  } as unknown as TenantOpsSummary;
}

async function stateOf(checkName: string) {
  return env.DB.prepare(`SELECT status, last_alert_ts FROM watchtower_state WHERE check_name = ?`)
    .bind(checkName)
    .first<{ status: string; last_alert_ts: number | null }>();
}

describe("mailbox_orphan: — a bought/dangling/warming mailbox_intents row with no live mailboxes row", () => {
  const email = "phantom@orphan-co.test";
  const check = mailboxOrphanCheckName(email);

  it("fires on the confirming sweep, suppresses in the cooldown, and clears once a live mailboxes row appears", async () => {
    const mailer = new SandboxOpsMailer();
    const orphaned = summaryWith({
      mailboxOrphans: [{ email, pendingForMs: 45 * 60 * 1000 }],
      mailboxIntentEmails: [email],
    });

    let outcomes = await reconcileAlerts(env, mailer, sendPipelineChecks("ten_x", orphaned, await readReportedCheckNames(env)), T0);
    expect(outcomes).toEqual([{ name: check, action: "pending", emailSent: false, why: "pending_debounce" }]);
    expect(mailer.sent).toEqual([]);

    const confirmedAt = T0 + 300_000;
    outcomes = await reconcileAlerts(env, mailer, sendPipelineChecks("ten_x", orphaned, await readReportedCheckNames(env)), confirmedAt);
    expect(outcomes).toEqual([{ name: check, action: "alerted", emailSent: true, why: "sent" }]);
    expect(mailer.sent[0]!.text).toContain(email);
    expect(mailer.sent[0]!.text.toLowerCase()).toContain("no live mailboxes row");

    outcomes = await reconcileAlerts(
      env,
      mailer,
      sendPipelineChecks("ten_x", orphaned, await readReportedCheckNames(env)),
      confirmedAt + 300_000,
    );
    expect(outcomes).toEqual([{ name: check, action: "suppressed", emailSent: false, why: "suppressed_cooldown" }]);

    // A live mailboxes row appears: the intent is still owned by this tenant
    // (mailboxIntentEmails), but no longer in the orphan set.
    const resolved = summaryWith({ mailboxOrphans: [], mailboxIntentEmails: [email] });
    outcomes = await reconcileAlerts(
      env,
      mailer,
      sendPipelineChecks("ten_x", resolved, await readReportedCheckNames(env)),
      confirmedAt + WATCHTOWER_COOLDOWN_MS + 1,
    );
    expect(outcomes).toEqual([{ name: check, action: "recovered", emailSent: true, why: "sent" }]);
    expect((await stateOf(check))?.status).toBe("healthy");
  });

  it("stays SILENT about an address it never alerted on (no healthy row per mailbox intent)", async () => {
    const mailer = new SandboxOpsMailer();
    const checks = sendPipelineChecks("ten_x", summaryWith({ mailboxIntentEmails: [email] }), await readReportedCheckNames(env));
    expect(checks).toEqual([]);
    await reconcileAlerts(env, mailer, checks, T0);
    expect(await stateOf(check)).toBeNull();
  });

  it("does not alert for an UNACTIVATED tenant", async () => {
    const checks = sendPipelineChecks(
      "ten_x",
      summaryWith({ activated: false, mailboxOrphans: [{ email, pendingForMs: 99_000_000 }], mailboxIntentEmails: [email] }),
      await readReportedCheckNames(env),
    );
    expect(checks).toEqual([]);
  });

  it("never clears another tenant's orphan alert (ownership guard)", async () => {
    const mailer = new SandboxOpsMailer();
    const orphaned = summaryWith({ mailboxOrphans: [{ email, pendingForMs: 45 * 60 * 1000 }], mailboxIntentEmails: [email] });
    for (const at of [T0, T0 + 300_000]) {
      // eslint-disable-next-line no-await-in-loop
      await reconcileAlerts(env, mailer, sendPipelineChecks("ten_x", orphaned, await readReportedCheckNames(env)), at);
    }
    // A DIFFERENT tenant's sweep, which never named this email in ITS OWN
    // mailbox_intents table, must not clear it.
    const otherTenant = summaryWith({ mailboxOrphans: [], mailboxIntentEmails: [] });
    const checks = sendPipelineChecks("ten_y", otherTenant, await readReportedCheckNames(env));
    expect(checks).toEqual([]);
  });
});

describe("domain_orphan: — a committed domain_intents row with no matching domains row", () => {
  const domain = "phantom-domain.example.com";
  const check = domainOrphanCheckName(domain);

  it("fires, suppresses, and clears once a matching domains row appears", async () => {
    const mailer = new SandboxOpsMailer();
    const orphaned = summaryWith({
      domainOrphans: [{ domain, pendingForMs: 60 * 60 * 1000 }],
      domainIntentCandidates: [domain],
    });

    let outcomes = await reconcileAlerts(env, mailer, sendPipelineChecks("ten_x", orphaned, await readReportedCheckNames(env)), T0);
    expect(outcomes).toEqual([{ name: check, action: "pending", emailSent: false, why: "pending_debounce" }]);

    const confirmedAt = T0 + 300_000;
    outcomes = await reconcileAlerts(env, mailer, sendPipelineChecks("ten_x", orphaned, await readReportedCheckNames(env)), confirmedAt);
    expect(outcomes).toEqual([{ name: check, action: "alerted", emailSent: true, why: "sent" }]);
    expect(mailer.sent[0]!.text).toContain(domain);

    const resolved = summaryWith({ domainOrphans: [], domainIntentCandidates: [domain] });
    outcomes = await reconcileAlerts(
      env,
      mailer,
      sendPipelineChecks("ten_x", resolved, await readReportedCheckNames(env)),
      confirmedAt + 300_000,
    );
    expect(outcomes).toEqual([{ name: check, action: "recovered", emailSent: true, why: "sent" }]);
  });

  it("does not alert for an UNACTIVATED tenant", async () => {
    const checks = sendPipelineChecks(
      "ten_x",
      summaryWith({ activated: false, domainOrphans: [{ domain, pendingForMs: 99_000_000 }], domainIntentCandidates: [domain] }),
      await readReportedCheckNames(env),
    );
    expect(checks).toEqual([]);
  });
});

// The signals come from the tenant's REAL state, not a fixture — proves the
// SQL join in engine/ops-summary.ts (not just the CheckResult shaping above),
// mirroring send-pipeline-alerts.test.ts's own "REAL state" section.
describe("Item 2 — the orphan signals come from the tenant's REAL mailbox_intents/domain_intents state", () => {
  it("a mailbox_intents row at 'bought' past the grace bound with no mailboxes row surfaces; a fresh one does not", async () => {
    const { tenantId } = await mintTenant("Real Orphan Co", "managed");
    await activatePaidPlan(tenantId, "managed");
    const past = Date.now() - DEFAULT_PROVISIONING_ORPHAN_GRACE_MS - 60_000;
    const fresh = Date.now();
    await runInDurableObject(tenantStub(tenantId), async (_i, state) => {
      state.storage.sql.exec(
        `INSERT INTO mailbox_intents (key, tenant_id, email, status, created_at, updated_at) VALUES (?, ?, ?, 'bought', ?, ?)`,
        "mbx:orphaned",
        tenantId,
        "orphaned@real-orphan-co.test",
        past,
        past,
      );
      state.storage.sql.exec(
        `INSERT INTO mailbox_intents (key, tenant_id, email, status, created_at, updated_at) VALUES (?, ?, ?, 'bought', ?, ?)`,
        "mbx:fresh",
        tenantId,
        "fresh@real-orphan-co.test",
        fresh,
        fresh,
      );
    });

    const summary = await tenantStub(tenantId).opsSummary(0);
    expect(summary.sendPipeline.mailboxOrphans.map((o) => o.email)).toEqual(["orphaned@real-orphan-co.test"]);
    expect(summary.sendPipeline.mailboxOrphans[0]!.pendingForMs).toBeGreaterThan(DEFAULT_PROVISIONING_ORPHAN_GRACE_MS);
    expect(new Set(summary.sendPipeline.mailboxIntentEmails)).toEqual(
      new Set(["orphaned@real-orphan-co.test", "fresh@real-orphan-co.test"]),
    );
  });

  it("a live mailboxes row for the SAME email removes it from the orphan set", async () => {
    const { tenantId } = await mintTenant("Real Orphan Live Co", "managed");
    await activatePaidPlan(tenantId, "managed");
    const past = Date.now() - DEFAULT_PROVISIONING_ORPHAN_GRACE_MS - 60_000;
    await runInDurableObject(tenantStub(tenantId), async (_i, state) => {
      state.storage.sql.exec(
        `INSERT INTO mailbox_intents (key, tenant_id, email, status, created_at, updated_at) VALUES (?, ?, ?, 'committed', ?, ?)`,
        "mbx:landed",
        tenantId,
        "landed@real-orphan-live-co.test",
        past,
        past,
      );
      state.storage.sql.exec(
        `INSERT INTO mailboxes (id, tenant_id, domain_id, domain, email, daily_cap, warmup_started_at, created_at, source, slot_counted, provider)
         VALUES (?, ?, 'dom_x', 'real-orphan-live-co.test', ?, 5, ?, ?, 'provisioned', 1, 'google')`,
        "mbx_landed",
        tenantId,
        "landed@real-orphan-live-co.test",
        past,
        past,
      );
    });

    // status='committed' is not in ('bought','dangling','warming') AND the
    // mailboxes row exists either way — the orphan set is empty.
    const summary = await tenantStub(tenantId).opsSummary(0);
    expect(summary.sendPipeline.mailboxOrphans).toEqual([]);
  });

  it("a domain_intents row 'committed' past the grace bound with no domains row surfaces", async () => {
    const { tenantId } = await mintTenant("Real Domain Orphan Co", "managed");
    await activatePaidPlan(tenantId, "managed");
    const past = Date.now() - DEFAULT_PROVISIONING_ORPHAN_GRACE_MS - 60_000;
    await runInDurableObject(tenantStub(tenantId), async (_i, state) => {
      state.storage.sql.exec(
        `INSERT INTO domain_intents (key, tenant_id, candidate_domain, status, created_at, updated_at) VALUES (?, ?, ?, 'committed', ?, ?)`,
        "dom:orphaned",
        tenantId,
        "orphaned-domain.real-domain-orphan-co.test",
        past,
        past,
      );
    });

    const summary = await tenantStub(tenantId).opsSummary(0);
    expect(summary.sendPipeline.domainOrphans.map((o) => o.domain)).toEqual(["orphaned-domain.real-domain-orphan-co.test"]);
    expect(summary.sendPipeline.domainIntentCandidates).toEqual(["orphaned-domain.real-domain-orphan-co.test"]);
  });
});
