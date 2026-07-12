import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { PolledEvent } from "@coldstart/shared";
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
    const inbox = await api<{ threadId: string; leadEmail: string }[]>("/inbox", { token });
    const threadId = inbox.body[0]!.threadId;

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
    const inbox = await api<{ threadId: string }[]>("/inbox", { token });
    const threadId = inbox.body[0]!.threadId;

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
      // replayed verbatim on every subsequent poll (an at-least-once IMAP re-poll
      // with no atomic clear).
      const emailPort = (instance as unknown as { adapters: { email: { poll: (m: string) => Promise<PolledEvent[]> } } }).adapters.email;
      const realPoll = emailPort.poll.bind(emailPort);
      const captured = new Map<string, PolledEvent[]>();
      emailPort.poll = async (mbx: string) => {
        if (!captured.has(mbx)) captured.set(mbx, await realPoll(mbx));
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
      // Simulate an in-flight first call: a 'pending' claim already exists.
      state.storage.sql.exec(
        `INSERT INTO request_idempotency (key, status, response_json, created_at) VALUES (?, 'pending', NULL, ?)`,
        "launch_campaign:inflight",
        Date.now(),
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
