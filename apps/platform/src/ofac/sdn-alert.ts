// Shared SDN-list-failure ops alert — used by BOTH the scheduled direct-fetch
// refresh (sdn-refresh.ts) and the droplet-relay ingest endpoint
// (sdn-ingest.ts) so the two failure paths send through one code path
// (CLAUDE.md rule c: no duplicated logic). Swallows its own send error — a
// failed alert must never abort the caller's fail-loud "keep the prior list"
// behavior.
import { escapeHtml } from "../html-escape.js";
import type { OpsMailer } from "../ops-mail/ops-mailer.js";
import type { Env } from "../env.js";

export async function alertSdnListFailure(
  env: Env,
  params: { subject: string; text: string },
  mailer: OpsMailer,
): Promise<void> {
  if (!env.OPS_ALERT_EMAIL) return;
  try {
    await mailer.send({
      to: env.OPS_ALERT_EMAIL,
      subject: params.subject,
      text: params.text,
      html: `<p>${escapeHtml(params.text).replace(/\n/g, "<br>")}</p>`,
    });
  } catch (mailErr) {
    console.error(`SDN list-failure alert: send to ${env.OPS_ALERT_EMAIL} failed (dark or transient)`, mailErr);
  }
}
