import { DurableObject } from "cloudflare:workers";
import type { LaunchCampaignInput, SetupInfrastructureInput, TenantPlan } from "@coldstart/shared";
import { TenantIsolationError } from "@coldstart/shared";
import { RealClock, VirtualClock } from "./clock.js";
import type { Env } from "./env.js";
import { runDemo, type DemoRunSummary } from "./engine/demo.js";
import { getInfrastructureStatus, runSetupInfrastructure } from "./engine/provisioning.js";
import { launchCampaign, pauseAllCampaigns, pauseCampaign } from "./engine/campaigns.js";
import { runTick } from "./engine/tick.js";
import { runPollInbox } from "./engine/reply-processor.js";
import { getThread, listInbox, markThread, replyToThread } from "./engine/threads.js";
import { getAccount, getCampaignResults, getMetrics } from "./engine/reporting.js";
import { newId, TENANT_DO_SCHEMA } from "./schema.js";
import type { TenantContext } from "./tenant-context.js";
import { createVendorAdapters, type VendorAdapterBundle } from "./vendors/factory.js";

export interface InitTenantInput {
  tenantId: string;
  brand: string;
  plan: TenantPlan;
}

/**
 * TenantDO — per-tenant state + the SQLite money ledger (ARCHITECTURE.md
 * decision #3). Holds no business logic itself: every RPC method builds a
 * `TenantContext` and dispatches into `src/engine/*.ts`. Callable directly
 * via the stub (Workers RPC), never over an internal HTTP protocol.
 */
export class TenantDO extends DurableObject<Env> {
  private tenantId: string | null = null;
  private plan: TenantPlan = "demo";
  private clock: VirtualClock | null = null;
  private adapters: VendorAdapterBundle | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(TENANT_DO_SCHEMA);

    const row = this.ctx.storage.sql
      .exec<{ id: string; plan: TenantPlan; clock_base: number; clock_offset: number; clock_multiplier: number }>(
        `SELECT id, plan, clock_base, clock_offset, clock_multiplier FROM tenant_profile LIMIT 1`,
      )
      .toArray()[0];

    if (row) {
      this.tenantId = row.id;
      this.plan = row.plan;
      this.clock = new VirtualClock(row.clock_base, row.clock_offset, row.clock_multiplier);
    }
  }

  /** Bootstraps a freshly-signed-up tenant. Idempotent: a second call is a no-op. */
  async initTenant(input: InitTenantInput): Promise<void> {
    if (this.tenantId) return;

    const baseMs = new RealClock().now();
    const multiplier = input.plan === "demo" || input.plan === "free" ? 1440 : 1;

    this.tenantId = input.tenantId;
    this.plan = input.plan;
    this.clock = new VirtualClock(baseMs, 0, multiplier);

    this.ctx.storage.sql.exec(
      `INSERT INTO tenant_profile (id, brand, plan, status, created_at, clock_base, clock_offset, clock_multiplier)
       VALUES (?, ?, ?, 'active', ?, ?, 0, ?)`,
      input.tenantId,
      input.brand,
      input.plan,
      baseMs,
      baseMs,
      multiplier,
    );
    this.ctx.storage.sql.exec(
      `INSERT INTO ledger_entries (id, tenant_id, kind, amount_cents, description, ts)
       VALUES (?, ?, 'credit', 0, 'tenant created (sandbox)', ?)`,
      newId("ledg"),
      input.tenantId,
      baseMs,
    );

    await this.buildAdapters().billing.createCustomer(input.tenantId, `create-customer:${input.tenantId}`);
  }

  private buildAdapters(): VendorAdapterBundle {
    if (!this.clock) throw new Error("tenant not initialized");
    // Cached per DO instance: the sandbox EmailPort's in-memory send/poll
    // queues must be the SAME instance across calls, or a poll() right
    // after a send() would never see what was just queued.
    // realAdaptersActivated is always false in this build — see vendors/factory.ts.
    this.adapters ??= createVendorAdapters(this.plan, this.clock, false);
    return this.adapters;
  }

  private requireContext(): TenantContext {
    if (!this.tenantId || !this.clock) throw new Error("tenant not initialized");
    return {
      sql: this.ctx.storage.sql,
      tenantId: this.tenantId,
      plan: this.plan,
      clock: this.clock,
      adapters: this.buildAdapters(),
    };
  }

  // --- The facade intents (bearer-token-authed, tenant-scoped) ---

  async setupInfrastructure(input: SetupInfrastructureInput) {
    return runSetupInfrastructure(this.requireContext(), input);
  }

  infrastructureStatus() {
    return getInfrastructureStatus(this.requireContext());
  }

  launchCampaign(input: LaunchCampaignInput) {
    return launchCampaign(this.requireContext(), input);
  }

  campaignResults(campaignId: string) {
    return getCampaignResults(this.requireContext(), campaignId);
  }

  metrics() {
    return getMetrics(this.requireContext());
  }

  inbox() {
    return listInbox(this.requireContext());
  }

  thread(threadId: string) {
    return getThread(this.requireContext(), threadId);
  }

  async reply(threadId: string, body: string) {
    return replyToThread(this.requireContext(), threadId, body);
  }

  mark(threadId: string, status: string) {
    markThread(this.requireContext(), threadId, status);
  }

  pause(campaignId: string) {
    pauseCampaign(this.requireContext(), campaignId);
  }

  pauseAll() {
    pauseAllCampaigns(this.requireContext());
  }

  account() {
    return getAccount(this.requireContext());
  }

  // --- Engine tick / poll — see engine/README.md for why these are directly-callable, not alarms ---

  async tick() {
    return runTick(this.requireContext());
  }

  async pollInbox() {
    return runPollInbox(this.requireContext());
  }

  // --- POST /demo/run (B5) — sandbox-only, structurally gated to demo/free plans ---

  async demoRun(): Promise<DemoRunSummary> {
    if (this.plan !== "demo" && this.plan !== "free") {
      throw new TenantIsolationError(
        "demo run is a sandbox-only surface, unavailable for this tenant's plan — see ARCHITECTURE.md #8",
      );
    }
    return runDemo(this.requireContext());
  }

  // --- Sandbox/test-only clock control — never exposed as an HTTP facade intent ---

  advanceClock(virtualMs: number): number {
    if (this.plan !== "demo" && this.plan !== "free") {
      throw new Error("advanceClock is a sandbox-only control, unavailable for this tenant's plan");
    }
    if (!this.clock || !this.tenantId) throw new Error("tenant not initialized");
    const newOffset = this.clock.advanceVirtual(virtualMs);
    this.ctx.storage.sql.exec(`UPDATE tenant_profile SET clock_offset = ? WHERE id = ?`, newOffset, this.tenantId);
    return newOffset;
  }
}
