import { RegistrarUnarmedError } from "@coldstart/shared";
import type {
  DomainConnectionType,
  DomainDnsResult,
  DomainPort,
  LookalikeCandidate,
  OwnedDomain,
  PurchasedDomain,
  ReleaseResult,
} from "@coldstart/shared";

/**
 * The domain port handed out whenever a paid+activated tenant's bundle would
 * otherwise go real, but the registrar seam isn't ARMED FOR THIS TENANT — G5
 * gate (a) (ROADMAP.md:19,33,43; adversary B1 2026-07-23). Replaces the
 * dropped-vendor Porkbun stub that used to sit here: that stub was reachable
 * ONLY when `inboxKitConfig` (the MAILBOX vendor's credential) was present,
 * which meant arming InboxKit for mailboxes silently welded `domain.buy` to
 * InboxKit-as-registrar too (factory.ts's old logic). This class is
 * deliberately vendor-agnostic and fails loud on EVERY method regardless of
 * `inboxKitConfig`'s presence.
 *
 * A real, WORKING InboxKit-backed registrar adapter now exists
 * (`real/inboxkit-domain-port.ts`'s `RealInboxKitDomainPort`, wired via
 * `vendors/factory.ts`'s two-leg `registrarArming` check — 2026-07-27), but it
 * is reached ONLY when BOTH `REGISTRAR_PROVIDER=inboxkit` (env, the operator's
 * global switch) AND the tenant's own persisted
 * `SetupInfrastructureInput.registerDomains` opt-in are true. Absent either
 * leg — including for every tenant who simply hasn't opted in yet — this
 * class is what `factory.ts` hands out instead: same "coded to the
 * interface, fail-loud until wired/armed/opted-in" posture as every other
 * real/ port. A hypothetical FUTURE non-InboxKit registrar (Cloudflare
 * Registrar, say) would need its own dedicated adapter + arming leg; no such
 * adapter is built (scope note 2026-07-23: whether Cloudflare's public API
 * supports NEW-domain purchase, vs. transfers/settings only, is unverified —
 * this codebase does not build dark adapters against an unverified wire
 * shape) — see vendors/factory.ts for the full selection logic.
 */
export class RegistrarUnarmedDomainPort implements DomainPort {
  private fail(op: string): never {
    throw new RegistrarUnarmedError(op);
  }

  async searchLookalikes(_brand: string, _primaryDomain: string, _count: number): Promise<LookalikeCandidate[]> {
    this.fail("searchLookalikes");
  }

  async listOwnedDomains(): Promise<OwnedDomain[]> {
    this.fail("listOwnedDomains");
  }

  async buy(_domain: string, _idempotencyKey: string): Promise<PurchasedDomain> {
    this.fail("buy");
  }

  /**
   * The one DOCUMENTED EXEMPTION from the port contract's "must be able to
   * answer `{kind:"terminal"}`" rule (vendor-verdict class fix, guard D3): this
   * port observes nothing at all, so it has no verdict to give. Throwing a
   * named, non-retryable RegistrarUnarmedError is a strictly LOUDER answer than
   * any verdict — it carries its own 503 `registrar_unarmed` mapping and a
   * founder alert — and it can never be mistaken for "still propagating", which
   * is the failure mode the contract exists to prevent.
   */
  async setDns(_domain: string, _idempotencyKey: string, _connectionType: DomainConnectionType): Promise<DomainDnsResult> {
    this.fail("setDns");
  }

  async release(_domain: string, _idempotencyKey: string): Promise<ReleaseResult> {
    this.fail("release");
  }
}
