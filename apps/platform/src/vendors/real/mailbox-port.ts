import { NotActivatedError } from "@coldstart/shared";
import type { MailboxHealth, MailboxPort, ProvisionedMailbox, ReleaseResult } from "@coldstart/shared";

// Real MailboxPort (Inboxkit) — coded stub only, activation-gated. See real/domain-port.ts.
export class RealMailboxPort implements MailboxPort {
  async provision(_domain: string, _localPart: string, _idempotencyKey: string): Promise<ProvisionedMailbox> {
    throw new NotActivatedError("inboxkit", "provision");
  }

  async getHealth(_email: string): Promise<MailboxHealth> {
    throw new NotActivatedError("inboxkit", "getHealth");
  }

  async startWarmup(_email: string, _idempotencyKey: string): Promise<{ started: boolean; startedAt: number }> {
    throw new NotActivatedError("inboxkit", "startWarmup");
  }

  async release(_email: string, _idempotencyKey: string): Promise<ReleaseResult> {
    throw new NotActivatedError("inboxkit", "release");
  }
}
