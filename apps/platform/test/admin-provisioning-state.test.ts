import { describe, expect, it } from "vitest";
import { nonTerminal, terminal } from "@coldstart/shared";
import { domainIntentKey } from "../src/engine/provision-intents.js";
import { withRequestIdempotency } from "../src/engine/idempotency.js";
import { adminApi, api, mintTenant, withTenantContext } from "./helpers.js";

// UNVERIFIABLE-1/2/3 (docs/adversarial/agent-channel-product-audit-2026-08-17.md) —
// the operator has no read on a tenant's provisioning state: whether a
// setup_infrastructure idempotency key is 'done' (so a retry replays instead
// of running), which ordinal a domain occupies, or a domain's real DNS
// standing. GET /admin/tenants/:id/provisioning-state (routes/admin-messages.ts
// ONLY; never a tenant-facing route) closes that gap — same auth/404 pattern
// as GET /admin/tenants/:id/messages.

interface ProvisioningStateResponse {
  tenantId: string;
  domains: {
    domain: string;
    status: string;
    source: string;
    dnsStatus: string;
    dnsFirstCheckedAt: number | null;
    dnsCheckCount: number;
    dnsGaveUpAt: number | null;
    purchasedAt: number;
  }[];
  domainIntents: {
    key: string;
    ordinal: number | null;
    candidateDomain: string;
    status: string;
    personaSlug: string | null;
    inboxesEach: number | null;
    createdAt: number;
    updatedAt: number;
  }[];
  requestIdempotency: {
    key: string;
    status: string;
    createdAt: number;
  }[];
}

async function seedDomain(
  tenantId: string,
  domain: string,
  overrides: Partial<{
    status: string;
    source: string;
    dnsStatus: string;
    dnsFirstCheckedAt: number | null;
    dnsCheckCount: number;
    dnsGaveUpAt: number | null;
    purchasedAt: number;
  }> = {},
): Promise<void> {
  await withTenantContext(tenantId, (ctx) => {
    ctx.sql.exec(
      `INSERT INTO domains (id, tenant_id, domain, status, source, purchased_at, dns_status, dns_first_checked_at, dns_check_count, dns_gave_up_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      `dom_${domain.replace(/\W/g, "")}`,
      tenantId,
      domain,
      overrides.status ?? "active",
      overrides.source ?? "provisioned",
      overrides.purchasedAt ?? 1000,
      overrides.dnsStatus ?? "ready",
      overrides.dnsFirstCheckedAt ?? null,
      overrides.dnsCheckCount ?? 0,
      overrides.dnsGaveUpAt ?? null,
    );
  });
}

describe("GET /admin/tenants/:id/provisioning-state", () => {
  describe("auth", () => {
    it("401s with no Authorization header", async () => {
      const { tenantId } = await mintTenant("Prov State NoAuth Co", "managed");
      const res = await api(`/admin/tenants/${tenantId}/provisioning-state`);
      expect(res.status).toBe(401);
    });

    it("401s with a wrong admin token", async () => {
      const { tenantId } = await mintTenant("Prov State WrongAuth Co", "managed");
      const res = await adminApi(`/admin/tenants/${tenantId}/provisioning-state`, { adminToken: "not-the-admin-token" });
      expect(res.status).toBe(401);
    });

    it("401s a tenant's OWN bearer token — this is an admin-only surface", async () => {
      const { tenantId, token } = await mintTenant("Prov State TenantAuth Co", "managed");
      const res = await api(`/admin/tenants/${tenantId}/provisioning-state`, { token });
      expect(res.status).toBe(401);
    });
  });

  it("404s an unknown tenant id", async () => {
    const res = await adminApi("/admin/tenants/does-not-exist/provisioning-state");
    expect(res.status).toBe(404);
  });

  it("round-trips seeded domains, domain intents, and setup_infrastructure idempotency rows", async () => {
    const { tenantId } = await mintTenant("Prov State Roundtrip Co", "managed");

    await seedDomain(tenantId, "goodco0.com", { dnsStatus: "ready", purchasedAt: 5000 });
    await seedDomain(tenantId, "deadco1.com", {
      dnsStatus: "pending",
      dnsFirstCheckedAt: 1000,
      dnsCheckCount: 3,
      dnsGaveUpAt: 9000,
      purchasedAt: 500,
    });

    await withTenantContext(tenantId, (ctx) => {
      ctx.sql.exec(
        `INSERT INTO domain_intents (key, tenant_id, candidate_domain, status, persona_slug, inboxes_each, created_at, updated_at)
         VALUES (?, ?, ?, 'committed', ?, ?, ?, ?)`,
        domainIntentKey(tenantId, 0),
        tenantId,
        "goodco0.com",
        "Sender",
        2,
        1000,
        1000,
      );
      ctx.sql.exec(
        `INSERT INTO domain_intents (key, tenant_id, candidate_domain, status, created_at, updated_at)
         VALUES (?, ?, ?, 'dangling', ?, ?)`,
        domainIntentKey(tenantId, 1),
        tenantId,
        "deadco1.com",
        1000,
        1000,
      );
    });

    // The exact scenario UNVERIFIABLE-1 needs: a setup_infrastructure key that
    // replays to 'done' with a real (never-returned) response body.
    //
    // Under the `Settled` contract (engine/idempotency.ts) a row exists ONLY
    // for a TERMINAL outcome, so the fixture states the word: this is the
    // `{ jobId, billing }` shape runSetupInfrastructure returns when it owes
    // nothing further — the one thing this endpoint can list. What it must
    // never do is put that body on the wire.
    await withTenantContext(tenantId, (ctx) =>
      withRequestIdempotency(ctx, "setup_infrastructure:apd-setup-a-2mbx", () =>
        terminal({ jobId: "job-apd-setup-a", billing: { provisionedAfter: 2 } }),
      ),
    );
    // A DIFFERENT intent's key must NOT appear (the prefix filter).
    await withTenantContext(tenantId, (ctx) => withRequestIdempotency(ctx, "launch_campaign:unrelated-key", () => terminal({ ok: true })));

    const res = await adminApi<ProvisioningStateResponse>(`/admin/tenants/${tenantId}/provisioning-state`);
    expect(res.status).toBe(200);
    expect(res.body.tenantId).toBe(tenantId);

    expect(res.body.domains).toHaveLength(2);
    const good = res.body.domains.find((d) => d.domain === "goodco0.com")!;
    const dead = res.body.domains.find((d) => d.domain === "deadco1.com")!;
    expect(good).toMatchObject({ status: "active", source: "provisioned", dnsStatus: "ready", purchasedAt: 5000 });
    expect(dead).toMatchObject({
      dnsStatus: "pending",
      dnsFirstCheckedAt: 1000,
      dnsCheckCount: 3,
      dnsGaveUpAt: 9000,
      purchasedAt: 500,
    });

    expect(res.body.domainIntents).toHaveLength(2);
    const ord0 = res.body.domainIntents.find((i) => i.ordinal === 0)!;
    const ord1 = res.body.domainIntents.find((i) => i.ordinal === 1)!;
    expect(ord0).toMatchObject({
      key: domainIntentKey(tenantId, 0),
      candidateDomain: "goodco0.com",
      status: "committed",
      personaSlug: "Sender",
      inboxesEach: 2,
    });
    expect(ord1).toMatchObject({
      key: domainIntentKey(tenantId, 1),
      candidateDomain: "deadco1.com",
      status: "dangling",
      personaSlug: null,
      inboxesEach: null,
    });

    // Only the setup_infrastructure: prefixed key, never the response body.
    expect(res.body.requestIdempotency).toHaveLength(1);
    expect(res.body.requestIdempotency[0]).toMatchObject({ key: "setup_infrastructure:apd-setup-a-2mbx", status: "done" });
    expect(typeof res.body.requestIdempotency[0]!.createdAt).toBe("number");
    expect(res.body.requestIdempotency[0]).not.toHaveProperty("responseJson");
    expect(res.body.requestIdempotency[0]).not.toHaveProperty("response_json");
    expect(JSON.stringify(res.body.requestIdempotency)).not.toContain("job-apd-setup-a");
  });

  // What this endpoint asserts under the `Settled` contract, stated once. A
  // non-terminal setup outcome RELEASES its claim instead of recording it, so
  // the wedged-key shape the endpoint was originally built to diagnose — a
  // 'done' row holding a 202 that owed a domain's DNS — can no longer be
  // minted. An empty `requestIdempotency` therefore means "no finished key is
  // frozen here", never "this tenant never called setup_infrastructure"; the
  // in-flight/owing state is read from `domainIntents` + `domains` above.
  it("a NON-TERMINAL setup outcome leaves no row — this lists FINISHED keys only", async () => {
    const { tenantId } = await mintTenant("Prov State NonTerminal Co", "managed");

    await withTenantContext(tenantId, (ctx) =>
      withRequestIdempotency(ctx, "setup_infrastructure:still-provisioning", () =>
        nonTerminal({ provisioning: "pending", pendingDomain: "deadco1.com" }),
      ),
    );

    const res = await adminApi<ProvisioningStateResponse>(`/admin/tenants/${tenantId}/provisioning-state`);
    expect(res.status).toBe(200);
    expect(res.body.requestIdempotency).toEqual([]);
  });

  it("tenant isolation — tenant A's domains/intents/idempotency rows never appear under tenant B's id", async () => {
    const a = await mintTenant("Prov State Iso A Co", "managed");
    const b = await mintTenant("Prov State Iso B Co", "managed");

    await seedDomain(a.tenantId, "onlya.com");
    await withTenantContext(a.tenantId, (ctx) => {
      ctx.sql.exec(
        `INSERT INTO domain_intents (key, tenant_id, candidate_domain, status, created_at, updated_at) VALUES (?, ?, 'onlya.com', 'committed', 1, 1)`,
        domainIntentKey(a.tenantId, 0),
        a.tenantId,
      );
    });
    await withTenantContext(a.tenantId, (ctx) => withRequestIdempotency(ctx, "setup_infrastructure:only-a-key", () => terminal({ ok: true })));

    const resA = await adminApi<ProvisioningStateResponse>(`/admin/tenants/${a.tenantId}/provisioning-state`);
    expect(resA.body.domains.map((d) => d.domain)).toEqual(["onlya.com"]);
    expect(resA.body.domainIntents).toHaveLength(1);
    expect(resA.body.requestIdempotency).toHaveLength(1);

    const resB = await adminApi<ProvisioningStateResponse>(`/admin/tenants/${b.tenantId}/provisioning-state`);
    expect(resB.body.domains).toEqual([]);
    expect(resB.body.domainIntents).toEqual([]);
    expect(resB.body.requestIdempotency).toEqual([]);
  });
});
