import { describe, expect, it } from "vitest";
import type { EngineMailboxClient } from "../src/engine/engine-mailbox-client.js";
import { releaseMailboxes } from "../src/engine/lifecycle.js";
import {
  type CredentialPushDeps,
  maybePushProvisionedMailbox,
  reconcileMailboxCredentialPushes,
  recordProvisionedMailboxForPush,
} from "../src/engine/mailbox-credential-push.js";
import { newId } from "../src/schema.js";
import { signup, withTenantContext } from "./helpers.js";

// CREDSTORE F2 (wave2-design §"CREDSTORE F2", audit-credstore-2026-08-05
// finding F2) — teardown used to leave `mailbox_cred_pushes` rows untouched,
// so a reconcile sweep landing after a mailbox was released/revoked could
// still find a 'pending' row and push (create) fresh credentials for a
// mailbox we had just told the engine to revoke: resurrection. The Worker
// half of the fix is a per-mailbox tombstone UPDATE inside `releaseMailboxes`
// — synchronous SQL, run BEFORE any await in the per-mailbox loop (order:
// tombstone -> vendor release -> engine revoke -> mark released_at) — which
// both (a) makes reconcile's `status = 'pending'` selection permanently miss
// the row, and (b) is visible to any concurrently-interleaved reconcile the
// instant the DO's input gate reopens at the loop's first await.

const VENDOR_IMAP = { host: "imap.gmail.com", port: 993, secure: true, user: "a@pilot.test", pass: "imap-pass" };
const GRANT = { clientId: "cid", clientSecret: "csecret", refreshToken: "1//refresh" };

function fakePush(onPush?: () => void): EngineMailboxClient {
  return {
    pushMailbox: async (email: string) => {
      onPush?.();
      return { email, outcome: "created", contentHash: "h" };
    },
  } as unknown as EngineMailboxClient;
}

const WORKING: CredentialPushDeps = {
  fetchCredentials: async () => ({ imap: VENDOR_IMAP, smtp: undefined }),
  mintGrant: async () => GRANT,
  push: fakePush(),
};

async function statusOf(tenantId: string, email: string): Promise<string | undefined> {
  return withTenantContext(tenantId, (ctx) =>
    ctx.sql.exec<{ status: string }>(`SELECT status FROM mailbox_cred_pushes WHERE tenant_id = ? AND email = ?`, tenantId, email).toArray()[0]?.status,
  );
}

/** Seeds a live `mailboxes` row directly (bypasses provisioning) so
 * `releaseMailboxes`' `SELECT ... FROM mailboxes WHERE released_at IS NULL`
 * finds it, without needing a full setup-infrastructure vendor saga. */
async function seedLiveMailbox(tenantId: string, email: string): Promise<void> {
  await withTenantContext(tenantId, (ctx) => {
    const now = ctx.clock.now();
    ctx.sql.exec(
      `INSERT INTO mailboxes (id, tenant_id, domain_id, domain, email, daily_cap, warmup_started_at, created_at)
       VALUES (?, ?, ?, ?, ?, 5, ?, ?)`,
      newId("mbx"),
      ctx.tenantId,
      "dom1",
      email.split("@")[1],
      email,
      now,
      now,
    );
  });
}

describe("CREDSTORE F2 — teardown tombstone closes post-release resurrection", () => {
  it("push not-yet-succeeded (still 'pending') -> release -> reconcile: the revoked mailbox is never pushed (FAILS on old code: reconcile still finds the untouched 'pending' row and pushes it after release)", async () => {
    const { tenantId } = await signup("F2 Resurrect Co", "founder@f2resurrect.test");
    const email = "seller1@f2resurrect.test";
    await seedLiveMailbox(tenantId, email);

    // The push hasn't landed yet — a durable 'pending' record exists (F6 step 1).
    await withTenantContext(tenantId, (ctx) => recordProvisionedMailboxForPush(ctx, email));
    expect(await statusOf(tenantId, email)).toBe("pending");

    // Teardown/release reclaims the mailbox.
    await withTenantContext(tenantId, (ctx) => releaseMailboxes(ctx));
    expect(await statusOf(tenantId, email)).toBe("revoked");

    // A reconcile landing after release must not push credentials for a
    // mailbox we just told the engine (best-effort) to revoke.
    let pushCalls = 0;
    const countingDeps: CredentialPushDeps = { ...WORKING, push: fakePush(() => pushCalls++) };
    const summary = await withTenantContext(tenantId, (ctx) => reconcileMailboxCredentialPushes(ctx, countingDeps));
    expect(summary.attempted).toBe(0);
    expect(pushCalls).toBe(0);
    expect(await statusOf(tenantId, email)).toBe("revoked");
  });

  it("push already succeeded ('pushed') -> release -> reconcile: still no resurrection (reconcile only ever selected 'pending', but ground-truths the tombstone doesn't disturb an already-terminal push)", async () => {
    const { tenantId } = await signup("F2 Pushed Release Co", "founder@f2pushedrelease.test");
    const email = "seller1@f2pushedrelease.test";
    await seedLiveMailbox(tenantId, email);
    await withTenantContext(tenantId, (ctx) => maybePushProvisionedMailbox(ctx, { email, provider: "google" }, WORKING));
    expect(await statusOf(tenantId, email)).toBe("pushed");

    await withTenantContext(tenantId, (ctx) => releaseMailboxes(ctx));
    expect(await statusOf(tenantId, email)).toBe("revoked");

    const summary = await withTenantContext(tenantId, (ctx) => reconcileMailboxCredentialPushes(ctx, WORKING));
    expect(summary.attempted).toBe(0);
    expect(await statusOf(tenantId, email)).toBe("revoked");
  });

  it("tombstones synchronously BEFORE any await — closes the reconcile-in-the-await-gap window (FAILS on old order: status is still 'pushed' at the moment the vendor-release await begins)", async () => {
    const { tenantId } = await signup("F2 Race Co", "founder@f2race.test");
    const email = "seller1@f2race.test";
    await seedLiveMailbox(tenantId, email);
    await withTenantContext(tenantId, (ctx) => maybePushProvisionedMailbox(ctx, { email, provider: "google" }, WORKING));
    expect(await statusOf(tenantId, email)).toBe("pushed");

    let statusAtFirstAwait: string | undefined;
    await withTenantContext(tenantId, async (ctx) => {
      // Wrap the FIRST await point inside releaseMailboxes' per-mailbox loop
      // (the vendor release call) to sample the DB exactly where the audit's
      // proven race (a concurrent reconcile landing in the await gap) would
      // land. The tombstone must already be committed by the time any code
      // can observe an opened input gate.
      const port = ctx.adapters.mailbox as unknown as { release: (email: string, key: string) => Promise<unknown> };
      const original = port.release.bind(ctx.adapters.mailbox);
      port.release = async (addr: string, key: string) => {
        statusAtFirstAwait = ctx.sql
          .exec<{ status: string }>(`SELECT status FROM mailbox_cred_pushes WHERE tenant_id = ? AND email = ?`, ctx.tenantId, email)
          .one().status;
        return original(addr, key);
      };
      await releaseMailboxes(ctx);
    });

    expect(statusAtFirstAwait).toBe("revoked");
  });

  it("legitimate re-provision after cancel revives the tombstoned row and pushes again (FAILS on old code: revoked row is stuck forever, INSERT OR IGNORE swallows the revive)", async () => {
    const { tenantId } = await signup("F2 Revive Co", "founder@f2revive.test");
    const email = "seller1@f2revive.test";
    await seedLiveMailbox(tenantId, email);
    await withTenantContext(tenantId, (ctx) => maybePushProvisionedMailbox(ctx, { email, provider: "google" }, WORKING));
    await withTenantContext(tenantId, (ctx) => releaseMailboxes(ctx));
    expect(await statusOf(tenantId, email)).toBe("revoked");

    // Customer re-provisions the same address (a re-subscribe / re-buy).
    const out = await withTenantContext(tenantId, (ctx) => maybePushProvisionedMailbox(ctx, { email, provider: "google" }, WORKING));
    expect(out).toMatchObject({ pushed: true });
    expect(await statusOf(tenantId, email)).toBe("pushed");
  });
});
