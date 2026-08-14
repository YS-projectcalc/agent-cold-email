import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  domainDnsResult,
  VendorError,
  type DomainDnsResult,
  type DomainPort,
  type LookalikeCandidate,
  type OwnedDomain,
  type PurchasedDomain,
  type ReleaseResult,
} from "@coldstart/shared";
import type { Env } from "../src/env.js";
import { runSetupInfrastructure } from "../src/engine/provisioning.js";
import { runProvisioningReconcile } from "../src/engine/provisioning-reconcile.js";
import { runProvisioningReconcileAllTenants } from "../src/admin/ops-sweep.js";
import { domainIntentKey, replacementDomainIntentKey } from "../src/engine/provision-intents.js";
import { SandboxOpsMailer } from "../src/ops-mail/sandbox-ops-mailer.js";
import { activatePaidPlan, mintTenant, tenantStub, withTenantContext } from "./helpers.js";

// C3 part d — the out-of-band provisioning-reconcile leg (engine/
// provisioning-reconcile.ts). Every completion test drives a CONTROLLABLE domain
// port (not-propagated first, then ready), because the sandbox port always
// returns ready — the exact "sandbox-always-succeeds" trap this platform's
// incident history warns against. A reconcile tested only against that could
// never prove it actually re-drives the real DNS seam.

/**
 * A stateful DomainPort: setDns reports NOT-propagated until `ready` is flipped,
 * throws a seeded error for a named domain, and logs every setDns call — so a
 * test can assert not just the outcome but WHICH domains were (never) touched.
 */
function reconcilePort() {
  const log = { setDns: [] as string[], buys: [] as string[] };
  let ready = false;
  const throwFor = new Map<string, VendorError>();
  const port: DomainPort = {
    async searchLookalikes(_brand, primaryDomain, count): Promise<LookalikeCandidate[]> {
      const slug = primaryDomain.split(".")[0];
      return Array.from({ length: count }, (_v, i) => ({ domain: `${slug}${i}.com`, available: true }));
    },
    async listOwnedDomains(): Promise<OwnedDomain[]> {
      return [];
    },
    async buy(domain: string): Promise<PurchasedDomain> {
      log.buys.push(domain);
      return { domain, purchasedAt: Date.now(), registrar: "test", connectionType: "purchased" };
    },
    async setDns(domain: string): Promise<DomainDnsResult> {
      log.setDns.push(domain);
      const err = throwFor.get(domain);
      if (err) throw err;
      return domainDnsResult(ready ? { kind: "ready" } : { kind: "not_yet" });
    },
    async release(): Promise<ReleaseResult> {
      return { released: true, releasedAt: Date.now() };
    },
  };
  return {
    port,
    log,
    setReady: (v: boolean) => {
      ready = v;
    },
    throwOn: (domain: string, err: VendorError) => throwFor.set(domain, err),
  };
}

function setupInput(primaryDomain: string, domains = 1) {
  const brand = primaryDomain.replace(/\.com$/, "");
  return {
    brand,
    primaryDomain,
    domains,
    inboxesEach: 2,
    persona: "Sender",
    physicalAddress: "1 Test St",
    senderIdentity: `S <s@${primaryDomain}>`,
    quoteOnly: false as const,
  };
}

function readDomains(tenantId: string): Promise<{ domain: string; dns_status: string }[]> {
  return runInDurableObject(tenantStub(tenantId), (_i, s) =>
    s.storage.sql.exec<{ domain: string; dns_status: string }>(`SELECT domain, dns_status FROM domains`).toArray(),
  );
}

function readMailboxCount(tenantId: string): Promise<number> {
  return runInDurableObject(tenantStub(tenantId), (_i, s) =>
    s.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) as n FROM mailboxes WHERE released_at IS NULL`).one().n,
  );
}

/** Seeds a committed setup ordinal exactly as a stranded first-buy leaves it:
 * a 'purchased'/'active'/'pending' domain row + a 'committed' intent carrying
 * (or, with spec:false, lacking) the durable persona/count spec. */
function seedPendingDomain(
  tenantId: string,
  opts: { domain: string; key: string; personaSlug?: string; inboxesEach?: number },
): Promise<void> {
  return runInDurableObject(tenantStub(tenantId), (_i, s) => {
    s.storage.sql.exec(
      `INSERT INTO domains (id, tenant_id, domain, status, purchased_at, dns_status, connection_type)
       VALUES (?, ?, ?, 'active', 1, 'pending', 'purchased')`,
      `dom_${opts.domain}`,
      tenantId,
      opts.domain,
    );
    s.storage.sql.exec(
      `INSERT INTO domain_intents (key, tenant_id, candidate_domain, status, persona_slug, inboxes_each, created_at, updated_at)
       VALUES (?, ?, ?, 'committed', ?, ?, 1, 1)`,
      opts.key,
      tenantId,
      opts.domain,
      opts.personaSlug ?? null,
      opts.inboxesEach ?? null,
    );
  });
}

describe("C3 part d — out-of-band provisioning reconcile", () => {
  it("re-drives a pending setup domain to COMPLETION (simulated-real DNS: pending, then ready)", async () => {
    const { tenantId } = await mintTenant("Reconcile Co", "managed");
    await activatePaidPlan(tenantId, "managed");
    const rp = reconcilePort();

    // A first setup that lands DNS-pending — SUCCESS-PENDING (C3 part b), so the
    // domain is bought + recorded 'pending' with ZERO mailboxes, and its intent
    // carries the durable persona/count spec the reconcile will re-use.
    const setupResult = await withTenantContext(tenantId, (base) =>
      runSetupInfrastructure(
        { ...base, adapters: { ...base.adapters, domain: rp.port } },
        setupInput("reconcileco.com"),
        new SandboxOpsMailer(),
        "rk-1",
      ),
    );
    expect(setupResult).toMatchObject({ provisioning: "pending" });
    expect(await readMailboxCount(tenantId)).toBe(0);
    expect((await readDomains(tenantId))[0]!.dns_status).toBe("pending");

    // The vendor's async registration completes — now the reconcile finishes it
    // out of band, with no agent retry.
    rp.setReady(true);
    const summary = await withTenantContext(tenantId, (ctx) =>
      runProvisioningReconcile({ ...ctx, adapters: { ...ctx.adapters, domain: rp.port } }),
    );

    expect(summary).toMatchObject({ scanned: 1, reconciled: 1, completed: 1, deferred: 0, skippedNoSpec: 0 });
    expect((await readDomains(tenantId))[0]!.dns_status).toBe("ready");
    expect(await readMailboxCount(tenantId)).toBe(2); // the original inboxesEach — no re-buy, no over-provision
    // Exactly ONE buy across setup+reconcile: the setup's. The reconcile hit the
    // resume branch of a committed intent and re-bought NOTHING.
    expect(rp.log.buys).toEqual(["reconcileco0.com"]);
  });

  it("re-driving twice is idempotent — the second pass buys nothing more", async () => {
    const { tenantId } = await mintTenant("Idem Co", "managed");
    await activatePaidPlan(tenantId, "managed");
    const rp = reconcilePort();
    await withTenantContext(tenantId, (base) =>
      runSetupInfrastructure({ ...base, adapters: { ...base.adapters, domain: rp.port } }, setupInput("idemco.com"), new SandboxOpsMailer(), "ik-1"),
    );
    rp.setReady(true);

    const first = await withTenantContext(tenantId, (ctx) => runProvisioningReconcile({ ...ctx, adapters: { ...ctx.adapters, domain: rp.port } }));
    expect(first).toMatchObject({ reconciled: 1, completed: 1 });
    // Second pass: the domain is 'ready' with its full mailbox count, so there is
    // nothing left to do — scanned, but never re-driven, never re-spent.
    const second = await withTenantContext(tenantId, (ctx) => runProvisioningReconcile({ ...ctx, adapters: { ...ctx.adapters, domain: rp.port } }));
    expect(second).toMatchObject({ scanned: 1, reconciled: 0, completed: 0 });
    expect(await readMailboxCount(tenantId)).toBe(2);
  });

  it("per-domain fault isolation — one still-failing domain never blocks another's completion", async () => {
    const { tenantId } = await mintTenant("Isolation Co", "managed");
    await activatePaidPlan(tenantId, "managed");
    const rp = reconcilePort();
    // Two committed pending ordinals: one whose DNS is ready, one whose vendor
    // permanently rejects it. Seeded directly so both carry a durable spec.
    await seedPendingDomain(tenantId, { domain: "goodone.com", key: domainIntentKey(tenantId, 0), personaSlug: "rep", inboxesEach: 2 });
    await seedPendingDomain(tenantId, { domain: "badone.com", key: domainIntentKey(tenantId, 1), personaSlug: "rep", inboxesEach: 2 });
    rp.setReady(true);
    rp.throwOn("badone.com", new VendorError("inboxkit domains/list -> HTTP 503: upstream busy", true));

    const summary = await withTenantContext(tenantId, (ctx) =>
      runProvisioningReconcile({ ...ctx, adapters: { ...ctx.adapters, domain: rp.port } }),
    );

    // The good domain completes; the bad one is DEFERRED (surfaced as errors),
    // and neither aborts the other.
    expect(summary).toMatchObject({ scanned: 2, reconciled: 2, completed: 1, deferred: 1, errors: 1 });
    const byDomain = Object.fromEntries((await readDomains(tenantId)).map((d) => [d.domain, d.dns_status]));
    expect(byDomain["goodone.com"]).toBe("ready");
    expect(byDomain["badone.com"]).toBe("pending");
  });

  it("NEVER touches a replace: burn-replacement intent (the P0 second-writer landmine)", async () => {
    const { tenantId } = await mintTenant("Replace Co", "managed");
    await activatePaidPlan(tenantId, "managed");
    const rp = reconcilePort();
    rp.setReady(true); // even a fully-completable replace domain must be left alone
    // A committed replace: intent with a full spec + a pending replacement domain.
    await seedPendingDomain(tenantId, {
      domain: "burnrepl.com",
      key: replacementDomainIntentKey(tenantId, "burned.com", 0),
      personaSlug: "rep",
      inboxesEach: 2,
    });

    const summary = await withTenantContext(tenantId, (ctx) =>
      runProvisioningReconcile({ ...ctx, adapters: { ...ctx.adapters, domain: rp.port } }),
    );

    // The reconcile skipped it entirely: never scanned, never re-driven, its
    // setDns never called — the burn route is the deliverability loop's, not ours.
    expect(summary).toMatchObject({ scanned: 0, reconciled: 0, completed: 0 });
    expect(rp.log.setDns).toEqual([]);
    expect((await readDomains(tenantId))[0]!.dns_status).toBe("pending");
    expect(await readMailboxCount(tenantId)).toBe(0);
  });

  it("SKIPS a committed intent with no durable spec (a legacy/rebound row) rather than guessing a mailbox count", async () => {
    const { tenantId } = await mintTenant("Legacy Spec Co", "managed");
    await activatePaidPlan(tenantId, "managed");
    const rp = reconcilePort();
    rp.setReady(true);
    // A committed CURRENT-derivation intent whose persona/count columns are NULL —
    // exactly the shape the P0 legacy-key rebind leaves (spec predates the column).
    await seedPendingDomain(tenantId, { domain: "legacyspec.com", key: domainIntentKey(tenantId, 0) });

    const summary = await withTenantContext(tenantId, (ctx) =>
      runProvisioningReconcile({ ...ctx, adapters: { ...ctx.adapters, domain: rp.port } }),
    );

    // Scanned, but SKIPPED for want of a spec — never re-driven, no mailbox
    // guessed/bought. Completion is left to an agent retry (which supplies the
    // real persona + count). Guessing here would double-provision.
    expect(summary).toMatchObject({ scanned: 1, reconciled: 0, completed: 0, skippedNoSpec: 1 });
    expect(rp.log.setDns).toEqual([]);
    expect(await readMailboxCount(tenantId)).toBe(0);
    expect((await readDomains(tenantId))[0]!.dns_status).toBe("pending");
  });

  it("the sweep is DARK by default — PROVISIONING_RECONCILE_ENABLED unset is a no-op that touches nothing", async () => {
    const { tenantId } = await mintTenant("Dark Co", "managed");
    await activatePaidPlan(tenantId, "managed");
    await seedPendingDomain(tenantId, { domain: "darkco.com", key: domainIntentKey(tenantId, 0), personaSlug: "rep", inboxesEach: 2 });

    // The shipped default env has the flag unset.
    const summary = await runProvisioningReconcileAllTenants(env);

    expect(summary).toMatchObject({ disabled: true, tenantsSwept: 0, completed: 0 });
    // The DO was never even constructed — the pending domain is untouched.
    expect((await readDomains(tenantId)).find((d) => d.domain === "darkco.com")!.dns_status).toBe("pending");
    expect(await readMailboxCount(tenantId)).toBe(0);
  });

  it("once ARMED, the sweep reaches each tenant's DO and completes its pending domains", async () => {
    const { tenantId } = await mintTenant("Armed Co", "managed");
    await activatePaidPlan(tenantId, "managed");
    await seedPendingDomain(tenantId, { domain: "armedco.com", key: domainIntentKey(tenantId, 0), personaSlug: "rep", inboxesEach: 2 });

    // Arming is a single env value away — no code change, no deploy. The DO's own
    // (sandbox, in this build) adapters drive the seeded pending domain to ready.
    const summary = await runProvisioningReconcileAllTenants({ ...env, PROVISIONING_RECONCILE_ENABLED: "1" } as Env);

    expect(summary.disabled).toBe(false);
    expect(summary.completed).toBeGreaterThanOrEqual(1);
    expect((await readDomains(tenantId)).find((d) => d.domain === "armedco.com")!.dns_status).toBe("ready");
    expect(await readMailboxCount(tenantId)).toBe(2);
  });
});

void env;
