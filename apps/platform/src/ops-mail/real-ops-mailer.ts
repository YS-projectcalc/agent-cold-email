import { AUTH_FROM_EMAIL, AUTH_FROM_NAME, OPS_FROM_EMAIL, OPS_FROM_NAME, OpsMailNotConfiguredError, type OpsEmailMessage, type OpsMailer, type OpsSendResult } from "./ops-mailer.js";

/**
 * Real OpsMailer — a thin wrapper over the Cloudflare Email Service
 * `send_email` binding (the 2025 product; no API keys — the binding IS the
 * credential). The send shape is the Email Service builder API
 * (@cloudflare/workers-types `EmailMessageBuilder`): a structured object, not
 * raw MIME. Every send is from one of exactly two FIXED identities
 * (`ops@coldrig.dev` by default, or `login@coldrig.dev` for magic-link mail —
 * see `sender` on OpsEmailMessage) and carries BOTH html + text.
 *
 * Dark-safe: constructed with the binding which is OPTIONAL in env.ts. When
 * the binding is absent (pre-onboarding) `send()` throws the typed
 * OpsMailNotConfiguredError; when the binding is present but the domain isn't
 * onboarded yet the underlying `.send()` throws the Email Service's own
 * `E_SENDER_NOT_VERIFIED` Error. Callers catch BOTH — an ops alert must never
 * be able to break the caller.
 */
export class RealOpsMailer implements OpsMailer {
  constructor(private readonly binding: SendEmail | undefined) {}

  async send(message: OpsEmailMessage): Promise<OpsSendResult> {
    if (!this.binding) throw new OpsMailNotConfiguredError();
    const from = message.sender === "auth" ? { email: AUTH_FROM_EMAIL, name: AUTH_FROM_NAME } : { email: OPS_FROM_EMAIL, name: OPS_FROM_NAME };
    const result = await this.binding.send({
      to: message.to,
      from,
      subject: message.subject,
      html: message.html,
      text: message.text,
    });
    return { messageId: result.messageId };
  }
}
