/**
 * `infrastructure_status` — the READ-ONLY view of a tenant's provisioned infra.
 *
 * Split out of engine/provisioning.ts (CLAUDE.md rule b): provisioning WRITES
 * and this READS, and the write half had grown past the point where the two
 * belonged in one file. No behaviour moved with it.
 */

import type { MailboxHealth } from "@coldstart/shared";
import type { TenantContext } from "../tenant-context.js";
import { customerSafeVendorDetail, logVendorFailure } from "../vendor-failure.js";
import { gatherMailboxHealth } from "./deliverability.js";
import { logAction } from "./deliverability-actions.js";
import { computeMailboxWarmupSnapshot } from "./mailbox-state.js";
import { listSurfacedTenantMessages, type TenantMessage } from "./tenant-messages.js";

// The one sentence a customer surface says when a mailbox's health lookup fails.
// Deliberately identical in the report field and the activity row so the two
// cannot drift into naming different things.
const MAILBOX_HEALTH_UNAVAILABLE_REASON = "mailbox health check temporarily unavailable";

export interface MailboxHealthReport {
  email: string;
  domain: string;
  status: string;
  warmupDay: number;
  dailyCap: number;
  sentToday: number;
  sendReady: boolean;
  // B6 deliverability signals surfaced so the customer's agent can see the
  // control loop working: our own throttle/pause state + observed first-party
  // rates (fractions, 0-1) + the vendor-reported reputation/placement.
  delivStatus: string;
  sends: number;
  complaintRate: number;
  bounceRate: number;
  /** Soft (transient 4.x.x) bounce fraction — visible here but never triggers pause/burn (A3). */
  softBounceRate: number;
  // Gate (d) — display honesty (adversary inboxkit-adapters-2026-07-20 finding
  // 4): these are VENDOR-REPORTED approximations (InboxKit's coarse
  // health_status enum -> a 0-100 score, and the bounce-rate complement as a
  // placement PROXY — NOT a real inbox-placement test), never first-party
  // measurements. The control loop's burn/pause decisions use local counts
  // ONLY; these two are display-only. The `vendor*` prefix carries that
  // provenance so a consuming agent never treats them as measured (the pre-fix
  // `reputationScore`/`placementRate` names read as first-party truth).
  /** H-status (pipeline F4) — 'ok' when the vendor health lookup succeeded,
   * 'unknown' when it failed for THIS mailbox. The two `vendor*` numbers below
   * are 0 and meaningless when this is 'unknown'; previously that case took the
   * whole endpoint down with a 500 instead. */
  vendorHealth: "ok" | "unknown";
  /**
   * Why the lookup failed — an ABSTRACT, provider-blind sentence, null when
   * `vendorHealth` is 'ok'. This field used to carry the adapter's raw
   * `err.message`, which names the provider and the exact endpoint that failed
   * (`infrastructure_status` is the ONE endpoint the tool description tells a
   * customer's agent to poll, so it was the widest leak of the set —
   * docs/adversarial/sweep-vendor-leak-2026-08-05.md). The operator's version of
   * this failure goes to the Worker log instead.
   */
  vendorHealthError: string | null;
  vendorReputationScore: number;
  vendorPlacementRate: number;
  /** SPEC.md §19.2/§19.6 [F7] — last time runPollInbox() polled this mailbox (engine/reply-processor.ts); null before the first poll. Backs the Settings→Mailboxes "last polled" UI claim. */
  lastPolledAt: number | null;
}

export interface InfrastructureStatus {
  domains: number;
  mailboxes: number;
  mailboxHealth: MailboxHealthReport[];
  sendReady: boolean;
  // System->agent message channel, increment 1 (founder-approved 2026-08-05,
  // engine/tenant-messages.ts) — system notices (a retryable setup step, a
  // credential going live) surfaced here so the customer's agent sees them
  // without a human relay. Unread-first, newest-first, capped at 5, expired
  // rows filtered out.
  messages: TenantMessage[];
}

export async function getInfrastructureStatus(ctx: TenantContext): Promise<InfrastructureStatus> {
  // Read-only: computes the same live warmup dailyCap/sentToday the tick
  // would persist, WITHOUT writing (MCP readOnlyHint: true — see
  // mailbox-state.ts's computeMailboxWarmupSnapshot doc). `s.warmupStatus`
  // below is already freshly computed by gatherMailboxHealth (never read
  // from the possibly-stale DB `status` column), so only dailyCap/sentToday
  // need overriding from the snapshot.
  const warmupSnapshot = computeMailboxWarmupSnapshot(ctx);
  // LIVE domains only. This count is what a customer's agent reads back to
  // decide whether its infrastructure exists, and an unfiltered COUNT keeps
  // reporting a domain that teardown handed back to the registrar
  // (engine/lifecycle.ts's release) — so a canceled-then-reprovisioned tenant
  // is told it holds more than it does. `status != 'released'` is the same
  // predicate every reader that acts on a domain already uses
  // (engine/provisioning.ts's liveDomainForIntent / findAdoptableDomain,
  // lifecycle.ts's teardown scan), deliberately: a third definition of "live"
  // is how the two guards in the 2026-08-13 P0 came to disagree.
  const domainCount = ctx.sql
    .exec<{ n: number }>(
      `SELECT COUNT(*) as n FROM domains WHERE tenant_id = ? AND status != 'released'`,
      ctx.tenantId,
    )
    .one().n;

  const signals = gatherMailboxHealth(ctx);
  // Collected during the fan-out, written after it: the activity row records the
  // ABSTRACT failure detail, which the customer-facing report shape has no field
  // to carry (and should not — it is one sentence there, not a structure).
  const degraded: { email: string; detail: Record<string, unknown> }[] = [];
  const mailboxHealth: MailboxHealthReport[] = await Promise.all(
    signals.map(async (s) => {
      // Vendor-reported reputation/placement (SPEC.md §10 raw signal, Inboxkit
      // in the real adapter) — display-only, surfaced under `vendor*` names
      // (gate (d)). On-demand here, NOT on the hot tick path.
      // H-status (INCIDENT 2026-08-05, pipeline F4) — PER-MAILBOX isolation.
      // This fan-out was an unguarded Promise.all, so ONE rejection blanked the
      // whole response into a 500. `resolveMailboxUid` throws a PERMANENT
      // VendorError when the vendor has no matching mailbox — exactly what a
      // half-failed saga leaves behind — which bricked `infrastructure_status`
      // forever for that tenant, with no API path to repair it. It is the one
      // endpoint the tool description tells the agent to poll, so it must
      // degrade, never disappear: the mailbox reports vendorHealth 'unknown'
      // and the rest of the response (including every OTHER mailbox) survives.
      let vendor: MailboxHealth | null = null;
      let vendorHealthError: string | null = null;
      try {
        vendor = await ctx.adapters.mailbox.getHealth(s.email);
      } catch (err) {
        logVendorFailure(`getHealth ${s.email}`, err);
        degraded.push({ email: s.email, detail: customerSafeVendorDetail(err, MAILBOX_HEALTH_UNAVAILABLE_REASON) });
        vendorHealthError = MAILBOX_HEALTH_UNAVAILABLE_REASON;
      }
      const snapshot = warmupSnapshot.get(s.mailboxId);
      return {
        email: s.email,
        domain: s.domain,
        status: s.warmupStatus,
        warmupDay: s.warmupDay,
        dailyCap: snapshot?.dailyCap ?? s.dailyCap,
        sentToday: snapshot?.sentToday ?? s.sentToday,
        sendReady: s.sendReady,
        delivStatus: s.delivStatus,
        sends: s.sends,
        complaintRate: s.complaintRate,
        bounceRate: s.bounceRate,
        softBounceRate: s.softBounceRate,
        // 'ok' | 'unknown' — whether the VENDOR-reported pair below could be
        // fetched at all. Distinguishes "the vendor says 0" from "we could not
        // ask", which the previous 0-or-500 shape could not express.
        vendorHealth: vendor ? ("ok" as const) : ("unknown" as const),
        vendorHealthError,
        vendorReputationScore: vendor?.reputationScore ?? 0,
        vendorPlacementRate: vendor?.placementRate ?? 0,
        lastPolledAt: s.lastPolledAt,
      };
    }),
  );
  // Operator-visible, once per degraded mailbox per call: a permanently-failing
  // health lookup usually means a local row with no vendor counterpart, which
  // is a saga remnant someone has to reconcile. The row is customer-readable
  // (account().recentActions), so it carries the abstract step, never the
  // adapter's text — the raw failure already went to the Worker log above.
  for (const { email, detail } of degraded) {
    logAction(ctx, "MAILBOX_HEALTH_UNAVAILABLE", email, detail);
  }

  return {
    domains: domainCount,
    mailboxes: mailboxHealth.length,
    mailboxHealth,
    // Send-readiness ignores paused/throttled state (it's a warmup concept);
    // a paused mailbox still counts as warmed. delivStatus surfaces the pause.
    sendReady: mailboxHealth.length > 0 && mailboxHealth.every((m) => m.sendReady),
    // Pure SELECT (GUARDRAIL: never inserts) — see listSurfacedTenantMessages.
    messages: listSurfacedTenantMessages(ctx),
  };
}
