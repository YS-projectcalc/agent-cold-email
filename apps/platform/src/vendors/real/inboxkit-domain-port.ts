import { VendorError } from "@coldstart/shared";
import type { DnsRecordSet, DomainPort, LookalikeCandidate, PurchasedDomain, ReleaseResult } from "@coldstart/shared";
import { InboxKitClient, type InboxKitClientConfig } from "./inboxkit-client.js";

/**
 * Registrant-of-record contact details InboxKit requires on domain
 * registration (`POST /domains/register`'s `contact_details`). Deliberately
 * NOT defaulted/invented here — a domain registrant is a real legal fact, not
 * something safe to synthesize a placeholder for. `buy()` throws a clear
 * VendorError until this is actually configured (ACTIVATION.md decision:
 * whose identity is the registrant of record for tenant-provisioned domains).
 */
export interface InboxKitDomainRegistrant {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  organization: string;
  addressLine1: string;
  city: string;
  state: string;
  country: string;
  postalCode: string;
}

/**
 * Real DomainPort — InboxKit's OWN domain provisioning (register-through-
 * InboxKit, or connect a domain already owned elsewhere by pointing its
 * nameservers at InboxKit's Cloudflare zone). Coded-but-dark, same pattern
 * as `real/mailbox-port.ts`'s `RealMailboxPort` — activation-gated via
 * `InboxKitClient`, never reachable from the deployed default.
 *
 * ⚠ OPEN QUESTION (flag for adversary/founder pass, not resolved by this
 * adapter): `real/domain-port.ts`'s `RealDomainPort` (Porkbun) is SPEC.md
 * §11/§12's still-current documented registrar decision, and
 * ACTIVATION.md:25 ("Registrar account + card") still names Namecheap/
 * Porkbun, unchanged by the 2026-07-20 "go inboxkit" ruling recorded at
 * ACTIVATION.md:9 (which reads as mailbox-vendor-scoped, not an explicit
 * domain-registrar swap). This class exists because the task brief for this
 * pass explicitly asked for "domain port for the InboxKit-registered +
 * connect-existing-domain flows" with a verified endpoint catalog — it is
 * coded and contract-tested, but the factory only wires it in when a
 * DEDICATED `inboxKitConfig` is supplied (see factory.ts), independent of
 * and additional to the still-default Porkbun `RealDomainPort`. Which one is
 * the actually-decided registrar path is a founder-level call this adapter
 * does not make.
 *
 * Endpoint coverage (verified live/doc-captured 2026-07-20,
 * https://docs.inboxkit.com/):
 *  - searchLookalikes -> GET /domains/available?domain=X (verified live, one
 *    call per candidate — InboxKit has no documented batch-check endpoint
 *    this pass looked at)
 *  - buy              -> POST /domains/register (InboxKit-registered flow)
 *  - setDns           -> POST /domains/nameservers (get nameservers to point
 *                        the domain at) then
 *                        POST /domains/nameservers/check-propagation
 *                        (connect-existing-domain flow's poll-verify step)
 *  - release          -> POST /domains/remove
 */
export class RealInboxKitDomainPort implements DomainPort {
  private readonly client: InboxKitClient;

  constructor(config?: InboxKitClientConfig, private readonly registrant?: InboxKitDomainRegistrant) {
    this.client = new InboxKitClient(config);
  }

  async searchLookalikes(brand: string, primaryDomain: string, count: number): Promise<LookalikeCandidate[]> {
    const root = primaryDomain.replace(/^www\./, "").split(".")[0] || brand.toLowerCase();
    const slug = root.toLowerCase().replace(/[^a-z0-9]/g, "");
    // Distinct prefix set from sandbox/domain-port.ts's PREFIXES/SUFFIX_TLDS
    // (a live availability check per candidate costs a real network call,
    // unlike the sandbox's free synthetic list — kept to .com only per
    // SPEC.md §12's no-renewal-cliff default).
    const prefixes = ["go", "the", "my", "get", "try"];
    const candidates = prefixes.slice(0, Math.max(1, count)).map((prefix) => `${prefix}${slug}.com`);

    const results: LookalikeCandidate[] = [];
    for (const domain of candidates) {
      const body = await this.client.request<CheckAvailabilityResponse>("searchLookalikes", "GET", "/domains/available", {
        query: { domain },
      });
      results.push({ domain, available: body.available === true });
    }
    return results;
  }

  async buy(domain: string, _idempotencyKey: string): Promise<PurchasedDomain> {
    if (!this.registrant) {
      throw new VendorError(`inboxkit domain registration for ${domain} requires registrant contact details, not configured`, false);
    }
    const body = await this.client.request<RegisterDomainsResponse>("buy", "POST", "/domains/register", {
      body: {
        domains: [{ name: domain, registration_years: 1 }],
        use_wallet_balance: true,
        contact_details: {
          first_name: this.registrant.firstName,
          last_name: this.registrant.lastName,
          email: this.registrant.email,
          phone: this.registrant.phone,
          organization: this.registrant.organization,
          address_line1: this.registrant.addressLine1,
          city: this.registrant.city,
          state: this.registrant.state,
          country: this.registrant.country,
          postal_code: this.registrant.postalCode,
        },
      },
    });
    if (body.error) {
      throw new VendorError(`inboxkit domains/register failed for ${domain}: ${body.message ?? "no message"}`, false);
    }
    if (typeof body.url === "string") {
      // A Stripe checkout session was created instead of a wallet-funded
      // purchase — the wallet balance was insufficient. Our pipeline has no
      // interactive-checkout step, so this is a permanent, operator-fixable
      // (top up the InboxKit wallet) failure, not a retry candidate.
      throw new VendorError(`inboxkit domains/register for ${domain} requires a Stripe checkout (insufficient wallet balance): ${body.url}`, false);
    }
    if (body.payment_type !== "wallet") {
      throw new VendorError(`inboxkit domains/register for ${domain} returned an unrecognized response shape (no wallet payment_type)`, false);
    }
    return { domain, purchasedAt: Date.now(), registrar: "inboxkit" };
  }

  async setDns(domain: string, _idempotencyKey: string): Promise<DnsRecordSet> {
    // Step 1 (connect-existing-domain flow): ask InboxKit which nameservers
    // to point this domain at (its Cloudflare zone). We don't act on the
    // returned nameservers ourselves — the operator/tenant applies them at
    // their registrar — this call just (re)creates the InboxKit-side zone.
    await this.client.request("setDns:nameservers", "POST", "/domains/nameservers", {
      body: { domains: [domain], mask_forwarding: false },
    });

    // Step 2: poll-verify propagation (SPEC.md §20.1's `we_manage_zone`-style
    // signal, InboxKit's own analogue). APPROXIMATION: InboxKit reports one
    // coarse `propagated` boolean per domain, not per-record-type (MX/SPF/
    // DKIM/DMARC/rDNS) status. Once nameservers have propagated, InboxKit's
    // own automation owns setting up the domain's mail DNS — so `propagated`
    // is mapped onto ALL FIVE `DnsRecordSet` flags rather than left granular.
    const body = await this.client.request<CheckPropagationResponse>("setDns:check-propagation", "POST", "/domains/nameservers/check-propagation", {
      body: { domains: [domain] },
    });
    const match = body.result?.find((r) => r.name === domain) ?? body.result?.[0];
    const propagated = match?.propagated === true;
    return { mx: propagated, spf: propagated, dkim: propagated, dmarc: propagated, rdns: propagated };
  }

  async release(domain: string, _idempotencyKey: string): Promise<ReleaseResult> {
    const body = await this.client.request<RemoveDomainsResponse>("release", "POST", "/domains/remove", {
      body: { domains: [domain] },
    });
    if (body.error) {
      throw new VendorError(`inboxkit domains/remove failed for ${domain}: ${body.message ?? "no message"}`, false);
    }
    return { released: true, releasedAt: Date.now() };
  }
}

interface CheckAvailabilityResponse {
  error: boolean;
  available?: boolean;
  banned?: boolean;
}

interface RegisterDomainsResponse {
  error: boolean;
  message?: string;
  url?: string;
  payment_type?: string;
}

interface CheckPropagationResponse {
  error: boolean;
  message?: string;
  result?: Array<{ name: string; status: string; propagated: boolean }>;
}

interface RemoveDomainsResponse {
  error: boolean;
  message?: string;
}
