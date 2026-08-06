import type {
  Clock,
  DnsRecordSet,
  DomainConnectionType,
  DomainPort,
  LookalikeCandidate,
  OwnedDomain,
  PurchasedDomain,
  ReleaseResult,
} from "@coldstart/shared";

// Sandbox DomainPort — SPEC.md §8 lookalike workflow, simulated. Deterministic
// happy path (no fault injection yet — that's a later, budgeted lane per
// ARCHITECTURE.md #2 and ROADMAP.md's hardening-budget rule).
const PREFIXES = ["try", "get", "join"];
const SUFFIX_TLDS = ["hq.io", "hq.com"];

export class SandboxDomainPort implements DomainPort {
  private readonly seen = new Set<string>();
  private readonly released = new Set<string>();

  constructor(private readonly clock: Clock) {}

  /**
   * Domains this sandbox should report as UNAVAILABLE (already registered by
   * someone else). Empty by default, so existing behavior is byte-identical.
   *
   * H3b (pipeline F3): the port used to hardcode `available: true`, so NO
   * fixture could express the unavailable branch — which is why "availability
   * is fetched and then ignored" survived every suite. Tests set this to drive
   * the real filter.
   */
  readonly unavailable = new Set<string>();

  async searchLookalikes(brand: string, primaryDomain: string, count: number): Promise<LookalikeCandidate[]> {
    const root = primaryDomain.replace(/^www\./, "").split(".")[0] ?? brand.toLowerCase();
    const slug = root.toLowerCase().replace(/[^a-z0-9]/g, "");
    const candidates: LookalikeCandidate[] = [];
    for (const prefix of PREFIXES) {
      candidates.push({ domain: `${prefix}${slug}.com`, available: !this.unavailable.has(`${prefix}${slug}.com`) });
    }
    for (const tld of SUFFIX_TLDS) {
      candidates.push({ domain: `${slug}${tld}`, available: !this.unavailable.has(`${slug}${tld}`) });
    }
    // Numbered spillover so a caller asking for more than the fixed list (the
    // H3b over-request: domains + owned + buffer) still gets a full set instead
    // of silently short-changing the not-owned filter.
    for (let i = 1; candidates.length < count; i++) {
      const domain = `${slug}${i}.com`;
      candidates.push({ domain, available: !this.unavailable.has(domain) });
    }
    return candidates.slice(0, count);
  }

  async listOwnedDomains(): Promise<OwnedDomain[]> {
    // Empty by design (H3): the sandbox registrar never has pre-existing
    // vendor-side state to adopt, so every sandbox provision takes the ordinary
    // buy path — byte-identical to behavior before adopt-before-buy existed.
    // Tests that need an already-owned domain inject their own DomainPort.
    return [];
  }

  async buy(domain: string, idempotencyKey: string): Promise<PurchasedDomain> {
    // Idempotent: re-buying the same domain under the same key is a no-op success.
    this.seen.add(`${idempotencyKey}:${domain}`);
    // Same shape as a real registrar buy: we registered it, so we hold it.
    return { domain, purchasedAt: this.clock.now(), registrar: "sandbox-registrar", connectionType: "purchased" };
  }

  async setDns(_domain: string, _idempotencyKey: string, _connectionType: DomainConnectionType): Promise<DnsRecordSet> {
    // The sandbox registrar operates both halves identically (there is no real
    // zone and no propagation delay), so the branch a real vendor needs is
    // invisible here — see test/domain-connection-type.test.ts, which drives the
    // real port for it.
    return { mx: true, spf: true, dkim: true, dmarc: true, rdns: true };
  }

  async release(domain: string, idempotencyKey: string): Promise<ReleaseResult> {
    // Idempotent: releasing the same domain under the same key is a no-op
    // success. The real adapter calls the registrar's release endpoint here.
    this.released.add(`${idempotencyKey}:${domain}`);
    return { released: true, releasedAt: this.clock.now() };
  }
}
