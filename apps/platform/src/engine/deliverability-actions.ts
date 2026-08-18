// B6 — the ACT half of the deliverability control loop (the DECIDE half is
// engine/deliverability.ts). `applyActions` mutates DO state for each action
// the pure `evaluate` produced; `runDeliverabilitySweep` is the one entry point
// the tick calls each cycle (monitor -> decide -> act) BEFORE scheduling sends.

import { DomainDnsTerminalError, RegistrarUnarmedError, VendorError } from "@coldstart/shared";
import { escapeHtml } from "../html-escape.js";
import { lookupTenantContactEmail } from "../db.js";
import { createOpsMailer, type OpsMailer } from "../ops-mail/ops-mailer.js";
import { newId } from "../schema.js";
import type { TenantContext } from "../tenant-context.js";
import { customerSafeVendorDetail, logVendorFailure } from "../vendor-failure.js";
import { syncMailboxQuantity } from "./billing.js";
import { releaseMailboxes } from "./lifecycle.js";
import { alertRegistrarUnarmed } from "./registrar-alert.js";
import { isLifecycleFrozen, readLifecycleState } from "./billing-state.js";
import {
  DEFAULT_THRESHOLDS,
  evaluate,
  gatherDomainStats,
  gatherMailboxHealth,
  type DeliverabilityAction,
  type DeliverabilityThresholds,
} from "./deliverability.js";
import { forEachIsolated } from "../isolated-loop.js";
import { replacementDomainIntentKey } from "./provision-intents.js";
import { provisionDomainWithMailboxes, slugify } from "./provisioning.js";
import { ONE_DAY_MS } from "./warmup.js";

// Domain-replacement rate cap: at most this many auto-provisioned replacements
// per rolling window, so a replacement domain that ALSO burns can never spawn
// an infinite chain (SPEC.md §7: burn is normal, replacement is a feature — but
// a runaway is not). Over the cap, the burning domain is still retired + its
// mailboxes paused; only the new-domain provisioning is withheld (+ logged).
const MAX_REPLACEMENTS_PER_WINDOW = 3;
const REPLACEMENT_WINDOW_MS = 30 * ONE_DAY_MS;

/** Appends one ops-visible system action (activity feed + infrastructure_status).
 * Exported for engine/warmup-cancel.ts, which records ramp-completion warmup
 * cancellations through this SAME writer rather than a second insert. */
export function logAction(ctx: TenantContext, action: string, target: string, detail: Record<string, unknown>): void {
  ctx.sql.exec(
    `INSERT INTO deliverability_actions (id, tenant_id, action, target, detail_json, ts) VALUES (?, ?, ?, ?, ?, ?)`,
    newId("dact"),
    ctx.tenantId,
    action,
    target,
    JSON.stringify(detail),
    ctx.clock.now(),
  );
}

/**
 * Founder alert for a REPLACE_DOMAIN failure on a plain VendorError — the
 * sibling of registrar-alert.ts's alertRegistrarUnarmed for every OTHER
 * vendor failure on this same path (Item 4, docs/adversarial/
 * class-sweep-vendor-truth-2026-08-18.md, class B). Before this, only the
 * registrar-not-armed hard block paged the founder; a transient InboxKit
 * outage or a terminal DNS give-up on the replacement domain left the
 * customer's automatic replacement silently paused with no alert — only a
 * server `console.error` line (logVendorFailure) that nobody watches as an
 * alert channel.
 *
 * Same shape as alertRegistrarUnarmed: best-effort, gated on
 * `OPS_ALERT_EMAIL`, NEVER throws (an unsendable alert must not fail the
 * sweep that triggered it). Customer-facing wording is untouched — this is
 * purely an operator notification, `customerSafeVendorDetail`'s row (below,
 * at the call site) still owns what the tenant sees.
 */
async function alertReplaceDomainFailed(
  ctx: TenantContext,
  burningDomain: string,
  err: VendorError,
  terminal: boolean,
  mailer: OpsMailer,
): Promise<void> {
  if (!ctx.env.OPS_ALERT_EMAIL) return;
  const text =
    `Tenant ${ctx.tenantId}'s automatic domain replacement for burning domain "${burningDomain}" ` +
    `${terminal ? "bought a replacement domain and then hit a terminal DNS failure — the replacement has been abandoned" : "failed"}.\n\n` +
    `${err.message}\n\n` +
    `Automatic domain replacement is paused for this tenant until the underlying issue clears.`;
  try {
    await mailer.send({
      to: ctx.env.OPS_ALERT_EMAIL,
      subject: `[coldrig] domain replacement failed (tenant ${ctx.tenantId})`,
      text,
      html: `<p>${escapeHtml(text).replace(/\n/g, "<br>")}</p>`,
    });
  } catch (mailErr) {
    console.error(`replace-domain-failed alert: send to ${ctx.env.OPS_ALERT_EMAIL} failed (dark or transient)`, mailErr);
  }
}

function applyThrottle(
  ctx: TenantContext,
  action: Extract<DeliverabilityAction, { type: "THROTTLE" }>,
): void {
  // cap_override persists the throttle so mailbox-state.ts's per-tick warmup
  // recompute can't lift the cap back up; daily_cap is lowered now so the send
  // loop in this very tick already respects it.
  ctx.sql.exec(
    `UPDATE mailboxes SET deliv_status = 'throttled', cap_override = ?, daily_cap = MIN(daily_cap, ?)
     WHERE id = ? AND tenant_id = ?`,
    action.newCap,
    action.newCap,
    action.mailboxId,
    ctx.tenantId,
  );
  logAction(ctx, "THROTTLE", action.email, { mailboxId: action.mailboxId, newCap: action.newCap, reason: action.reason });
}

function applyPause(ctx: TenantContext, action: Extract<DeliverabilityAction, { type: "PAUSE" }>): void {
  // Idempotent: the conditional guard means re-pausing an already-paused
  // mailbox writes nothing and logs nothing (panel #2 lesson).
  const res = ctx.sql.exec(
    `UPDATE mailboxes SET deliv_status = 'paused' WHERE id = ? AND tenant_id = ? AND deliv_status != 'paused'`,
    action.mailboxId,
    ctx.tenantId,
  );
  if (res.rowsWritten > 0) {
    logAction(ctx, "PAUSE", action.email, { mailboxId: action.mailboxId, reason: action.reason });
  }
}

function pauseDomainMailboxes(ctx: TenantContext, domainId: string): void {
  ctx.sql.exec(
    `UPDATE mailboxes SET deliv_status = 'paused' WHERE tenant_id = ? AND domain_id = ? AND deliv_status != 'paused'`,
    ctx.tenantId,
    domainId,
  );
}

/**
 * Replacement ATTEMPTS THAT CONSUMED A DOMAIN in the rolling window.
 *
 * It counts two actions, not one. `REPLACE_DOMAIN` is a replacement that
 * completed. `REPLACE_DOMAIN_TERMINAL` is one that bought a domain and then hit
 * a TERMINAL vendor verdict on it (vendor-verdict class fix) — money moved, the
 * domain exists, and it will never work.
 *
 * WHY THE SECOND ONE HAS TO COUNT (corrected, gate delta NOTE 3,
 * docs/adversarial/vendor-verdict-gate-2026-08-14.md — the accounting is
 * conservative spend-cap consumption, NOT a loop-breaker: `applyReplaceDomain`
 * flips the burning domain to 'burning' unconditionally BEFORE the attempt, and
 * `evaluate()` (engine/deliverability.ts) skips any non-'active' domain, so
 * nothing ever re-enters a REPLACE_DOMAIN for the SAME burn — an infinite
 * re-buy loop on one domain cannot occur either way). What DOES happen without
 * counting it: a terminal replacement burned real money (one domain bought)
 * that a per-window SPEND cap meant to catch would silently miss, since the cap
 * only ever saw `REPLACE_DOMAIN_FAILED` as free. Counting it is what makes the
 * cap describe actual spend rather than only successful spend.
 *
 * Deliberately narrow: an ordinary transient failure, and a
 * RegistrarUnarmedError (which never reaches a purchase at all), stay
 * `REPLACE_DOMAIN_FAILED` and stay uncounted — capping those would withhold
 * legitimate replacements over conditions that cost nothing and do heal.
 */
function countReplacementsInWindow(ctx: TenantContext): number {
  return ctx.sql
    .exec<{ n: number }>(
      `SELECT COUNT(*) as n FROM deliverability_actions
       WHERE tenant_id = ? AND action IN ('REPLACE_DOMAIN', 'REPLACE_DOMAIN_TERMINAL') AND ts >= ?`,
      ctx.tenantId,
      ctx.clock.now() - REPLACEMENT_WINDOW_MS,
    )
    .one().n;
}

async function pickReplacementDomain(ctx: TenantContext, brand: string, primaryDomain: string): Promise<string> {
  const owned = new Set(
    ctx.sql
      .exec<{ domain: string }>(`SELECT domain FROM domains WHERE tenant_id = ?`, ctx.tenantId)
      .toArray()
      .map((r) => r.domain),
  );
  const candidates = await ctx.adapters.domain.searchLookalikes(brand, primaryDomain, owned.size + 4);
  const fresh = candidates.find((c) => !owned.has(c.domain));
  if (fresh) return fresh.domain;
  // Fallback if the lookalike generator is exhausted — deterministic + unique.
  const slug = slugify(brand);
  let i = 1;
  while (owned.has(`${slug}-r${i}.com`)) i++;
  return `${slug}-r${i}.com`;
}

async function applyReplaceDomain(
  ctx: TenantContext,
  action: Extract<DeliverabilityAction, { type: "REPLACE_DOMAIN" }>,
  mailer: OpsMailer,
): Promise<void> {
  // Retire the burning domain + stop all its mailboxes FIRST, unconditionally —
  // even if we can't provision a replacement, we must stop sending from it.
  ctx.sql.exec(
    `UPDATE domains SET status = 'burning' WHERE id = ? AND tenant_id = ? AND status = 'active'`,
    action.domainId,
    ctx.tenantId,
  );
  pauseDomainMailboxes(ctx, action.domainId);

  try {
    // §7.1 REQUIRED (adversary B2-rework) — RELEASE the burned domain's mailboxes
    // on the UNCONDITIONAL retire leg, BEFORE the replacement-vs-withhold decision,
    // so the swap is bill-NEUTRAL-or-lowering in every branch: replacement succeeds
    // -> release N then provision N = net 0; withheld / vendor-throw -> release N,
    // no provision = -N. Without this the burned mailboxes keep `released_at IS NULL`,
    // keep counting, and the autonomous reconcile would push set-to-2N — a silent
    // double-bill (SPEC §18 "no silent capacity addition") + a G4 vendor-slot leak.
    // Reuses the teardown release path (revoke-before-mark ordering preserved).
    //
    // INSIDE the try since the head-of-line class sweep (2026-08-17, IN-2): it
    // used to sit ABOVE it, which everyone read as "this is the isolated part",
    // and its throw escaped applyActions, escaped runDeliverabilitySweep, and
    // escaped tick.ts's unwrapped call — so one unreleasable mailbox stopped the
    // tenant's entire send loop, every cycle, while its reputation burned. The
    // `finally` below now also covers it, so the meter is truthful on that path.
    const release = await releaseMailboxes(ctx, { domainId: action.domainId });
    if (release.failedCount > 0) {
      // §7.1 bill-neutrality is a PRECONDITION of the replacement, not a
      // side effect of it: provisioning N fresh mailboxes while N burned ones
      // are still un-released and still counted is exactly the silent
      // double-bill the release above exists to prevent. Withhold the
      // replacement (the burning domain is already retired + paused, so nothing
      // unsafe keeps sending) and say so.
      logAction(ctx, "REPLACE_DOMAIN_WITHHELD_UNRELEASED", action.domain, {
        domainId: action.domainId,
        reason: action.reason,
        unreleasedMailboxes: release.failedCount,
        note: "burning domain retired + mailboxes paused; replacement withheld because some mailboxes could not be released and would double-bill",
      });
      return;
    }

    if (countReplacementsInWindow(ctx) >= MAX_REPLACEMENTS_PER_WINDOW) {
      // Spawn cap hit: retire but do NOT provision — prevents an infinite
      // burn->replace->burn chain. Surfaced so the agent/owner can intervene.
      // The burned mailboxes were already released above -> this leg is -N.
      logAction(ctx, "REPLACE_DOMAIN_CAPPED", action.domain, {
        domainId: action.domainId,
        reason: action.reason,
        cap: MAX_REPLACEMENTS_PER_WINDOW,
        note: "retired + mailboxes released; replacement withheld (per-window cap reached)",
      });
      return;
    }

    const profile = ctx.sql
      .exec<{ brand: string; primary_domain: string }>(
        `SELECT brand, primary_domain FROM tenant_profile WHERE id = ?`,
        ctx.tenantId,
      )
      .one();

    // inboxesEach is the burned domain's ORIGINAL mailbox count (this query does
    // NOT filter released_at, so the just-released rows still count) — so we
    // provision exactly N replacements and the swap nets to zero.
    const inboxesEach = Math.max(
      1,
      ctx.sql
        .exec<{ n: number }>(
          `SELECT COUNT(*) as n FROM mailboxes WHERE tenant_id = ? AND domain_id = ?`,
          ctx.tenantId,
          action.domainId,
        )
        .one().n,
    );
    const domainIndex = ctx.sql
      .exec<{ n: number }>(`SELECT COUNT(*) as n FROM domains WHERE tenant_id = ?`, ctx.tenantId)
      .one().n;

    // N-G5-2 (ga-gates G5 build review) — VendorError isolation. The burning domain
    // is already retired + its mailboxes released ABOVE (unconditionally), so no
    // unsafe sending continues regardless of what happens next. The replacement's
    // vendor calls (searchLookalikes → domain.buy → mailbox.provision) CAN throw a
    // VendorError once the real vendor path is armed — a RegistrarUnarmedError (G5
    // gate (a) hard-block), a CapacityPendingError (G2/G4 ceiling), or a transient
    // upstream error. Unlike setup_infrastructure (a request the caller can 503),
    // this runs inside the tick's deliverability sweep — an unguarded throw would
    // crash the WHOLE tick for this tenant (no sends scheduled) and produce only a
    // console.error, no founder alert. Isolate it here (mirroring
    // runSetupInfrastructure's catch): alert the founder on the registrar block,
    // log the withheld replacement ops-visibly, and let the sweep/tick continue.
    try {
      const replacementDomain = await pickReplacementDomain(ctx, profile.brand, profile.primary_domain);
      const provisioned = await provisionDomainWithMailboxes(ctx, {
        domain: replacementDomain,
        domainIndex,
        personaSlug: slugify(profile.brand),
        inboxesEach,
        // H1 — REPLACE_DOMAIN has no caller idempotency key, so its intents key
        // off the burned domain being replaced (replacementDomainIntentKey): a
        // re-swept replacement for the SAME burn resolves to the same intent
        // row (and so adopts a stranded buy) rather than minting a fresh one
        // each sweep.
        intentKey: replacementDomainIntentKey(ctx.tenantId, action.domain, domainIndex),
      });

      logAction(ctx, "REPLACE_DOMAIN", action.domain, {
        burningDomainId: action.domainId,
        replacementDomain: provisioned.domain,
        replacementDomainId: provisioned.domainId,
        mailboxesProvisioned: provisioned.mailboxEmails.length,
        reason: action.reason,
      });
    } catch (err) {
      if (!(err instanceof VendorError)) throw err; // a genuine bug (not a vendor signal) must NOT be swallowed
      // A TERMINAL vendor verdict on the replacement's own domain is recorded
      // under its OWN action, because countReplacementsInWindow counts it
      // (see that function): the replacement DID buy a domain, and without that
      // accounting this sweep buys another one every pass, forever. Narrowed by
      // `instanceof` in-process, where the prototype is intact — this catch is
      // in the same DO invocation as the throw, unlike the HTTP surface.
      const terminal = err instanceof DomainDnsTerminalError;
      if (err instanceof RegistrarUnarmedError) {
        await alertRegistrarUnarmed(ctx, profile.primary_domain, err, mailer);
      } else {
        // Item 4 (docs/adversarial/class-sweep-vendor-truth-2026-08-18.md, class
        // B): every OTHER VendorError on this path — a transient InboxKit outage,
        // a terminal DNS give-up on the replacement — used to alert nobody, only
        // logVendorFailure below (a server log line, never read as an alert
        // channel). Same alert machinery as the registrar-unarmed sibling (best-
        // effort, never throws, gated on OPS_ALERT_EMAIL); customer wording is
        // unchanged (customerSafeVendorDetail below still owns it).
        await alertReplaceDomainFailed(ctx, action.domain, err, terminal, mailer);
      }
      // The raw vendor text goes to the Worker log; this row is customer-readable
      // (account().recentActions) so it carries the abstract step instead — an
      // `error: err.message` here shipped the provider's name and endpoint
      // straight into the activity feed.
      logVendorFailure(`REPLACE_DOMAIN ${action.domain}`, err);
      logAction(
        ctx,
        terminal ? "REPLACE_DOMAIN_TERMINAL" : "REPLACE_DOMAIN_FAILED",
        action.domain,
        customerSafeVendorDetail(
          err,
          terminal
            ? "the replacement domain could not be brought up and has been abandoned — automatic replacement is paused"
            : "automatic domain replacement is paused (provider issue)",
          {
            burningDomainId: action.domainId,
            burnReason: action.reason,
            note: "burning domain retired + mailboxes released; replacement withheld — isolated so the tick continues",
          },
        ),
      );
    }
  } finally {
    // §7.1 sync placement — the meter reflects reality in EVERY branch (success
    // = net 0, withheld/failed = -N; never +N). Active-only + set-to-N inside;
    // a no-op in the default build (no real Stripe subscription). Runs even on a
    // re-thrown genuine bug (harmless — the release already lowered the count).
    await syncMailboxQuantity(ctx);
  }
}

/**
 * SPEC.md §20.2's substitute remedy for a domain that cannot be
 * burn-replaced: hard-pause ALL its mailboxes (never retire+replace), then
 * best-effort dispatch the TWO required alert paths — the customer (it's
 * their domain, dashboard-visible via this same deliverability_actions log +
 * an account-contact email) and the owner (the §D6 digest already surfaces
 * `deliverability.pausedMailboxesTotal`/`actionsInWindow` platform-wide; this
 * adds a direct, immediate owner copy rather than waiting for the next digest
 * cycle, mirroring admin/ops-sweep.ts's sendDunningSuspendNotice pattern
 * exactly). Idempotent: only fires once, on the 'active' -> 'paused_primary'
 * transition (the conditional UPDATE below), so a re-sweep of an
 * already-paused domain never re-sends the alert.
 */
async function applyHardPauseDomain(
  ctx: TenantContext,
  action: Extract<DeliverabilityAction, { type: "HARD_PAUSE_DOMAIN" }>,
  mailer: OpsMailer,
): Promise<void> {
  const res = ctx.sql.exec(
    `UPDATE domains SET status = 'paused_primary' WHERE id = ? AND tenant_id = ? AND status = 'active'`,
    action.domainId,
    ctx.tenantId,
  );
  if (res.rowsWritten === 0) return; // already paused by a concurrent/prior sweep — no-op, no duplicate alert

  pauseDomainMailboxes(ctx, action.domainId);
  logAction(ctx, "HARD_PAUSE_DOMAIN", action.domain, { domainId: action.domainId, reason: action.reason });
  await sendHardPauseDomainAlerts(ctx, mailer, action.domain, action.reason);
}

/**
 * SPEC.md §20.2's soft response (below the volume floor — see byo-breaker.ts):
 * halve every active mailbox's current effective cap on the domain + flag for
 * human review via the action log (no email — this is a "worth a look", not
 * an incident). `cap_override` is the SAME mechanism THROTTLE uses, so a
 * later warmup recompute can't silently lift the halved cap back up.
 */
function applySoftFlagDomain(ctx: TenantContext, action: Extract<DeliverabilityAction, { type: "SOFT_FLAG_DOMAIN" }>): void {
  const rows = ctx.sql
    .exec<{ id: string; daily_cap: number }>(
      `SELECT id, daily_cap FROM mailboxes WHERE tenant_id = ? AND domain_id = ? AND deliv_status != 'paused'`,
      ctx.tenantId,
      action.domainId,
    )
    .toArray();
  for (const row of rows) {
    const halved = Math.max(1, Math.floor(row.daily_cap / 2));
    ctx.sql.exec(
      `UPDATE mailboxes SET cap_override = ?, daily_cap = MIN(daily_cap, ?) WHERE id = ?`,
      halved,
      halved,
      row.id,
    );
  }
  logAction(ctx, "SOFT_FLAG_DOMAIN", action.domain, { domainId: action.domainId, mailboxesHalved: rows.length, reason: action.reason });
}

/** Best-effort dual alert — mirrors admin/ops-sweep.ts's sendDunningSuspendNotice exactly (tenant notice + owner copy, every send wrapped, never throws). */
async function sendHardPauseDomainAlerts(ctx: TenantContext, mailer: OpsMailer, domain: string, reason: string): Promise<void> {
  const profile = ctx.sql.exec<{ brand: string }>(`SELECT brand FROM tenant_profile WHERE id = ?`, ctx.tenantId).one();

  let contactEmail: string | null = null;
  try {
    contactEmail = await lookupTenantContactEmail(ctx.env, ctx.tenantId);
  } catch (err) {
    console.error(`hard-pause-domain alert: contact-email lookup failed for tenant ${ctx.tenantId}`, err);
  }

  if (contactEmail) {
    const text =
      `Sending from your domain "${domain}" has been paused by the deliverability control loop.\n\n${reason}\n\n` +
      `This is a primary/dedicated business domain, so it is never auto-replaced — sending stays paused until you review it. ` +
      `See your account's activity feed for detail, or reply to this email and it will reach our team.`;
    await trySendHardPauseAlert(mailer, {
      to: contactEmail,
      subject: `[coldrig] Sending from "${domain}" has been paused`,
      text,
      html:
        `<p>Sending from your domain <strong>${escapeHtml(domain)}</strong> has been paused by the deliverability control loop.</p>` +
        `<p>${escapeHtml(reason)}</p>` +
        `<p>This is a primary/dedicated business domain, so it is never auto-replaced — sending stays paused until you review it. See your account's activity feed for detail, or reply to this email and it will reach our team.</p>`,
    });
  }

  if (ctx.env.OPS_ALERT_EMAIL) {
    const notified = contactEmail ? `tenant notified at ${contactEmail}` : "NO contact email on file — tenant NOT notified (flag)";
    const text =
      `Tenant "${profile.brand}" (${ctx.tenantId}) had domain "${domain}" hard-paused by the deliverability control loop (SPEC.md §20.2 — primary-domain substitute remedy, never auto-replaced).\n` +
      `${reason}\n${notified}.`;
    await trySendHardPauseAlert(mailer, {
      to: ctx.env.OPS_ALERT_EMAIL,
      subject: `[coldrig] tenant "${profile.brand}" — primary/dedicated domain "${domain}" hard-paused`,
      text,
      html:
        `<p>Tenant <strong>${escapeHtml(profile.brand)}</strong> (<code>${escapeHtml(ctx.tenantId)}</code>) had domain <strong>${escapeHtml(domain)}</strong> hard-paused by the deliverability control loop (SPEC.md §20.2 — primary-domain substitute remedy, never auto-replaced).</p>` +
        `<p>${escapeHtml(reason)}</p><p>${escapeHtml(notified)}.</p>`,
    });
  }
}

async function trySendHardPauseAlert(mailer: OpsMailer, msg: { to: string; subject: string; text: string; html: string }): Promise<void> {
  try {
    await mailer.send(msg);
  } catch (err) {
    // Dark/unconfigured OpsMailer or a transient send failure — log, never
    // throw. The domain-pause + audit log already committed above; a failed
    // notification must never roll that back or block the sweep.
    console.error(`hard-pause-domain alert: send to ${msg.to} failed (dark or transient)`, err);
  }
}

/**
 * Mutates DO state for every action the pure `evaluate` produced, auditing
 * each. `mailer` is injectable (default a real/dark-per-env OpsMailer, exactly
 * like admin/ops-sweep.ts's runDunningSweep) so tests can assert the
 * HARD_PAUSE_DOMAIN dual-alert content with a SandboxOpsMailer without any
 * production call site needing to change.
 */
export async function applyActions(
  ctx: TenantContext,
  actions: DeliverabilityAction[],
  mailer: OpsMailer = createOpsMailer(ctx.env),
): Promise<void> {
  // HEAD-OF-LINE BLOCKING (class sweep 2026-08-17, IN-2). The actions in one
  // sweep are INDEPENDENT remedies for independent problems — a REPLACE_DOMAIN
  // on a burning domain and a PAUSE on a degrading mailbox somewhere else — and
  // `evaluate` emits them in a fixed order, so a persistent failure on the first
  // one silently withheld every remedy behind it on every cycle. Worse, the
  // throw escaped all the way to tick.ts's unwrapped `runDeliverabilitySweep`
  // call, so the tenant's ENTIRE send loop stopped running while its reputation
  // burned. Each action is isolated here so a remedy that cannot be applied
  // costs only itself.
  await forEachIsolated(
    actions,
    async (action) => {
      switch (action.type) {
        case "THROTTLE":
          applyThrottle(ctx, action);
          break;
        case "PAUSE":
          applyPause(ctx, action);
          break;
        case "ROTATE":
          // The reroute itself is realized by the tick's capacity picker (it
          // excludes paused mailboxes); this records the decision + whether there
          // was a healthy target to reroute to right now.
          logAction(ctx, "ROTATE", "fleet", {
            pendingSends: action.pendingSends,
            healthyTargets: action.healthyTargets,
            reason: action.reason,
          });
          break;
        case "REPLACE_DOMAIN":
          await applyReplaceDomain(ctx, action, mailer);
          break;
        case "HARD_PAUSE_DOMAIN":
          await applyHardPauseDomain(ctx, action, mailer);
          break;
        case "SOFT_FLAG_DOMAIN":
          applySoftFlagDomain(ctx, action);
          break;
      }
    },
    {
      onItemError: ({ item, error }) => {
        // Anything reaching here got PAST applyReplaceDomain's own VendorError
        // handling, so it is either a vendor failure on a leg that has none
        // (HARD_PAUSE_DOMAIN's alerts) or a genuine bug. Both go to the Worker
        // log raw AND to the customer-readable feed abstractly — isolating a
        // real bug is only defensible if the bug is loud.
        console.error(`deliverability action ${item.type} failed (the remaining actions were still applied)`, error);
        logAction(
          ctx,
          "DELIVERABILITY_ACTION_FAILED",
          "domain" in item ? item.domain : item.type,
          customerSafeVendorDetail(error, "a deliverability remedy could not be applied — the remaining remedies were still applied", {
            actionType: item.type,
          }),
        );
      },
    },
  );
}

/**
 * The control loop's single entry point (monitor -> decide -> act). Called by
 * the tick BEFORE scheduling sends so a degrading mailbox is throttled/paused
 * before it can send more. Gathering is DB-only + synchronous; the sole awaits
 * are inside REPLACE_DOMAIN's replacement provisioning.
 */
export async function runDeliverabilitySweep(
  ctx: TenantContext,
  thresholds: DeliverabilityThresholds = DEFAULT_THRESHOLDS,
  mailer: OpsMailer = createOpsMailer(ctx.env),
): Promise<{ actions: DeliverabilityAction[] }> {
  // Lifecycle freeze — the SAME kill switch the tick has, but enforced INSIDE
  // the sweep so it also covers the standalone TenantDO.deliverabilitySweep()
  // RPC and the cron runDeliverabilitySweepAllTenants lane (adversarial
  // panel-03 finding #3: those bypassed the tick's guard, so a frozen tenant's
  // burning domain still triggered REPLACE_DOMAIN -> buys a new domain +
  // mailboxes = real vendor spend on an account we deliberately froze).
  const { status, billingState } = readLifecycleState(ctx);
  if (isLifecycleFrozen(status, billingState)) {
    return { actions: [] };
  }

  const mailboxes = gatherMailboxHealth(ctx);
  const domains = gatherDomainStats(ctx, mailboxes);
  const pendingSends = ctx.sql
    .exec<{ n: number }>(
      `SELECT COUNT(*) as n FROM scheduled_sends WHERE tenant_id = ? AND status = 'pending'`,
      ctx.tenantId,
    )
    .one().n;

  const actions = evaluate(mailboxes, domains, thresholds, { pendingSends });
  await applyActions(ctx, actions, mailer);
  return { actions };
}
