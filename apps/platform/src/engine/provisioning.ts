import type { SetupInfrastructureInput } from "@coldstart/shared";
import { newId } from "../schema.js";
import type { TenantContext } from "../tenant-context.js";
import { assertBrandOwnership } from "./brand-guard.js";
import { refreshMailboxWarmupState } from "./mailbox-state.js";
import { computeWarmupDay, epochDay, isSendReady, warmupDailyCap, warmupStatus } from "./warmup.js";

function slugify(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 20) || "hello";
}

/**
 * setup_infrastructure — SPEC.md §6 / brief signature. Buys N lookalike
 * domains, DNS them, provisions `inboxesEach` mailboxes per domain, starts
 * warmup. Runs synchronously under the hood in B0 (the sandbox vendor calls
 * are in-memory and instant); the async resumable saga (DO alarms, retries)
 * is B2 scope. The returned jobId reflects the intent's async shape without
 * yet being backed by a tracked job record.
 */
export async function runSetupInfrastructure(
  ctx: TenantContext,
  input: SetupInfrastructureInput,
): Promise<{ jobId: string }> {
  // Lookalike third-party-brand hard-reject — BEFORE any searchLookalikes/buy
  // (ARCHITECTURE.md #8 "enforced in code"). Throws ValidationError -> HTTP 400.
  assertBrandOwnership({ brand: input.brand, primaryDomain: input.primaryDomain });

  const now = ctx.clock.now();

  ctx.sql.exec(
    `UPDATE tenant_profile SET brand = ?, physical_address = ?, sender_identity = ? WHERE id = ?`,
    input.brand,
    input.physicalAddress,
    input.senderIdentity,
    ctx.tenantId,
  );

  const candidates = await ctx.adapters.domain.searchLookalikes(input.brand, input.primaryDomain, input.domains);
  const personaSlug = slugify(input.persona);

  for (let domainIndex = 0; domainIndex < input.domains; domainIndex++) {
    const candidate = candidates[domainIndex % candidates.length];
    if (!candidate) continue;
    const domainKey = `${candidate.domain}#${domainIndex}`;

    const purchased = await ctx.adapters.domain.buy(candidate.domain, `buy:${ctx.tenantId}:${domainKey}`);
    await ctx.adapters.domain.setDns(candidate.domain, `dns:${ctx.tenantId}:${domainKey}`);

    const domainId = newId("dom");
    ctx.sql.exec(
      `INSERT INTO domains (id, tenant_id, domain, status, purchased_at) VALUES (?, ?, ?, 'active', ?)`,
      domainId,
      ctx.tenantId,
      purchased.domain,
      purchased.purchasedAt,
    );

    for (let mailboxIndex = 0; mailboxIndex < input.inboxesEach; mailboxIndex++) {
      const localPart = `${personaSlug}${domainIndex + 1}${mailboxIndex + 1}`;
      const provisioned = await ctx.adapters.mailbox.provision(
        purchased.domain,
        localPart,
        `mbx:${ctx.tenantId}:${domainKey}:${localPart}`,
      );
      const warmup = await ctx.adapters.mailbox.startWarmup(
        provisioned.email,
        `warmup:${ctx.tenantId}:${provisioned.email}`,
      );

      const day = computeWarmupDay(warmup.startedAt, now);
      ctx.sql.exec(
        `INSERT INTO mailboxes
           (id, tenant_id, domain_id, domain, email, daily_cap, sent_today, sent_today_epoch_day, status, warmup_started_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
        newId("mbx"),
        ctx.tenantId,
        domainId,
        purchased.domain,
        provisioned.email,
        warmupDailyCap(day),
        epochDay(now),
        warmupStatus(day),
        warmup.startedAt,
        now,
      );
    }
  }

  return { jobId: newId("job") };
}

export interface MailboxHealthReport {
  email: string;
  domain: string;
  status: string;
  warmupDay: number;
  dailyCap: number;
  sentToday: number;
  sendReady: boolean;
}

export interface InfrastructureStatus {
  domains: number;
  mailboxes: number;
  mailboxHealth: MailboxHealthReport[];
  sendReady: boolean;
}

export function getInfrastructureStatus(ctx: TenantContext): InfrastructureStatus {
  refreshMailboxWarmupState(ctx);
  const now = ctx.clock.now();
  const domainCount = ctx.sql
    .exec<{ n: number }>(`SELECT COUNT(*) as n FROM domains WHERE tenant_id = ?`, ctx.tenantId)
    .one().n;

  const mailboxRows = ctx.sql
    .exec<{
      email: string;
      domain: string;
      warmup_started_at: number;
      sent_today: number;
    }>(`SELECT email, domain, warmup_started_at, sent_today FROM mailboxes WHERE tenant_id = ?`, ctx.tenantId)
    .toArray();

  const mailboxHealth: MailboxHealthReport[] = mailboxRows.map((row) => {
    const day = computeWarmupDay(row.warmup_started_at, now);
    return {
      email: row.email,
      domain: row.domain,
      status: warmupStatus(day),
      warmupDay: day,
      dailyCap: warmupDailyCap(day),
      sentToday: row.sent_today,
      sendReady: isSendReady(day),
    };
  });

  return {
    domains: domainCount,
    mailboxes: mailboxHealth.length,
    mailboxHealth,
    sendReady: mailboxHealth.length > 0 && mailboxHealth.every((m) => m.sendReady),
  };
}
