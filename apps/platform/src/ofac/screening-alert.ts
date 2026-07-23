// Founder ops alert on a screening HIT — mirrors engine/registrar-alert.ts's
// pattern exactly (design line 57-58): an unsendable alert must NEVER fail the
// screening write that triggered it, and NEVER reveal the sanctions-match
// framing to the tenant (that's a separate, deliberately vague customer-facing
// "account review" surface — this is the founder-only channel).
import { escapeHtml } from "../html-escape.js";
import { createOpsMailer, type OpsMailer } from "../ops-mail/ops-mailer.js";
import type { TenantContext } from "../tenant-context.js";
import type { MatchedSdnEntry } from "./match.js";

type ScreeningTrigger = "checkout" | "brand_change" | "list_unavailable_recovery";

export async function alertScreeningHit(
  ctx: TenantContext,
  matches: MatchedSdnEntry[],
  trigger: ScreeningTrigger,
  mailer: OpsMailer = createOpsMailer(ctx.env),
): Promise<void> {
  if (!ctx.env.OPS_ALERT_EMAIL) return;
  const matchLines = matches
    .map((m) => `  - "${m.nameNormalized}" (${m.matchType} match, program ${m.program ?? "unknown"}) matched on field "${m.matchedField}"`)
    .join("\n");
  const text =
    `Tenant ${ctx.tenantId} was held for OFAC/SDN screening review at ${trigger}.\n\n` +
    `Status set to 'review' — activation is BLOCKED until an admin clears or rejects it (POST /admin/tenants/${ctx.tenantId}/screening).\n\n` +
    `Matches:\n${matchLines}\n\n` +
    `This is NEVER an auto-reject — a human must clear or reject.`;
  try {
    await mailer.send({
      to: ctx.env.OPS_ALERT_EMAIL,
      subject: `[coldrig] screening review held — tenant ${ctx.tenantId} (${trigger})`,
      text,
      html: `<p>${escapeHtml(text).replace(/\n/g, "<br>")}</p>`,
    });
  } catch (mailErr) {
    console.error(`screening-hit alert: send to ${ctx.env.OPS_ALERT_EMAIL} failed (dark or transient)`, mailErr);
  }
}

/**
 * N-OF-1 fix (adversary OFAC build review, 2026-07-23) — fired when a tenant
 * is held fail-CLOSED because NO SDN list was loaded yet at screening time
 * (never a real name match, so this is a DISTINCT alert from
 * `alertScreeningHit` — "Matches:" framing would be misleading here). Honest
 * about the self-heal path: `screening-recovery.ts`'s cron sweep re-screens
 * every tenant still holding the `list-unavailable` sentinel once a real list
 * loads, but a manual admin clear works too in the meantime.
 */
export async function alertScreeningListUnavailable(
  ctx: TenantContext,
  trigger: ScreeningTrigger,
  mailer: OpsMailer = createOpsMailer(ctx.env),
): Promise<void> {
  if (!ctx.env.OPS_ALERT_EMAIL) return;
  const text =
    `Tenant ${ctx.tenantId} completed ${trigger} but NO SDN list was loaded yet — screening could not run.\n\n` +
    `Fail-CLOSED: status set to 'review' (activation BLOCKED) rather than assuming clear.\n\n` +
    `This resolves automatically once the SDN list loads (the next ops-sweep recovery pass re-screens it), ` +
    `or can be cleared manually now (POST /admin/tenants/${ctx.tenantId}/screening).`;
  try {
    await mailer.send({
      to: ctx.env.OPS_ALERT_EMAIL,
      subject: `[coldrig] screening held — no SDN list loaded yet (tenant ${ctx.tenantId})`,
      text,
      html: `<p>${escapeHtml(text).replace(/\n/g, "<br>")}</p>`,
    });
  } catch (mailErr) {
    console.error(`screening-list-unavailable alert: send to ${ctx.env.OPS_ALERT_EMAIL} failed (dark or transient)`, mailErr);
  }
}
