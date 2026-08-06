import type { Clock, TenantPlan } from "@coldstart/shared";
import type { Env } from "./env.js";
import type { VendorAdapterBundle } from "./vendors/factory.js";

/** Bundle every engine/*.ts function needs, assembled once per RPC call by TenantDO. */
export interface TenantContext {
  readonly sql: SqlStorage;
  readonly tenantId: string;
  readonly plan: TenantPlan;
  /**
   * The tenant's clock — REAL for a paid tenant, VIRTUAL for a demo/free one
   * (clock.ts). TenantDO supplies a DelegatingClock, so an in-flight saga sees
   * a mid-call virtual->real flip on its very next now(). Narrow with
   * `requireVirtualClock` before calling a VirtualClock-only control.
   */
  readonly clock: Clock;
  readonly adapters: VendorAdapterBundle;
  // B1: threaded through so engine/billing.ts can read STRIPE_SECRET_KEY
  // without every engine function taking a separate env param.
  readonly env: Env;
}
