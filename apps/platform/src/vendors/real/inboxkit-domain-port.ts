import { VendorError } from "@coldstart/shared";
import type {
  DnsRecordSet,
  DomainConnectionType,
  DomainPort,
  LookalikeCandidate,
  OwnedDomain,
  PurchasedDomain,
  ReleaseResult,
} from "@coldstart/shared";
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
 * ⚠ G5 gate (a) (ROADMAP.md:19,33,43; adversary B1 2026-07-23) RESOLVED the
 * Porkbun-vs-InboxKit registrar question this doc comment used to flag as
 * open: InboxKit is NOT the DEFAULT registrar for any tenant, and arming
 * InboxKit for MAILBOXES (`inboxKitConfig`) alone can never wire this class
 * in for `domain` — that welding was the exact bug the gate closed.
 *
 * 2026-07-27 follow-up: this class IS now reachable, but ONLY through its OWN
 * dedicated, two-leg arming (`vendors/registrar-arming.ts`,
 * `vendors/factory.ts`'s `registrarArming` param) — BOTH
 * `REGISTRAR_PROVIDER=inboxkit` (env, the operator's global switch) AND the
 * tenant's own persisted `SetupInfrastructureInput.registerDomains` opt-in
 * (founder ruling 2026-07-21: "per-tenant opt-in only, never a default") must
 * be true. It reuses the SAME InboxKit credentials as the mailbox port (one
 * vendor account) but the ARMING decision is entirely separate. Absent either
 * leg, every real-eligible tenant's domain port still hard-blocks via
 * `real/domain-port.ts`'s `RegistrarUnarmedDomainPort` — byte-identical to
 * gate (a)'s original shipped behavior. The `buy()` registrant-contact-details
 * argument is a best-effort object derived from `tenant_profile` (brand/
 * physicalAddress/senderIdentity — `vendors/registrar-arming.ts`'s
 * `deriveInboxKitRegistrant`); its COMPLETENESS is validated at the actual
 * call site (`engine/provisioning.ts`), never here — this class's own
 * coarse `if (!this.registrant)` check below is the last-resort fail-loud
 * backstop, not the primary validation.
 *
 * Endpoint coverage (verified live/doc-captured 2026-07-20,
 * https://docs.inboxkit.com/):
 *  - searchLookalikes -> GET /domains/available?domain=X (verified live, one
 *    call per candidate — InboxKit has no documented batch-check endpoint
 *    this pass looked at)
 *  - buy              -> POST /domains/register (InboxKit-registered flow)
 *  - setDns           -> BRANCHES on connection type (see below)
 *  - release          -> POST /domains/remove
 *
 * ⚠ INCIDENT 2026-08-05 root cause (docs/adversarial/sweep-domain-type-2026-08-05.md):
 * `setDns` used to run the CONNECT-EXISTING-DOMAIN flow (POST
 * /domains/nameservers = "here are nameservers for YOU to apply at YOUR
 * registrar", then check-propagation) UNCONDITIONALLY — while the only domains
 * this platform ever puts through it are ones InboxKit itself REGISTERED
 * (`connection_type: "purchased"`, live-verified against the stranded
 * goauthorpitchdesk.com). Wrong operation for that domain type: it threw at
 * step 1 on every attempt, before a single mailbox was attempted, and the
 * failure was graded RETRYABLE so the customer's agent re-ran the same wrong
 * call for 24 hours. The port implemented one half of a two-half contract and
 * was only ever invoked on the other half.
 *
 * ⚠ VENDOR CONTRACT 2026-08-10 (InboxKit support reply, verbatim): "The domain
 * goauthorpitchdesk.com is now active, and the DNS will be configured during
 * mailbox processing." The two halves differ in WHEN mail DNS exists, not just
 * in which call sets it up — so the propagation verdicts the wave-1 fix waited
 * on are inert on the purchased half. See `polledDomainIsReady`.
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
    const wanted = Math.max(1, count);
    const candidates = prefixes.slice(0, wanted).map((prefix) => `${prefix}${slug}.com`);
    // N5 (gate 2026-08-05) — numbered spillover past the fixed prefix list,
    // matching the sandbox. Callers legitimately ask for MORE than 5: H3b
    // over-requests `domains + owned + buffer` so its not-owned/available
    // filters have room to discard. `slice(0, count)` silently capped at 5, so
    // a real request the generator could have served instead hit the
    // exhaustion 400 — a customer blamed for our generator's shape. The
    // availability probe below is one real network call per candidate, so this
    // only ever generates exactly what was asked for.
    for (let i = 1; candidates.length < wanted; i++) {
      candidates.push(`${slug}${i}.com`);
    }

    const results: LookalikeCandidate[] = [];
    for (const domain of candidates) {
      const body = await this.client.request<CheckAvailabilityResponse>("searchLookalikes", "GET", "/domains/available", {
        query: { domain },
      });
      results.push({ domain, available: body.available === true });
    }
    return results;
  }

  /**
   * Every domain the workspace already owns — POST /v1/api/domains/list
   * (contract live-verified 2026-08-05): body `{page, limit}`, response
   * `domains[]` with `{uid, name, status, connection_type, assigned_mailboxes}`.
   * The adopt-before-buy input (H1/H3): it is what lets a retry RECOVER a
   * domain the vendor registered for us but that never reached our DB, instead
   * of re-attempting a buy the vendor answers with "already owned by your
   * team". Paged like the warmup-subscription lookup, with the same ceiling —
   * an unfinished walk must not be read as "not owned", so an incomplete or
   * failed page throws rather than under-reporting.
   */
  async listOwnedDomains(): Promise<OwnedDomain[]> {
    return (await this.listDomainRecords()).map((row) => ({
      domain: row.name,
      status: row.status ?? "unknown",
      assignedMailboxes: row.assigned_mailboxes ?? 0,
      // The discriminator the vendor has always reported and this adapter used
      // to DROP — the enabler that made the wrong-operation bug unbranchable.
      connectionType: normalizeConnectionType(row.connection_type),
    }));
  }

  /**
   * The raw paged /domains/list walk shared by `listOwnedDomains` (adopt-before-buy)
   * and `findDomainRecord` (the purchased-domain DNS poll) — one implementation,
   * one page ceiling, one error grade.
   */
  private async listDomainRecords(): Promise<ListedDomain[]> {
    const rows: ListedDomain[] = [];
    for (let page = 1; page <= MAX_DOMAIN_PAGES; page++) {
      const body = await this.client.request<ListDomainsResponse>("listOwnedDomains", "POST", "/domains/list", {
        body: { page, limit: DOMAIN_PAGE_SIZE },
      });
      if (body.error) {
        throw new VendorError(`inboxkit domains/list failed: ${body.message ?? "no message"}`, true);
      }
      const pageRows = body.domains ?? [];
      for (const row of pageRows) {
        const { name } = row;
        if (!name) continue;
        rows.push({ ...row, name });
      }
      if (pageRows.length === 0 || page >= (body.pages ?? 1)) return rows;
    }
    // A workspace bigger than we will walk is a PERMANENT condition for this
    // adapter, not a hiccup: retrying re-walks the same ceiling and fails
    // identically. Grading it retryable (the pre-fix grade) turned it into an
    // unbounded loop — the same laundering class as the setDns grade above.
    throw new VendorError("inboxkit domains/list has more pages than this adapter will walk", false);
  }

  /** One domain's raw vendor record, or null when the workspace does not list it. */
  private async findDomainRecord(domain: string): Promise<ListedDomain | null> {
    const wanted = domain.toLowerCase();
    return (await this.listDomainRecords()).find((row) => row.name.toLowerCase() === wanted) ?? null;
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
    // A domain InboxKit registers for us is one InboxKit HOLDS — the
    // discriminator is a fact about the operation, not a lookup.
    return { domain, purchasedAt: Date.now(), registrar: "inboxkit", connectionType: "purchased" };
  }

  /**
   * Brings mail DNS up and reports what is ACTUALLY in effect, by the route the
   * domain's connection type calls for (INCIDENT 2026-08-05 root cause).
   */
  async setDns(domain: string, _idempotencyKey: string, connectionType: DomainConnectionType): Promise<DnsRecordSet> {
    return connectionType === "connected"
      ? this.setDnsForConnectedDomain(domain)
      : this.pollPurchasedDomainDns(domain, connectionType);
  }

  /**
   * PURCHASED (and 'unknown', see `DomainConnectionType`): InboxKit is the
   * registrar AND already owns the nameservers, so there is no handshake to
   * perform — its own automation sets the mail DNS up. Our job is only to
   * OBSERVE the domain, so this is a read-only poll: it can report "not ready
   * yet" but can never fail the way asking to connect an already-connected
   * domain does.
   */
  private async pollPurchasedDomainDns(domain: string, connectionType: DomainConnectionType): Promise<DnsRecordSet> {
    const record = await this.findDomainRecord(domain);
    if (!record) {
      // Registration is ASYNC — a domain whose order was accepted seconds ago is
      // genuinely not listed yet. This is NOT an error: it is the same "not ready
      // yet, heals by waiting" condition as a listed-but-not-active record, so it
      // is reported as an all-false DnsRecordSet, NOT a thrown VendorError.
      //
      // WHY A RESULT, NOT A THROW (C3 part b, 2026-08-13). A genuine vendor API
      // failure (`/domains/list` erroring) still THROWS from listDomainRecords
      // above; only the domain-simply-not-listed-yet case returns here. That split
      // is what lets setDnsWithRetry (engine/domain-dns.ts) grade a freshly-bought
      // purchased domain's propagation wait as the benign, non-error "provisioning
      // in progress" state (its notPropagated branch) while a real API error stays
      // a surfaced failure — the two used to be one indistinguishable retryable
      // throw. Attempt count and backoff are unchanged (the caller retries a
      // not-ready result exactly as it retried this throw).
      return dnsRecordSet(false);
    }
    return dnsRecordSet(polledDomainIsReady(record, connectionType));
  }

  /**
   * CONNECTED: the domain is registered elsewhere and pointed at InboxKit, which
   * is exactly what the two-step nameserver flow is for. Step 1 (re)creates the
   * InboxKit-side zone and returns the nameservers to apply at the OWNER's
   * registrar; step 2 poll-verifies propagation (SPEC.md §20.1's
   * `we_manage_zone`-style signal).
   *
   * APPROXIMATION: InboxKit reports one coarse `propagated` boolean per domain,
   * not per-record-type (MX/SPF/DKIM/DMARC/rDNS) status. Once nameservers have
   * propagated, InboxKit's own automation owns the domain's mail DNS — so
   * `propagated` maps onto ALL FIVE flags rather than being left granular.
   */
  private async setDnsForConnectedDomain(domain: string): Promise<DnsRecordSet> {
    await this.client.request("setDns:nameservers", "POST", "/domains/nameservers", {
      body: { domains: [domain], mask_forwarding: false },
    });

    const body = await this.client.request<CheckPropagationResponse>("setDns:check-propagation", "POST", "/domains/nameservers/check-propagation", {
      body: { domains: [domain] },
    });
    const match = body.result?.find((r) => r.name === domain) ?? body.result?.[0];
    return dnsRecordSet(match?.propagated === true);
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

// POST /domains/list — contract live-verified 2026-08-05 against the workspace
// holding the stranded goauthorpitchdesk.com, whose record read:
//   {uid, price: 12.5, assigned_mailboxes: 0, status: "active",
//    connection_type: "purchased", dns_propagation_status: "pending",
//    nameserver_match_status: "pending", last_nameserver_check: null,
//    actual_nameservers: [], nameservers: ["alexandra.ns.cloudflare.com", …]}
// Every field this adapter reads is from that live capture.
interface ListDomainsResponse {
  error: boolean;
  message?: string;
  domains?: RawDomainRow[];
  total?: number;
  pages?: number;
}

interface RawDomainRow {
  uid?: string;
  name?: string;
  status?: string;
  connection_type?: string;
  assigned_mailboxes?: number;
  /**
   * Vendor's own coarse propagation verdict. Meaningful on a CONNECTED domain
   * only — on a purchased one the checker behind it does not run until mailbox
   * processing, so it reads "pending" indefinitely (contract note above).
   */
  dns_propagation_status?: string;
  /** Vendor's own verdict on whether the domain's real nameservers match the ones it assigned. Same connected-only caveat. */
  nameserver_match_status?: string;
  /** The nameservers InboxKit assigned (what SHOULD be in effect). */
  nameservers?: string[];
  /** The nameservers actually observed in DNS (empty until the registrar change propagates). */
  actual_nameservers?: string[];
}

/** A listed domain that actually carries a name — the only kind the walk keeps. */
type ListedDomain = RawDomainRow & { name: string };

const DOMAIN_PAGE_SIZE = 100;
const MAX_DOMAIN_PAGES = 10;

/** `connection_type` as reported, defaulting to 'unknown' when the vendor omits it. */
function normalizeConnectionType(raw: string | undefined): DomainConnectionType {
  const value = (raw ?? "").trim().toLowerCase();
  return value === "purchased" || value === "connected" ? value : "unknown";
}

/**
 * Vendor status tokens that positively mean "propagation/matching finished".
 * BEST-EFFORT — combined-diff gate round 2 (docs/adversarial/
 * wave-integration-gate-2026-08-05.md, "NEW" #1, live-confirmed 2026-08-06):
 * "propagated" and "matched" are the tokens actually observed live in this
 * PROPAGATION field ("pending" is the only other one seen). Deliberately an
 * ALLOWLIST rather than "anything that isn't pending": an unrecognized token
 * must fall to NOT-ready, because a false "ready" provisions billable mailboxes
 * onto a domain whose mail DNS does not work, which is the silent,
 * monthly-billing failure this wave exists to prevent. "active"/"ok" were
 * dropped (round 2 finding): in a `status` field "active" means live, but in a
 * *propagation* field it plausibly means "actively propagating" — i.e. NOT
 * finished — and neither has ever been observed live here.
 *
 * ⚠ The wave-1 justification for that asymmetry ("a false not-ready is visible,
 * recoverable and costs nothing") held only where the verdicts eventually
 * ARRIVE. On a purchased domain they never do (see `polledDomainIsReady`), so
 * there a false not-ready was a permanent deadlock, not a cheap retry — which is
 * why these tokens no longer gate that branch at all.
 */
const READY_STATUS_TOKENS = new Set([
  "completed",
  "complete",
  "propagated",
  "matched",
  "match",
  "success",
  "successful",
  "verified",
  "done",
]);

/**
 * May the caller provision mailboxes onto this polled domain?
 *
 * `status: "active"` is required either way — an expired or suspended
 * registration can never carry mail, whatever else the record reports. What
 * differs is whether the vendor's two propagation verdicts are consulted at all,
 * and that is decided by the OPERATING connection type (the discriminator the
 * caller resolved), never by the vendor row's own field: reading it off the row
 * would silently import this rule into the connected flow.
 *
 * PURCHASED — the verdicts are NOT consulted. VENDOR CONTRACT, InboxKit support
 * reply 2026-08-10, verbatim: "The domain goauthorpitchdesk.com is now active,
 * and the DNS will be configured during mailbox processing." The propagation
 * checker belongs to the CONNECT flow; on a domain InboxKit registered it never
 * runs before a mailbox exists, so `dns_propagation_status` and
 * `nameserver_match_status` stay "pending" and `last_nameserver_check` stays
 * null indefinitely (six days observed live on the workspace holding
 * goauthorpitchdesk.com, while the vendor's own dashboard computed NS "Matched"
 * live from DNS — the stored fields simply never update). Requiring them was
 * therefore not a conservative wait but a DEADLOCK: mailbox creation is what
 * triggers the DNS configuration the old gate was waiting to observe, so every
 * retry re-read "pending" and stalled forever.
 *
 * That inverts where the billing safety comes from on this branch, and it is
 * worth being explicit that it did not disappear. The mail-DNS-must-work
 * guarantee no longer rides on this predicate; it rides on the vendor confirming
 * the MAILBOX — engine/mailbox-provisioning.ts buys, then awaits
 * `provisioningState === "ready"`, and only then writes the billable row. A
 * vendor failure while configuring the DNS surfaces there, with its own grade.
 *
 * CONNECTED / UNKNOWN — the full conjunction stands. On a connected domain the
 * customer's own registrar has to act, the checker demonstrably DOES run
 * (dmhadvisor.com polled live with `last_nameserver_check` non-null and
 * "matched"), and the verdicts are real evidence. An 'unknown' row is one we
 * failed to classify, and nothing licenses the short-circuit for it.
 *
 * THE CONJUNCTION USED TO HAVE A SECOND ROUTE and it was a false-ready bug
 * (combined-diff gate 2026-08-06, finding #1, EXECUTED against the real REST
 * route): if every nameserver InboxKit assigned appeared in
 * `actual_nameservers`, the function returned true WITHOUT consulting
 * `dns_propagation_status`, so a domain whose NS delegation had landed but whose
 * mail DNS the vendor had not finished setting up was marked ready — and a
 * mailbox was bought, warmup-enrolled and billed on it.
 *
 * The route was deleted rather than added as a third conjunct, for three
 * reasons, and it stays deleted — the change above is grounded in the vendor's
 * stated contract, not in re-deriving readiness from raw fields:
 *  - It was NOT independent evidence. `actual_nameservers` is a field in the
 *    same `/domains/list` response as the verdicts — we never query DNS
 *    ourselves — so the route traded the vendor's CONCLUSION for the vendor's
 *    raw input, which is strictly less information from the same source. The
 *    "first-party proof" framing it shipped under was simply wrong.
 *  - Matching nameservers say "the zone is delegated to the vendor", NOT
 *    "MX/SPF/DKIM/DMARC are live inside it". Delegation is a PRECONDITION of
 *    mail-DNS propagation, not a substitute for it.
 *  - `nameserver_match_status` is the vendor's verdict on precisely the
 *    comparison the route re-derived. Two derivations of one fact with
 *    different thresholds is what produced the disagreement in the first place.
 */
function polledDomainIsReady(record: ListedDomain, connectionType: DomainConnectionType): boolean {
  if ((record.status ?? "").trim().toLowerCase() !== "active") return false;
  if (connectionType === "purchased") return true;
  return isReadyStatus(record.dns_propagation_status) && isReadyStatus(record.nameserver_match_status);
}

function isReadyStatus(raw: string | undefined): boolean {
  return READY_STATUS_TOKENS.has((raw ?? "").trim().toLowerCase());
}

/**
 * One readiness verdict onto all five DnsRecordSet flags. The port reports a
 * single coarse signal (see setDnsForConnectedDomain's APPROXIMATION note), and
 * every caller gates on ALL flags, so the mapping stays in one place.
 */
function dnsRecordSet(ready: boolean): DnsRecordSet {
  return { mx: ready, spf: ready, dkim: ready, dmarc: ready, rdns: ready };
}
