import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { PollResult } from "@coldstart/shared";
import { ONE_DAY_MS, WARMUP_RAMP_DAYS } from "../src/engine/warmup.js";
import { api, signup, tenantStub } from "./helpers.js";

async function setupReadyTenant(brand: string, primaryDomain: string) {
  const { tenantId, token } = await signup(brand, `founder@${primaryDomain}`);
  await api("/setup-infrastructure", {
    method: "POST",
    token,
    body: JSON.stringify({
      brand,
      primaryDomain,
      domains: 1,
      inboxesEach: 1,
      persona: "Sender",
      physicalAddress: "1 Test St",
      senderIdentity: `Sender <s@${primaryDomain}>`,
    }),
  });
  await tenantStub(tenantId).advanceClock((WARMUP_RAMP_DAYS + 1) * ONE_DAY_MS);
  return { tenantId, token };
}

const ONE_STEP = [{ step: 1, subject: "Hi", body: "Hi", delayDays: 0 }];

function rowCount(tenantId: string, sql: string, ...binds: unknown[]): Promise<number> {
  return runInDurableObject(tenantStub(tenantId), async (_i, state) =>
    state.storage.sql.exec<{ n: number }>(sql, ...binds).one().n,
  );
}

// The tenant's actual ctx.clock.now() (clock_base + clock_offset), reconstructed
// from tenant_profile — NOT real Date.now(). setupReadyTenant() fast-forwards
// the tenant's VIRTUAL clock by a warmup ramp (engine/idempotency.ts's staleness
// check reads created_at against ctx.clock.now()), so a row stamped with real
// Date.now() would already read as ~29 virtual days old — always "stale"
// regardless of intent. Simulated claim rows must be stamped on this same clock
// base to mean what a test says they mean ("fresh" vs "stale").
function currentClockMs(state: DurableObjectState): number {
  const row = state.storage.sql
    .exec<{ clock_base: number; clock_offset: number }>(`SELECT clock_base, clock_offset FROM tenant_profile LIMIT 1`)
    .one();
  return row.clock_base + row.clock_offset;
}

// G1 / B2 — a retried mutating request carrying the same Idempotency-Key must
// leave IDENTICAL end state (no second campaign / provision / send).
describe("B2 — request-level idempotency (Idempotency-Key)", () => {
  it("launch_campaign: a replay returns the first campaign and does not create a second (row counts unchanged)", async () => {
    const { tenantId, token } = await setupReadyTenant("Launch Idem Co", "launchidem.com");
    const body = JSON.stringify({
      name: "once",
      offer: "x",
      leads: [{ email: "lead@launchidem-leads.com", firstName: "L", company: "Co" }],
      sequence: ONE_STEP,
      stopOnReply: true,
    });
    const headers = { "Idempotency-Key": "launch-k1" };

    const r1 = await api<{ campaignId: string }>("/campaigns", { method: "POST", token, headers, body });
    const r2 = await api<{ campaignId: string }>("/campaigns", { method: "POST", token, headers, body });

    expect(r2.status).toBe(201);
    expect(r2.body.campaignId).toBe(r1.body.campaignId);
    expect(await rowCount(tenantId, `SELECT COUNT(*) as n FROM campaigns`)).toBe(1);
    expect(await rowCount(tenantId, `SELECT COUNT(*) as n FROM leads`)).toBe(1);
    expect(await rowCount(tenantId, `SELECT COUNT(*) as n FROM scheduled_sends`)).toBe(1);
  });

  it("setup_infrastructure: a replay returns the first job and does not re-provision duplicate domains/mailboxes", async () => {
    const { tenantId, token } = await signup("Setup Idem Co", "founder@setupidem.com");
    const body = JSON.stringify({
      brand: "Setup Idem Co",
      primaryDomain: "setupidem.com",
      domains: 1,
      inboxesEach: 2,
      persona: "Sender",
      physicalAddress: "1 St",
      senderIdentity: "Sender <s@setupidem.com>",
    });
    const headers = { "Idempotency-Key": "setup-k1" };

    const s1 = await api<{ jobId: string }>("/setup-infrastructure", { method: "POST", token, headers, body });
    const s2 = await api<{ jobId: string }>("/setup-infrastructure", { method: "POST", token, headers, body });

    expect(s2.body.jobId).toBe(s1.body.jobId);
    expect(await rowCount(tenantId, `SELECT COUNT(*) as n FROM domains`)).toBe(1); // not 2
    expect(await rowCount(tenantId, `SELECT COUNT(*) as n FROM mailboxes`)).toBe(2); // not 4
  });

  it("thread reply: a replay returns the first send and dispatches no second email", async () => {
    const { tenantId, token } = await setupReadyTenant("Reply Idem Co", "replyidem.com");
    await api("/campaigns", {
      method: "POST",
      token,
      body: JSON.stringify({ name: "r", offer: "x", leads: [{ email: "reply.prospect@replyidem-leads.com", firstName: "R", company: "Co" }], sequence: ONE_STEP, stopOnReply: true }),
    });
    await tenantStub(tenantId).tick();
    await tenantStub(tenantId).pollInbox();
    const inbox = await api<{ threads: { threadId: string; leadEmail: string }[] }>("/inbox", { token });
    const threadId = inbox.body.threads[0]!.threadId;

    const headers = { "Idempotency-Key": "reply-k1" };
    const rep1 = await api<{ messageId: string }>(`/threads/${threadId}/reply`, { method: "POST", token, headers, body: JSON.stringify({ body: "thanks!" }) });
    const rep2 = await api<{ messageId: string }>(`/threads/${threadId}/reply`, { method: "POST", token, headers, body: JSON.stringify({ body: "thanks!" }) });

    expect(rep2.body.messageId).toBe(rep1.body.messageId);
    // Thread events: the step-1 'sent' + the sandbox 'reply' + exactly ONE manual 'sent'.
    expect(await rowCount(tenantId, `SELECT COUNT(*) as n FROM events WHERE thread_id = ? AND type = 'sent'`, threadId)).toBe(2);
  });
});

// B3 — even WITHOUT a request idempotency key, a retried manual reply with the
// same body reuses a stable vendor key (content hash), so it can't double-send.
describe("B3 — manual reply vendor key is stable (no duplicate send on retry without a key)", () => {
  it("two identical-body replies with no Idempotency-Key produce one messageId and one sent event", async () => {
    const { tenantId, token } = await setupReadyTenant("Stable Key Co", "stablekey.com");
    await api("/campaigns", {
      method: "POST",
      token,
      body: JSON.stringify({ name: "r", offer: "x", leads: [{ email: "reply.prospect@stablekey-leads.com", firstName: "R", company: "Co" }], sequence: ONE_STEP, stopOnReply: true }),
    });
    await tenantStub(tenantId).tick();
    await tenantStub(tenantId).pollInbox();
    const inbox = await api<{ threads: { threadId: string }[] }>("/inbox", { token });
    const threadId = inbox.body.threads[0]!.threadId;

    const rep1 = await api<{ messageId: string }>(`/threads/${threadId}/reply`, { method: "POST", token, body: JSON.stringify({ body: "same body" }) });
    const rep2 = await api<{ messageId: string }>(`/threads/${threadId}/reply`, { method: "POST", token, body: JSON.stringify({ body: "same body" }) });

    expect(rep2.body.messageId).toBe(rep1.body.messageId); // stable key -> cached send result
    expect(await rowCount(tenantId, `SELECT COUNT(*) as n FROM events WHERE thread_id = ? AND type = 'sent'`, threadId)).toBe(2);
  });
});

// G1 / G3(ii) ANCHOR — an at-least-once re-poll re-delivers the SAME event; it
// must apply nothing twice. FAILS with the events INSERT OR IGNORE reverted
// (the second insert violates the unique index and throws out of pollInbox).
describe("B1 — inbound event idempotency across an at-least-once re-poll (G3 anchor)", () => {
  it("a double poll of the same reply yields one event row and metrics().reply === 1", async () => {
    const { tenantId } = await setupReadyTenant("Redelivery Co", "redelivery.com");

    await runInDurableObject(tenantStub(tenantId), async (instance, state) => {
      await instance.launchCampaign({
        name: "redeliver",
        offer: "x",
        leads: [{ email: "reply.prospect@redelivery-leads.com", firstName: "R", company: "Co" }],
        sequence: ONE_STEP,
        timezone: "UTC",
        sendWindow: { startHour: 0, endHour: 23 },
        stopOnReply: true,
      });
      await instance.tick(); // sends step 1, queues a sandbox reply for the mailbox

      // Make the port RE-DELIVER: each mailbox's first real poll is captured and
      // replayed verbatim on every subsequent poll — exactly the consumer-owned-
      // cursor failure mode (the cursor never advanced, so the same batch comes
      // back). This is the end-to-end proof that redelivery is SAFE: the Worker
      // dedupes on the event's stable Message-ID (events unique index).
      const emailPort = (instance as unknown as { adapters: { email: { poll: (m: string, c: number) => Promise<PollResult> } } }).adapters.email;
      const realPoll = emailPort.poll.bind(emailPort);
      const captured = new Map<string, PollResult>();
      emailPort.poll = async (mbx: string, sinceCursor: number) => {
        if (!captured.has(mbx)) captured.set(mbx, await realPoll(mbx, sinceCursor));
        return captured.get(mbx)!;
      };

      const first = await instance.pollInbox(); // processes the reply
      const second = await instance.pollInbox(); // RE-DELIVERS the same reply
      expect(first.replies).toBe(1);
      expect(second.replies).toBe(0); // the duplicate applied nothing

      const replyRows = state.storage.sql
        .exec<{ n: number }>(`SELECT COUNT(*) as n FROM events WHERE type = 'reply'`)
        .one().n;
      expect(replyRows).toBe(1);
      const metrics = await instance.metrics();
      expect(metrics.reply).toBe(1);
    });
  });
});

const LAUNCH_INPUT = (email: string) => ({
  name: "idem",
  offer: "x",
  leads: [{ email, firstName: "L", company: "Co" }],
  sequence: ONE_STEP,
  timezone: "UTC",
  sendWindow: { startHour: 0, endHour: 23 },
  stopOnReply: true,
});

// NB1 — one row per unique key would live forever, growing the per-tenant DO.
// Eviction happens at write time: each new claim prunes completed rows past the
// TTL. FAILS on the pre-fix code (INSERT-only, no eviction anywhere).
describe("NB1 — request_idempotency eviction bounds table growth", () => {
  it("evicts 'done' rows older than the TTL at write time; the fresh row remains", async () => {
    const { tenantId } = await setupReadyTenant("Evict Co", "evictco.com");
    await runInDurableObject(tenantStub(tenantId), async (instance, state) => {
      // An ancient completed claim (created_at = epoch 0, far older than the TTL).
      state.storage.sql.exec(
        `INSERT INTO request_idempotency (key, status, response_json, created_at) VALUES (?, 'done', ?, 0)`,
        "launch_campaign:ancient",
        JSON.stringify({ campaignId: "old" }),
      );
      // A fresh keyed intent inserts its own claim, which triggers write-time eviction.
      await instance.launchCampaign(LAUNCH_INPUT("fresh@evictco-leads.com"), "fresh");

      const count = (key: string) =>
        state.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) as n FROM request_idempotency WHERE key = ?`, key).one().n;
      expect(count("launch_campaign:ancient")).toBe(0); // evicted
      expect(count("launch_campaign:fresh")).toBe(1); // retained
    });
  });
});

// NB2 — claim-then-execute closes the async race (two concurrent FIRST calls
// both passing the read and both executing an intent that awaits vendor I/O).
describe("NB2 — claim-then-execute idempotency", () => {
  it("rejects a concurrent same-key call while the first is still pending (claim)", async () => {
    const { tenantId } = await setupReadyTenant("Claim Co", "claimco.com");
    await runInDurableObject(tenantStub(tenantId), async (instance, state) => {
      // Simulate an in-flight first call: a fresh 'pending' claim already
      // exists (stamped on the tenant's own virtual clock, not real
      // Date.now() — see currentClockMs()'s doc).
      state.storage.sql.exec(
        `INSERT INTO request_idempotency (key, status, response_json, created_at) VALUES (?, 'pending', NULL, ?)`,
        "launch_campaign:inflight",
        currentClockMs(state),
      );
      await expect(instance.launchCampaign(LAUNCH_INPUT("l@claimco-leads.com"), "inflight")).rejects.toThrow(/in progress/i);
      // The blocked call executed nothing — no campaign row was created.
      expect(state.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) as n FROM campaigns`).one().n).toBe(0);
    });
  });

  it("clears the claim when the first call throws, so a retry re-runs (error not cached)", async () => {
    const { tenantId } = await setupReadyTenant("Fail Claim Co", "failclaim.com");
    await runInDurableObject(tenantStub(tenantId), async (instance, state) => {
      // reply() to a nonexistent thread throws NotFoundError inside fn; with a
      // key, the claim must be cleared (not left 'pending') so a retry re-runs.
      await expect(instance.reply("missing_thread", "hi", "failk")).rejects.toThrow();
      expect(
        state.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) as n FROM request_idempotency WHERE key = ?`, "reply:missing_thread:failk").one().n,
      ).toBe(0); // claim cleared
      // The retry re-runs fn and throws again — a cached success would resolve instead.
      await expect(instance.reply("missing_thread", "hi", "failk")).rejects.toThrow();
    });
  });
});

async function replyReadyThread(brand: string, primaryDomain: string, leadEmail: string) {
  const { tenantId, token } = await setupReadyTenant(brand, primaryDomain);
  await api("/campaigns", {
    method: "POST",
    token,
    body: JSON.stringify({ name: "r", offer: "x", leads: [{ email: leadEmail, firstName: "R", company: "Co" }], sequence: ONE_STEP, stopOnReply: true }),
  });
  await tenantStub(tenantId).tick();
  await tenantStub(tenantId).pollInbox();
  const inbox = await api<{ threads: { threadId: string }[] }>("/inbox", { token });
  return { tenantId, threadId: inbox.body.threads[0]!.threadId };
}

// NB6 — ACTIVATION.md Gate 2 / d342cd0's liveness note: a DO that dies mid-fn
// (after its claim is durable, before the UPDATE/DELETE) leaves a PERMANENT
// 'pending' row that would 409 every retry of that key forever — write-time
// eviction (NB1) only ever removes 'done' rows. A 'pending' claim past
// REQUEST_IDEMPOTENCY_PENDING_CLAIM_TTL_MS is presumed dead and reclaimable by
// a retry of the SAME key.
describe("NB6 — stale 'pending' claim reclaim (ACTIVATION.md Gate 2)", () => {
  it("a fresh 'pending' claim (within the TTL) still 409s — genuine concurrent-duplicate protection is unweakened", async () => {
    const { tenantId, threadId } = await replyReadyThread("Fresh Pending Co", "freshpending.com", "reply.prospect@freshpending-leads.com");
    await runInDurableObject(tenantStub(tenantId), async (instance, state) => {
      const key = `reply:${threadId}:fresh-key`;
      state.storage.sql.exec(
        `INSERT INTO request_idempotency (key, status, response_json, created_at) VALUES (?, 'pending', NULL, ?)`,
        key,
        currentClockMs(state), // just claimed — well within the TTL
      );
      await expect(instance.reply(threadId, "body", "fresh-key")).rejects.toThrow(/in progress/i);
      // The blocked retry executed nothing — no second 'sent' event landed.
      expect(
        state.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) as n FROM events WHERE thread_id = ? AND type = 'sent'`, threadId).one().n,
      ).toBe(1); // only the step-1 campaign send
    });
  });

  it("a stale 'pending' claim (past the TTL) is reclaimed — the retry executes and completes", async () => {
    const { tenantId, threadId } = await replyReadyThread("Stale Pending Co", "stalepending.com", "reply.prospect@stalepending-leads.com");
    await runInDurableObject(tenantStub(tenantId), async (instance, state) => {
      const key = `reply:${threadId}:stale-key`;
      // A claim from a DO that died mid-fn, long past any legitimate fn()
      // duration (created_at = 0 is billions of ms before the tenant's own
      // clock_base, so it's stale under any realistic TTL).
      state.storage.sql.exec(
        `INSERT INTO request_idempotency (key, status, response_json, created_at) VALUES (?, 'pending', NULL, 0)`,
        key,
      );
      const result = await instance.reply(threadId, "reclaimed body", "stale-key");
      expect(result.messageId).toBeTruthy();
      // step-1 campaign send + exactly ONE manual reply send.
      expect(
        state.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) as n FROM events WHERE thread_id = ? AND type = 'sent'`, threadId).one().n,
      ).toBe(2);
      const row = state.storage.sql
        .exec<{ status: string; response_json: string | null }>(`SELECT status, response_json FROM request_idempotency WHERE key = ?`, key)
        .one();
      expect(row.status).toBe("done");
      expect(JSON.parse(row.response_json!)).toEqual(result);
    });
  });

  // Two retries of the SAME stale key, launched concurrently against the same
  // DO instance (Promise.all, same pattern as tick-correctness.test.ts's
  // "processes a due row exactly once" — an honest race via the DO's own
  // serial-execution/input-gate semantics, not a faked/manually-stepped one):
  // exactly one must reclaim and run fn(); the other must see the
  // freshly-reclaimed (no-longer-stale) row and 409, never double-send.
  it("reclaim is atomic under a concurrent retry race — exactly one retry wins", async () => {
    const { tenantId, threadId } = await replyReadyThread("Race Co", "raceco.com", "reply.prospect@raceco-leads.com");
    await runInDurableObject(tenantStub(tenantId), async (instance, state) => {
      const key = `reply:${threadId}:race-key`;
      state.storage.sql.exec(
        `INSERT INTO request_idempotency (key, status, response_json, created_at) VALUES (?, 'pending', NULL, 0)`,
        key,
      );
      const [a, b] = await Promise.allSettled([
        instance.reply(threadId, "race body", "race-key"),
        instance.reply(threadId, "race body", "race-key"),
      ]);
      const fulfilled = [a, b].filter((r) => r.status === "fulfilled");
      const rejected = [a, b].filter((r): r is PromiseRejectedResult => r.status === "rejected");
      expect(fulfilled.length).toBe(1); // exactly one retry actually ran fn()
      expect(rejected.length).toBe(1);
      expect(rejected[0]!.reason).toMatchObject({ message: expect.stringMatching(/in progress/i) });
      // step-1 campaign send + exactly ONE manual reply send — never two.
      expect(
        state.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) as n FROM events WHERE thread_id = ? AND type = 'sent'`, threadId).one().n,
      ).toBe(2);
      expect(state.storage.sql.exec<{ status: string }>(`SELECT status FROM request_idempotency WHERE key = ?`, key).one().status).toBe(
        "done",
      );
    });
  });
});

// NB4 — B3 content-hash dedupe was warm-DO-only: the sandbox vendor's send-cache
// is in-memory, so a no-key reply retried after a DO eviction would mint a fresh
// messageId and double-send. The stable send-key -> messageId map is now durable
// (sent_message_keys), so the dedupe survives a cold start. FAILS on the pre-fix
// code (a cleared vendor cache reopens the double-send).
describe("NB4 — reply content-hash dedupe survives a cold DO", () => {
  it("a no-key reply retried after the in-memory vendor cache is gone dedupes (one send, one event)", async () => {
    const { tenantId } = await setupReadyTenant("Cold Reply Co", "coldreply.com");
    await runInDurableObject(tenantStub(tenantId), async (instance, state) => {
      await instance.launchCampaign(LAUNCH_INPUT("reply.prospect@coldreply-leads.com"));
      await instance.tick(); // sends step 1 -> assigns a mailbox to the thread

      const threadId = state.storage.sql
        .exec<{ thread_id: string }>(`SELECT thread_id FROM scheduled_sends LIMIT 1`)
        .one().thread_id;

      const rep1 = await instance.reply(threadId, "cold-start body"); // no idempotency key
      // Simulate a DO cold start: the in-memory vendor send-cache is gone; DO
      // SQLite (the durable send-key map) persists.
      const port = (instance as unknown as { adapters: { email: { sentByIdempotencyKey: Map<string, unknown> } } }).adapters.email;
      port.sentByIdempotencyKey.clear();
      const rep2 = await instance.reply(threadId, "cold-start body"); // same body, cold vendor

      expect(rep2.messageId).toBe(rep1.messageId); // durable map -> same id, no second send
      // step-1 'sent' + exactly ONE manual 'sent' = 2 (a double-send would be 3).
      expect(
        state.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) as n FROM events WHERE thread_id = ? AND type = 'sent'`, threadId).one().n,
      ).toBe(2);
    });
  });
});

// Consumer-owned cursor: the DO must PERSIST the cursor the engine returns and
// pass its STORED cursor as sinceCursor on the next poll — so the engine can be
// cursor-stateless and a lost response redelivers instead of skipping events.
describe("poll cursor is owned + persisted by the consumer DO", () => {
  it("stores the returned cursor and passes it as sinceCursor on the next poll", async () => {
    const { tenantId } = await setupReadyTenant("Cursor Co", "cursor.com");

    await runInDurableObject(tenantStub(tenantId), async (instance, state) => {
      await instance.launchCampaign({
        name: "cursor",
        offer: "x",
        leads: [{ email: "reply.prospect@cursor-leads.com", firstName: "R", company: "Co" }],
        sequence: ONE_STEP,
        timezone: "UTC",
        sendWindow: { startHour: 0, endHour: 23 },
        stopOnReply: true,
      });
      await instance.tick();

      // Stub the port to record the sinceCursor it receives and return an
      // advancing cursor, so we can assert the DO round-trips it.
      const seen: number[] = [];
      const port = (instance as unknown as { adapters: { email: { poll: (m: string, c: number) => Promise<PollResult> } } }).adapters.email;
      port.poll = async (_m: string, sinceCursor: number) => {
        seen.push(sinceCursor);
        return { events: [], cursor: sinceCursor + 10 };
      };

      const cursorOf = () =>
        state.storage.sql.exec<{ poll_cursor: number }>(`SELECT poll_cursor FROM mailboxes LIMIT 1`).one().poll_cursor;

      // Fresh mailbox: poll_cursor starts at -1 (the never-polled sentinel,
      // engine.ts's first-contact branch) -- provisioning.ts sets it
      // explicitly on insert (round-2 fix, adversary
      // poll-bounded-fetch-2026-07-16 finding 1: a bare 0 default collided
      // with a legitimate empty-mailbox cursor and permanently lost the
      // first inbound on every fresh mailbox).
      expect(cursorOf()).toBe(-1);
      await instance.pollInbox();
      expect(cursorOf()).toBe(9); // persisted the returned cursor (-1 + 10)
      await instance.pollInbox();
      expect(cursorOf()).toBe(19); // 9 + 10
      // The DO passed its STORED cursor each time (-1 then 9), never a fixed 0.
      expect(seen).toEqual([-1, 9]);
    });
  });
});
