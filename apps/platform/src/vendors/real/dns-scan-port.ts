import { NotActivatedError } from "@coldstart/shared";
import type { DnsScanPort, DnsScanResult } from "@coldstart/shared";

// Real DnsScanPort — coded to the interface shape, never called. Matches the
// "coded-but-unactivated" posture of every other real/ port (RealMailboxPort
// et al.), even though a DNS-over-HTTPS lookup is a free read rather than
// vendor spend: this scans a TENANT-SUPPLIED hostname on every intake call,
// which is a new external network dependency + latency + an SSRF-adjacent
// surface (arbitrary caller-controlled hostname) that deserves a deliberate
// activation step, not a silent live wire. Real implementation (deferred,
// ACTIVATION.md): Cloudflare/Google DNS-over-HTTPS for MX/A/AAAA/TXT(SPF)/
// TXT(_dmarc)/DS, with a parking-page IP/ASN heuristic for the A-record
// exception (SPEC.md §20.1).
export class RealDnsScanPort implements DnsScanPort {
  async scan(_hostname: string): Promise<DnsScanResult> {
    throw new NotActivatedError("dns-scan", "scan");
  }
}
