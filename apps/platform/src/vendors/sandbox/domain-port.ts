import type { Clock, DnsRecordSet, DomainPort, LookalikeCandidate, PurchasedDomain, ReleaseResult } from "@coldstart/shared";

// Sandbox DomainPort — SPEC.md §8 lookalike workflow, simulated. Deterministic
// happy path (no fault injection yet — that's a later, budgeted lane per
// ARCHITECTURE.md #2 and ROADMAP.md's hardening-budget rule).
const PREFIXES = ["try", "get", "join"];
const SUFFIX_TLDS = ["hq.io", "hq.com"];

export class SandboxDomainPort implements DomainPort {
  private readonly seen = new Set<string>();
  private readonly released = new Set<string>();

  constructor(private readonly clock: Clock) {}

  async searchLookalikes(brand: string, primaryDomain: string, count: number): Promise<LookalikeCandidate[]> {
    const root = primaryDomain.replace(/^www\./, "").split(".")[0] ?? brand.toLowerCase();
    const slug = root.toLowerCase().replace(/[^a-z0-9]/g, "");
    const candidates: LookalikeCandidate[] = [];
    for (const prefix of PREFIXES) {
      candidates.push({ domain: `${prefix}${slug}.com`, available: true });
    }
    for (const tld of SUFFIX_TLDS) {
      candidates.push({ domain: `${slug}${tld}`, available: true });
    }
    return candidates.slice(0, count);
  }

  async buy(domain: string, idempotencyKey: string): Promise<PurchasedDomain> {
    // Idempotent: re-buying the same domain under the same key is a no-op success.
    this.seen.add(`${idempotencyKey}:${domain}`);
    return { domain, purchasedAt: this.clock.now(), registrar: "sandbox-registrar" };
  }

  async setDns(_domain: string, _idempotencyKey: string): Promise<DnsRecordSet> {
    return { mx: true, spf: true, dkim: true, dmarc: true, rdns: true };
  }

  async release(domain: string, idempotencyKey: string): Promise<ReleaseResult> {
    // Idempotent: releasing the same domain under the same key is a no-op
    // success. The real adapter calls the registrar's release endpoint here.
    this.released.add(`${idempotencyKey}:${domain}`);
    return { released: true, releasedAt: this.clock.now() };
  }
}
