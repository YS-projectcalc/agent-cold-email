import type { Clock, MetricsPort, PlacementResult } from "@coldstart/shared";

// Sandbox MetricsPort — stand-in for vendor-side placement-test results
// (Inboxkit-style seed-list inbox/spam placement). Our own
// campaign_results()/metrics() aggregate from the event log; the B6
// deliverability loop reads vendor reputation/placement via MailboxPort.getHealth
// (surfaced in infrastructure_status). This dedicated placement-test port stays
// part of the frozen VendorPort contract (ARCHITECTURE.md #1) for activation-time
// seed-list enrichment — kept minimal on purpose (YAGNI, CLAUDE.md rule i).
export class SandboxMetricsPort implements MetricsPort {
  constructor(private readonly clock: Clock) {}

  async getPlacement(mailboxEmail: string): Promise<PlacementResult> {
    return { mailboxEmail, inboxRate: 0.95, spamRate: 0.05, checkedAt: this.clock.now() };
  }
}
