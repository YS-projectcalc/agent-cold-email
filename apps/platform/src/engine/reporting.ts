import { NotFoundError } from "@coldstart/shared";
import type { TenantContext } from "../tenant-context.js";
import {
  deriveActivationState,
  realSendPathLive,
  type ActivationSurfaceState,
} from "./activation.js";
import { getTeardownSummary, type TeardownSummary } from "./lifecycle.js";
import { capFor } from "./quota.js";

// campaign_results() / metrics() — SPEC.md §6: "replies, bounces,
// complaints... (opens OFF by default)". Opens are never tracked anywhere
// in this schema, so there's nothing to accidentally leak.
export interface EventCounts {
  sent: number;
  reply: number;
  /** HARD (permanent 5.x.x) bounces (A2). Soft bounces are counted separately below. */
  bounce: number;
  complaint: number;
  unsubscribe: number;
  failed: number;
  /** SOFT (transient 4.x.x) bounces — tallied but not a permanent suppression (A2). */
  soft_bounce: number;
}

// Exported so engine/campaigns.ts's listCampaigns() (§19.4 GET /campaigns)
// can build a zero-filled row for a campaign with no events yet, matching
// this file's own shape (CLAUDE.md rule c: one definition of "empty counts").
export function emptyEventCounts(): EventCounts {
  return { sent: 0, reply: 0, bounce: 0, complaint: 0, unsubscribe: 0, failed: 0, soft_bounce: 0 };
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

  const counts = emptyEventCounts();
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

export interface DeliverabilityAudit {
  action: string;
  target: string;
  ts: number;
  detail: Record<string, unknown>;
}

export interface DeliverabilitySummary {
  /** Mailboxes the control loop has paused (crossed a hard threshold). */
  pausedMailboxes: number;
  /** Mailboxes the control loop has throttled (reduced daily cap). */
  throttledMailboxes: number;
  /** Domains retired as 'burning' by the loop. */
  burningDomains: number;
  /** Replacement domains the loop has auto-provisioned. */
  domainsReplaced: number;
  /** Most-recent loop actions (newest first) so the agent can see the loop working. */
  recentActions: DeliverabilityAudit[];
}

export interface AccountSummary {
  tenantId: string;
  brand: string;
  plan: string;
  status: string;
  billingState: string;
  /** G3 — the HONEST activation state (design §G3 parity law). NEVER claims
   *  'active' while the tenant is really on the sandbox port. 'pending_provisioning'
   *  = paid, infra being armed, sandbox previews only; 'capacity_pending' = a
   *  spend/slot gate is holding provisioning; 'screening_hold' = under review. */
  activationState: ActivationSurfaceState;
  domains: number;
  mailboxes: number;
  campaigns: number;
  leads: number;
  sends: number;
  usageCents: number;
  /** The domains/mailboxes cap governing this tenant's current plan — see engine/quota.ts. */
  quota: { domains: number; mailboxes: number };
  /** B6 — what the AI deliverability control loop has done for this tenant. */
  deliverability: DeliverabilitySummary;
  /** D5 — the infra reclaim summary once the tenant has been canceled/terminated; null while live. */
  teardown: TeardownSummary | null;
}

// Exported (not just used by getAccount below) so engine/ops-summary.ts
// (the D6 owner digest) can reuse the exact same per-tenant deliverability
// rollup instead of re-deriving it (CLAUDE.md rule c).
export function getDeliverabilitySummary(ctx: TenantContext): DeliverabilitySummary {
  const countMailbox = (delivStatus: string): number =>
    ctx.sql
      .exec<{ n: number }>(
        `SELECT COUNT(*) as n FROM mailboxes WHERE tenant_id = ? AND deliv_status = ?`,
        ctx.tenantId,
        delivStatus,
      )
      .one().n;

  const burningDomains = ctx.sql
    .exec<{ n: number }>(
      `SELECT COUNT(*) as n FROM domains WHERE tenant_id = ? AND status = 'burning'`,
      ctx.tenantId,
    )
    .one().n;

  const domainsReplaced = ctx.sql
    .exec<{ n: number }>(
      `SELECT COUNT(*) as n FROM deliverability_actions WHERE tenant_id = ? AND action = 'REPLACE_DOMAIN'`,
      ctx.tenantId,
    )
    .one().n;

  const recentActions = ctx.sql
    .exec<{ action: string; target: string; ts: number; detail_json: string }>(
      `SELECT action, target, ts, detail_json FROM deliverability_actions
       WHERE tenant_id = ? ORDER BY ts DESC, rowid DESC LIMIT 20`,
      ctx.tenantId,
    )
    .toArray()
    .map((r) => ({
      action: r.action,
      target: r.target,
      ts: r.ts,
      detail: JSON.parse(r.detail_json) as Record<string, unknown>,
    }));

  return {
    pausedMailboxes: countMailbox("paused"),
    throttledMailboxes: countMailbox("throttled"),
    burningDomains,
    domainsReplaced,
    recentActions,
  };
}

export function getAccount(ctx: TenantContext): AccountSummary {
  const profile = ctx.sql
    .exec<{ brand: string; plan: string; status: string; billing_state: string; provisioning_state: string; screening_status: "clear" | "review" }>(
      `SELECT brand, plan, status, billing_state, provisioning_state, screening_status FROM tenant_profile WHERE id = ?`,
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

  // G3 — derive the honest activation state. `screening` is the REAL G1b
  // column read (same row as the rest of this profile query — the stub this
  // seam carried pre-OFAC-merge is gone). realSendPathLive reads env (engine +
  // InboxKit both armed — adversary B2).
  const activationState = deriveActivationState({
    plan: ctx.plan,
    status: profile.status,
    billingState: profile.billing_state,
    screening: profile.screening_status,
    realSendPathLive: realSendPathLive(ctx.env),
    capacityPending: profile.provisioning_state === "capacity_pending",
  });

  return {
    tenantId: ctx.tenantId,
    brand: profile.brand,
    plan: profile.plan,
    status: profile.status,
    billingState: profile.billing_state,
    activationState,
    domains: count("domains"),
    mailboxes: count("mailboxes"),
    campaigns: count("campaigns"),
    leads: count("leads"),
    sends,
    usageCents,
    quota: capFor(ctx.plan),
    deliverability: getDeliverabilitySummary(ctx),
    teardown: getTeardownSummary(ctx),
  };
}
