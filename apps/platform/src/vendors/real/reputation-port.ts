import { NotActivatedError } from "@coldstart/shared";
import type { DomainReputationPort, DomainReputationResult } from "@coldstart/shared";

// Real DomainReputationPort — coded to the interface shape, never called
// (same "coded-but-unactivated" posture as RealDnsScanPort — see that file's
// doc comment). Real implementation (deferred, ACTIVATION.md): RDAP for
// registration-date age, a public DNSBL (Spamhaus DBL-class) query for
// blocklist status. `activeSendingEvidence` is the hardest signal to satisfy
// honestly — SPEC.md §20.5 explicitly requires DMARC aggregate-report volume
// (or an equivalent real-send-volume signal), NOT passive-DNS/historical-
// resolution alone; that requires ingesting and parsing RUA aggregate
// reports, which is genuinely out of scope for this build (no reports exist
// to ingest without a live customer domain sending them to us) and is
// explicitly called out as unbuildable-as-specced in this lane's report.
export class RealDomainReputationPort implements DomainReputationPort {
  async check(_hostname: string): Promise<DomainReputationResult> {
    throw new NotActivatedError("domain-reputation", "check");
  }
}
