// BYO teardown (ROADMAP.md:32, founder ruling 2026-08-06) — best-effort
// founder alert for the one ambiguous case the rule creates: a domain
// reaching teardown with no resolvable connection_type. lifecycle.ts treats
// that the same as 'connected' (never released), which is the safe default,
// but a safe GUESS is not a substitute for a human actually checking whether
// the domain was ever really purchased through the registrar. Mirrors
// registrar-alert.ts's alertRegistrarUnarmed pattern exactly: gated on
// OPS_ALERT_EMAIL, an injectable mailer (tests inject their own — under
// vitest-pool-workers `createOpsMailer`'s ctx.env default resolves to
// RealOpsMailer, since Miniflare reports the send_email binding as present),
// and NEVER lets a failed/unconfigured send block or fail the teardown it
// annotates.

import { escapeHtml } from "../html-escape.js";
import { createOpsMailer, type OpsMailer } from "../ops-mail/ops-mailer.js";
import type { TenantContext } from "../tenant-context.js";

export async function alertUnresolvedDomainConnectionType(
  ctx: TenantContext,
  domain: string,
  mailer: OpsMailer = createOpsMailer(ctx.env),
): Promise<void> {
  if (!ctx.env.OPS_ALERT_EMAIL) return;
  const text =
    `Tenant ${ctx.tenantId}'s teardown reached domain "${domain}" with no recorded connection type ` +
    `(a legacy row, or a BYO intake that never resolved one). Treated as CONNECTED — no vendor release ` +
    `was attempted, only this tenant's local records were cleared.\n\n` +
    `Please confirm by hand whether this domain was ever actually purchased through the registrar, and ` +
    `release it there yourself if so.`;
  try {
    await mailer.send({
      to: ctx.env.OPS_ALERT_EMAIL,
      subject: `[coldrig] teardown skipped a domain release — connection type unresolved (tenant ${ctx.tenantId})`,
      text,
      html: `<p>${escapeHtml(text).replace(/\n/g, "<br>")}</p>`,
    });
  } catch (mailErr) {
    console.error(`unresolved-connection-type teardown alert: send to ${ctx.env.OPS_ALERT_EMAIL} failed (dark or transient)`, mailErr);
  }
}
