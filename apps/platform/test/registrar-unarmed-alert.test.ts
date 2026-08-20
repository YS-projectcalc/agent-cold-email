import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { RegistrarUnarmedError, type DomainDnsResult, type DomainPort, type LookalikeCandidate, type OwnedDomain, type PurchasedDomain, type ReleaseResult } from "@coldstart/shared";
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
function alwaysRegistrarUnarmed(reason: "env" | "opt_in" = "env"): DomainPort {
  return {
    async searchLookalikes(): Promise<LookalikeCandidate[]> {
      throw new RegistrarUnarmedError("searchLookalikes", reason);
    },
    async listOwnedDomains(): Promise<OwnedDomain[]> {
      throw new RegistrarUnarmedError("listOwnedDomains", reason);
    },
    async buy(): Promise<PurchasedDomain> {
      throw new RegistrarUnarmedError("buy", reason);
    },
    async setDns(): Promise<DomainDnsResult> {
      throw new RegistrarUnarmedError("setDns", reason);
    },
    async release(): Promise<ReleaseResult> {
      throw new RegistrarUnarmedError("release", reason);
    },
  };
}

async function withInjectedDomain<T>(tenantId: string, domain: DomainPort, fn: (ctx: TenantContext) => Promise<T> | T): Promise<T> {
  return runInDurableObject(tenantStub(tenantId), async (_instance, state) => {
    const sql = state.storage.sql;
    const profile = sql
      .exec<{ plan: "demo" | "free" | "managed"; clock_base: number; clock_offset: number }>(
        `SELECT plan, clock_base, clock_offset FROM tenant_profile WHERE id = ?`,
        tenantId,
      )
      .one();
    const clock = new VirtualClock(profile.clock_base, profile.clock_offset);
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
  registerDomains: false,
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

  // J4 (build gate 2026-08-19) — THE ALERT IS THE ENV LEG'S, AND ONLY THE ENV
  // LEG'S. The two-leg split (§7.8) made the opt-in refusal TENANT-fixable and
  // set `operatorActionable: reason === "env"` on the error itself; paging the
  // founder for the leg the same wave declared not operator-actionable is the
  // contradiction. Three further reasons, each independently sufficient: the
  // alert body says "the registrar is not armed", which is FALSE on that leg
  // (it IS armed — the request simply did not consent); the 400 the wave added
  // is fully self-describing, so nothing is lost; and `searchLookalikes` runs
  // unconditionally BEFORE any shortfall branch, so an agent retry loop that
  // omits `registerDomains` pages the founder on EVERY attempt through a direct
  // `mailer.send`, with none of the watchtower's debounce or backoff.
  it("does NOT page the founder on the tenant-fixable OPT-IN leg — the 400 is self-describing", async () => {
    const { tenantId } = await signup("Registrar Optin Co", "founder@registraroptin.test");
    const mailer = new SandboxOpsMailer();

    await expect(
      withInjectedDomain(tenantId, alwaysRegistrarUnarmed("opt_in"), (ctx) => runSetupInfrastructure(ctx, SETUP_INPUT, mailer)),
    ).rejects.toBeInstanceOf(RegistrarUnarmedError);

    expect(mailer.sent).toHaveLength(0);
  });

  it("the env-leg alert body names the ENV leg rather than the pre-split 'gate (a)' wording alone", async () => {
    const { tenantId } = await signup("Registrar Wording Co", "founder@registrarwording.test");
    const mailer = new SandboxOpsMailer();

    await expect(
      withInjectedDomain(tenantId, alwaysRegistrarUnarmed("env"), (ctx) => runSetupInfrastructure(ctx, SETUP_INPUT, mailer)),
    ).rejects.toBeInstanceOf(RegistrarUnarmedError);

    const text = mailer.sent[0]?.text ?? "";
    // The operator's actual lever, named — and the leg this alert is NOT about,
    // so a founder reading it never goes looking for a tenant's consent field.
    expect(text).toMatch(/REGISTRAR_PROVIDER/);
    expect(text).toMatch(/opt-in/i);
  });

  it("never sends an alert on the ordinary (non-registrar) success path — the hook only fires on RegistrarUnarmedError", async () => {
    const { tenantId } = await signup("Registrar Alert Quiet Co", "founder@registraralertquiet.test");
    const mailer = new SandboxOpsMailer();

    // Default sandbox adapters (no injected domain override) — the ordinary
    // demo-tenant path, which succeeds without ever touching the registrar seam.
    await withInjectedDomain(tenantId, createVendorAdapters("demo", new VirtualClock(Date.now(), 0), false).domain, (ctx) =>
      runSetupInfrastructure(ctx, SETUP_INPUT, mailer),
    );

    expect(mailer.sent).toHaveLength(0);
  });
});
