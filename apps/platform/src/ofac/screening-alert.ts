// Founder ops alert on a screening HIT — mirrors engine/registrar-alert.ts's
// pattern exactly (design line 57-58): an unsendable alert must NEVER fail the
// screening write that triggered it, and NEVER reveal the sanctions-match
// framing to the tenant (that's a separate, deliberately vague customer-facing
// "account review" surface — this is the founder-only channel).
import { escapeHtml } from "../html-escape.js";
import { createOpsMailer, type OpsMailer } from "../ops-mail/ops-mailer.js";
import type { TenantContext } from "../tenant-context.js";
import type { MatchedSdnEntry } from "./match.js";

export async function alertScreeningHit(
  ctx: TenantContext,
  matches: MatchedSdnEntry[],
  trigger: "checkout" | "brand_change",
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
