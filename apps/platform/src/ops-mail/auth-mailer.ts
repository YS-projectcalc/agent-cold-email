import { escapeHtml } from "../html-escape.js";
import type { OpsMailer } from "./ops-mailer.js";

// Magic-link auth mail (design docs/research/human-signup-magic-link-design-
// 2026-07-22.md §1.7/§1.8) — a thin builder over the shared OpsMailer port,
// mirroring the trySendNotice/trySendHardPauseAlert house style
// (admin/ops-sweep.ts, engine/deliverability-actions.ts): a plain exported
// function so a test can inject a SandboxOpsMailer directly and assert
// content, instead of only exercising it through the HTTP route.

export interface LoginLinkEmailParams {
  to: string;
  url: string;
  /** Requesting IP/UA (§1.8 forwarded-link hygiene) — shown in the body so
   * the real owner notices an unexpected request even if they never click
   * the link. NOT used for any binding/restriction decision (§1.8: binding a
   * magic link to IP/device breaks the read-on-phone-click-on-desktop path). */
  requestIp: string;
  requestUserAgent: string;
}

/**
 * Sends the magic-link sign-in email. Callers fire this via
 * `ctx.waitUntil()` (adversary r1 NB2, routes/login.ts) — never inline-await
 * it before responding to `POST /login`, or the exists/not-exists branches
 * become a timing oracle.
 *
 * Reply-To is deliberately OMITTED (§1.7c): `login@coldrig.dev` is not a
 * monitored mailbox, and support@ inbound routing is still disarmed
 * (ROADMAP.md) — adding `Reply-To: support@coldrig.dev` is a one-line
 * follow-up once that arms, not now.
 */
export async function sendLoginLinkEmail(mailer: OpsMailer, params: LoginLinkEmailParams): Promise<void> {
  const { to, url, requestIp, requestUserAgent } = params;
  const safeUrl = escapeHtml(url);
  const safeIp = escapeHtml(requestIp);
  const safeUa = escapeHtml(requestUserAgent);

  await mailer.send({
    to,
    sender: "auth",
    subject: "Your Coldrig sign-in link",
    text: [
      "Use this link to sign in to your Coldrig dashboard:",
      "",
      url,
      "",
      "This link expires in 15 minutes and can only be used once.",
      "",
      `Requested from IP ${requestIp} (${requestUserAgent}).`,
      "If this wasn't you, ignore this email — no account changes were made.",
    ].join("\n"),
    html: [
      "<p>Use this link to sign in to your Coldrig dashboard:</p>",
      `<p><a href="${safeUrl}">${safeUrl}</a></p>`,
      "<p>This link expires in 15 minutes and can only be used once.</p>",
      `<p style="color:#6b7280;font-size:12px">Requested from IP ${safeIp} (${safeUa}).<br>` +
        "If this wasn't you, ignore this email — no account changes were made.</p>",
    ].join("\n"),
  });
}
