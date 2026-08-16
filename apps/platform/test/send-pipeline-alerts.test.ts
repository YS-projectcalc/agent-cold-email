import { beforeEach, describe, expect, it } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import {
  credPushAgingCheckName,
  reconcileAlerts,
  readReportedCheckNames,
  sendPipelineChecks,
  sendStarvedCheckName,
} from "../src/admin/watchtower.js";
import { WATCHTOWER_COOLDOWN_MS } from "../src/admin/watchtower-policy.js";
import { AGING_CRED_PUSH_MS, type TenantOpsSummary } from "../src/engine/ops-summary.js";
import { SandboxOpsMailer } from "../src/ops-mail/sandbox-ops-mailer.js";
import { activatePaidPlan, api, mintTenant, seedBenignSdnList, tenantStub } from "./helpers.js";

// WAVE 2 §1c — the two alerts the design's "quiet" choice originally omitted.
//
// The failure they exist for is not a crash: it is SILENCE. Per-mailbox
// eligibility (§1a) turned "one un-grantable mailbox starves the whole tenant"
// into "one mailbox sits idle" — better, but still invisible. And a tenant
// whose every mailbox is excluded reports perfectly healthy while sending
// nothing, forever. These two checks are what make both states loud.

const T0 = 1_800_000_000_000;

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM watchtower_state").run();
  await env.DB.prepare("DELETE FROM watchtower_cursor").run();
});

/** A summary carrying only what `sendPipelineChecks` reads. */
function summaryWith(overrides: Partial<TenantOpsSummary["sendPipeline"]>, mailboxEmails: string[] = []): TenantOpsSummary {
  return {
    brand: "Alert Co",
    sendPipeline: {
      activated: true,
      dueNonDemoPendingSends: 0,
      eligibleMailboxes: 1,
      agingPendingPushes: [],
      agingPendingDomains: [],
      provisionedDomainNames: [],
      ...overrides,
    },
    mailboxProvenance: mailboxEmails.map((email) => ({
      email,
      source: "provisioned",
      slot_counted: 1,
      provider: "google",
      released_at: null,
      warmup_started_at: T0,
    })),
  } as unknown as TenantOpsSummary;
}

async function stateOf(checkName: string) {
  return env.DB.prepare(`SELECT status, last_alert_ts FROM watchtower_state WHERE check_name = ?`)
    .bind(checkName)
    .first<{ status: string; last_alert_ts: number | null }>();
}

describe("§1c alert — aging credential push", () => {
  const email = "waiting@alert-co.test";
  const check = credPushAgingCheckName(email);

  it("fires ONCE on the confirming sweep, suppresses inside the cooldown, re-alerts after it, and clears on recovery", async () => {
    const mailer = new SandboxOpsMailer();
    const aging = summaryWith({ agingPendingPushes: [{ email, pendingForMs: 45 * 60 * 1000 }] }, [email]);

    // 1. First sweep: the condition is recorded, nothing is sent yet (founder
    //    ruling 2026-08-16 — one observation is a flap until a second agrees).
    let outcomes = await reconcileAlerts(env, mailer, sendPipelineChecks("ten_x", aging, await readReportedCheckNames(env)), T0);
    expect(outcomes).toEqual([{ name: check, action: "pending", emailSent: false }]);
    expect(mailer.sent).toEqual([]);

    // 2. Second consecutive sweep: alert, naming the mailbox and what a human
    //    must do.
    const confirmedAt = T0 + 300_000;
    outcomes = await reconcileAlerts(env, mailer, sendPipelineChecks("ten_x", aging, await readReportedCheckNames(env)), confirmedAt);
    expect(outcomes).toEqual([{ name: check, action: "alerted", emailSent: true }]);
    expect(mailer.sent[0]!.subject).toBe(`[coldrig] Mailbox credentials ${email}: UNHEALTHY`);
    expect(mailer.sent[0]!.text).toContain("45 min");
    expect(mailer.sent[0]!.text).toContain("GMAIL_OAUTH_GRANTS");

    // 3. Still aging, one cron cycle later: SUPPRESSED (the anti-storm rule —
    //    5-minute cadence must not become a 5-minute mail loop).
    outcomes = await reconcileAlerts(
      env,
      mailer,
      sendPipelineChecks("ten_x", aging, await readReportedCheckNames(env)),
      confirmedAt + 300_000,
    );
    expect(outcomes).toEqual([{ name: check, action: "suppressed", emailSent: false }]);
    expect(mailer.sent).toHaveLength(1);

    // 4. Past the cooldown: re-alert.
    outcomes = await reconcileAlerts(
      env,
      mailer,
      sendPipelineChecks("ten_x", aging, await readReportedCheckNames(env)),
      confirmedAt + WATCHTOWER_COOLDOWN_MS + 1,
    );
    expect(outcomes).toEqual([{ name: check, action: "realerted", emailSent: true }]);

    // 5. The grant lands — the push clears, and the founder is told it recovered.
    const cleared = summaryWith({ agingPendingPushes: [] }, [email]);
    outcomes = await reconcileAlerts(
      env,
      mailer,
      sendPipelineChecks("ten_x", cleared, await readReportedCheckNames(env)),
      confirmedAt + WATCHTOWER_COOLDOWN_MS + 2,
    );
    expect(outcomes).toEqual([{ name: check, action: "recovered", emailSent: true }]);
    expect(mailer.sent.at(-1)!.subject).toContain("RECOVERED");
    expect((await stateOf(check))?.status).toBe("healthy");
  });

  it("stays SILENT about a mailbox it never alerted on (no healthy row per mailbox)", async () => {
    // Without this the table would fill with one healthy row per mailbox per
    // tenant, burying the handful of real platform checks it exists for.
    const mailer = new SandboxOpsMailer();
    const checks = sendPipelineChecks("ten_x", summaryWith({}, [email]), await readReportedCheckNames(env));
    expect(checks).toEqual([]);
    await reconcileAlerts(env, mailer, checks, T0);
    expect(await stateOf(check)).toBeNull();
  });

  it("does not alert for an UNACTIVATED tenant", async () => {
    const checks = sendPipelineChecks(
      "ten_x",
      summaryWith({ activated: false, agingPendingPushes: [{ email, pendingForMs: 99_000_000 }] }, [email]),
      await readReportedCheckNames(env),
    );
    expect(checks).toEqual([]);
  });
});

describe("§1c alert — send-starved tenant", () => {
  const check = sendStarvedCheckName("ten_starved");

  it("fires when a tenant has due mail and ZERO eligible mailboxes, then clears", async () => {
    const mailer = new SandboxOpsMailer();
    const starved = summaryWith({ dueNonDemoPendingSends: 7, eligibleMailboxes: 0 });

    let outcomes = await reconcileAlerts(env, mailer, sendPipelineChecks("ten_starved", starved, await readReportedCheckNames(env)), T0);
    expect(outcomes).toEqual([{ name: check, action: "pending", emailSent: false }]);

    outcomes = await reconcileAlerts(
      env,
      mailer,
      sendPipelineChecks("ten_starved", starved, await readReportedCheckNames(env)),
      T0 + 300_000,
    );
    expect(outcomes).toEqual([{ name: check, action: "alerted", emailSent: true }]);
    expect(mailer.sent[0]!.text).toContain("7 send(s) due and ZERO eligible mailboxes");
    expect(mailer.sent[0]!.text).toContain("mailboxProvenance");

    outcomes = await reconcileAlerts(
      env,
      mailer,
      sendPipelineChecks("ten_starved", starved, await readReportedCheckNames(env)),
      T0 + 600_000,
    );
    expect(outcomes).toEqual([{ name: check, action: "suppressed", emailSent: false }]);

    const recovered = summaryWith({ dueNonDemoPendingSends: 7, eligibleMailboxes: 2 });
    outcomes = await reconcileAlerts(
      env,
      mailer,
      sendPipelineChecks("ten_starved", recovered, await readReportedCheckNames(env)),
      T0 + 900_000,
    );
    expect(outcomes).toEqual([{ name: check, action: "recovered", emailSent: true }]);
  });

  it("does NOT fire when a tenant simply has nothing due", async () => {
    // An idle tenant is not a starved one; alerting on idleness would train the
    // founder to ignore the channel.
    const checks = sendPipelineChecks(
      "ten_starved",
      summaryWith({ dueNonDemoPendingSends: 0, eligibleMailboxes: 0 }),
      await readReportedCheckNames(env),
    );
    expect(checks).toEqual([]);
  });

  it("does NOT fire for an unactivated tenant with due mail and no mailboxes", async () => {
    const checks = sendPipelineChecks(
      "ten_starved",
      summaryWith({ activated: false, dueNonDemoPendingSends: 5, eligibleMailboxes: 0 }),
      await readReportedCheckNames(env),
    );
    expect(checks).toEqual([]);
  });
});

describe("§1c — the signals come from the tenant's REAL state, not a fixture", () => {
  it("a paid tenant with due rows and only sandbox mailboxes reports itself starved", async () => {
    await seedBenignSdnList();
    const { tenantId, token } = await mintTenant("Real Starved Co", "managed");
    await activatePaidPlan(tenantId, "managed");
    await api("/setup-infrastructure", {
      method: "POST",
      token,
      body: JSON.stringify({
        brand: "Real Starved Co",
        primaryDomain: "real-starved-co.test",
        domains: 1,
        inboxesEach: 1,
        persona: "Sender",
        physicalAddress: "1 Starve St",
        senderIdentity: "Sender <s@real-starved-co.test>",
      }),
    });
    await api("/campaigns", {
      method: "POST",
      token,
      body: JSON.stringify({
        name: "Starved campaign",
        offer: "x",
        leads: [{ email: "lead@real-starved-co.test", firstName: "L", company: "Co" }],
        sequence: [{ step: 1, subject: "Hi", body: "Hi", delayDays: 0 }],
      }),
    });

    // The mailbox really is provider='sandbox' — the sandbox port said so.
    const summary = await tenantStub(tenantId).opsSummary(0);
    expect(summary.mailboxProvenance.map((m) => m.provider)).toEqual(["sandbox"]);
    expect(summary.sendPipeline.activated).toBe(true);
    expect(summary.sendPipeline.dueNonDemoPendingSends).toBe(1);
    expect(summary.sendPipeline.eligibleMailboxes).toBe(0);

    const checks = sendPipelineChecks(tenantId, summary, await readReportedCheckNames(env));
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ name: sendStarvedCheckName(tenantId), healthy: false });
  });

  it("a credential push older than the 30-minute threshold surfaces, a fresh one does not", async () => {
    await seedBenignSdnList();
    const { tenantId } = await mintTenant("Aging Push Co", "managed");
    await activatePaidPlan(tenantId, "managed");
    await runInDurableObject(tenantStub(tenantId), async (_i, state) => {
      const now = Date.now();
      state.storage.sql.exec(
        `INSERT INTO mailbox_cred_pushes (email, tenant_id, status, attempts, created_at, updated_at) VALUES (?, ?, 'pending', 0, ?, ?)`,
        "old@aging-push-co.test",
        tenantId,
        now - AGING_CRED_PUSH_MS - 60_000,
        now - AGING_CRED_PUSH_MS - 60_000,
      );
      state.storage.sql.exec(
        `INSERT INTO mailbox_cred_pushes (email, tenant_id, status, attempts, created_at, updated_at) VALUES (?, ?, 'pending', 0, ?, ?)`,
        "fresh@aging-push-co.test",
        tenantId,
        now,
        now,
      );
    });

    const aging = (await tenantStub(tenantId).opsSummary(0)).sendPipeline.agingPendingPushes;
    expect(aging.map((p) => p.email)).toEqual(["old@aging-push-co.test"]);
    expect(aging[0]!.pendingForMs).toBeGreaterThan(AGING_CRED_PUSH_MS);
  });
});
