import type { DnsScanPort, DnsScanResult } from "@coldstart/shared";

// Sandbox DnsScanPort — SPEC.md §20.1's pre-flight live-infra scan,
// deterministic + in-memory. Tests inject an exact per-hostname fixture via
// the constructor map; anything not in the map falls back to a
// fresh-domain-with-no-live-infra default (the common happy-path case), with
// a few magic-substring heuristics for ad hoc scenario hostnames so most
// tests never need to build a fixture map at all.
const FRESH_DOMAIN: DnsScanResult = {
  hasMx: false,
  aRecordResolved: false,
  isParkingPage: false,
  hasSpfInclude: false,
  dmarcPolicy: null,
  hasDnssecDs: false,
  delegatedToUs: false,
  recordsApplied: false,
};

export class SandboxDnsScanPort implements DnsScanPort {
  constructor(private readonly fixtures: ReadonlyMap<string, DnsScanResult> = new Map()) {}

  async scan(hostname: string): Promise<DnsScanResult> {
    const fixture = this.fixtures.get(hostname);
    if (fixture) return { ...fixture };

    // Additive, NOT exclusive if/else-if: a test hostname combining multiple
    // substrings (e.g. "liveinfra-recordsapplied.com" -- live infra AND its
    // records-to-apply poll-verify both present) must get BOTH signals, not
    // just whichever check runs first.
    const host = hostname.toLowerCase();
    const result = { ...FRESH_DOMAIN };
    if (host.includes("liveinfra")) result.hasMx = true;
    if (host.includes("parked")) {
      result.aRecordResolved = true;
      result.isParkingPage = true;
    }
    if (host.includes("dnssec")) result.hasDnssecDs = true;
    if (host.includes("enforced")) result.dmarcPolicy = "reject";
    if (host.includes("delegated")) result.delegatedToUs = true;
    if (host.includes("recordsapplied")) result.recordsApplied = true;
    return result;
  }
}
