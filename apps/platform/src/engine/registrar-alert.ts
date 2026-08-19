// G5 gate (a) — best-effort founder alert when a domain-purchase request
// hits the registrar-not-armed hard block (ROADMAP.md:19,33,43; adversary B1
// 2026-07-23). Mirrors admin/ops-sweep.ts's trySendNotice / admin/watchtower.ts
// pattern exactly: an unsendable alert must NEVER fail the request that
// triggered it — the caller has already decided the customer-facing error
// (RegistrarUnarmedError) propagates regardless; this is purely notification.

import { RegistrarUnarmedError } from "@coldstart/shared";
import { escapeHtml } from "../html-escape.js";
import { createOpsMailer, type OpsMailer } from "../ops-mail/ops-mailer.js";
import type { TenantContext } from "../tenant-context.js";

/** `mailer` is injectable (default a real/dark-per-env OpsMailer) — same
 * pattern as admin/ops-sweep.ts's runDunningSweep / deliverability-actions.ts's
 * runDeliverabilitySweep, so a test can assert the alert content with a
 * SandboxOpsMailer without any production call site needing to change. */
export async function alertRegistrarUnarmed(
  ctx: TenantContext,
  domain: string,
  err: RegistrarUnarmedError,
  mailer: OpsMailer = createOpsMailer(ctx.env),
): Promise<void> {
  if (!ctx.env.OPS_ALERT_EMAIL) return;
  // J4 (build gate 2026-08-19) — THE ENV LEG ONLY, and the scoping lives HERE
  // rather than at the three call sites (provisioning.ts twice,
  // deliverability-actions.ts's REPLACE_DOMAIN sweep) so no future caller of
  // this effect can reintroduce the other leg.
  //
  // §7.8 split the block in two and set `operatorActionable: reason === "env"`
  // on the error itself; the `opt_in` leg is the TENANT's to clear by resending
  // one field, and the 400 the wave added says exactly that. Paging the founder
  // for it (a) contradicts the wave's own classification, (b) sends a body that
  // is FALSE on that leg — the registrar IS armed — and (c) is caller-rate
  // unbounded: `searchLookalikes` runs before any shortfall branch, so an agent
  // retry loop omitting `registerDomains` reaches this direct `mailer.send` on
  // every attempt, with none of the watchtower's debounce or backoff. That
  // residual dies with this scoping: the env leg is founder-fixable once.
  if (err.reason !== "env") return;
  const text =
    `Tenant ${ctx.tenantId} attempted to purchase domain "${domain}" but the registrar's ENV leg is not armed ` +
    `(ACTIVATION.md gate (a) — REGISTRAR_PROVIDER + CLOUDFLARE_REGISTRAR_API_TOKEN). This is the operator's gate, not ` +
    `the tenant's: the per-tenant opt-in leg refuses with a self-describing 400 and never reaches this alert.\n\n` +
    `${err.message}`;
  try {
    await mailer.send({
      to: ctx.env.OPS_ALERT_EMAIL,
      subject: `[coldrig] domain purchase blocked — registrar not armed (tenant ${ctx.tenantId})`,
      text,
      html: `<p>${escapeHtml(text).replace(/\n/g, "<br>")}</p>`,
    });
  } catch (mailErr) {
    console.error(`registrar-unarmed alert: send to ${ctx.env.OPS_ALERT_EMAIL} failed (dark or transient)`, mailErr);
  }
}
