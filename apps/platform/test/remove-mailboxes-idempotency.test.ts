import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
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

function removeOne(token: string, idempotencyKey?: string) {
  return api<{ releasedCount?: number; error?: string }>("/remove-mailboxes", {
    method: "POST",
    token,
    body: JSON.stringify({ count: 1, acknowledged: true }),
    headers: idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined,
  });
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
