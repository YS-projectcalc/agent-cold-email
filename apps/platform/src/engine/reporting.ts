import { NotFoundError } from "@coldstart/shared";
import type { TenantContext } from "../tenant-context.js";
import { capFor } from "./quota.js";

// campaign_results() / metrics() — SPEC.md §6: "replies, bounces,
// complaints... (opens OFF by default)". Opens are never tracked anywhere
// in this schema, so there's nothing to accidentally leak.
export interface EventCounts {
  sent: number;
  reply: number;
  bounce: number;
  complaint: number;
  unsubscribe: number;
  failed: number;
}

function emptyCounts(): EventCounts {
  return { sent: 0, reply: 0, bounce: 0, complaint: 0, unsubscribe: 0, failed: 0 };
}

function countEvents(ctx: TenantContext, campaignId?: string): EventCounts {
  const rows = campaignId
    ? ctx.sql
        .exec<{ type: keyof EventCounts; n: number }>(
          `SELECT type, COUNT(*) as n FROM events WHERE tenant_id = ? AND campaign_id = ? GROUP BY type`,
          ctx.tenantId,
          campaignId,
        )
        .toArray()
    : ctx.sql
        .exec<{ type: keyof EventCounts; n: number }>(
          `SELECT type, COUNT(*) as n FROM events WHERE tenant_id = ? GROUP BY type`,
          ctx.tenantId,
        )
        .toArray();

  const counts = emptyCounts();
  for (const row of rows) counts[row.type] = row.n;
  return counts;
}

export function getCampaignResults(ctx: TenantContext, campaignId: string): { campaignId: string } & EventCounts {
  const exists = ctx.sql
    .exec<{ n: number }>(
      `SELECT COUNT(*) as n FROM campaigns WHERE id = ? AND tenant_id = ?`,
      campaignId,
      ctx.tenantId,
    )
    .one().n;
  if (exists === 0) throw new NotFoundError(`campaign ${campaignId} not found`);
  return { campaignId, ...countEvents(ctx, campaignId) };
}

export function getMetrics(ctx: TenantContext): EventCounts {
  return countEvents(ctx);
}

export interface AccountSummary {
  tenantId: string;
  brand: string;
  plan: string;
  status: string;
  billingState: string;
  domains: number;
  mailboxes: number;
  campaigns: number;
  leads: number;
  sends: number;
  usageCents: number;
  /** The domains/mailboxes cap governing this tenant's current plan — see engine/quota.ts. */
  quota: { domains: number; mailboxes: number };
}

export function getAccount(ctx: TenantContext): AccountSummary {
  const profile = ctx.sql
    .exec<{ brand: string; plan: string; status: string; billing_state: string }>(
      `SELECT brand, plan, status, billing_state FROM tenant_profile WHERE id = ?`,
      ctx.tenantId,
    )
    .one();

  const count = (table: string): number =>
    ctx.sql.exec<{ n: number }>(`SELECT COUNT(*) as n FROM ${table} WHERE tenant_id = ?`, ctx.tenantId).one().n;

  const sends = ctx.sql
    .exec<{ n: number }>(`SELECT COUNT(*) as n FROM events WHERE tenant_id = ? AND type = 'sent'`, ctx.tenantId)
    .one().n;

  const usageCents = ctx.sql
    .exec<{ total: number | null }>(
      `SELECT SUM(amount_cents) as total FROM ledger_entries WHERE tenant_id = ? AND kind = 'usage'`,
      ctx.tenantId,
    )
    .one().total ?? 0;

  return {
    tenantId: ctx.tenantId,
    brand: profile.brand,
    plan: profile.plan,
    status: profile.status,
    billingState: profile.billing_state,
    domains: count("domains"),
    mailboxes: count("mailboxes"),
    campaigns: count("campaigns"),
    leads: count("leads"),
    sends,
    usageCents,
    quota: capFor(ctx.plan),
  };
}
