import { describe, expect, it } from "vitest";
import type { EngineMailboxClient } from "../src/engine/engine-mailbox-client.js";
import {
  type CredentialPushDeps,
  maybePushProvisionedMailbox,
  pushRecordedMailbox,
  reconcileMailboxCredentialPushes,
  recordProvisionedMailboxForPush,
} from "../src/engine/mailbox-credential-push.js";
import { listSurfacedTenantMessages } from "../src/engine/tenant-messages.js";
import { signup, withTenantContext } from "./helpers.js";

// Wire point B (system->agent message channel, increment 1) — the
// mailbox_cred_pushes pending->pushed transition (the "you can send now"
// signal the founder currently hand-relays). Drives the REAL
// pushRecordedMailbox/maybePushProvisionedMailbox/reconcileMailboxCredentialPushes
// path with injected deps, mirroring test/mailbox-credential-push.test.ts.

const VENDOR_IMAP = { host: "imap.gmail.com", port: 993, secure: true, user: "a@pilot.test", pass: "imap-pass" };
const GRANT = { clientId: "cid", clientSecret: "csecret", refreshToken: "1//refresh" };

function fakeDeps(pushImpl: () => Promise<{ email: string; outcome: string; contentHash: string }>): CredentialPushDeps {
  return {
    fetchCredentials: async () => ({ imap: VENDOR_IMAP, smtp: undefined }),
    mintGrant: async () => GRANT,
    push: { pushMailbox: async (email: string) => pushImpl().then((r) => ({ ...r, email })) } as unknown as EngineMailboxClient,
  };
}

const WORKING = fakeDeps(async () => ({ email: "", outcome: "created", contentHash: "h1" }));

describe("credential_ready tenant message — fires on the pending->pushed transition", () => {
  it("a fresh provisioned mailbox's successful push emits kind=credential_ready naming the mailbox", async () => {
    const { tenantId } = await signup("Cred Ready Co", "founder@credready.test");
    const email = "seller1@credready.test";

    await withTenantContext(tenantId, (ctx) => maybePushProvisionedMailbox(ctx, { email, provider: "google" }, WORKING));

    const messages = await withTenantContext(tenantId, (ctx) => listSurfacedTenantMessages(ctx));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ kind: "credential_ready", severity: "action_required", source: "system" });
    expect(messages[0]!.body).toContain(email);
  });

  it("does NOT fire when the push is unconfigured (no deps) — dark by default", async () => {
    const { tenantId } = await signup("Cred Dark Co", "founder@creddark.test");
    await withTenantContext(tenantId, (ctx) => maybePushProvisionedMailbox(ctx, { email: "a@creddark.test", provider: "google" }));
    const messages = await withTenantContext(tenantId, (ctx) => listSurfacedTenantMessages(ctx));
    expect(messages).toEqual([]);
  });

  it("does NOT fire for a sandbox-provider mailbox even with deps supplied", async () => {
    const { tenantId } = await signup("Cred Sandbox Co", "founder@credsandbox.test");
    await withTenantContext(tenantId, (ctx) => maybePushProvisionedMailbox(ctx, { email: "a@credsandbox.test", provider: "sandbox" }, WORKING));
    const messages = await withTenantContext(tenantId, (ctx) => listSurfacedTenantMessages(ctx));
    expect(messages).toEqual([]);
  });

  it("a reconcile-driven push (F6 retry) ALSO emits — the failed-then-retried path reaches the agent too", async () => {
    const { tenantId } = await signup("Cred Reconcile Co", "founder@credreconcile.test");
    const email = "seller1@credreconcile.test";
    const FAILING = fakeDeps(async () => {
      throw new Error("engine unreachable");
    });

    await withTenantContext(tenantId, (ctx) => maybePushProvisionedMailbox(ctx, { email, provider: "google" }, FAILING));
    expect(await withTenantContext(tenantId, (ctx) => listSurfacedTenantMessages(ctx))).toEqual([]); // failed push: no message yet

    await withTenantContext(tenantId, (ctx) => reconcileMailboxCredentialPushes(ctx, WORKING));
    const messages = await withTenantContext(tenantId, (ctx) => listSurfacedTenantMessages(ctx));
    expect(messages).toHaveLength(1);
    expect(messages[0]!.kind).toBe("credential_ready");
  });

  it("GUARDRAIL A — a repeated push for the SAME mailbox refreshes, never duplicates, the message", async () => {
    const { tenantId } = await signup("Cred Dup Co", "founder@creddup.test");
    const mailbox = { email: "seller1@creddup.test", domain: "creddup.test" };

    await withTenantContext(tenantId, (ctx) => pushRecordedMailbox(ctx, mailbox, WORKING));
    await withTenantContext(tenantId, (ctx) => pushRecordedMailbox(ctx, mailbox, WORKING));

    const messages = await withTenantContext(tenantId, (ctx) => listSurfacedTenantMessages(ctx));
    expect(messages.filter((m) => m.kind === "credential_ready")).toHaveLength(1);
  });

  it("GUARDRAIL B — the stored body never leaks vendor credential detail (IMAP host/user, refresh token)", async () => {
    const { tenantId } = await signup("Cred Secret Co", "founder@credsecret.test");
    const mailbox = { email: "seller1@credsecret.test", domain: "credsecret.test" };

    await withTenantContext(tenantId, (ctx) => pushRecordedMailbox(ctx, mailbox, WORKING));

    const messages = await withTenantContext(tenantId, (ctx) => listSurfacedTenantMessages(ctx));
    const body = messages[0]!.body;
    for (const marker of ["imap.gmail.com", "imap-pass", "1//refresh", "csecret"]) {
      expect(body).not.toContain(marker);
    }
  });

  it("F2 (gate 2026-08-05) — a SUSPENDED tenant's push completes but never claims 'sending is now enabled'", async () => {
    const { tenantId } = await signup("Cred Suspended Co", "founder@credsuspended.test");
    const mailbox = { email: "seller1@credsuspended.test", domain: "credsuspended.test" };
    await withTenantContext(tenantId, (ctx) =>
      ctx.sql.exec(`UPDATE tenant_profile SET status = 'suspended' WHERE id = ?`, tenantId),
    );

    const outcome = await withTenantContext(tenantId, (ctx) => pushRecordedMailbox(ctx, mailbox, WORKING));
    // The credential bookkeeping transition itself is unaffected by lifecycle
    // state (dovetails with the credstore audit's own F2, a separate class) —
    // only the customer-facing message is gated.
    expect(outcome.pushed).toBe(true);

    const messages = await withTenantContext(tenantId, (ctx) => listSurfacedTenantMessages(ctx));
    expect(messages).toEqual([]);
  });

  it("F2 — a CANCELED tenant's reconcile sweep does NOT tell a frozen tenant its sending is enabled", async () => {
    const { tenantId } = await signup("Cred Canceled Co", "founder@credcanceled.test");
    const email = "seller1@credcanceled.test";
    await withTenantContext(tenantId, (ctx) => recordProvisionedMailboxForPush(ctx, email));
    await withTenantContext(tenantId, (ctx) =>
      ctx.sql.exec(`UPDATE tenant_profile SET billing_state = 'canceled' WHERE id = ?`, tenantId),
    );

    // Mirrors the gate's exact scenario: a mailbox left mid-suspension (its
    // credential push never released) gets swept by the reconcile sweep while
    // the tenant is frozen.
    const summary = await withTenantContext(tenantId, (ctx) => reconcileMailboxCredentialPushes(ctx, WORKING));
    expect(summary.pushed).toBe(1);

    const messages = await withTenantContext(tenantId, (ctx) => listSurfacedTenantMessages(ctx));
    expect(messages).toEqual([]);
  });
});
