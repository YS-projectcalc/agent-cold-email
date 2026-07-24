import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { RegistrarUnarmedError, type DnsRecordSet, type DomainPort, type LookalikeCandidate, type PurchasedDomain, type ReleaseResult } from "@coldstart/shared";
import { VirtualClock } from "../src/clock.js";
import { readActivationState } from "../src/engine/activation.js";
import { runSetupInfrastructure } from "../src/engine/provisioning.js";
import { SandboxOpsMailer } from "../src/ops-mail/sandbox-ops-mailer.js";
import type { TenantContext } from "../src/tenant-context.js";
import { createVendorAdapters } from "../src/vendors/factory.js";
import { signup, tenantStub } from "./helpers.js";

// G5 gate (a) (ROADMAP.md:19,33,43; adversary B1 2026-07-23) — proves
// runSetupInfrastructure's catch-and-alert wiring around the registrar hard
// block: (1) the customer-facing call still rejects with RegistrarUnarmedError
// (never a silent sandbox fallthrough, never a generic swallow), and (2) the
// founder gets a same-request ops alert naming the tenant + blocked domain —
// "graceful customer-visible state ... never an unhandled 500" per the brief.

/** A DomainPort that always hard-blocks — mirrors RegistrarUnarmedDomainPort's
 * OWN behavior (real/domain-port.ts) without depending on factory wiring, so
 * this test isolates runSetupInfrastructure's error-handling/alert wiring
 * from the factory's port-selection logic (already covered by
 * inboxkit-adapter-dark-gating.test.ts's gate (a) guard). */
function alwaysRegistrarUnarmed(): DomainPort {
  return {
    async searchLookalikes(): Promise<LookalikeCandidate[]> {
      throw new RegistrarUnarmedError("searchLookalikes");
    },
    async buy(): Promise<PurchasedDomain> {
      throw new RegistrarUnarmedError("buy");
    },
    async setDns(): Promise<DnsRecordSet> {
      throw new RegistrarUnarmedError("setDns");
    },
    async release(): Promise<ReleaseResult> {
      throw new RegistrarUnarmedError("release");
    },
  };
}

async function withInjectedDomain<T>(tenantId: string, domain: DomainPort, fn: (ctx: TenantContext) => Promise<T> | T): Promise<T> {
  return runInDurableObject(tenantStub(tenantId), async (_instance, state) => {
    const sql = state.storage.sql;
    const profile = sql
      .exec<{ plan: "demo" | "free" | "managed"; clock_base: number; clock_offset: number; clock_multiplier: number }>(
        `SELECT plan, clock_base, clock_offset, clock_multiplier FROM tenant_profile WHERE id = ?`,
        tenantId,
      )
      .one();
    const clock = new VirtualClock(profile.clock_base, profile.clock_offset, profile.clock_multiplier);
    const { activated } = readActivationState(sql, tenantId);
    const ctx: TenantContext = {
      sql,
      tenantId,
      plan: profile.plan,
      clock,
      adapters: { ...createVendorAdapters(profile.plan, clock, activated), domain },
      env,
    };
    return fn(ctx);
  });
}

const SETUP_INPUT = {
  brand: "Registrar Alert Co",
  primaryDomain: "registraralertco.com",
  domains: 1,
  inboxesEach: 1,
  persona: "Sender",
  physicalAddress: "1 St",
  senderIdentity: "Sender <s@registraralertco.com>",
  quoteOnly: false,
};

describe("G5 gate (a) — runSetupInfrastructure's registrar-unarmed handling", () => {
  it("rejects with RegistrarUnarmedError (never a silent sandbox fallthrough) AND fires exactly one founder ops alert naming the tenant + blocked domain", async () => {
    const { tenantId } = await signup("Registrar Alert Co", "founder@registraralertco.test");
    const mailer = new SandboxOpsMailer();

    await expect(
      withInjectedDomain(tenantId, alwaysRegistrarUnarmed(), (ctx) => runSetupInfrastructure(ctx, SETUP_INPUT, mailer)),
    ).rejects.toBeInstanceOf(RegistrarUnarmedError);

    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]?.to).toBe(env.OPS_ALERT_EMAIL);
    expect(mailer.sent[0]?.subject).toContain("registrar not armed");
    expect(mailer.sent[0]?.subject).toContain(tenantId);
    expect(mailer.sent[0]?.text).toContain(SETUP_INPUT.primaryDomain);
  });

  it("never sends an alert on the ordinary (non-registrar) success path — the hook only fires on RegistrarUnarmedError", async () => {
    const { tenantId } = await signup("Registrar Alert Quiet Co", "founder@registraralertquiet.test");
    const mailer = new SandboxOpsMailer();

    // Default sandbox adapters (no injected domain override) — the ordinary
    // demo-tenant path, which succeeds without ever touching the registrar seam.
    await withInjectedDomain(tenantId, createVendorAdapters("demo", new VirtualClock(Date.now(), 0, 1), false).domain, (ctx) =>
      runSetupInfrastructure(ctx, SETUP_INPUT, mailer),
    );

    expect(mailer.sent).toHaveLength(0);
  });
});
