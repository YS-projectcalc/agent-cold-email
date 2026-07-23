import { RegistrarUnarmedError } from "@coldstart/shared";
import type { DnsRecordSet, DomainPort, LookalikeCandidate, PurchasedDomain, ReleaseResult } from "@coldstart/shared";

/**
 * The domain port handed out whenever a paid+activated tenant's bundle would
 * otherwise go real, but the registrar seam isn't live — G5 gate (a)
 * (ROADMAP.md:19,33,43; adversary B1 2026-07-23). Replaces the dropped-vendor
 * Porkbun stub that used to sit here: that stub was reachable ONLY when
 * `inboxKitConfig` (the MAILBOX vendor's credential) was present, which meant
 * arming InboxKit for mailboxes silently welded `domain.buy` to
 * InboxKit-as-registrar too (factory.ts's old logic). This class is
 * deliberately vendor-agnostic and fails loud on EVERY method regardless of
 * `registrarConfig` — real registrar spend needs its own dedicated adapter
 * (Cloudflare Registrar, the founder-ruled default), and that adapter is
 * DEFERRED to the GA wave (scope note 2026-07-23: whether Cloudflare's public
 * API supports NEW-domain purchase, vs. transfers/settings only, is
 * unverified — this codebase does not build dark adapters against an
 * unverified wire shape). Same "coded to the interface, fail-loud until
 * wired" posture as every other real/ port, just without a vendor to code
 * against yet — see vendors/factory.ts for the decoupled selection logic.
 */
export class RegistrarUnarmedDomainPort implements DomainPort {
  private fail(op: string): never {
    throw new RegistrarUnarmedError(op);
  }

  async searchLookalikes(_brand: string, _primaryDomain: string, _count: number): Promise<LookalikeCandidate[]> {
    this.fail("searchLookalikes");
  }

  async buy(_domain: string, _idempotencyKey: string): Promise<PurchasedDomain> {
    this.fail("buy");
  }

  async setDns(_domain: string, _idempotencyKey: string): Promise<DnsRecordSet> {
    this.fail("setDns");
  }

  async release(_domain: string, _idempotencyKey: string): Promise<ReleaseResult> {
    this.fail("release");
  }
}
