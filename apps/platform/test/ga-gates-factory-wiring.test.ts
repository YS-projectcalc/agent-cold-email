import { afterEach, describe, expect, it } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import type { VendorAdapterBundle } from "../src/vendors/factory.js";
import { RealMailboxPort } from "../src/vendors/real/mailbox-port.js";
import { SandboxMailboxPort } from "../src/vendors/sandbox/mailbox-port.js";
import { RegistrarUnarmedDomainPort } from "../src/vendors/real/domain-port.js";
import { RealInboxKitDomainPort } from "../src/vendors/real/inboxkit-domain-port.js";
import { RealEmailPort } from "../src/vendors/real/email-port.js";
import { activatePaidPlan, mintTenant, tenantStub } from "./helpers.js";

// GA increment #1 — factory wiring (closes the dark gap the G5 verdict named:
// createVendorAdapters was NEVER passed inboxKitConfig, so real mailbox
// provisioning was unreachable regardless of which secrets were armed). Once
// INBOXKIT_* is armed for a paid+activated tenant, the bundle goes REAL — while
// every existing gate is preserved and the domain port stays the G5 gate-(a)
// hard-block.

interface TenantDOWithBuildAdapters {
  buildAdapters(): VendorAdapterBundle;
}

const saved = {
  ENGINE_BASE_URL: env.ENGINE_BASE_URL,
  ENGINE_AUTH_SECRET: env.ENGINE_AUTH_SECRET,
  INBOXKIT_API_KEY: env.INBOXKIT_API_KEY,
  INBOXKIT_WORKSPACE_ID: env.INBOXKIT_WORKSPACE_ID,
};
afterEach(() => Object.assign(env, saved));

describe("createVendorAdapters wiring — INBOXKIT_* arming makes real mailbox provisioning REACHABLE", () => {
  it("paid+activated + BOTH engine & InboxKit armed → real bundle: RealMailboxPort, RealEmailPort, and the G5 gate-(a) hard-block domain", async () => {
    Object.assign(env, {
      ENGINE_BASE_URL: "https://engine.example.internal",
      ENGINE_AUTH_SECRET: "s",
      INBOXKIT_API_KEY: "k",
      INBOXKIT_WORKSPACE_ID: "w",
    });
    const { tenantId } = await mintTenant("Wiring Real Co", "launch");
    await activatePaidPlan(tenantId, "launch");

    await runInDurableObject(tenantStub(tenantId), (instance) => {
      const bundle = (instance as unknown as TenantDOWithBuildAdapters).buildAdapters();
      expect(bundle.kind).toBe("real");
      expect(bundle.mailbox).toBeInstanceOf(RealMailboxPort); // the GA gap: real provisioning reachable
      expect(bundle.email).toBeInstanceOf(RealEmailPort);
      // G5 gate (a) preserved — the domain port is the hard-block, NEVER
      // InboxKit-as-registrar, even though InboxKit is armed.
      expect(bundle.domain).toBeInstanceOf(RegistrarUnarmedDomainPort);
      expect(bundle.domain).not.toBeInstanceOf(RealInboxKitDomainPort);
    });
  });

  it("paid+activated + engine armed but InboxKit UNARMED → mailbox stays sandbox (dark), only email is real (pre-GA behavior preserved)", async () => {
    Object.assign(env, {
      ENGINE_BASE_URL: "https://engine.example.internal",
      ENGINE_AUTH_SECRET: "s",
      INBOXKIT_API_KEY: undefined,
      INBOXKIT_WORKSPACE_ID: undefined,
    });
    const { tenantId } = await mintTenant("Wiring Email-Only Co", "launch");
    await activatePaidPlan(tenantId, "launch");

    await runInDurableObject(tenantStub(tenantId), (instance) => {
      const bundle = (instance as unknown as TenantDOWithBuildAdapters).buildAdapters();
      expect(bundle.kind).toBe("sandbox");
      expect(bundle.mailbox).toBeInstanceOf(SandboxMailboxPort);
      expect(bundle.email).toBeInstanceOf(RealEmailPort);
    });
  });

  it("a demo tenant with everything armed still gets sandbox (plan check is unconditional — ARCHITECTURE.md #8)", async () => {
    Object.assign(env, {
      ENGINE_BASE_URL: "https://engine.example.internal",
      ENGINE_AUTH_SECRET: "s",
      INBOXKIT_API_KEY: "k",
      INBOXKIT_WORKSPACE_ID: "w",
    });
    const { tenantId } = await mintTenant("Wiring Demo Co", "demo");
    await runInDurableObject(tenantStub(tenantId), (instance) => {
      const bundle = (instance as unknown as TenantDOWithBuildAdapters).buildAdapters();
      expect(bundle.kind).toBe("sandbox");
      expect(bundle.mailbox).toBeInstanceOf(SandboxMailboxPort);
    });
  });
});
