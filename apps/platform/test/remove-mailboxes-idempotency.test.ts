import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { VendorError } from "@coldstart/shared";
import { api, signup, tenantStub } from "./helpers.js";

// BLOCKING-2, docs/adversarial/audit-dashboard-idempotency-2026-08-06.md.
//
// `remove_mailboxes` is a RELATIVE operation ("release N"), release is
// irreversible through this API, and the route accepted an `Idempotency-Key`
// header and threw it away. The audit drove two same-key calls and watched a
// perfectly well-behaved client destroy twice (2 -> 1 -> 0), and two concurrent
// unkeyed submits release 2N.
//
// Relative semantics are kept (a genuine second downgrade must still work), so
// the two things that make a retry safe are: the key is honored durably, and
// only one release may be in flight per tenant at a time.

function setupBody(brand: string, primaryDomain: string, domains: number, inboxesEach: number) {
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

function liveMailboxes(tenantId: string): Promise<number> {
  return runInDurableObject(
    tenantStub(tenantId),
    (_i, state) =>
      state.storage.sql
        .exec<{ n: number }>(
          `SELECT COUNT(*) as n FROM mailboxes WHERE tenant_id = ? AND released_at IS NULL`,
          tenantId,
        )
        .one().n,
  );
}

async function seedTenant(brand: string, primaryDomain: string) {
  const { tenantId, token } = await signup(brand, `founder@${primaryDomain}`);
  await api("/setup-infrastructure", { method: "POST", token, body: setupBody(brand, primaryDomain, 2, 2) });
  expect(await liveMailboxes(tenantId)).toBe(4);
  return { tenantId, token };
}

function removeN(token: string, count: number, idempotencyKey?: string) {
  return api<{ releasedCount?: number; failedCount?: number; error?: string }>("/remove-mailboxes", {
    method: "POST",
    token,
    body: JSON.stringify({ count, acknowledged: true }),
    headers: idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined,
  });
}

function removeOne(token: string, idempotencyKey?: string) {
  return removeN(token, 1, idempotencyKey);
}

describe("B2 — remove_mailboxes honors the Idempotency-Key it advertises", () => {
  it("a same-key replay returns the recorded response and releases nothing more", async () => {
    const { tenantId, token } = await seedTenant("Replay Remove Co", "replayremove.com");

    const first = await removeOne(token, "downgrade-1");
    expect(first.status).toBe(200);
    expect(first.body.releasedCount).toBe(1);
    expect(await liveMailboxes(tenantId)).toBe(3);

    const replay = await removeOne(token, "downgrade-1");

    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(first.body);
    expect(await liveMailboxes(tenantId)).toBe(3);
  });

  it("a genuine SECOND downgrade under a new key still releases", async () => {
    const { tenantId, token } = await seedTenant("Second Downgrade Co", "seconddowngrade.com");

    await removeOne(token, "downgrade-1");
    const second = await removeOne(token, "downgrade-2");

    expect(second.status).toBe(200);
    expect(second.body.releasedCount).toBe(1);
    expect(await liveMailboxes(tenantId)).toBe(2);
  });

  it("an unkeyed release that has already settled does not block the next one", async () => {
    const { tenantId, token } = await seedTenant("Sequential Remove Co", "sequentialremove.com");

    expect((await removeOne(token)).status).toBe(200);
    expect((await removeOne(token)).status).toBe(200);

    expect(await liveMailboxes(tenantId)).toBe(2);
  });
});

/** The tenant's live mailboxes, NEWEST FIRST — the order releaseMailboxes picks in. */
function liveMailboxEmails(tenantId: string): Promise<string[]> {
  return runInDurableObject(tenantStub(tenantId), (_i, state) =>
    state.storage.sql
      .exec<{ email: string }>(
        `SELECT email FROM mailboxes WHERE tenant_id = ? AND released_at IS NULL ORDER BY created_at DESC`,
        tenantId,
      )
      .toArray()
      .map((r) => r.email),
  );
}

/** The `remove_mailboxes:` claims this tenant is holding. */
function removeClaims(tenantId: string): Promise<{ key: string; status: string }[]> {
  return runInDurableObject(tenantStub(tenantId), (_i, state) =>
    state.storage.sql
      .exec<{ key: string; status: string }>(
        `SELECT key, status FROM request_idempotency WHERE key LIKE 'remove_mailboxes:%'`,
      )
      .toArray(),
  );
}

/**
 * One mailbox the vendor permanently refuses to release (a 404 on an address
 * already gone at the provider, a 403 on one it will not delete), every other
 * one released normally. `attempts` records every release the vendor was asked
 * for, so a test can prove a retry did real work rather than replaying.
 */
async function failReleaseFor(tenantId: string, stuckEmail: string, attempts: string[]): Promise<void> {
  await runInDurableObject(tenantStub(tenantId), (instance) => {
    const bundle = (instance as unknown as { sandboxAdapters: { mailbox: { release: unknown } } | null }).sandboxAdapters;
    if (!bundle) throw new Error("no cached sandbox bundle to break — seed the tenant first");
    const original = bundle.mailbox.release as (email: string, key: string) => Promise<unknown>;
    bundle.mailbox.release = async (email: string, key: string) => {
      attempts.push(email);
      if (email === stuckEmail) throw new VendorError("mailbox not found at the provider", false, { step: "mailbox release" });
      return original.call(bundle.mailbox, email, key);
    };
  });
}

// F1 ON THE MONEY PATH (docs/adversarial/wave-1-2-integration-gate-2026-08-18.md
// B3). Per-item isolation (IN-3) replaced releaseMailboxes' throw with a
// returned `failedCount`, and this call site kept asserting `terminal(...)` on
// the strength of a throw that no longer happens. A PARTIAL release was then
// recorded as the permanent answer to the customer's key: the retry the
// platform's own docs instruct made zero vendor calls, and the mailbox the
// vendor refused stayed live — billed to the customer at $10/mo and to the
// platform by the vendor — with no reconcile lane anywhere that re-attempts it.
describe("B3 — a PARTIAL release is never recorded as the finished answer", () => {
  it("discloses the failure and lets the same key re-attempt the mailbox that did not release", async () => {
    const { tenantId, token } = await seedTenant("Partial Release Co", "partialrelease.com");
    const live = await liveMailboxEmails(tenantId);
    // Inside the 3 this call selects (newest first), so the failure is a
    // straggler in the middle of the batch, not the head or the tail.
    const stuck = live[1]!;
    const attempts: string[] = [];
    await failReleaseFor(tenantId, stuck, attempts);

    const first = await removeN(token, 3, "downgrade-partial");
    expect(first.status).toBe(200);
    expect(first.body.releasedCount).toBe(2);
    // The agent asked for 3 and got 2. Without this field the response gives it
    // no way to tell a completed downgrade from a partial one.
    expect(first.body.failedCount).toBe(1);
    expect(attempts).toEqual(live.slice(0, 3));
    expect(await liveMailboxEmails(tenantId)).toContain(stuck);

    // THE INVARIANT: an outcome that still owes work is not recorded, so the
    // key is free for the retry the platform tells the agent to make.
    expect(await removeClaims(tenantId)).toEqual([]);

    const retry = await removeN(token, 3, "downgrade-partial");
    expect(retry.status).toBe(200);
    // Real vendor work, not a replay: the stuck address is asked again.
    expect(attempts.filter((e) => e === stuck)).toHaveLength(2);
    expect(retry.body.failedCount).toBe(1);
  });

  it("a release where everything lands IS terminal — the key still replays", async () => {
    const { tenantId, token } = await seedTenant("Whole Release Co", "wholerelease.com");
    const attempts: string[] = [];
    await failReleaseFor(tenantId, "nobody@nowhere.invalid", attempts);

    const first = await removeN(token, 2, "downgrade-whole");
    expect(first.body).toMatchObject({ releasedCount: 2, failedCount: 0 });
    expect(await removeClaims(tenantId)).toEqual([{ key: "remove_mailboxes:downgrade-whole", status: "done" }]);

    const replay = await removeN(token, 2, "downgrade-whole");
    expect(replay.body).toEqual(first.body);
    // Nothing further was asked of the vendor.
    expect(attempts).toHaveLength(2);
    expect(await liveMailboxEmails(tenantId)).toHaveLength(2);
  });
});

/**
 * Makes the tenant's mailbox release SUSPEND, the way production's does.
 *
 * Without this the concurrency test is theatre. A Durable Object's input gate
 * opens on I/O, not on a microtask — and the sandbox MailboxPort's `release` is
 * `async` but performs none, so two "concurrent" submits run strictly one after
 * the other and the second is really a sequential replay. In production
 * `release` is an HTTP call to the mailbox provider per mailbox, the gate opens
 * on every one of them, and a genuine interleave is the ordinary case. Wrapping
 * the cached sandbox port restores the one property of the real port that the
 * guard exists to survive.
 */
async function suspendReleases(tenantId: string): Promise<void> {
  await runInDurableObject(tenantStub(tenantId), (instance) => {
    const bundle = (instance as unknown as { sandboxAdapters: { mailbox: { release: unknown } } | null }).sandboxAdapters;
    if (!bundle) throw new Error("no cached sandbox bundle to slow down — seed the tenant first");
    const original = bundle.mailbox.release as (email: string, key: string) => Promise<unknown>;
    bundle.mailbox.release = async (email: string, key: string) => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return original.call(bundle.mailbox, email, key);
    };
  });
}

describe("B2 — only one release may be in flight per tenant", () => {
  it("a concurrent unkeyed double-submit releases once and refuses the other", async () => {
    const { tenantId, token } = await seedTenant("Concurrent Remove Co", "concurrentremove.com");
    await suspendReleases(tenantId);

    const [a, b] = await Promise.all([removeOne(token), removeOne(token)]);

    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(await liveMailboxes(tenantId)).toBe(3);
  });

  it("a concurrent SAME-KEY double-submit releases once and refuses the other", async () => {
    const { tenantId, token } = await seedTenant("Concurrent Keyed Remove Co", "concurrentkeyedremove.com");
    await suspendReleases(tenantId);

    const [a, b] = await Promise.all([removeOne(token, "dg"), removeOne(token, "dg")]);

    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(await liveMailboxes(tenantId)).toBe(3);
  });
});
