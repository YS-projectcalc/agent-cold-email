import { describe, expect, it } from "vitest";
import { api, signup } from "./helpers.js";

// HTTP facade tests for SPEC.md §20's BYO domain intake — auth gating,
// validation-at-boundary (zod rejects malformed bodies BEFORE the DO ever
// sees them, CLAUDE.md rule h), and tenant isolation through the real bearer-
// auth path (not just the engine-level DO scoping already covered by
// byo-intake.test.ts / byo-mailbox-composition.test.ts).

interface ByoDomainBody {
  domainId: string;
  domain: string;
  isPrimary: boolean;
  dnsMode: string;
  byoStatus: string;
  breakerTier: string;
}

describe("POST /byo-domains — auth + validation at the boundary", () => {
  it("401s without a bearer token", async () => {
    const res = await api("/byo-domains", {
      method: "POST",
      body: JSON.stringify({ domain: "noauth.com", domainRelationship: "fresh_standalone" }),
    });
    expect(res.status).toBe(401);
  });

  it("400s on a missing domain field", async () => {
    const { token } = await signup("Route Validation Co", "rv@example.com");
    const res = await api("/byo-domains", { method: "POST", token, body: JSON.stringify({ domainRelationship: "fresh_standalone" }) });
    expect(res.status).toBe(400);
  });

  it("400s on an invalid domainRelationship enum value", async () => {
    const { token } = await signup("Route Enum Co", "renum@example.com");
    const res = await api("/byo-domains", { method: "POST", token, body: JSON.stringify({ domain: "renum.com", domainRelationship: "not_a_real_shape" }) });
    expect(res.status).toBe(400);
  });

  it("201s + returns the intake record on a valid body", async () => {
    const { token } = await signup("Route Happy Co", "rhappy@example.com");
    const res = await api<ByoDomainBody>("/byo-domains", {
      method: "POST",
      token,
      body: JSON.stringify({ domain: "route-happy.com", domainRelationship: "fresh_standalone" }),
    });
    expect(res.status).toBe(201);
    expect(res.body.domain).toBe("route-happy.com");
    expect(res.body.byoStatus).toBe("pending_dns");
  });
});

describe("GET /byo-domains — listing + tenant isolation", () => {
  it("lists only the calling tenant's own BYO domains", async () => {
    const { token: tokenA } = await signup("List Isolation A", "lia@example.com");
    const { token: tokenB } = await signup("List Isolation B", "lib@example.com");
    await api("/byo-domains", { method: "POST", token: tokenA, body: JSON.stringify({ domain: "list-isolation-a.com", domainRelationship: "fresh_standalone" }) });

    const listB = await api<ByoDomainBody[]>("/byo-domains", { token: tokenB });
    expect(listB.body).toHaveLength(0);
    const listA = await api<ByoDomainBody[]>("/byo-domains", { token: tokenA });
    expect(listA.body).toHaveLength(1);
  });

  it("404s (not a cross-tenant leak) when tenant B requests tenant A's domainId directly", async () => {
    const { token: tokenA } = await signup("Get Isolation A", "gia@example.com");
    const { token: tokenB } = await signup("Get Isolation B", "gib@example.com");
    const created = await api<ByoDomainBody>("/byo-domains", {
      method: "POST",
      token: tokenA,
      body: JSON.stringify({ domain: "get-isolation-a.com", domainRelationship: "fresh_standalone" }),
    });

    const crossTenantGet = await api(`/byo-domains/${created.body.domainId}`, { token: tokenB });
    expect(crossTenantGet.status).toBe(404);
  });
});

describe("POST /byo-domains/:id/consent", () => {
  it("400s when acknowledged is missing or false", async () => {
    const { token } = await signup("Consent Route Co", "consentroute@example.com");
    const created = await api<ByoDomainBody>("/byo-domains", {
      method: "POST",
      token,
      body: JSON.stringify({ domain: "consent-route.com", domainRelationship: "is_primary" }),
    });
    expect(created.body.byoStatus).toBe("pending_consent");

    const missing = await api(`/byo-domains/${created.body.domainId}/consent`, { method: "POST", token, body: JSON.stringify({}) });
    expect(missing.status).toBe(400);
    const falseAck = await api(`/byo-domains/${created.body.domainId}/consent`, { method: "POST", token, body: JSON.stringify({ acknowledged: false }) });
    expect(falseAck.status).toBe(400);
  });

  it("200s and advances byoStatus on an explicit true acknowledgment", async () => {
    const { token } = await signup("Consent Route Ok Co", "consentrouteok@example.com");
    const created = await api<ByoDomainBody>("/byo-domains", {
      method: "POST",
      token,
      body: JSON.stringify({ domain: "consent-route-ok.com", domainRelationship: "is_primary" }),
    });
    const acked = await api<ByoDomainBody>(`/byo-domains/${created.body.domainId}/consent`, {
      method: "POST",
      token,
      body: JSON.stringify({ acknowledged: true }),
    });
    expect(acked.status).toBe(200);
    expect(acked.body.byoStatus).toBe("pending_dns");
  });
});

describe("POST /byo-domains/:id/managed-mailboxes", () => {
  it("400s while the domain is not yet active", async () => {
    const { token } = await signup("Managed Route Co", "managedroute@example.com");
    const created = await api<ByoDomainBody>("/byo-domains", {
      method: "POST",
      token,
      body: JSON.stringify({ domain: "managed-route.com", domainRelationship: "fresh_standalone" }),
    });
    const res = await api(`/byo-domains/${created.body.domainId}/managed-mailboxes`, { method: "POST", token, body: JSON.stringify({ count: 1 }) });
    expect(res.status).toBe(400);
  });

  it("201s once the domain is active (real DNS poll-verify through the route)", async () => {
    const { token } = await signup("Managed Route Active Co", "managedrouteactive@example.com");
    const created = await api<ByoDomainBody>("/byo-domains", {
      method: "POST",
      token,
      body: JSON.stringify({ domain: "delegated-route-active.com", domainRelationship: "fresh_standalone" }),
    });
    const polled = await api<{ byoStatus: string }>(`/byo-domains/${created.body.domainId}/poll-dns`, { method: "POST", token });
    expect(polled.body.byoStatus).toBe("active");

    const res = await api<{ mailboxEmails: string[] }>(`/byo-domains/${created.body.domainId}/managed-mailboxes`, {
      method: "POST",
      token,
      body: JSON.stringify({ count: 2 }),
    });
    expect(res.status).toBe(201);
    expect(res.body.mailboxEmails).toHaveLength(2);
  });
});

describe("POST /byo-domains/:id/connect-mailbox — validation-at-boundary on the transport discriminated union", () => {
  it("400s on an unknown transport kind", async () => {
    const { token } = await signup("Connect Route Bad Kind Co", "connectroutebadkind@example.com");
    const created = await api<ByoDomainBody>("/byo-domains", {
      method: "POST",
      token,
      body: JSON.stringify({ domain: "delegated-route-badkind.com", domainRelationship: "fresh_standalone" }),
    });
    await api(`/byo-domains/${created.body.domainId}/poll-dns`, { method: "POST", token });
    const res = await api(`/byo-domains/${created.body.domainId}/connect-mailbox`, {
      method: "POST",
      token,
      body: JSON.stringify({ email: "x@delegated-route-badkind.com", transport: { kind: "carrier_pigeon" } }),
    });
    expect(res.status).toBe(400);
  });

  it("400s when a smtp transport is missing required fields (e.g. no pass)", async () => {
    const { token } = await signup("Connect Route Missing Field Co", "connectroutemissing@example.com");
    const created = await api<ByoDomainBody>("/byo-domains", {
      method: "POST",
      token,
      body: JSON.stringify({ domain: "delegated-route-missing.com", domainRelationship: "fresh_standalone" }),
    });
    await api(`/byo-domains/${created.body.domainId}/poll-dns`, { method: "POST", token });
    const res = await api(`/byo-domains/${created.body.domainId}/connect-mailbox`, {
      method: "POST",
      token,
      body: JSON.stringify({
        email: "x@delegated-route-missing.com",
        transport: { kind: "smtp", host: "smtp.example.com", port: 465, secure: true, user: "u" },
      }),
    });
    expect(res.status).toBe(400);
  });

  it("201s on a valid smtp transport", async () => {
    const { token } = await signup("Connect Route Ok Co", "connectrouteok@example.com");
    const created = await api<ByoDomainBody>("/byo-domains", {
      method: "POST",
      token,
      body: JSON.stringify({ domain: "delegated-route-ok.com", domainRelationship: "fresh_standalone" }),
    });
    await api(`/byo-domains/${created.body.domainId}/poll-dns`, { method: "POST", token });
    const res = await api<{ mailboxId: string; transportKind: string }>(`/byo-domains/${created.body.domainId}/connect-mailbox`, {
      method: "POST",
      token,
      body: JSON.stringify({
        email: "x@delegated-route-ok.com",
        transport: { kind: "smtp", host: "smtp.example.com", port: 465, secure: true, user: "u", pass: "p" },
      }),
    });
    expect(res.status).toBe(201);
    expect(res.body.transportKind).toBe("smtp");
  });
});
