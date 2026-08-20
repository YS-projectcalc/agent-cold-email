import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ONE_DAY_MS, WARMUP_RAMP_DAYS } from "../src/engine/warmup.js";
import { api, signup, tenantStub } from "./helpers.js";

// IN-7, docs/adversarial/class-sweep-dedup-semantics-2026-08-17.md.
//
// `replyToThread` falls back to `h:sha256(body)` as its vendor-send key when the
// caller supplies no idempotency key, and a hit RETURNS the first send's
// messageId with no second send and nothing said. The window was
// SENT_MESSAGE_KEY_TTL_MS = 30 DAYS.
//
// So a customer replying "Following up on this." into a thread on Monday and
// again on Thursday gets one email and two successes. The key encodes text
// identity; it never encoded intent-to-send-again. This directly contradicts the
// sibling guard at engine/campaigns.ts:93-108, which throws on the same shape.
//
// The dedup itself is load-bearing and stays (B3/NB4: across a DO cold start a
// retried no-key reply would otherwise mint a fresh messageId and double-send).
// What changes is that the fallback's window means "this is still the same
// attempt being retried" rather than "this body is spent for a month", and that
// a collapse is DISCLOSED instead of looking like a fresh send.

interface ReplyOk {
  messageId: string;
  deduplicated?: boolean;
}

async function seedRepliableThread(slug: string): Promise<{ tenantId: string; token: string; threadId: string }> {
  const domain = `${slug}.com`;
  const { tenantId, token } = await signup(slug, `founder@${domain}`);
  await api("/setup-infrastructure", {
    method: "POST",
    token,
    body: JSON.stringify({
      brand: slug,
      primaryDomain: domain,
      domains: 1,
      inboxesEach: 1,
      persona: "Sender",
      physicalAddress: "1 Test St",
      senderIdentity: `Sender <s@${domain}>`,
    }),
  });
  await tenantStub(tenantId).advanceClock((WARMUP_RAMP_DAYS + 1) * ONE_DAY_MS);
  await api("/campaigns", {
    method: "POST",
    token,
    body: JSON.stringify({
      name: "c",
      offer: "x",
      leads: [{ email: `lead@${slug}-leads.com`, firstName: "L", company: "Co" }],
      sequence: [{ step: 1, subject: "Hi", body: "Hi", delayDays: 0 }],
    }),
  });
  await tenantStub(tenantId).tick();
  const inbox = await api<{ threads: { threadId: string }[] }>("/inbox", { token });
  return { tenantId, token, threadId: inbox.body.threads[0]!.threadId };
}

function reply(token: string, threadId: string, body: string, idempotencyKey?: string) {
  return api<ReplyOk>(`/threads/${threadId}/reply`, {
    method: "POST",
    token,
    body: JSON.stringify({ body }),
    headers: idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined,
  });
}

/** 'sent' events on this thread — one per real send that went out. */
function sentEventCount(tenantId: string, threadId: string): Promise<number> {
  return runInDurableObject(tenantStub(tenantId), (_i, state) =>
    state.storage.sql
      .exec<{ n: number }>(
        `SELECT COUNT(*) as n FROM events WHERE tenant_id = ? AND thread_id = ? AND type = 'sent'`,
        tenantId,
        threadId,
      )
      .one().n,
  );
}

const FOLLOW_UP = "Following up on this.";

describe("IN-7 — the no-key content-hash fallback must not swallow a genuine repeat reply", () => {
  it("SENDS an identical-body follow-up three days later", async () => {
    const { tenantId, token, threadId } = await seedRepliableThread("followupco");

    const monday = await reply(token, threadId, FOLLOW_UP);
    expect(monday.status).toBe(201);
    const sentAfterFirst = await sentEventCount(tenantId, threadId);

    await tenantStub(tenantId).advanceClock(3 * ONE_DAY_MS);

    const thursday = await reply(token, threadId, FOLLOW_UP);
    expect(thursday.status).toBe(201);
    expect(thursday.body.messageId).not.toBe(monday.body.messageId);
    expect(await sentEventCount(tenantId, threadId)).toBe(sentAfterFirst + 1);
    expect(thursday.body.deduplicated).toBe(false);
  });

  // The B3/NB4 guarantee the fallback exists for: an immediate retry of a reply
  // that already went out must NOT double-send.
  it("still collapses an immediate identical-body retry, and now SAYS it collapsed", async () => {
    const { tenantId, token, threadId } = await seedRepliableThread("retrycollapseco");

    const first = await reply(token, threadId, FOLLOW_UP);
    expect(first.status).toBe(201);
    expect(first.body.deduplicated).toBe(false);
    const sentAfterFirst = await sentEventCount(tenantId, threadId);

    const retry = await reply(token, threadId, FOLLOW_UP);
    expect(retry.status).toBe(201);
    expect(retry.body.messageId).toBe(first.body.messageId);
    expect(await sentEventCount(tenantId, threadId)).toBe(sentAfterFirst);
    expect(retry.body.deduplicated).toBe(true);
  });

  // A caller-supplied key is an explicit "this exact request" claim and keeps
  // its long replay window — only the CONTENT-HASH fallback is time-boxed.
  it("keeps replaying a caller-keyed reply after three days", async () => {
    const { tenantId, token, threadId } = await seedRepliableThread("keyedreplayco");

    const first = await reply(token, threadId, FOLLOW_UP, "my-key");
    expect(first.status).toBe(201);
    const sentAfterFirst = await sentEventCount(tenantId, threadId);

    await tenantStub(tenantId).advanceClock(3 * ONE_DAY_MS);

    const replayed = await reply(token, threadId, FOLLOW_UP, "my-key");
    expect(replayed.status).toBe(201);
    expect(replayed.body.messageId).toBe(first.body.messageId);
    expect(await sentEventCount(tenantId, threadId)).toBe(sentAfterFirst);
  });
});
