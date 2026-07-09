import type { TenantPlan } from "@coldstart/shared";
import type { VirtualClock } from "./clock.js";
import type { Env } from "./env.js";
import type { VendorAdapterBundle } from "./vendors/factory.js";

/** Bundle every engine/*.ts function needs, assembled once per RPC call by TenantDO. */
export interface TenantContext {
  readonly sql: SqlStorage;
  readonly tenantId: string;
  readonly plan: TenantPlan;
  readonly clock: VirtualClock;
  readonly adapters: VendorAdapterBundle;
  // B1: threaded through so engine/billing.ts can read STRIPE_SECRET_KEY
  // without every engine function taking a separate env param.
  readonly env: Env;
}
