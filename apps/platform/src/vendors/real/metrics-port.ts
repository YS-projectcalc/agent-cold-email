import { NotActivatedError } from "@coldstart/shared";
import type { MetricsPort, PlacementResult } from "@coldstart/shared";

// Real MetricsPort (Inboxkit placement/deliverability signals) — coded stub
// only, activation-gated. See real/domain-port.ts.
export class RealMetricsPort implements MetricsPort {
  async getPlacement(_mailboxEmail: string): Promise<PlacementResult> {
    throw new NotActivatedError("inboxkit", "getPlacement");
  }
}
