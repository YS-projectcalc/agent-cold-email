import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { VendorError } from "@coldstart/shared";
import { api, mintTenant, signup, tenantStub } from "./helpers.js";

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

async function seedTenant(brand: string, primaryDomain: string, domains = 2, inboxesEach = 2) {
  const { tenantId, token } = await signup(brand, `founder@${primaryDomain}`);
  await api("/setup-infrastructure", { method: "POST", token, body: setupBody(brand, primaryDomain, domains, inboxesEach) });
  expect(await liveMailboxes(tenantId)).toBe(domains * inboxesEach);
  return { tenantId, token };
}

function removeN(token: string, count: number, idempotencyKey?: string) {
  return api<{ releasedCount?: number; failedCount?: number; unreleased?: string[]; error?: string }>("/remove-mailboxes", {
    method: "POST",
    token,
    body: JSON.stringify({ count, acknowledged: true }),
    headers: idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined,
  });
}

function removeOne(token: string, idempotencyKey?: string) {
  return removeN(token, 1, idempotencyKey);
}

/**
 * A replay hands back the RECORDED response — with exactly one deliberate
 * difference, which is the point of the whole `Collapsed<T>` field.
 *
 * These assertions used to demand BYTE-IDENTITY with the original. That is
 * precisely the defect the wave-A gate named (docs/adversarial/
 * wave-a-trains-3-4-gate-2026-08-20.md, the RULING): "a collapse returned
 * byte-identically to a real admission, so an agent in a loop cannot tell that
 * its second request was absorbed". `engine/idempotency.ts` now stamps
 * `deduplicated: true` onto a replayed response that carries the field, so the
 * ONE thing that may differ is the disclosure that it is a replay. Everything
 * else — the counts, the billing projection, the unreleased set — must still
 * match exactly, which is what these tests are really about.
 */
function expectReplayOf(replayBody: unknown, recordedBody: Record<string, unknown>): void {
  expect(replayBody).toEqual({ ...recordedBody, deduplicated: true });
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
    expectReplayOf(replay.body, first.body);
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
 * Mailboxes the vendor permanently refuses to release (a 404 on an address
 * already gone at the provider, a 403 on one it will not delete), every other
 * one released normally. `attempts` records every release the vendor was asked
 * for, so a test can prove a retry did real work rather than replaying.
 *
 * A `Set` is read LIVE on every call, so a test can heal the vendor mid-run
 * (`stuck.clear()`) and watch the next retry finish what it owed.
 */
async function failReleaseFor(tenantId: string, stuck: string | Set<string>, attempts: string[]): Promise<void> {
  const stuckAddresses = typeof stuck === "string" ? new Set([stuck]) : stuck;
  await runInDurableObject(tenantStub(tenantId), (instance) => {
    const bundle = (instance as unknown as { sandboxAdapters: { mailbox: { release: unknown } } | null }).sandboxAdapters;
    if (!bundle) throw new Error("no cached sandbox bundle to break — seed the tenant first");
    const original = bundle.mailbox.release as (email: string, key: string) => Promise<unknown>;
    bundle.mailbox.release = async (email: string, key: string) => {
      attempts.push(email);
      if (stuckAddresses.has(email)) throw new VendorError("mailbox not found at the provider", false, { step: "mailbox release" });
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
    expectReplayOf(replay.body, first.body);
    // Nothing further was asked of the vendor.
    expect(attempts).toHaveLength(2);
    expect(await liveMailboxEmails(tenantId)).toHaveLength(2);
  });
});

// N1 (docs/adversarial/wave-1-2-integration-gate-2026-08-18.md, round-2
// re-attack). B3 correctly made a PARTIAL release non-terminal, which is what
// frees the key for the retry the platform's own docs instruct. What made that
// unsafe is the retry VEHICLE: "release N" is a RELATIVE destructive op, so a
// mailbox the vendor permanently refuses keeps `failedCount >= 1` forever, the
// key never freezes, and every instructed retry re-resolved "the N newest live"
// and destroyed `count - failedCount` HEALTHY mailboxes. Measured by the gate:
// 20 live, one stuck, ask 3, six retries -> 12 destroyed and still counting, for
// a customer who asked to release 3. The loss is irreversible in the way that
// matters — a released mailbox loses its warmup reputation, which costs real
// money and the platform's own documented four-week ramp to rebuild.
//
// The fix makes the keyed retry ABSOLUTE: the first execution under a key
// durably records the resolved target set (engine/remove-intents.ts), and every
// same-key retry re-drives exactly that set's still-unreleased members.
describe("N1 — a keyed retry is ABSOLUTE: only the set the first call resolved can ever be released", () => {
  it("a permanently stuck mailbox cannot make a retry destroy anything beyond the count asked for", async () => {
    // 15 live is the demo plan's provisioning cap (engine/quota.ts) — enough to
    // run the gate's six retries and still be the same measurement: on the old
    // code they destroy 12 healthy mailboxes for a customer who asked for 3.
    const { tenantId, token } = await seedTenant("Absolute Retry Co", "absoluteretry.com", 3, 5);
    const live = await liveMailboxEmails(tenantId);
    const target = live.slice(0, 3);
    // Mid-window: inside the 3 this call selects, neither the head nor the tail.
    const stuck = new Set([live[1] as string]);
    const attempts: string[] = [];
    await failReleaseFor(tenantId, stuck, attempts);

    const first = await removeN(token, 3, "downgrade-absolute");
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ releasedCount: 2, failedCount: 1 });
    expect(await liveMailboxes(tenantId)).toBe(13);

    // The gate's probe verbatim: five more of the retry the platform instructs.
    let retryBody = first.body;
    for (let attempt = 2; attempt <= 6; attempt++) {
      const retry = await removeN(token, 3, "downgrade-absolute");
      expect(retry.status).toBe(200);
      // THE INVARIANT: not one healthy mailbox beyond the 3 originally asked for,
      // however many times the agent retries. (On the pre-fix code this reads 11,
      // then 9, 7, 5, 3 — `count - failedCount` destroyed per pass, forever.)
      expect(await liveMailboxes(tenantId)).toBe(13);
      // Counts are scoped to the RECORDED intent, so they report the downgrade
      // as a whole (2 of the 3 are gone) rather than this pass in isolation.
      expect(retry.body).toMatchObject({ releasedCount: 2, failedCount: 1 });
      retryBody = retry.body;
    }
    // Nothing outside the originally-resolved set was ever asked of the vendor.
    expect([...new Set(attempts)].sort()).toEqual([...target].sort());
    // The response names what is still owed, so the agent need not derive it.
    expect(retryBody.unreleased).toEqual([...stuck]);

    // The vendor heals: the retry finishes exactly the intent's last member.
    stuck.clear();
    const healed = await removeN(token, 3, "downgrade-absolute");
    expect(healed.body).toMatchObject({ releasedCount: 3, failedCount: 0, unreleased: [] });
    expect(await liveMailboxes(tenantId)).toBe(12); // the 3 asked for, and only those

    // Terminal at last, so the key freezes: a further retry replays with zero
    // vendor calls, exactly as a whole release always has.
    const releasesAtFreeze = attempts.length;
    const replay = await removeN(token, 3, "downgrade-absolute");
    expectReplayOf(replay.body, healed.body);
    expect(attempts).toHaveLength(releasesAtFreeze);
    expect(await liveMailboxes(tenantId)).toBe(12);
  });

  it("two stuck mailboxes mid-window: every retry drives exactly that pair and nothing else", async () => {
    const { tenantId, token } = await seedTenant("Two Stuck Co", "twostuck.com", 1, 7);
    const live = await liveMailboxEmails(tenantId);
    const target = live.slice(0, 4);
    // Non-adjacent, both mid-window: the healthy mailboxes at live[0] and
    // live[2] sit BETWEEN them, so a retry that re-resolved would take them.
    const stuck = new Set([live[1] as string, live[3] as string]);
    const attempts: string[] = [];
    await failReleaseFor(tenantId, stuck, attempts);

    const first = await removeN(token, 4, "downgrade-pair");
    expect(first.body).toMatchObject({ releasedCount: 2, failedCount: 2 });
    expect(attempts).toEqual(target);
    expect(await liveMailboxes(tenantId)).toBe(5);

    let retryBody = first.body;
    for (let attempt = 2; attempt <= 4; attempt++) {
      attempts.length = 0;
      const retry = await removeN(token, 4, "downgrade-pair");
      expect(await liveMailboxes(tenantId)).toBe(5);
      // Exactly the stuck pair reached the vendor — no healthy mailbox was touched.
      expect([...attempts].sort()).toEqual([...stuck].sort());
      expect(retry.body).toMatchObject({ releasedCount: 2, failedCount: 2 });
      retryBody = retry.body;
    }
    expect([...(retryBody.unreleased as string[])].sort()).toEqual([...stuck].sort());

    stuck.clear();
    const healed = await removeN(token, 4, "downgrade-pair");
    expect(healed.body).toMatchObject({ releasedCount: 4, failedCount: 0, unreleased: [] });
    expect(await liveMailboxes(tenantId)).toBe(3); // exactly the 4 asked for
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

/** Rows `recordRemoveIntent` wrote under `key` — proves the whole target set landed. */
function intentRowCount(tenantId: string, key: string): Promise<number> {
  return runInDurableObject(tenantStub(tenantId), (_i, state) =>
    state.storage.sql
      .exec<{ n: number }>(
        `SELECT COUNT(*) as n FROM mailbox_release_intents WHERE key = ? AND tenant_id = ?`,
        key,
        tenantId,
      )
      .one().n,
  );
}

// R3-1 (gate finding, wave-1-2-integration-gate). recordRemoveIntent wrote
// the whole resolved target set as ONE multi-row INSERT — 5 bound params per
// row — and DO SqlStorage enforces the same 100-bound-parameter ceiling D1
// does (ofac/sdn-list.ts's INSERT_BATCH_SIZE precedent), so any keyed
// removeMailboxes call resolving >=21 targets threw "too many SQL variables"
// before a single row was recorded. RemoveMailboxesInput.count allows up to
// 60 (packages/shared/src/intents.ts), so two-thirds of the schema-permitted
// range failed on the documented path. `mintTenant(..., "managed")` bypasses
// /signup's demo-only cap (SANDBOX_PROVISIONING_CAP.mailboxes = 15,
// engine/quota.ts) to reach the managed plan's flat 60-mailbox self-serve
// ceiling these counts need.
describe("R3-1 — a keyed removeMailboxes at self-serve fleet sizes records the whole target set", () => {
  it("count 21 crosses the old 20-row multi-row-INSERT ceiling and still records exactly 21 rows", async () => {
    const { tenantId, token } = await mintTenant("Large Fleet 21 Co", "managed");
    await api("/setup-infrastructure", {
      method: "POST",
      token,
      body: setupBody("Large Fleet 21 Co", "largefleet21.com", 7, 3), // 7 x 3 = 21
    });
    expect(await liveMailboxes(tenantId)).toBe(21);
    const attempts: string[] = [];
    await failReleaseFor(tenantId, new Set<string>(), attempts);

    const first = await removeN(token, 21, "downgrade-21");
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ releasedCount: 21, failedCount: 0 });
    expect(attempts).toHaveLength(21);
    expect(await intentRowCount(tenantId, "remove_mailboxes:downgrade-21")).toBe(21);
    expect(await liveMailboxes(tenantId)).toBe(0);

    // Retry-replay semantics survive chunking: the recorded intent still wins
    // over any re-resolution, so the replay makes zero further vendor calls.
    const replay = await removeN(token, 21, "downgrade-21");
    expect(replay.status).toBe(200);
    expectReplayOf(replay.body, first.body);
    expect(attempts).toHaveLength(21);
  });

  it("count 60 (the top of RemoveMailboxesInput's range) records exactly 60 rows across multiple chunks", async () => {
    const { tenantId, token } = await mintTenant("Large Fleet 60 Co", "managed");
    await api("/setup-infrastructure", {
      method: "POST",
      token,
      body: setupBody("Large Fleet 60 Co", "largefleet60.com", 20, 3), // 20 x 3 = 60
    });
    expect(await liveMailboxes(tenantId)).toBe(60);
    const attempts: string[] = [];
    await failReleaseFor(tenantId, new Set<string>(), attempts);

    const first = await removeN(token, 60, "downgrade-60");
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ releasedCount: 60, failedCount: 0 });
    expect(attempts).toHaveLength(60);
    expect(await intentRowCount(tenantId, "remove_mailboxes:downgrade-60")).toBe(60);
    expect(await liveMailboxes(tenantId)).toBe(0);

    const replay = await removeN(token, 60, "downgrade-60");
    expect(replay.status).toBe(200);
    expectReplayOf(replay.body, first.body);
    expect(attempts).toHaveLength(60);
  });
});
