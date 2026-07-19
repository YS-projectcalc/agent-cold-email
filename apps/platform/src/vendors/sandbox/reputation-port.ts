import type { DomainReputationPort, DomainReputationResult } from "@coldstart/shared";

// Sandbox DomainReputationPort — SPEC.md §20.5's non-primary reputation
// ladder signals, deterministic + in-memory. Same fixture-map + magic-
// substring convention as SandboxDnsScanPort (dns-scan-port.ts).
const UNKNOWN_FRESH: DomainReputationResult = { ageDays: 30, blocklisted: false, activeSendingEvidence: false };

export class SandboxDomainReputationPort implements DomainReputationPort {
  constructor(private readonly fixtures: ReadonlyMap<string, DomainReputationResult> = new Map()) {}

  async check(hostname: string): Promise<DomainReputationResult> {
    const fixture = this.fixtures.get(hostname);
    if (fixture) return { ...fixture };

    const host = hostname.toLowerCase();
    if (host.includes("established")) return { ageDays: 900, blocklisted: false, activeSendingEvidence: true };
    if (host.includes("blocklisted")) return { ageDays: 900, blocklisted: true, activeSendingEvidence: false };
    // An aged-dormant/marketplace-flipped domain (SPEC.md §20.5's named
    // anti-gaming case): old and clean, but with no active-sending evidence.
    if (host.includes("dormant")) return { ageDays: 900, blocklisted: false, activeSendingEvidence: false };
    return { ...UNKNOWN_FRESH };
  }
}
