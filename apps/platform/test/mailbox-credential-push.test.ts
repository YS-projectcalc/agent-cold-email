import { afterEach, describe, expect, it, vi } from "vitest";
import { VendorError } from "@coldstart/shared";
import type { Env } from "../src/env.js";
import type { EngineMailboxClient } from "../src/engine/engine-mailbox-client.js";
import {
  assembleEngineCredentials,
  buildCredentialPushDeps,
  type CredentialPushDeps,
  isCredentialPushConfigured,
  maybePushProvisionedMailbox,
  pushRecordedMailbox,
  reconcileMailboxCredentialPushes,
  revokePushedMailboxCredentials,
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

/**
 * A fake engine credential store mirroring the REAL
 * MailboxCredentialStore.upsert semantics this caller drives (F4,
 * apps/engine/src/mailbox-store.ts): content-hash replay-safety (same
 * content -> 'unchanged', different content -> 'replaced') AND keyed-mode
 * rejection (a reused idempotencyKey with a DIFFERENT payload throws) — both
 * branches are asserted directly against the real store in
 * apps/engine/test/mailbox-store.test.ts:67,76. This proves the CALLER's
 * wiring (does `pushRecordedMailbox` supply a key that defeats rotation?),
 * not the store itself — apps/platform never imports apps/engine source
 * (separate deployables, HTTP-only boundary).
 */
function fakeEngineCredentialStore() {
  const mailboxes = new Map<string, { credentials: unknown; contentHash: string }>();
  const idempotency = new Map<string, { email: string; contentHash: string }>();
  const hash = (credentials: unknown) => JSON.stringify(credentials);
  return {
    async pushMailbox(email: string, credentials: unknown, idempotencyKey?: string) {
      const contentHash = hash(credentials);
      if (idempotencyKey) {
        const seen = idempotency.get(idempotencyKey);
        if (seen) {
          if (seen.email === email && seen.contentHash === contentHash) {
            return { email, outcome: "replayed", contentHash };
          }
          throw new Error(
            `idempotency key ${idempotencyKey} was already used for a different mailbox push (${seen.email}) — a key must map to one request`,
          );
        }
      }
      const existing = mailboxes.get(email);
      const outcome = !existing ? "created" : existing.contentHash === contentHash ? "unchanged" : "replaced";
      mailboxes.set(email, { credentials, contentHash });
      if (idempotencyKey) idempotency.set(idempotencyKey, { email, contentHash });
      return { email, outcome, contentHash };
    },
    get: (email: string) => mailboxes.get(email)?.credentials,
  };
}

// FIX 1 (adversary i3i4-build-review-2026-07-23 finding 1, BLOCKING) — the
// deterministic key `credpush:${tenantId}:${email}` the caller used to stamp
// on EVERY push (including retries) defeated the store's F4 rotation
// support: a lost-response retry that re-assembles credentials (a fresh
// mintGrant() call — the real InboxKitOAuthMinter path mints a NEW refresh
// token every time, oauth-mint.ts:94-114) pushed DIFFERENT content under the
// SAME key, which the store's keyed mode rejects as BadRequestError. The
// row was then stuck 'pending' forever.
describe("regression — a retry with re-minted (different) credentials must not be permanently rejected", () => {
  it("a second push with a DIFFERENT grant lands 'replaced' and the engine resolves the NEW credentials (fails on old code: BadRequestError, row stuck 'pending')", async () => {
    const { tenantId } = await signup("Rotation Co", "founder@rotation.test");
    const mailbox = { email: "seller1@rotation.test", domain: "rotation.test" };
    const store = fakeEngineCredentialStore();
    let mintCount = 0;
    const deps: CredentialPushDeps = {
      fetchCredentials: async () => ({ imap: VENDOR_IMAP, smtp: undefined }),
      mintGrant: async () => {
        mintCount++;
        return { ...GRANT, refreshToken: `refresh-v${mintCount}` };
      },
      push: store as unknown as EngineMailboxClient,
    };

    // First push commits.
    const first = await withTenantContext(tenantId, (ctx) => pushRecordedMailbox(ctx, mailbox, deps));
    expect(first).toMatchObject({ pushed: true });
    expect(store.get(mailbox.email)).toMatchObject({ send: { refreshToken: "refresh-v1" } });

    // Reconcile-style retry: a fresh mint yields a DIFFERENT refresh token
    // (simulating a lost-response retry that re-assembled credentials). On
    // the pre-fix caller (deterministic key reused) this throws
    // BadRequestError and `pushed` stays false; on the fix it must succeed.
    const retry = await withTenantContext(tenantId, (ctx) => pushRecordedMailbox(ctx, mailbox, deps));
    expect(retry.error).toBeUndefined();
    expect(retry).toMatchObject({ pushed: true });
    expect(store.get(mailbox.email)).toMatchObject({ send: { refreshToken: "refresh-v2" } });
  });
});

// FIX 2 (adversary i3i4-build-review-2026-07-23 finding 3, NON-BLOCKING) —
// parseGrants used to catch a malformed GMAIL_OAUTH_GRANTS secret and
// silently return {}, hiding the ROOT CAUSE (the secret itself is broken)
// behind the per-mailbox "no manually-minted grant supplied" error. It must
// now log loud (F5-equivalent convention) while still failing closed (never
// throwing into the provisioning saga).
describe("parseGrants (via buildCredentialPushDeps) — malformed GMAIL_OAUTH_GRANTS fails LOUD", () => {
  afterEach(() => vi.restoreAllMocks());

  const ARMED_ENV_BASE = { INBOXKIT_API_KEY: "a", INBOXKIT_WORKSPACE_ID: "b", ENGINE_BASE_URL: "https://e", ENGINE_AUTH_SECRET: "s" };

  it("invalid JSON logs the parse failure loud, but still returns a safe (empty-grants) deps object", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const deps = buildCredentialPushDeps({ ...ARMED_ENV_BASE, GMAIL_OAUTH_GRANTS: "{ this is not json" } as Env);
    expect(deps).toBeDefined(); // still fails CLOSED, not aborted
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toMatch(/GMAIL_OAUTH_GRANTS is malformed/);
  });

  it("valid JSON but the wrong top-level shape (an array) also logs loud", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const deps = buildCredentialPushDeps({ ...ARMED_ENV_BASE, GMAIL_OAUTH_GRANTS: "[1,2,3]" } as Env);
    expect(deps).toBeDefined();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toMatch(/GMAIL_OAUTH_GRANTS is malformed/);
  });

  it("a well-formed grants object logs NOTHING", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const deps = buildCredentialPushDeps({
      ...ARMED_ENV_BASE,
      GMAIL_OAUTH_GRANTS: JSON.stringify({ "a@b.com": { clientId: "c", clientSecret: "s", refreshToken: "r" } }),
    } as Env);
    expect(deps).toBeDefined();
    expect(spy).not.toHaveBeenCalled();
  });
});

// FIX 3 (adversary i3i4-build-review-2026-07-23 finding 2, NON-BLOCKING) —
// the DELETE/revoke path was fully coded+tested but had ZERO production
// callers; canceled tenants' OAuth refresh tokens lingered on the engine
// daemon forever. revokePushedMailboxCredentials is the seam
// lifecycle.ts's teardownTenant now calls for every released mailbox.
describe("revokePushedMailboxCredentials — best-effort revoke seam", () => {
  it("is a no-op when the injected client is not configured (the deployed default)", async () => {
    const { tenantId } = await signup("Revoke Dark Co", "founder@revokedark.test");
    const calls: string[] = [];
    const client = { isConfigured: false, removeMailbox: async (email: string) => { calls.push(email); return { email, removed: true }; } } as unknown as EngineMailboxClient;
    await withTenantContext(tenantId, (ctx) => revokePushedMailboxCredentials(ctx, "a@revokedark.test", client));
    expect(calls).toEqual([]);
  });

  it("calls the engine's removeMailbox when configured", async () => {
    const { tenantId } = await signup("Revoke Armed Co", "founder@revokearmed.test");
    const calls: string[] = [];
    const client = {
      isConfigured: true,
      removeMailbox: async (email: string) => {
        calls.push(email);
        return { email, removed: true };
      },
    } as unknown as EngineMailboxClient;
    await withTenantContext(tenantId, (ctx) => revokePushedMailboxCredentials(ctx, "a@revokearmed.test", client));
    expect(calls).toEqual(["a@revokearmed.test"]);
  });

  it("swallows a revoke failure (logs, never throws) — the caller (teardown) must be able to proceed regardless", async () => {
    const { tenantId } = await signup("Revoke Unreachable Co", "founder@revokeunreachable.test");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const client = {
      isConfigured: true,
      removeMailbox: async () => {
        throw new VendorError("engine unreachable", true);
      },
    } as unknown as EngineMailboxClient;
    await expect(withTenantContext(tenantId, (ctx) => revokePushedMailboxCredentials(ctx, "a@revokeunreachable.test", client))).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });
});
