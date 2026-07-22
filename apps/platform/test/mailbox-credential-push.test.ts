import { describe, expect, it } from "vitest";
import { VendorError } from "@coldstart/shared";
import type { Env } from "../src/env.js";
import type { EngineMailboxClient } from "../src/engine/engine-mailbox-client.js";
import {
  assembleEngineCredentials,
  buildCredentialPushDeps,
  type CredentialPushDeps,
  isCredentialPushConfigured,
  maybePushProvisionedMailbox,
  reconcileMailboxCredentialPushes,
} from "../src/engine/mailbox-credential-push.js";
import { signup, withTenantContext } from "./helpers.js";

// Self-serve I3 credential push (F6 partial-failure ordering). The billed
// mailbox is recorded durably BEFORE the push, so a push failure never loses it
// — the reconcile sweep retries. Deps are injected (no live vendor/engine).

const VENDOR_IMAP = { host: "imap.gmail.com", port: 993, secure: true, user: "a@pilot.test", pass: "imap-pass" };
const GRANT = { clientId: "cid", clientSecret: "csecret", refreshToken: "1//refresh" };

/** A fake EngineMailboxClient whose push either succeeds or throws (transient). */
function fakeDeps(pushImpl: () => Promise<{ email: string; outcome: string; contentHash: string }>): CredentialPushDeps {
  return {
    fetchCredentials: async () => ({ imap: VENDOR_IMAP, smtp: undefined }),
    mintGrant: async () => GRANT,
    push: { pushMailbox: async (email: string) => pushImpl().then((r) => ({ ...r, email })) } as unknown as EngineMailboxClient,
  };
}

const FAILING = fakeDeps(async () => {
  throw new VendorError("engine unreachable", true);
});
const WORKING = fakeDeps(async () => ({ email: "", outcome: "created", contentHash: "h1" }));

function statusOf(tenantId: string, email: string): Promise<string | undefined> {
  return withTenantContext(tenantId, (ctx) =>
    ctx.sql.exec<{ status: string }>(`SELECT status FROM mailbox_cred_pushes WHERE tenant_id = ? AND email = ?`, tenantId, email).toArray()[0]?.status,
  );
}

describe("isCredentialPushConfigured", () => {
  it("is false unless BOTH the InboxKit vendor AND the engine are configured", () => {
    expect(isCredentialPushConfigured({} as Env)).toBe(false);
    expect(isCredentialPushConfigured({ INBOXKIT_API_KEY: "a", INBOXKIT_WORKSPACE_ID: "b" } as Env)).toBe(false);
    expect(isCredentialPushConfigured({ ENGINE_BASE_URL: "https://e", ENGINE_AUTH_SECRET: "s" } as Env)).toBe(false);
    expect(isCredentialPushConfigured({ INBOXKIT_API_KEY: "a", INBOXKIT_WORKSPACE_ID: "b", ENGINE_BASE_URL: "https://e", ENGINE_AUTH_SECRET: "s" } as Env)).toBe(true);
  });

  it("buildCredentialPushDeps is DARK (undefined) unless armed", () => {
    expect(buildCredentialPushDeps({} as Env)).toBeUndefined();
    const deps = buildCredentialPushDeps({ INBOXKIT_API_KEY: "a", INBOXKIT_WORKSPACE_ID: "b", ENGINE_BASE_URL: "https://e", ENGINE_AUTH_SECRET: "s" } as Env);
    expect(deps).toBeDefined();
  });
});

describe("assembleEngineCredentials", () => {
  it("combines the vendor IMAP endpoint with the gmail_api OAuth grant into the engine credential shape", async () => {
    const creds = await assembleEngineCredentials({ email: "a@pilot.test", domain: "pilot.test" }, WORKING);
    expect(creds).toEqual({
      imap: VENDOR_IMAP,
      send: { kind: "gmail_api", clientId: "cid", clientSecret: "csecret", refreshToken: "1//refresh", user: "a@pilot.test" },
      messageIdDomain: "pilot.test",
    });
  });
});

describe("maybePushProvisionedMailbox — inert unless armed + real vendor mailbox", () => {
  it("is a no-op (no row) when the push is unconfigured (default env, the deployed build)", async () => {
    const { tenantId } = await signup("Push Inert Co", "founder@pushinert.test");
    const out = await withTenantContext(tenantId, (ctx) => maybePushProvisionedMailbox(ctx, { email: "a@pushinert.test", provider: "google" }));
    expect(out).toBeUndefined();
    expect(await statusOf(tenantId, "a@pushinert.test")).toBeUndefined();
  });

  it("is a no-op for a SANDBOX-provider mailbox even when deps are supplied (never pushes a sandbox mailbox)", async () => {
    const { tenantId } = await signup("Push Sandbox Co", "founder@pushsandbox.test");
    const out = await withTenantContext(tenantId, (ctx) => maybePushProvisionedMailbox(ctx, { email: "a@pushsandbox.test", provider: "sandbox" }, WORKING));
    expect(out).toBeUndefined();
    expect(await statusOf(tenantId, "a@pushsandbox.test")).toBeUndefined();
  });
});

describe("F6 — record-before-push + reconcile: a billed mailbox is never lost on a failed push", () => {
  it("records the mailbox 'pending' BEFORE the push, keeps it 'pending' when the push fails, then a reconcile pushes it", async () => {
    const { tenantId } = await signup("F6 Co", "founder@f6.test");
    const email = "seller1@f6.test";

    // The vendor slot was billed; the push to the engine FAILS.
    const out = await withTenantContext(tenantId, (ctx) => maybePushProvisionedMailbox(ctx, { email, provider: "google" }, FAILING));
    expect(out).toMatchObject({ pushed: false });

    // The billed mailbox is NOT lost — a durable 'pending' record survives the failure.
    expect(await statusOf(tenantId, email)).toBe("pending");

    // The reconcile sweep (config-gated in prod; deps injected here) retries and succeeds.
    const summary = await withTenantContext(tenantId, (ctx) => reconcileMailboxCredentialPushes(ctx, WORKING));
    expect(summary).toMatchObject({ attempted: 1, pushed: 1, stillPending: 0 });
    expect(await statusOf(tenantId, email)).toBe("pushed");
  });

  it("a successful first push marks 'pushed' immediately (reconcile then finds nothing pending)", async () => {
    const { tenantId } = await signup("F6 Happy Co", "founder@f6happy.test");
    const email = "seller1@f6happy.test";
    await withTenantContext(tenantId, (ctx) => maybePushProvisionedMailbox(ctx, { email, provider: "google" }, WORKING));
    expect(await statusOf(tenantId, email)).toBe("pushed");

    const summary = await withTenantContext(tenantId, (ctx) => reconcileMailboxCredentialPushes(ctx, WORKING));
    expect(summary.attempted).toBe(0);
  });
});
