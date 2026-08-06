import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { VendorError } from "@coldstart/shared";
import { getInfrastructureStatus } from "../src/engine/infrastructure-status.js";
import { runSetupInfrastructure } from "../src/engine/provisioning.js";
import { getOpsSummary } from "../src/engine/ops-summary.js";
import { SandboxDomainPort } from "../src/vendors/sandbox/domain-port.js";
import { SandboxOpsMailer } from "../src/ops-mail/sandbox-ops-mailer.js";
import { activatePaidPlan, api, mintTenant, tenantStub, withTenantContext } from "./helpers.js";

// AMENDMENT to the 2026-08-05 hotfix — the four Mordy-reachable gaps from
// docs/adversarial/provisioning-pipeline-deep-dive-2026-08-05.md (F1-F5).

function setupBody(brand: string, primaryDomain: string, domains: number, inboxesEach: number, extra: object = {}) {
  return JSON.stringify({
    brand,
    primaryDomain,
    domains,
    inboxesEach,
    persona: "Sender",
    physicalAddress: "1 Test St",
    senderIdentity: `Sender <s@${primaryDomain}>`,
    ...extra,
  });
}

function readDomains(tenantId: string): Promise<string[]> {
  return runInDurableObject(tenantStub(tenantId), (_i, state) =>
    state.storage.sql
      .exec<{ domain: string }>(`SELECT domain FROM domains ORDER BY purchased_at ASC`)
      .toArray()
      .map((r) => r.domain),
  );
}

function readOptIn(tenantId: string): Promise<{ register_domains: number; registrant_json: string | null }> {
  return runInDurableObject(tenantStub(tenantId), (_i, state) =>
    state.storage.sql
      .exec<{ register_domains: number; registrant_json: string | null }>(
        `SELECT register_domains, registrant_json FROM tenant_profile`,
      )
      .one(),
  );
}

const REGISTRANT = {
  firstName: "Ada",
  lastName: "Lovelace",
  email: "ada@example.com",
  phone: "+1.5555550100",
  addressLine1: "1 Test St",
  city: "Testville",
  state: "CA",
  country: "US",
  postalCode: "94000",
};

describe("H3b — candidate selection dedupes owned domains and honors availability (F1+F3)", () => {
  it("a SECOND setup call provisions a DIFFERENT domain, never the one call 1 bought", async () => {
    // THE incident shape: lookalike generation is stateless and deterministic,
    // so call 2 regenerated call 1's domain and the vendor rejected it as
    // "already owned by your team" — a guaranteed failure on every retry.
    const { tenantId, token } = await mintTenant("Dedupe Co", "managed");
    await activatePaidPlan(tenantId, "managed");

    // DISTINCT Idempotency-Keys — the two calls are deliberate provisionings,
    // not a retry. A KEYLESS repeat is indistinguishable from a retry and
    // deliberately converges instead (see the keyless test below), which is what
    // keeps a dropped-response retry from double-charging.
    const first = await api("/setup-infrastructure", {
      method: "POST",
      token,
      headers: { "Idempotency-Key": "dedupe-call-1" },
      body: setupBody("Dedupe Co", "dedupeco.com", 1, 1),
    });
    expect(first.status).toBe(202);
    const afterFirst = await readDomains(tenantId);
    expect(afterFirst).toHaveLength(1);

    const second = await api("/setup-infrastructure", {
      method: "POST",
      token,
      headers: { "Idempotency-Key": "dedupe-call-2" },
      body: setupBody("Dedupe Co", "dedupeco.com", 1, 1),
    });
    expect(second.status).toBe(202);

    const afterSecond = await readDomains(tenantId);
    expect(afterSecond).toHaveLength(2);
    expect(afterSecond[1]).not.toBe(afterFirst[0]); // the whole point
    expect(new Set(afterSecond).size).toBe(2);
  });

  it("a KEYLESS repeat of an identical call CONVERGES — no second domain, no double charge", async () => {
    // The other side of the ruling above. Without an idempotency key the
    // platform cannot tell a deliberate second provisioning from a retried
    // first one, so it must take the safe reading: converge on what exists.
    const { tenantId, token } = await mintTenant("Keyless Retry Co", "managed");
    await activatePaidPlan(tenantId, "managed");
    const body = setupBody("Keyless Retry Co", "keylessretry.com", 1, 1);

    await api("/setup-infrastructure", { method: "POST", token, body });
    await api("/setup-infrastructure", { method: "POST", token, body });

    expect(await readDomains(tenantId)).toHaveLength(1);
  });

  it("never buys a candidate the vendor reports as UNAVAILABLE", async () => {
    const { tenantId } = await mintTenant("Unavailable Co", "managed");
    await activatePaidPlan(tenantId, "managed");

    const domainPort = new SandboxDomainPort({ now: () => Date.now() });
    // The first two generated candidates are taken by third parties — the
    // common case for any real business slug. Pre-fix these were bought anyway.
    domainPort.unavailable.add("tryunavailableco.com");
    domainPort.unavailable.add("getunavailableco.com");
    const bought: string[] = [];
    const originalBuy = domainPort.buy.bind(domainPort);
    domainPort.buy = async (domain: string, key: string) => {
      bought.push(domain);
      return originalBuy(domain, key);
    };

    await withTenantContext(tenantId, (base) =>
      runSetupInfrastructure(
        { ...base, adapters: { ...base.adapters, domain: domainPort } },
        {
          brand: "Unavailable Co",
          primaryDomain: "unavailableco.com",
          domains: 1,
          inboxesEach: 1,
          persona: "Sender",
          physicalAddress: "1 St",
          senderIdentity: "S <s@unavailableco.com>",
          quoteOnly: false,
        },
        new SandboxOpsMailer(),
      ),
    );

    expect(bought).toHaveLength(1);
    expect(bought[0]).not.toBe("tryunavailableco.com");
    expect(bought[0]).not.toBe("getunavailableco.com");
  });

  it("fails with a STRUCTURED 400 when no usable candidate remains, never a silent repeat buy", async () => {
    const { tenantId } = await mintTenant("Exhausted Co", "managed");
    await activatePaidPlan(tenantId, "managed");

    const domainPort = new SandboxDomainPort({ now: () => Date.now() });
    domainPort.searchLookalikes = async () => [{ domain: "taken.com", available: false }];

    const err = await withTenantContext(tenantId, (base) =>
      runSetupInfrastructure(
        { ...base, adapters: { ...base.adapters, domain: domainPort } },
        {
          brand: "Exhausted Co",
          primaryDomain: "exhaustedco.com",
          domains: 1,
          inboxesEach: 1,
          persona: "Sender",
          physicalAddress: "1 St",
          senderIdentity: "S <s@exhaustedco.com>",
          quoteOnly: false,
        },
        new SandboxOpsMailer(),
      ).catch((e: unknown) => e),
    );

    expect((err as Error).name).toBe("ValidationError");
    expect((err as Error).message).toMatch(/available lookalike domain/i);
    expect(await readDomains(tenantId)).toEqual([]);
  });
});

describe("H8b — an ABSENT registerDomains leaves persisted consent alone (F2)", () => {
  it("call 1 opts in; call 2 OMITS the fields; the opt-in and registrant survive", async () => {
    const { tenantId, token } = await mintTenant("OptIn Survives Co", "managed");
    await activatePaidPlan(tenantId, "managed");

    await api("/setup-infrastructure", {
      method: "POST",
      token,
      body: setupBody("OptIn Survives Co", "optinsurvives.com", 1, 1, { registerDomains: true, registrant: REGISTRANT }),
    });
    expect((await readOptIn(tenantId)).register_domains).toBe(1);

    // A routine later call that simply doesn't re-send the registrar block.
    await api("/setup-infrastructure", {
      method: "POST",
      token,
      body: setupBody("OptIn Survives Co", "optinsurvives.com", 1, 1),
    });

    // Pre-fix this wiped BOTH columns, silently disabling burn-replacement and
    // making the founder's registrar alert name the wrong cause.
    const after = await readOptIn(tenantId);
    expect(after.register_domains).toBe(1);
    expect(JSON.parse(after.registrant_json ?? "null")).toMatchObject({ firstName: "Ada" });
  });

  it("an EXPLICIT registerDomains:false still revokes (opt-out is not weakened)", async () => {
    const { tenantId, token } = await mintTenant("OptOut Co", "managed");
    await activatePaidPlan(tenantId, "managed");

    await api("/setup-infrastructure", {
      method: "POST",
      token,
      body: setupBody("OptOut Co", "optoutco.com", 1, 1, { registerDomains: true, registrant: REGISTRANT }),
    });
    expect((await readOptIn(tenantId)).register_domains).toBe(1);

    await api("/setup-infrastructure", {
      method: "POST",
      token,
      body: setupBody("OptOut Co", "optoutco.com", 1, 1, { registerDomains: false }),
    });
    expect((await readOptIn(tenantId)).register_domains).toBe(0);
  });
});

describe("H-status — infrastructure_status degrades per mailbox, never 500s (F4)", () => {
  it("one permanently-failing getHealth leaves the endpoint answering, that mailbox 'unknown'", async () => {
    const { tenantId, token } = await mintTenant("Status Isolation Co", "managed");
    await activatePaidPlan(tenantId, "managed");
    await api("/setup-infrastructure", { method: "POST", token, body: setupBody("Status Isolation Co", "statusiso.com", 1, 2) });

    const status = await withTenantContext(tenantId, (base) => {
      let call = 0;
      const ctx = {
        ...base,
        adapters: {
          ...base.adapters,
          mailbox: {
            ...base.adapters.mailbox,
            async getHealth(email: string) {
              // The saga-remnant shape: a local row with no vendor counterpart
              // makes resolveMailboxUid throw PERMANENTLY.
              if (call++ === 0) throw new VendorError(`inboxkit has no mailbox matching ${email}`, false);
              return { email, reputationScore: 90, bounceRate: 0.01, complaintRate: 0, placementRate: 0.98 };
            },
          },
        },
      };
      return getInfrastructureStatus(ctx);
    });

    // Pre-fix: the unguarded Promise.all made this a permanent 500 for the
    // tenant, on the one endpoint the tool description says to poll.
    expect(status.mailboxHealth).toHaveLength(2);
    const degraded = status.mailboxHealth.filter((m) => m.vendorHealth === "unknown");
    expect(degraded).toHaveLength(1);
    // The REASON is now abstract: this field used to carry the adapter's
    // `err.message` ("inboxkit has no mailbox matching …") on the one endpoint
    // a customer's agent is told to poll (sweep-vendor-leak-2026-08-05). The
    // operator's copy goes to the Worker log instead.
    expect(degraded[0]!.vendorHealthError).toBe("mailbox health check temporarily unavailable");
    expect(degraded[0]!.vendorHealthError).not.toMatch(/inboxkit/i);
    // The healthy sibling is unaffected.
    expect(status.mailboxHealth.filter((m) => m.vendorHealth === "ok")).toHaveLength(1);
  });
});

describe("H-alert — a stuck credential push reaches the founder (F5)", () => {
  it("counts pending pushes in the ops summary so the digest can alarm", async () => {
    const { tenantId } = await mintTenant("Cred Alert Co", "managed");
    await activatePaidPlan(tenantId, "managed");

    // A recorded-but-never-pushed mailbox — what EVERY first provisioning
    // produces today, since the manual OAuth minter cannot have a grant for an
    // email that did not exist until this provisioning created it.
    await runInDurableObject(tenantStub(tenantId), (_i, state) => {
      state.storage.sql.exec(
        `INSERT INTO mailbox_cred_pushes (email, tenant_id, status, attempts, created_at, updated_at)
         VALUES (?, ?, 'pending', 7, 1, 1)`,
        "sender11@credalert.com",
        tenantId,
      );
    });

    const summary = await withTenantContext(tenantId, (ctx) => getOpsSummary(ctx, 0));
    // Pre-fix: mailbox_cred_pushes.status was read by NOTHING but the reconcile
    // sweep, so this was invisible to the founder forever.
    expect(summary.pendingCredentialPushes).toBe(1);
  });
});

// Keeps the unused import honest when only a subset of tests run.
void env;
