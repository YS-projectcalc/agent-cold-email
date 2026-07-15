// The OpsMailer port — the platform's OUTBOUND ops-email channel (founder
// alerts from the watchtower, dunning-suspend notices, any operator email).
// Modeled on the VendorPort house style (src/vendors/): one interface, a real
// impl over a live binding, and a sandbox impl that records sends for tests —
// but kept OUT of the per-tenant VendorAdapterBundle because this is a
// platform/control-plane concern (the Cloudflare `send_email` binding is a
// Worker-global, not a per-tenant vendor), never something a demo/free tenant
// could reach.
//
// Inbound support@ is a SEPARATE surface (src/admin/support-inbound.ts) — it
// uses Email Routing's `message.forward`, not this outbound send port.

import { RealOpsMailer } from "./real-ops-mailer.js";
import { SandboxOpsMailer } from "./sandbox-ops-mailer.js";
import type { Env } from "../env.js";

// Fixed sender identity for every ops email (brief). Centralized here so no
// caller can spoof a different From — callers supply only to/subject/body.
export const OPS_FROM_EMAIL = "ops@coldrig.dev";
export const OPS_FROM_NAME = "coldrig ops";

export interface OpsEmailMessage {
  /** Single recipient (founder alert address, or a tenant's contact email). */
  to: string;
  subject: string;
  /** ALWAYS both — some clients only render text, and it helps spam scores
   * (cloudflare-email-service skill). Callers must supply both, not one. */
  text: string;
  html: string;
}

export interface OpsSendResult {
  messageId: string;
}

export interface OpsMailer {
  send(message: OpsEmailMessage): Promise<OpsSendResult>;
}

/**
 * Thrown by RealOpsMailer when the `send_email` binding is absent/unbound —
 * i.e. before the owner runs `wrangler email sending enable coldrig.dev`
 * (ACTIVATION.md). A typed, catchable signal so callers can degrade to
 * log-only: an alert that cannot be sent must NEVER take down the request
 * path or the ops sweep. Distinct from a runtime send failure (a bound-but-
 * un-onboarded domain throws the Email Service's own `E_SENDER_NOT_VERIFIED`
 * Error, which callers likewise catch-and-log) — this one specifically means
 * "no channel is wired at all yet".
 */
export class OpsMailNotConfiguredError extends Error {
  constructor(message = "OPS_EMAIL send binding is not configured — ops email is dark until ACTIVATION.md is executed (wrangler email sending enable coldrig.dev)") {
    super(message);
    this.name = "OpsMailNotConfiguredError";
  }
}

/**
 * The single choke point that decides real vs sandbox — mirrors
 * vendors/factory.ts. Real whenever the `send_email` binding is present
 * (production), sandbox otherwise. In tests/dev the binding is never bound,
 * so this returns a SandboxOpsMailer automatically; a test that needs to
 * INSPECT sends injects its own SandboxOpsMailer into the callee instead
 * (the sweep/dunning/watchtower functions take an OpsMailer param).
 *
 * Note the real impl still stays dark when its domain isn't onboarded yet:
 * a present binding whose domain is un-enabled throws at `.send()` time, and
 * every caller catches that. So "real" here means "attempt the real channel,
 * degrade gracefully if it isn't live", never "assume it works".
 */
export function createOpsMailer(env: Env): OpsMailer {
  return env.OPS_EMAIL ? new RealOpsMailer(env.OPS_EMAIL) : new SandboxOpsMailer();
}
