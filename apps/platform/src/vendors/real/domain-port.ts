import { NotActivatedError } from "@coldstart/shared";
import type { DnsRecordSet, DomainPort, LookalikeCandidate, PurchasedDomain } from "@coldstart/shared";

// Real DomainPort (Porkbun) — coded to the interface shape, never called.
// ARCHITECTURE.md #6/#8: activation-gated; DO NOT wire real HTTP calls here
// until ACTIVATION.md is executed by the owner.
export class RealDomainPort implements DomainPort {
  async searchLookalikes(_brand: string, _primaryDomain: string, _count: number): Promise<LookalikeCandidate[]> {
    throw new NotActivatedError("porkbun", "searchLookalikes");
  }

  async buy(_domain: string, _idempotencyKey: string): Promise<PurchasedDomain> {
    throw new NotActivatedError("porkbun", "buy");
  }

  async setDns(_domain: string, _idempotencyKey: string): Promise<DnsRecordSet> {
    throw new NotActivatedError("porkbun", "setDns");
  }
}
