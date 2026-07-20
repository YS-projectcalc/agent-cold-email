import type { Clock, TenantPlan, VendorAdapters } from "@coldstart/shared";
import { SandboxBillingPort } from "./sandbox/billing-port.js";
import { SandboxDnsScanPort } from "./sandbox/dns-scan-port.js";
import { SandboxDomainPort } from "./sandbox/domain-port.js";
import { SandboxEmailPort } from "./sandbox/email-port.js";
import { SandboxMailboxPort } from "./sandbox/mailbox-port.js";
import { SandboxMetricsPort } from "./sandbox/metrics-port.js";
import { SandboxDomainReputationPort } from "./sandbox/reputation-port.js";
import { RealBillingPort } from "./real/billing-port.js";
import { RealDnsScanPort } from "./real/dns-scan-port.js";
import { RealDomainPort } from "./real/domain-port.js";
import { RealEmailPort, type EngineClientConfig } from "./real/email-port.js";
import { type InboxKitClientConfig } from "./real/inboxkit-client.js";
import { RealInboxKitDomainPort, type InboxKitDomainRegistrant } from "./real/inboxkit-domain-port.js";
import { RealMailboxPort } from "./real/mailbox-port.js";
import { RealMetricsPort } from "./real/metrics-port.js";
import { RealDomainReputationPort } from "./real/reputation-port.js";

export type VendorAdapterKind = "sandbox" | "real";

export interface VendorAdapterBundle extends VendorAdapters {
  /**
   * Reflects domain/mailbox/billing/metrics only (the ENGINE_TENANTS
   * comped-pilot lane below can hand out a real `email` port while this
   * still reads "sandbox" — check `bundle.email`'s own class if you need the
   * email port's real/sandbox status specifically).
   */
  readonly kind: VendorAdapterKind;
}

/**
 * Parses `ENGINE_TENANTS` (a comma-separated allowlist of exact tenant IDs)
 * into a Set for membership lookup. Total and fail-closed by construction:
 *  - unset/empty -> empty Set. Default-empty means NOBODY is allowlisted,
 *    ever — there is no way to spell "activate everyone" here.
 *  - each entry is trimmed; blank tokens (whitespace, empty segments from a
 *    trailing/duplicate comma) are DROPPED rather than throwing.
 *  - a token containing `*` or `?` is dropped too: this allowlist has no
 *    wildcard/prefix syntax, so a literal "*" can never mean "match every
 *    tenant" — it's just another malformed entry that matches nothing.
 * Malformed entries are dropped INDIVIDUALLY rather than blanking the whole
 * variable on any bad token. That's the safer choice, not just the more
 * convenient one: a dropped entry is inert (Set membership below is exact
 * string equality, so it can only ever narrow, never widen, who matches) —
 * whereas "one bad token empties the whole list" would ALSO revoke every
 * OTHER correctly-specified tenant in the same var for zero extra safety
 * margin, which is a strictly worse operational footgun for the same
 * fail-closed guarantee.
 */
export function parseEngineTenants(raw: string | undefined): ReadonlySet<string> {
  const ids = new Set<string>();
  if (!raw) return ids;
  for (const token of raw.split(",")) {
    const id = token.trim();
    if (!id || id.includes("*") || id.includes("?")) continue;
    ids.add(id);
  }
  return ids;
}

/**
 * The ONE place that decides sandbox vs real. ARCHITECTURE.md #8 / SPEC.md
 * §0.1: "free/demo tenants must be structurally unable to get a real
 * adapter." `realAdaptersActivated` models a future global activation flag
 * (ACTIVATION.md); it is always `false` for now — nothing in this build can
 * set it true. Even if it somehow were true, a demo/free-plan tenant STILL
 * gets sandbox: the plan check is unconditional and comes first.
 *
 * ENGINE_TENANTS (ROADMAP "Mordy-pilot activation lane") layers a SECOND,
 * narrower gate on top, scoped to the EmailPort only: `tenantId` (the DO's
 * own verified identity — see tenant-do.ts) must be an exact member of the
 * parsed `engineTenantsRaw` allowlist. A tenant only ever reaches
 * RealEmailPort when ALL FOUR hold — global flag on, allowlisted, non-demo/
 * free plan, and `engineConfig` present (the last is enforced by
 * RealEmailPort's own dark-until-configured check, same as every other
 * activation-gated port). The allowlist can only ever narrow relative to the
 * base decision, never widen it: with `realAdaptersActivated` false, an
 * allowlisted paid tenant is still fully sandbox.
 *
 * Being on the allowlist ALSO pins domain/mailbox/billing/metrics to sandbox
 * for that tenant, regardless of `realAdaptersActivated` — there is no
 * per-port activation for those ports yet (YAGNI/EmailPort-only, this
 * phase), so the comped-pilot shape must not accidentally hand them a real
 * adapter as a side effect of being allowlisted for email.
 */
export function createVendorAdapters(
  plan: TenantPlan,
  clock: Clock,
  realAdaptersActivated: boolean,
  engineConfig?: EngineClientConfig,
  tenantId?: string,
  engineTenantsRaw?: string,
  /**
   * InboxKit workspace credentials (ACTIVATION.md Gate 0, founder ruling
   * 2026-07-20: "go inboxkit"). Absent in the deployed build today (no call
   * site supplies it) — `RealMailboxPort`/`RealInboxKitDomainPort` stay dark
   * regardless (their own `NotActivatedError` check, mirroring
   * `engineConfig`'s absence keeping `RealEmailPort` dark above). Reused for
   * BOTH the mailbox port and (if selected) the domain port — one InboxKit
   * vendor account.
   */
  inboxKitConfig?: InboxKitClientConfig,
  /**
   * Registrant-of-record contact details for InboxKit domain registration
   * (real/inboxkit-domain-port.ts's doc comment — a founder-level identity
   * decision, deliberately never defaulted). Only consulted when
   * `inboxKitConfig` is ALSO present; absent otherwise like every other
   * activation-gated input here.
   */
  inboxKitDomainRegistrant?: InboxKitDomainRegistrant,
): VendorAdapterBundle {
  const isDemoOrFree = plan === "demo" || plan === "free";
  const isEngineAllowlisted = tenantId !== undefined && parseEngineTenants(engineTenantsRaw).has(tenantId);

  const useSandbox = isDemoOrFree || !realAdaptersActivated || isEngineAllowlisted;
  const useRealEmail = !isDemoOrFree && realAdaptersActivated && isEngineAllowlisted;

  // `engineConfig` is the external email engine's address/secret (env-derived,
  // see tenant-do.ts). Absent -> RealEmailPort stays dark (NotActivatedError),
  // matching the coded-but-unactivated posture of every other real/ adapter.
  const email = useRealEmail ? new RealEmailPort(engineConfig) : new SandboxEmailPort(clock);

  if (useSandbox) {
    return {
      kind: "sandbox",
      domain: new SandboxDomainPort(clock),
      mailbox: new SandboxMailboxPort(clock),
      email,
      billing: new SandboxBillingPort(clock),
      metrics: new SandboxMetricsPort(clock),
      dnsScan: new SandboxDnsScanPort(),
      reputation: new SandboxDomainReputationPort(),
    };
  }

  return {
    kind: "real",
    // Porkbun stays the default registrar path (SPEC.md §11/§12,
    // ACTIVATION.md:25) unless a dedicated InboxKit domain config is
    // supplied — see real/inboxkit-domain-port.ts's OPEN QUESTION doc
    // comment on the unresolved Porkbun-vs-InboxKit registrar decision.
    domain: inboxKitConfig ? new RealInboxKitDomainPort(inboxKitConfig, inboxKitDomainRegistrant) : new RealDomainPort(),
    // InboxKit is the unambiguous, SPEC-decided mailbox vendor (§11/§12
    // "primary = Inboxkit") — no fallback branch needed here.
    mailbox: new RealMailboxPort(inboxKitConfig),
    email,
    billing: new RealBillingPort(),
    metrics: new RealMetricsPort(),
    dnsScan: new RealDnsScanPort(),
    reputation: new RealDomainReputationPort(),
  };
}
