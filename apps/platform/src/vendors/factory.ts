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
   * Reflects domain/mailbox/billing/metrics/dnsScan/reputation only — the
   * I1 product-driven `activated` gate below can hand out a real `email`
   * port while this still reads "sandbox" (check `bundle.email`'s own class
   * if you need the email port's real/sandbox status specifically).
   */
  readonly kind: VendorAdapterKind;
}

/**
 * The ONE place that decides sandbox vs real. ARCHITECTURE.md #8 / SPEC.md
 * §0.1: "free/demo tenants must be structurally unable to get a real
 * adapter" — the plan check is unconditional and comes first, so even a
 * hypothetically-`activated=true` demo/free tenant still gets sandbox.
 *
 * `activated` (self-serve activation design §2.1, I1 — REPLACES the manual
 * `ENGINE_TENANTS` allowlist and the hard-`false` `realAdaptersActivated`
 * flag) is the caller-computed product-driven gate:
 *   activated(tenant) = plan is paid && billing_state === 'active'
 *                     && NOT isLifecycleFrozen(status, billing_state)
 *                     && screening_status === 'clear'
 * (see `engine/activation.ts`'s `isTenantActivated`/`readActivationState`).
 * No operator ever touches an allowlist: paying flips `billing_state` to
 * 'active', which flips this on; a frozen/unpaid tenant can never reach it.
 *
 * `activated` gates the EmailPort ONLY (mirrors the retired ENGINE_TENANTS
 * lane's own "EmailPort-only, this phase" scope discipline — I3/I4, the
 * InboxKit mailbox-credential plumbing + arming gates, are separate unbuilt
 * increments). Domain/mailbox/billing/metrics/dnsScan/reputation have no
 * per-tenant activation path yet: they flip real only when BOTH `activated`
 * AND `inboxKitConfig` are present — today no call site supplies
 * `inboxKitConfig`, so they stay sandbox for every tenant regardless of
 * activation (byte-identical to the current, already-shipped behavior).
 *
 * EmailPort itself ALSO requires the design's "global-armed: engine wired"
 * conjunct (§2.1) — `activated` alone is NOT enough: `engineConfig` (derived
 * from `ENGINE_BASE_URL`/`ENGINE_AUTH_SECRET`) must ALSO be present. Without
 * this, a genuinely paid+active tenant in ANY environment that hasn't armed
 * the engine yet (every test env, and production before the founder's
 * one-time Cloudflare Tunnel arming step, ACTIVATION.md) would get a
 * PERMANENTLY-DARK RealEmailPort — every send throws `NotActivatedError`
 * (a `VendorError`, so `tick.ts` grades it non-retryable and marks the send
 * 'failed' — no crash, but nothing ever actually sends) instead of the
 * working sandbox simulator it gets today. Requiring `engineConfig` too
 * preserves TODAY's behavior (paid-but-engine-not-armed tenants keep
 * demonstrating the full sandbox experience) and only lets email go real
 * once the founder has ACTUALLY wired the engine — exactly I1's intent
 * (Mordy pays -> real send begins -> because the founder already armed the
 * engine first, per the design's documented arming order).
 * `inboxKitConfig` absence similarly keeps mailbox/domain dark as defense in
 * depth — this factory's gate narrows who is ELIGIBLE for a real port, each
 * real port's own dark-until-configured check narrows further to who is
 * actually WIRED.
 */
export function createVendorAdapters(
  plan: TenantPlan,
  clock: Clock,
  activated: boolean,
  engineConfig?: EngineClientConfig,
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
  // `engineConfig` is the external email engine's address/secret (env-derived
  // from ENGINE_BASE_URL/ENGINE_AUTH_SECRET, see tenant-do.ts) — required
  // ALONGSIDE `activated` (design §2.1's "engine wired" conjunct; see the doc
  // comment above for why `activated` alone is unsafe).
  const useRealEmail = !isDemoOrFree && activated && engineConfig !== undefined;
  // Domain/mailbox/billing/metrics stay sandbox unless BOTH activated AND
  // InboxKit is wired — see the doc comment above.
  const useSandbox = isDemoOrFree || !activated || !inboxKitConfig;

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
    // comment on the unresolved Porkbun-vs-InboxKit registrar decision
    // (I4 gate (a), unbuilt — this pass does not resolve it). The
    // `: new RealDomainPort()` arm is unreachable via THIS gate today (this
    // whole branch requires `inboxKitConfig` truthy), same "coded but
    // currently inert, not dead" posture as every other real/ stub above —
    // kept so a future domain-specific gate (decoupled from mailbox's) is a
    // config change here, not new code.
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
