import type { Clock, DomainPort, TenantPlan, VendorAdapters } from "@coldstart/shared";
import { SandboxBillingPort } from "./sandbox/billing-port.js";
import { SandboxDnsScanPort } from "./sandbox/dns-scan-port.js";
import { SandboxDomainPort } from "./sandbox/domain-port.js";
import { SandboxEmailPort } from "./sandbox/email-port.js";
import { SandboxMailboxPort } from "./sandbox/mailbox-port.js";
import { SandboxMetricsPort } from "./sandbox/metrics-port.js";
import { SandboxDomainReputationPort } from "./sandbox/reputation-port.js";
import { RealBillingPort } from "./real/billing-port.js";
import { RealDnsScanPort } from "./real/dns-scan-port.js";
import { RegistrarUnarmedDomainPort } from "./real/domain-port.js";
import { RealEmailPort, type EngineClientConfig } from "./real/email-port.js";
import { type InboxKitClientConfig } from "./real/inboxkit-client.js";
import { RealInboxKitDomainPort, type InboxKitDomainRegistrant } from "./real/inboxkit-domain-port.js";
import { RealMailboxPort } from "./real/mailbox-port.js";
import { RealMetricsPort } from "./real/metrics-port.js";
import { RealDomainReputationPort } from "./real/reputation-port.js";
import type { RegistrarArmingInput } from "./registrar-arming.js";

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
 * G5 gate (a) (ROADMAP.md:19,33,43; adversary B1 2026-07-23): `domain` is the
 * ONE exception inside the "real" branch below — it does NOT flip real just
 * because `inboxKitConfig` is present. The old logic welded `domain.buy` to
 * the mailbox vendor's credential (`inboxKitConfig ? RealInboxKitDomainPort
 * : RealDomainPort`), so arming InboxKit for mailboxes silently also armed
 * InboxKit-as-registrar — a money-out path the founder never authorized.
 * `domain` hard-blocks (`RegistrarUnarmedDomainPort`, throws
 * `RegistrarUnarmedError` on every call) whenever the bundle would otherwise
 * go real, UNLESS `registrarArming` proves BOTH of its own, independent legs
 * (2026-07-27 wiring, `vendors/registrar-arming.ts`):
 *   1. `armed`  — `REGISTRAR_PROVIDER === "inboxkit"` (env.ts) — the operator's
 *                 global switch.
 *   2. `optIn`  — the TENANT's persisted consent
 *                 (`SetupInfrastructureInput.registerDomains`, captured onto
 *                 `tenant_profile.register_domains` at
 *                 provisioning.ts's runSetupInfrastructure).
 * Both legs true -> `RealInboxKitDomainPort`, constructed with the SAME
 * `inboxKitConfig` credentials the mailbox port uses (one InboxKit vendor
 * account) plus a best-effort registrant derived from tenant_profile
 * (`registrarArming.registrant` — possibly incomplete; the fail-loud
 * completeness check lives at the actual buy() call site,
 * provisioning.ts, never here, so an incomplete profile never bricks THIS
 * factory call for unrelated intents). Either leg false -> the hard-block,
 * exactly as before gate (a) and 2026-07-27 both independently. Mailbox is
 * UNAFFECTED by any of this — InboxKit remains the sole mailbox vendor,
 * gated on `inboxKitConfig` exactly as before.
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
 * `inboxKitConfig` absence similarly keeps mailbox dark as defense in depth —
 * this factory's gate narrows who is ELIGIBLE for a real port, each real
 * port's own dark-until-configured check narrows further to who is actually
 * WIRED. `domain` is gate (a)'s hard block instead (see above) unless
 * `registrarArming` proves both its legs — it never reads `inboxKitConfig`
 * directly for that decision (it reuses the SAME credentials once armed, but
 * the ARMING decision is registrarArming's own two legs, never `inboxKitConfig`'s
 * mere presence).
 */
export function createVendorAdapters(
  plan: TenantPlan,
  clock: Clock,
  activated: boolean,
  engineConfig?: EngineClientConfig,
  /**
   * InboxKit workspace credentials (ACTIVATION.md Gate 0, founder ruling
   * 2026-07-20: "go inboxkit"). Absent in the deployed build today (no call
   * site supplies it) — `RealMailboxPort` stays dark regardless (its own
   * `NotActivatedError` check, mirroring `engineConfig`'s absence keeping
   * `RealEmailPort` dark above). Gates the MAILBOX port only — G5 gate (a)
   * deliberately removed this from the domain-port decision (see above).
   */
  inboxKitConfig?: InboxKitClientConfig,
  /**
   * G5 gate (a) follow-up (2026-07-27) — the domain port's OWN, independent
   * arming decision (`vendors/registrar-arming.ts`). Absent (no call site
   * supplies it — today's only call sites are the sandbox-cache line and
   * every test that doesn't opt in) behaves EXACTLY like `{ armed: false,
   * optIn: false, registrant: {} }` below — the pre-2026-07-27 hard-block,
   * unchanged.
   */
  registrarArming?: RegistrarArmingInput,
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
    // G5 gate (a) three-way branch (2026-07-27): the hard-block UNLESS BOTH
    // `registrarArming` legs (armed AND opted-in) are true — see
    // `selectRealDomainPort` below, the single source of truth for this
    // decision (shared with TenantDO.setupInfrastructure's per-call B1
    // re-selection). Never varies on `inboxKitConfig`'s mere presence; the real
    // adapter reuses the SAME `inboxKitConfig` credentials as the mailbox port
    // (one InboxKit vendor account).
    domain: selectRealDomainPort(inboxKitConfig, registrarArming),
    // InboxKit is the unambiguous, SPEC-decided mailbox vendor (§11/§12
    // "primary = Inboxkit") — no fallback branch needed here. UNAFFECTED by
    // gate (a): mailbox arming is exactly as before.
    mailbox: new RealMailboxPort(inboxKitConfig),
    email,
    billing: new RealBillingPort(),
    metrics: new RealMetricsPort(),
    dnsScan: new RealDnsScanPort(),
    reputation: new RealDomainReputationPort(),
  };
}

/**
 * The real-branch domain-port decision, factored out of `createVendorAdapters`
 * (CLAUDE.md rule c) so the per-call re-selection in
 * `TenantDO.setupInfrastructure` (the B1 fix,
 * docs/adversarial/registrar-arming-review-2026-07-28.md — THIS call's opt-in +
 * registrant is authoritative at buy time, not the pre-call persisted profile
 * `buildAdapters` read) reuses the EXACT same two-leg gate and construction as
 * the factory, never a parallel copy. Only meaningful for an already
 * real-eligible bundle (`useSandbox === false`): the two-leg decouple guard is
 * inviolable here — both `armed` (env, the operator's global switch) AND `optIn`
 * must be true, or the hard-block `RegistrarUnarmedDomainPort` applies exactly as
 * G5 gate (a) shipped it. The registrant is passed as a POSSIBLY-INCOMPLETE
 * best-effort object; the fail-loud completeness check (`assertCompleteRegistrant`)
 * lives at the actual buy() call site (engine/provisioning.ts), never here.
 */
export function selectRealDomainPort(
  inboxKitConfig: InboxKitClientConfig | undefined,
  registrarArming: RegistrarArmingInput | undefined,
): DomainPort {
  const useInboxKitRegistrar = Boolean(registrarArming?.armed && registrarArming?.optIn);
  return useInboxKitRegistrar
    ? new RealInboxKitDomainPort(inboxKitConfig, registrarArming!.registrant as InboxKitDomainRegistrant)
    : new RegistrarUnarmedDomainPort();
}
