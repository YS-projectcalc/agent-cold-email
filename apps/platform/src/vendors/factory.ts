import type { Clock, TenantPlan, VendorAdapters } from "@coldstart/shared";
import { SandboxBillingPort } from "./sandbox/billing-port.js";
import { SandboxDomainPort } from "./sandbox/domain-port.js";
import { SandboxEmailPort } from "./sandbox/email-port.js";
import { SandboxMailboxPort } from "./sandbox/mailbox-port.js";
import { SandboxMetricsPort } from "./sandbox/metrics-port.js";
import { RealBillingPort } from "./real/billing-port.js";
import { RealDomainPort } from "./real/domain-port.js";
import { RealEmailPort, type EngineClientConfig } from "./real/email-port.js";
import { RealMailboxPort } from "./real/mailbox-port.js";
import { RealMetricsPort } from "./real/metrics-port.js";

export type VendorAdapterKind = "sandbox" | "real";

export interface VendorAdapterBundle extends VendorAdapters {
  readonly kind: VendorAdapterKind;
}

/**
 * The ONE place that decides sandbox vs real. ARCHITECTURE.md #8 / SPEC.md
 * §0.1: "free/demo tenants must be structurally unable to get a real
 * adapter." `realAdaptersActivated` models a future global activation flag
 * (ACTIVATION.md); it is always `false` for now — nothing in this build can
 * set it true. Even if it somehow were true, a demo/free-plan tenant STILL
 * gets sandbox: the plan check is unconditional and comes first.
 */
export function createVendorAdapters(
  plan: TenantPlan,
  clock: Clock,
  realAdaptersActivated: boolean,
  engineConfig?: EngineClientConfig,
): VendorAdapterBundle {
  const isDemoOrFree = plan === "demo" || plan === "free";
  const useSandbox = isDemoOrFree || !realAdaptersActivated;

  if (useSandbox) {
    return {
      kind: "sandbox",
      domain: new SandboxDomainPort(clock),
      mailbox: new SandboxMailboxPort(clock),
      email: new SandboxEmailPort(clock),
      billing: new SandboxBillingPort(clock),
      metrics: new SandboxMetricsPort(clock),
    };
  }

  // `engineConfig` is the external email engine's address/secret (env-derived,
  // see tenant-do.ts). Absent -> RealEmailPort stays dark (NotActivatedError),
  // matching the coded-but-unactivated posture of every other real/ adapter.
  return {
    kind: "real",
    domain: new RealDomainPort(),
    mailbox: new RealMailboxPort(),
    email: new RealEmailPort(engineConfig),
    billing: new RealBillingPort(),
    metrics: new RealMetricsPort(),
  };
}
