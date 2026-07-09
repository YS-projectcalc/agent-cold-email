import { NotActivatedError } from "@coldstart/shared";
import type { BillingCustomer, BillingPort, UsageRecordResult } from "@coldstart/shared";

// Real BillingPort (Stripe live mode) — coded stub only, activation-gated. See real/domain-port.ts.
export class RealBillingPort implements BillingPort {
  async createCustomer(_tenantId: string, _idempotencyKey: string): Promise<BillingCustomer> {
    throw new NotActivatedError("stripe", "createCustomer");
  }

  async recordUsage(
    _tenantId: string,
    _description: string,
    _amountCents: number,
    _idempotencyKey: string,
  ): Promise<UsageRecordResult> {
    throw new NotActivatedError("stripe", "recordUsage");
  }
}
