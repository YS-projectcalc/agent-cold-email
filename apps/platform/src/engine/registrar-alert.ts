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
  const text =
    `Tenant ${ctx.tenantId} attempted to purchase domain "${domain}" but the registrar is not armed (gate (a)).\n\n` +
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
