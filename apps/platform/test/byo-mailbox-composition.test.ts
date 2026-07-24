import { describe, expect, it } from "vitest";
import { ValidationError } from "@coldstart/shared";
import { registerByoDomain, pollByoDomainDns, listByoDomains } from "../src/engine/byo-intake.js";
import { connectByoMailbox, requestManagedByoMailboxes } from "../src/engine/byo-mailbox-composition.js";
import { signup, tenantStub, withTenantContext } from "./helpers.js";

async function activeDomain(tenantId: string, domain: string, relationship: "fresh_standalone" | "subdomain_of_primary" | "is_primary" = "fresh_standalone") {
  const record = await withTenantContext(tenantId, (ctx) => registerByoDomain(ctx, { domain, domainRelationship: relationship }));
  if (record.byoStatus === "pending_dns") {
    await withTenantContext(tenantId, (ctx) => pollByoDomainDns(ctx, record.domainId));
  }
  return record;
}

describe("requestManagedByoMailboxes — SPEC.md §20.6 shape (a), the founder-ruled primary build target", () => {
  it("provisions platform-owned mailboxes on an active BYO domain (source='provisioned', on the BYO domain_id)", async () => {
    const { tenantId, token } = await signup("Managed Mbx Co", "managed@example.com");
    const record = await activeDomain(tenantId, "delegated-managed.com");
    expect(record.byoStatus).toBe("pending_dns");

    const result = await withTenantContext(tenantId, (ctx) => requestManagedByoMailboxes(ctx, record.domainId, { count: 2, personaSlug: "ops", quoteOnly: false }));
    if (!("mailboxEmails" in result)) throw new Error("expected a provisioned result, got a quote");
    expect(result.mailboxEmails).toHaveLength(2);
    expect(result.mailboxEmails.every((e) => e.endsWith("@delegated-managed.com"))).toBe(true);

    const rows = await withTenantContext(tenantId, (ctx) =>
      ctx.sql.exec<{ source: string; transport_kind: string; domain_id: string }>(`SELECT source, transport_kind, domain_id FROM mailboxes WHERE tenant_id = ?`, tenantId).toArray(),
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.source).toBe("provisioned");
      expect(row.transport_kind).toBe("smtp");
      expect(row.domain_id).toBe(record.domainId);
    }

    // Facade parity: listByoDomains surfaces the mailbox count.
    const list = await withTenantContext(tenantId, (ctx) => listByoDomains(ctx));
    expect(list.find((d) => d.domainId === record.domainId)?.mailboxCount).toBe(2);
    void token;
  });

  it("refuses to provision mailboxes on a domain that is not yet active", async () => {
    const { tenantId } = await signup("Managed Mbx Pending Co", "managedpending@example.com");
    const record = await withTenantContext(tenantId, (ctx) =>
      registerByoDomain(ctx, { domain: "pending-managed.com", domainRelationship: "fresh_standalone" }),
    );
    expect(record.byoStatus).toBe("pending_dns"); // never polled -> still pending

    await expect(withTenantContext(tenantId, (ctx) => requestManagedByoMailboxes(ctx, record.domainId, { count: 1, quoteOnly: false }))).rejects.toThrow(
      ValidationError,
    );
  });

  it("is tenant-isolated: tenant B cannot attach mailboxes to tenant A's BYO domain", async () => {
    const { tenantId: tenantA } = await signup("Managed Isolation A", "mia@example.com");
    const { tenantId: tenantB } = await signup("Managed Isolation B", "mib@example.com");
    const record = await activeDomain(tenantA, "delegated-isolation.com");

    await expect(withTenantContext(tenantB, (ctx) => requestManagedByoMailboxes(ctx, record.domainId, { count: 1, quoteOnly: false }))).rejects.toThrow(/not found/i);
  });
});

describe("connectByoMailbox — SPEC.md §20.6 Mordy-pilot BYO-mailbox seam", () => {
  it("connects an existing SMTP+IMAP mailbox, mapping onto the engine's transport discriminator, and never leaks the secret via listByoDomains", async () => {
    const { tenantId } = await signup("Connect Mbx Co", "connect@example.com");
    // records_to_apply path (Mordy shape): dedicated non-primary domain with
    // existing live infra (his existing Google Workspace boxes) — the
    // sandbox's "liveinfra"+"recordsapplied" substrings drive both the
    // pre-flight scan AND poll-verify.
    const record = await activeDomain(tenantId, "liveinfra-recordsapplied.com");
    expect(record.dnsMode).toBe("records_to_apply");

    const connected = await withTenantContext(tenantId, (ctx) =>
      connectByoMailbox(ctx, record.domainId, {
        email: "mordy@liveinfra-recordsapplied.com",
        transport: { kind: "smtp", host: "smtp.gmail.com", port: 465, secure: true, user: "mordy@liveinfra-recordsapplied.com", pass: "app-password-secret" },
      }),
    );
    expect(connected.transportKind).toBe("smtp");
    expect(connected.email).toBe("mordy@liveinfra-recordsapplied.com");

    const row = await withTenantContext(tenantId, (ctx) =>
      ctx.sql
        .exec<{ source: string; transport_kind: string; transport_json: string }>(
          `SELECT source, transport_kind, transport_json FROM mailboxes WHERE id = ?`,
          connected.mailboxId,
        )
        .one(),
    );
    expect(row.source).toBe("byo_connected");
    expect(row.transport_kind).toBe("smtp");
    expect(JSON.parse(row.transport_json)).toMatchObject({ kind: "smtp", pass: "app-password-secret" });

    // listByoDomains (the read-only facade surface) must never surface the secret.
    const list = await withTenantContext(tenantId, (ctx) => listByoDomains(ctx));
    const serialized = JSON.stringify(list);
    expect(serialized).not.toContain("app-password-secret");
    expect(list.find((d) => d.domainId === record.domainId)?.mailboxCount).toBe(1);
  });

  it("connects a Gmail-API mailbox (OAuth refresh-token grant)", async () => {
    // NOTE: "delegated-oauth-inbox.com" deliberately avoids the literal token
    // "gmail" -- an earlier draft of this fixture named the domain
    // "delegated-gmail.com" and the abuse gate correctly routed it to
    // pending_kyc (an exact well-known-brand-token hit, byo-abuse-gate.ts),
    // which is the CORRECT behavior being tested elsewhere
    // (byo-intake.test.ts) -- this test is about the gmail_api TRANSPORT
    // shape, not the abuse gate, so the domain name must not collide with it.
    const { tenantId } = await signup("Connect Gmail Co", "connectgmail@example.com");
    const record = await activeDomain(tenantId, "delegated-oauth-inbox.com");

    const connected = await withTenantContext(tenantId, (ctx) =>
      connectByoMailbox(ctx, record.domainId, {
        email: "ops@delegated-oauth-inbox.com",
        transport: { kind: "gmail_api", clientId: "client-id", clientSecret: "client-secret", refreshToken: "refresh-token" },
      }),
    );
    expect(connected.transportKind).toBe("gmail_api");
  });

  it("refuses to connect a mailbox on a domain that is not yet active", async () => {
    const { tenantId } = await signup("Connect Pending Co", "connectpending@example.com");
    const record = await withTenantContext(tenantId, (ctx) =>
      registerByoDomain(ctx, { domain: "pending-connect.com", domainRelationship: "fresh_standalone" }),
    );
    await expect(
      withTenantContext(tenantId, (ctx) =>
        connectByoMailbox(ctx, record.domainId, {
          email: "x@pending-connect.com",
          transport: { kind: "smtp", host: "h", port: 465, secure: true, user: "u", pass: "p" },
        }),
      ),
    ).rejects.toThrow(ValidationError);
  });
});
