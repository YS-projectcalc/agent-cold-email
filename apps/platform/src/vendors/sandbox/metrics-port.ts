import type { Clock, MetricsPort, PlacementResult } from "@coldstart/shared";

// Sandbox MetricsPort — stand-in for vendor-side placement-test results
// (Inboxkit-style). Our own campaign_results()/metrics() intents aggregate
// from TenantDO's event log directly; this port is for vendor-reported
// signals (e.g. the deliverability control loop, B6) which B0 does not
// exercise yet — kept minimal on purpose (YAGNI, CLAUDE.md rule i).
export class SandboxMetricsPort implements MetricsPort {
  constructor(private readonly clock: Clock) {}

  async getPlacement(mailboxEmail: string): Promise<PlacementResult> {
    return { mailboxEmail, inboxRate: 0.95, spamRate: 0.05, checkedAt: this.clock.now() };
  }
}
