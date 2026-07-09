import type { BillingCustomer, BillingPort, Clock, UsageRecordResult } from "@coldstart/shared";

// Sandbox BillingPort — records intents only, no Stripe test-mode wiring yet
// (that's B1 scope). Idempotent by key so retried usage writes don't double-bill.
export class SandboxBillingPort implements BillingPort {
  private readonly recordedByIdempotencyKey = new Map<string, UsageRecordResult>();

  constructor(private readonly clock: Clock) {}

  async createCustomer(tenantId: string, _idempotencyKey: string): Promise<BillingCustomer> {
    return { customerId: `cus_sandbox_${tenantId}`, createdAt: this.clock.now() };
  }

  async recordUsage(
    _tenantId: string,
    _description: string,
    _amountCents: number,
    idempotencyKey: string,
  ): Promise<UsageRecordResult> {
    const cached = this.recordedByIdempotencyKey.get(idempotencyKey);
    if (cached) return cached;
    const result: UsageRecordResult = { recordId: `rec_${crypto.randomUUID()}`, recordedAt: this.clock.now() };
    this.recordedByIdempotencyKey.set(idempotencyKey, result);
    return result;
  }
}
