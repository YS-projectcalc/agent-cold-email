import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { runSetupInfrastructure } from "../src/engine/provisioning.js";
import { SandboxOpsMailer } from "../src/ops-mail/sandbox-ops-mailer.js";
import { SandboxDomainPort } from "../src/vendors/sandbox/domain-port.js";
import { activatePaidPlan, api, mintTenant, signup, tenantStub, withTenantContext } from "./helpers.js";

// BLOCKING-1, docs/adversarial/audit-dashboard-idempotency-2026-08-06.md.
//
// The durable domain buy-intent used to be namespaced by the CALLER's request
// idempotency key (`${setupKey ?? tenant}#${ordinal}`), which inverted the
// retry contract: omitting the key converged, supplying one — or changing it —
// opened a fresh intent and bought a second lookalike domain plus a full set of
// billable mailboxes. The audit executed both reachable shapes (unkeyed call
// then keyed retry; k1 then k2) and got 2 domains / 4 mailboxes each time.
//
// The intent ordinal is now tenant-global, so `domains`/`inboxesEach` are a
// TARGET the call reconciles toward and the caller's key has no bearing on what
// is bought. These tests pin both halves: retries converge under every key
// permutation, and asking for MORE still provisions more.

function setupBody(brand: string, primaryDomain: string, domains = 1, inboxesEach = 2) {
  return JSON.stringify({
    brand,
    primaryDomain,
    domains,
    inboxesEach,
    persona: "Sender",
    physicalAddress: "1 Test St",
    senderIdentity: `Sender <s@${primaryDomain}>`,
  });
}

interface Counts {
  domains: number;
  mailboxes: number;
  names: string[];
}

function counts(tenantId: string): Promise<Counts> {
  return runInDurableObject(tenantStub(tenantId), (_i, state) => ({
    domains: state.storage.sql
      .exec<{ n: number }>(`SELECT COUNT(*) as n FROM domains WHERE tenant_id = ?`, tenantId)
      .one().n,
    mailboxes: state.storage.sql
      .exec<{ n: number }>(`SELECT COUNT(*) as n FROM mailboxes WHERE tenant_id = ? AND released_at IS NULL`, tenantId)
      .one().n,
    names: state.storage.sql
      .exec<{ domain: string }>(`SELECT domain FROM domains WHERE tenant_id = ? ORDER BY purchased_at ASC`, tenantId)
      .toArray()
      .map((r) => r.domain),
  }));
}

/** POSTs setup through the real HTTP surface, optionally carrying a key. */
function setup(token: string, body: string, idempotencyKey?: string) {
  return api("/setup-infrastructure", {
    method: "POST",
    token,
    body,
    headers: idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined,
  });
}

describe("B1 — a setup_infrastructure retry converges no matter what the caller's idempotency key does", () => {
  it("unkeyed first call, then a KEYED retry, buys nothing the second time", async () => {
    const { tenantId, token } = await signup("Mixed Key Co", "founder@mixedkey.com");
    const body = setupBody("Mixed Key Co", "mixedkey.com");

    await setup(token, body);
    const afterFirst = await counts(tenantId);
    expect(afterFirst.domains).toBe(1);
    expect(afterFirst.mailboxes).toBe(2);

    // The reachable trajectory: the dashboard never sends a key, and the
    // tenant's agent retries WITH one because the tool description tells it to.
    await setup(token, body, "agent-retry-1");

    const afterRetry = await counts(tenantId);
    expect(afterRetry.domains).toBe(1);
    expect(afterRetry.mailboxes).toBe(2);
    expect(afterRetry.names).toEqual(afterFirst.names);
  });

  it("two retries carrying DIFFERENT keys buy one domain, not two", async () => {
    const { tenantId, token } = await signup("Two Keys Co", "founder@twokeys.com");
    const body = setupBody("Two Keys Co", "twokeys.com");

    await setup(token, body, "k1");
    const afterK1 = await counts(tenantId);
    expect(afterK1.domains).toBe(1);

    await setup(token, body, "k2");

    const afterK2 = await counts(tenantId);
    expect(afterK2.domains).toBe(1);
    expect(afterK2.mailboxes).toBe(2);
    expect(afterK2.names).toEqual(afterK1.names);
  });

  it("keeps converging for the two shapes that already did: unkeyed twice, and the same key twice", async () => {
    const unkeyed = await signup("Unkeyed Co", "founder@unkeyedco.com");
    const unkeyedBody = setupBody("Unkeyed Co", "unkeyedco.com");
    await setup(unkeyed.token, unkeyedBody);
    await setup(unkeyed.token, unkeyedBody);
    expect((await counts(unkeyed.tenantId)).domains).toBe(1);

    const sameKey = await signup("Same Key Co", "founder@samekeyco.com");
    const sameKeyBody = setupBody("Same Key Co", "samekeyco.com");
    await setup(sameKey.token, sameKeyBody, "stable");
    await setup(sameKey.token, sameKeyBody, "stable");
    expect((await counts(sameKey.tenantId)).domains).toBe(1);
  });
});

describe("B1 — asking for MORE infrastructure still provisions it (the target is the ask, not the key)", () => {
  it("raising `domains` buys the shortfall and leaves the existing domain alone", async () => {
    const { tenantId, token } = await signup("Expand Co", "founder@expandco.com");

    await setup(token, setupBody("Expand Co", "expandco.com", 1, 2));
    const afterFirst = await counts(tenantId);
    expect(afterFirst.domains).toBe(1);

    await setup(token, setupBody("Expand Co", "expandco.com", 2, 2));

    const afterExpand = await counts(tenantId);
    expect(afterExpand.domains).toBe(2);
    expect(afterExpand.mailboxes).toBe(4);
    // The first domain is kept, not replaced — expansion is additive on top of
    // what the ordinals already resolved to.
    expect(afterExpand.names[0]).toBe(afterFirst.names[0]);
  });

  it("raising `inboxesEach` tops the SAME domain up to the new per-domain target", async () => {
    const { tenantId, token } = await signup("Topup Co", "founder@topupco.com");

    await setup(token, setupBody("Topup Co", "topupco.com", 1, 2));
    expect((await counts(tenantId)).mailboxes).toBe(2);

    await setup(token, setupBody("Topup Co", "topupco.com", 1, 4));

    const afterTopup = await counts(tenantId);
    expect(afterTopup.domains).toBe(1);
    expect(afterTopup.mailboxes).toBe(4);
  });

  it("a fresh key does not by itself buy anything — expansion comes from the numbers", async () => {
    const { tenantId, token } = await signup("Fresh Key Co", "founder@freshkeyco.com");
    const body = setupBody("Fresh Key Co", "freshkeyco.com", 1, 2);

    await setup(token, body, "first");
    await setup(token, body, "second");
    await setup(token, body, "third");

    expect((await counts(tenantId)).domains).toBe(1);
  });
});

describe("B1 — a retry that needs to buy NOTHING no longer depends on fresh candidates being available", () => {
  it("converges even when every remaining lookalike is taken by someone else", async () => {
    const { tenantId } = await mintTenant("Shortfall Co", "managed");
    await activatePaidPlan(tenantId, "managed");

    // One port instance across both calls so its availability state persists —
    // the retry has to survive the vendor reporting every OTHER candidate gone.
    const domainPort = new SandboxDomainPort({ now: () => Date.now() });
    const bought: string[] = [];
    const originalBuy = domainPort.buy.bind(domainPort);
    domainPort.buy = async (domain: string, key: string) => {
      bought.push(domain);
      return originalBuy(domain, key);
    };
    const input = {
      brand: "Shortfall Co",
      primaryDomain: "shortfallco.com",
      domains: 1,
      inboxesEach: 1,
      persona: "Sender",
      physicalAddress: "1 Test St",
      senderIdentity: "S <s@shortfallco.com>",
      quoteOnly: false,
    };
    const run = () =>
      withTenantContext(tenantId, (base) =>
        runSetupInfrastructure(
          { ...base, adapters: { ...base.adapters, domain: domainPort } },
          input,
          new SandboxOpsMailer(),
        ),
      );

    await run();
    expect(bought).toHaveLength(1);

    // Every candidate the generator can still offer is now unavailable, so the
    // retry has zero usable NEW names. It needs none: ordinal 0 is committed.
    for (const candidate of await domainPort.searchLookalikes("Shortfall Co", "shortfallco.com", 12)) {
      domainPort.unavailable.add(candidate.domain);
    }

    await expect(run()).resolves.toBeDefined();
    expect(bought).toHaveLength(1);
    expect((await counts(tenantId)).domains).toBe(1);
  });

  it("still refuses, without buying, when a call genuinely needs a domain and none is available", async () => {
    const { tenantId } = await mintTenant("Exhausted Retry Co", "managed");
    await activatePaidPlan(tenantId, "managed");

    const domainPort = new SandboxDomainPort({ now: () => Date.now() });
    for (const candidate of await domainPort.searchLookalikes("Exhausted Retry Co", "exhaustedretry.com", 12)) {
      domainPort.unavailable.add(candidate.domain);
    }
    const bought: string[] = [];
    domainPort.buy = async (domain: string) => {
      bought.push(domain);
      throw new Error("must not buy");
    };

    await expect(
      withTenantContext(tenantId, (base) =>
        runSetupInfrastructure(
          { ...base, adapters: { ...base.adapters, domain: domainPort } },
          {
            brand: "Exhausted Retry Co",
            primaryDomain: "exhaustedretry.com",
            domains: 1,
            inboxesEach: 1,
            persona: "Sender",
            physicalAddress: "1 Test St",
            senderIdentity: "S <s@exhaustedretry.com>",
            quoteOnly: false,
          },
          new SandboxOpsMailer(),
        ),
      ),
    ).rejects.toThrow(/available lookalike domain/i);
    expect(bought).toHaveLength(0);
  });
});
