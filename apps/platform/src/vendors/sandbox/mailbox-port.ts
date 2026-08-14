import type {
  CancelWarmupResult,
  Clock,
  MailboxHealth,
  MailboxPort,
  MailboxReadiness,
  ProvisionedMailbox,
  ReleaseResult,
} from "@coldstart/shared";

// Sandbox MailboxPort — deterministic, healthy-by-default mailboxes. Actual
// warmup ramp math lives in engine/warmup.ts (per-tenant, clock-driven); this
// port only simulates the vendor-side provisioning + health-check calls.
export class SandboxMailboxPort implements MailboxPort {
  private readonly released = new Set<string>();

  constructor(private readonly clock: Clock) {}

  async provision(domain: string, localPart: string, _idempotencyKey: string): Promise<ProvisionedMailbox> {
    return { email: `${localPart}@${domain}`, provider: "sandbox", provisionedAt: this.clock.now() };
  }

  /**
   * Mailboxes this sandbox should report as a TERMINAL vendor state (suspended /
   * cancelled — one that can never send). Empty by default, so existing behavior
   * is byte-identical.
   *
   * Guard D3 of the vendor-verdict class fix: every port implementation must be
   * able to express "dead", or no fixture can drive the engine's terminal branch
   * through it. That is the same lesson this method's own comment already
   * records one incident earlier — an always-succeeds sandbox is where the real
   * vendor's contract goes to hide.
   */
  readonly terminal = new Set<string>();

  async provisioningState(email: string): Promise<MailboxReadiness> {
    // In-process and instantaneous: `provision()` returning IS the mailbox
    // existing, so the async window a real vendor has simply does not exist
    // here. Ready-by-default keeps every sandbox provision byte-identical to
    // before the poll-until-ready gate. A test that needs the async window
    // injects its own MailboxPort (test/mailbox-provisioning-gate.test.ts).
    if (this.terminal.has(email)) return { kind: "terminal", vendorState: "suspended" };
    return { kind: "ready" };
  }

  async getHealth(email: string): Promise<MailboxHealth> {
    return { email, reputationScore: 92, bounceRate: 0.01, complaintRate: 0.0005, placementRate: 0.95 };
  }

  async startWarmup(_email: string, _idempotencyKey: string): Promise<{ started: boolean; startedAt: number }> {
    return { started: true, startedAt: this.clock.now() };
  }

  async cancelWarmup(_email: string, _idempotencyKey: string): Promise<CancelWarmupResult> {
    // Idempotent no-op success — there is no sandbox warmup subscription to
    // cancel (the ramp math is ours, engine/warmup.ts). The real adapter posts
    // InboxKit's /warmup/cancel here. Returning success means the engine's
    // ramp-completion sweep marks a sandbox mailbox cancelled on the first
    // pass and never re-fires, exactly as it would against a live vendor.
    return { cancelled: true, cancelledAt: this.clock.now() };
  }

  async release(email: string, idempotencyKey: string): Promise<ReleaseResult> {
    // Idempotent no-op success — the real adapter calls Inboxkit's
    // delete-mailbox endpoint here at activation.
    this.released.add(`${idempotencyKey}:${email}`);
    return { released: true, releasedAt: this.clock.now() };
  }
}
