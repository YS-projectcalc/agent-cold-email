import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { emitTenantMessage } from "../src/engine/tenant-messages.js";
import { deriveNextSteps, owedSignals } from "../src/engine/next-steps.js";
import { maybeEmitContinuityNudge, CONTINUITY_NUDGE_KIND } from "../src/engine/continuity-nudge.js";
import { managedMailboxAddress } from "../src/engine/mailbox-provisioning.js";
import { reconcileAlerts, readReportedCheckNames, sendPipelineChecks } from "../src/admin/watchtower.js";
import { customerProgressAgentCheckName } from "../src/admin/watchtower-alerts.js";
import { SandboxOpsMailer } from "../src/ops-mail/sandbox-ops-mailer.js";
import { activatePaidPlan, mintTenant, seedBenignSdnList, tenantStub, withTenantContext } from "./helpers.js";

// I15 — the one-shot continuity nudge (design §7.12, founder ruling Q1).
//
// THE R2 LOOP, asserted directly (the brief's decisive RED): the nudge's own
// `tenant_messages` row must not become a `message_action_required` owed
// step, or it would sustain the very check that fires it — every future
// stall for that tenant would be silently un-nudged. This passes BECAUSE of
// I6's `SELF_WRITTEN_MESSAGE_KINDS` exclusion (already live in the
// primitive) — this file proves the dependency holds end to end, not that
// the exclusion itself works (next-steps-gating.test.ts owns that).

const HOUR = 3_600_000;

async function seedStalledDomainTenant(): Promise<string> {
  await seedBenignSdnList();
  const { tenantId } = await mintTenant("Nudge Co", "managed");
  await activatePaidPlan(tenantId, "managed");
  await runInDurableObject(tenantStub(tenantId), (_instance, state) => {
    const sql = state.storage.sql;
    sql.exec(
      `UPDATE tenant_profile SET primary_domain = ?, physical_address = ?, sender_identity = ?, mailbox_qty_synced = 5, register_domains = 1 WHERE id = ?`,
      "nudgeco.com",
      "1 Nudge St, Testville, CA 94000",
      "Nudge Co <hello@nudgeco.com>",
      tenantId,
    );
    // A stalled, provisioned domain — domain_dns_incomplete, kind:owed,
    // waitingOn:null (agent-blamed, never operator).
    sql.exec(
      `INSERT INTO domain_intents (key, tenant_id, candidate_domain, status, persona_slug, inboxes_each, created_at, updated_at)
       VALUES (?, ?, ?, 'committed', 'nudgeco', 1, 1000, 1000)`,
      `nudge:${tenantId}#0`,
      tenantId,
      "nudgeco.com",
    );
    sql.exec(
      `INSERT INTO domains (id, tenant_id, domain, status, purchased_at, dns_status, source, dns_first_checked_at)
       VALUES (?, ?, ?, 'active', 1000, 'pending', 'provisioned', ?)`,
      `dom_${tenantId}`,
      tenantId,
      "nudgeco.com",
      1000,
    );
    // Floor mailboxes (5) so `paid_seats_unprovisioned`/`seat_headroom_free`
    // never fire — domain_dns_incomplete is the ONLY owed reason this
    // fixture produces (hermetic per §7.18.4: real provisioning would never
    // create mailboxes before DNS is ready, but isolating one condition is
    // exactly what a fixture is for).
    for (let slot = 0; slot < 5; slot++) {
      const email = `nudge${slot}@nudgeco.com`;
      sql.exec(
        `INSERT INTO mailboxes (id, tenant_id, domain_id, domain, email, daily_cap, warmup_started_at, created_at, provider)
         VALUES (?, ?, ?, ?, ?, 5, 1000, 1000, 'google')`,
        `mbx_${email}`,
        tenantId,
        `dom_${tenantId}`,
        "nudgeco.com",
        email,
      );
    }
  });
  return tenantId;
}

describe("maybeEmitContinuityNudge — the DO-side one-shot guard", () => {
  it("emits exactly one action_required message, and stamps the episode", async () => {
    const tenantId = await seedStalledDomainTenant();
    const episodeSinceTs = 5_000_000;

    await withTenantContext(tenantId, (ctx) => maybeEmitContinuityNudge(ctx, episodeSinceTs));

    const messages = await withTenantContext(tenantId, (ctx) =>
      ctx.sql
        .exec<{ kind: string; severity: string; body: string }>(
          `SELECT kind, severity, body FROM tenant_messages WHERE tenant_id = ? AND kind = ?`,
          ctx.tenantId,
          CONTINUITY_NUDGE_KIND,
        )
        .toArray(),
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]!.severity).toBe("action_required");
    // Professional tone (founder directive): no first names, no casual register.
    expect(messages[0]!.body).not.toMatch(/\bhi\b|\bhey\b/i);

    const stamped = await withTenantContext(tenantId, (ctx) =>
      ctx.sql.exec<{ t: number | null }>(`SELECT continuity_nudge_episode_ts as t FROM tenant_profile WHERE id = ?`, ctx.tenantId).one().t,
    );
    expect(stamped).toBe(episodeSinceTs);
  });

  it("a second call for the SAME episode is a genuine no-op", async () => {
    const tenantId = await seedStalledDomainTenant();
    const episodeSinceTs = 5_000_000;

    await withTenantContext(tenantId, (ctx) => maybeEmitContinuityNudge(ctx, episodeSinceTs));
    await withTenantContext(tenantId, (ctx) => maybeEmitContinuityNudge(ctx, episodeSinceTs));

    const count = await withTenantContext(tenantId, (ctx) =>
      ctx.sql
        .exec<{ n: number }>(`SELECT COUNT(*) as n FROM tenant_messages WHERE tenant_id = ? AND kind = ?`, ctx.tenantId, CONTINUITY_NUDGE_KIND)
        .one().n,
    );
    expect(count).toBe(1);
  });

  it("a LATER episode (strictly greater sinceTs) re-arms and nudges again", async () => {
    const tenantId = await seedStalledDomainTenant();
    await withTenantContext(tenantId, (ctx) => maybeEmitContinuityNudge(ctx, 5_000_000));
    await withTenantContext(tenantId, (ctx) => maybeEmitContinuityNudge(ctx, 9_000_000));

    const count = await withTenantContext(tenantId, (ctx) =>
      ctx.sql
        .exec<{ n: number }>(`SELECT COUNT(*) as n FROM tenant_messages WHERE tenant_id = ? AND kind = ?`, ctx.tenantId, CONTINUITY_NUDGE_KIND)
        .one().n,
    );
    expect(count).toBe(2);
  });

  it("THE CRY-WOLF RULE — never nudges when every owed step waits on the operator", async () => {
    // billed_quantity_drift ONLY: 5 live mailboxes (the floor — no
    // seat_headroom_free either) across two DNS-ready domains, billed for 6.
    const { tenantId } = await mintTenant("Operator Blocked Co", "managed");
    await seedBenignSdnList();
    await activatePaidPlan(tenantId, "managed");
    const persona = "opblocked";
    await runInDurableObject(tenantStub(tenantId), (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec(
        `UPDATE tenant_profile SET primary_domain = ?, physical_address = ?, sender_identity = ?, mailbox_qty_synced = 6, register_domains = 1 WHERE id = ?`,
        "opblocked.com",
        "1 Op St, Testville, CA 94000",
        "Op Blocked Co <hello@opblocked.com>",
        tenantId,
      );
      const ordinals = [
        { domain: "opblocked-0.com", live: 3 },
        { domain: "opblocked-1.com", live: 2 },
      ];
      ordinals.forEach((ord, ordinal) => {
        sql.exec(
          `INSERT INTO domain_intents (key, tenant_id, candidate_domain, status, persona_slug, inboxes_each, created_at, updated_at)
           VALUES (?, ?, ?, 'committed', ?, ?, 1000, 1000)`,
          `nudge-op:${tenantId}#${ordinal}`,
          tenantId,
          ord.domain,
          persona,
          ord.live,
        );
        const domainId = `dom_op_${ordinal}_${tenantId}`;
        sql.exec(
          `INSERT INTO domains (id, tenant_id, domain, status, purchased_at, dns_status) VALUES (?, ?, ?, 'active', 1000, 'ready')`,
          domainId,
          tenantId,
          ord.domain,
        );
        for (let slot = 0; slot < ord.live; slot++) {
          const email = managedMailboxAddress(persona, ord.domain, ordinal, slot);
          sql.exec(
            `INSERT INTO mailboxes (id, tenant_id, domain_id, domain, email, daily_cap, warmup_started_at, created_at, provider)
             VALUES (?, ?, ?, ?, ?, 5, 1000, 1000, 'google')`,
            `mbx_${email}`,
            tenantId,
            domainId,
            ord.domain,
            email,
          );
        }
      });
    });
    // Sanity: the fixture really is operator-only-blamed.
    const owed = await withTenantContext(tenantId, (ctx) => owedSignals(deriveNextSteps(ctx)));
    expect(owed.owedCount).toBeGreaterThan(0);
    expect(owed.anyOwedWaitingOnOperator).toBe(true);

    await withTenantContext(tenantId, (ctx) => maybeEmitContinuityNudge(ctx, 5_000_000));

    const count = await withTenantContext(tenantId, (ctx) =>
      ctx.sql
        .exec<{ n: number }>(`SELECT COUNT(*) as n FROM tenant_messages WHERE tenant_id = ? AND kind = ?`, ctx.tenantId, CONTINUITY_NUDGE_KIND)
        .one().n,
    );
    expect(count).toBe(0);
  });
});

describe("THE R2 LOOP, asserted directly — the nudge's own row must not sustain the check", () => {
  it("after emitting, deriveNextSteps' owedCount is UNCHANGED by the nudge's own message", async () => {
    const tenantId = await seedStalledDomainTenant();
    const before = await withTenantContext(tenantId, (ctx) => owedSignals(deriveNextSteps(ctx)));
    expect(before.owedCount).toBeGreaterThan(0);

    await withTenantContext(tenantId, (ctx) => maybeEmitContinuityNudge(ctx, 5_000_000));

    const after = await withTenantContext(tenantId, (ctx) => owedSignals(deriveNextSteps(ctx)));
    expect(after.owedCount).toBe(before.owedCount);
    expect(after.owedReasons).not.toContain("message_action_required");
  });

  it("once the REAL condition clears, owedCount reaches ZERO despite the nudge's row still sitting unacked", async () => {
    const tenantId = await seedStalledDomainTenant();
    await withTenantContext(tenantId, (ctx) => maybeEmitContinuityNudge(ctx, 5_000_000));

    // The nudge message is still there, unacked — and the real condition
    // (the stalled domain) now resolves.
    await runInDurableObject(tenantStub(tenantId), (_instance, state) => {
      state.storage.sql.exec(`UPDATE domains SET dns_status = 'ready' WHERE tenant_id = ?`, tenantId);
    });

    const after = await withTenantContext(tenantId, (ctx) => owedSignals(deriveNextSteps(ctx)));
    expect(after.owedCount).toBe(0);
  });
});

describe("END-TO-END — the real watchtower wiring (sendPipelineChecks + reconcileAlerts) fires the RPC", () => {
  const T0 = 1_800_000_000_000;

  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM watchtower_state").run();
    await env.DB.prepare("DELETE FROM watchtower_cursor").run();
  });

  it("a stalled tenant gets exactly one nudge through the real sweep, and it never sustains the check", async () => {
    const tenantId = await seedStalledDomainTenant();
    const checkName = customerProgressAgentCheckName(tenantId);
    const mailer = new SandboxOpsMailer();

    const summaryAt = () => tenantStub(tenantId).opsSummary(0);

    // Tick 1: first observation — pending, no nudge (not yet an
    // alert-worthy transition).
    let summary = await summaryAt();
    await reconcileAlerts(env, mailer, sendPipelineChecks(tenantId, summary, await readReportedCheckNames(env)), T0);
    expect(
      (await withTenantContext(tenantId, (ctx) => ctx.sql.exec<{ n: number }>(`SELECT COUNT(*) as n FROM tenant_messages WHERE tenant_id = ? AND kind = ?`, ctx.tenantId, CONTINUITY_NUDGE_KIND).one().n)),
    ).toBe(0);

    // Tick 2: the confirming observation, at nowMs 24h+ past T0 — crosses
    // BOTH the 2-observation debounce (action: "alerted") AND the nudge's
    // 24h delay from the episode's onset (T0, unchanged since tick 1).
    const T1 = T0 + 24 * 3_600_000 + 1_000;
    summary = await summaryAt();
    const outcomes = await reconcileAlerts(env, mailer, sendPipelineChecks(tenantId, summary, await readReportedCheckNames(env)), T1);
    expect(outcomes.find((o) => o.name === checkName)).toEqual({ name: checkName, action: "alerted", emailSent: false, why: "digest_only" });

    const nudgeCount = await withTenantContext(tenantId, (ctx) =>
      ctx.sql.exec<{ n: number }>(`SELECT COUNT(*) as n FROM tenant_messages WHERE tenant_id = ? AND kind = ?`, ctx.tenantId, CONTINUITY_NUDGE_KIND).one().n,
    );
    expect(nudgeCount).toBe(1);

    // Tick 3: another sweep, same episode — the R2 loop's decisive proof.
    // If the nudge's own row wrongly counted as `message_action_required`,
    // owedCount would have grown, sinceTs bookkeeping aside; it must not.
    const T2 = T1 + 300_000;
    summary = await summaryAt();
    const thirdOutcomes = await reconcileAlerts(env, mailer, sendPipelineChecks(tenantId, summary, await readReportedCheckNames(env)), T2);
    expect(thirdOutcomes.find((o) => o.name === checkName)).toEqual({
      name: checkName,
      action: "suppressed",
      emailSent: false,
      why: "suppressed_cooldown",
    });

    const stillOne = await withTenantContext(tenantId, (ctx) =>
      ctx.sql.exec<{ n: number }>(`SELECT COUNT(*) as n FROM tenant_messages WHERE tenant_id = ? AND kind = ?`, ctx.tenantId, CONTINUITY_NUDGE_KIND).one().n,
    );
    expect(stillOne).toBe(1);

    const owed = await withTenantContext(tenantId, (ctx) => owedSignals(deriveNextSteps(ctx)));
    expect(owed.owedReasons).not.toContain("message_action_required");
  });
});

// NON-BLOCKING-2 and -3 (build gate 2026-08-19) — the two deviations from
// "EXACTLY ONE per stall episode, ONE DAY after onset" that survived the J3
// attack. Both are about WHEN and about WHICH EPISODE, never about how many
// per episode: the DO-side guard owns that and is untouched.
describe("NB-2/NB-3 — the nudge fires at the DELAY, and a blame flip is the SAME episode", () => {
  const T0 = 1_900_000_000_000;
  const savedDelay = env.CONTINUITY_NUDGE_DELAY_MS;

  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM watchtower_state").run();
    await env.DB.prepare("DELETE FROM watchtower_cursor").run();
    // A 1-hour delay makes the realert grid and the delay observably
    // different: the first re-alert is 6h out, so any tick between 1h and 6h
    // is `suppressed` — precisely the tick the old gate could not sample.
    Object.assign(env, { CONTINUITY_NUDGE_DELAY_MS: String(HOUR) });
  });
  afterEach(() => {
    Object.assign(env, { CONTINUITY_NUDGE_DELAY_MS: savedDelay });
  });

  const nudgeCount = (tenantId: string): Promise<number> =>
    withTenantContext(tenantId, (ctx) =>
      ctx.sql
        .exec<{ n: number }>(
          `SELECT COUNT(*) as n FROM tenant_messages WHERE tenant_id = ? AND kind = ?`,
          ctx.tenantId,
          CONTINUITY_NUDGE_KIND,
        )
        .one().n,
    );

  async function sweep(tenantId: string, mailer: SandboxOpsMailer, nowMs: number) {
    const summary = await tenantStub(tenantId).opsSummary(0);
    return reconcileAlerts(env, mailer, sendPipelineChecks(tenantId, summary, await readReportedCheckNames(env)), nowMs);
  }

  it("NB-2 — delivers on a SUPPRESSED tick once the delay has passed, not on the realert grid", async () => {
    const tenantId = await seedStalledDomainTenant();
    const checkName = customerProgressAgentCheckName(tenantId);
    const mailer = new SandboxOpsMailer();

    await sweep(tenantId, mailer, T0); // pending, age 0
    expect(await nudgeCount(tenantId)).toBe(0);

    const alertedAt = T0 + 5 * 60_000;
    const second = await sweep(tenantId, mailer, alertedAt); // alerted, age 5m < 1h
    expect(second.find((o) => o.name === checkName)?.action).toBe("alerted");
    expect(await nudgeCount(tenantId)).toBe(0);

    // 1h past ONSET, and only ~55m past the alert — inside the 6h backoff, so
    // this transition is `suppressed`. Under the old gate the delay was
    // sampled only at alerted/realerted, so the first passing sample was the
    // 24h realert rung: ~30h, whatever CONTINUITY_NUDGE_DELAY_MS said.
    const pastDelay = T0 + HOUR + 1_000;
    const third = await sweep(tenantId, mailer, pastDelay);
    expect(third.find((o) => o.name === checkName)?.action).toBe("suppressed");
    expect(await nudgeCount(tenantId)).toBe(1);
  });

  it("NB-3 — a blame flip mid-stall continues the SAME episode and never nudges twice", async () => {
    const tenantId = await seedStalledDomainTenant();
    const mailer = new SandboxOpsMailer();

    await sweep(tenantId, mailer, T0);
    await sweep(tenantId, mailer, T0 + 5 * 60_000);
    const nudgedAt = T0 + HOUR + 1_000;
    await sweep(tenantId, mailer, nudgedAt);
    expect(await nudgeCount(tenantId)).toBe(1);

    // THE FLIP. An operator_pending message adds an owed step with
    // `waitingOn: "operator"`, so `anyOwedWaitingOnOperator` turns true and the
    // blamed NAME switches. Blame really does oscillate in production — it
    // tracks a vendor wallet that dips and refills — so this is the ordinary
    // case, not a corner.
    await withTenantContext(tenantId, (ctx) =>
      emitTenantMessage(ctx, {
        kind: "setup_failed",
        severity: "operator_pending",
        body: "The platform stopped on a step only an operator can clear.",
      }),
    );

    const flippedAt = nudgedAt + 5 * 60_000;
    await sweep(tenantId, mailer, flippedAt);
    expect(await nudgeCount(tenantId), "the flip tick itself must not nudge").toBe(1);

    // A FULL DELAY after the flip. The new name's own AlertState was born at
    // `flippedAt`, so keying the episode on it would pass `sinceTs > stored`
    // here and deliver a second nudge for one continuous stall.
    await sweep(tenantId, mailer, flippedAt + HOUR + 1_000);
    expect(await nudgeCount(tenantId), "one stall, one nudge — across the blame flip").toBe(1);
  });
});
