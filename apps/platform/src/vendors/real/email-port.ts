import { NotActivatedError } from "@coldstart/shared";
import type { EmailPort, PolledEvent, SendEmailInput, SendEmailResult } from "@coldstart/shared";

// Real EmailPort (forked cold-cli engine, off-Worker per ARCHITECTURE.md #6)
// — coded stub only, activation-gated. See real/domain-port.ts.
export class RealEmailPort implements EmailPort {
  async send(_input: SendEmailInput, _idempotencyKey: string): Promise<SendEmailResult> {
    throw new NotActivatedError("cold-cli-engine", "send");
  }

  async poll(_mailboxEmail: string): Promise<PolledEvent[]> {
    throw new NotActivatedError("cold-cli-engine", "poll");
  }
}
