import type { Clock, MailboxHealth, MailboxPort, ProvisionedMailbox, ReleaseResult } from "@coldstart/shared";

// Sandbox MailboxPort — deterministic, healthy-by-default mailboxes. Actual
// warmup ramp math lives in engine/warmup.ts (per-tenant, clock-driven); this
// port only simulates the vendor-side provisioning + health-check calls.
export class SandboxMailboxPort implements MailboxPort {
  private readonly released = new Set<string>();

  constructor(private readonly clock: Clock) {}

  async provision(domain: string, localPart: string, _idempotencyKey: string): Promise<ProvisionedMailbox> {
    return { email: `${localPart}@${domain}`, provider: "sandbox", provisionedAt: this.clock.now() };
  }

  async getHealth(email: string): Promise<MailboxHealth> {
    return { email, reputationScore: 92, bounceRate: 0.01, complaintRate: 0.0005, placementRate: 0.95 };
  }

  async startWarmup(_email: string, _idempotencyKey: string): Promise<{ started: boolean; startedAt: number }> {
    return { started: true, startedAt: this.clock.now() };
  }

  async release(email: string, idempotencyKey: string): Promise<ReleaseResult> {
    // Idempotent no-op success — the real adapter calls Inboxkit's
    // delete-mailbox endpoint here at activation.
    this.released.add(`${idempotencyKey}:${email}`);
    return { released: true, releasedAt: this.clock.now() };
  }
}
