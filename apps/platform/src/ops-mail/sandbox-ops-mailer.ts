import { AUTH_FROM_EMAIL, AUTH_FROM_NAME, OPS_FROM_EMAIL, OPS_FROM_NAME, type OpsEmailMessage, type OpsMailer, type OpsSendResult } from "./ops-mailer.js";

export interface RecordedOpsEmail extends OpsEmailMessage {
  from: { email: string; name: string };
  messageId: string;
}

/**
 * Sandbox OpsMailer — records every send in `sent` instead of touching the
 * network, so a test can assert exactly what the watchtower / dunning path
 * emailed (recipient, subject, body) with NO real email attempt anywhere.
 * Deterministic, in-memory, same role SandboxEmailPort plays for the tenant
 * send path. Tests construct one and inject it into the sweep/dunning/
 * watchtower functions, then read `sent`.
 */
export class SandboxOpsMailer implements OpsMailer {
  readonly sent: RecordedOpsEmail[] = [];

  async send(message: OpsEmailMessage): Promise<OpsSendResult> {
    const messageId = `<${crypto.randomUUID()}@ops.sandbox.local>`;
    const from = message.sender === "auth" ? { email: AUTH_FROM_EMAIL, name: AUTH_FROM_NAME } : { email: OPS_FROM_EMAIL, name: OPS_FROM_NAME };
    this.sent.push({ ...message, from, messageId });
    return { messageId };
  }
}
