import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { VendorError } from "@coldstart/shared";
import { replyToThread } from "../src/engine/threads.js";
import { ONE_DAY_MS, WARMUP_RAMP_DAYS } from "../src/engine/warmup.js";
import { api, signup, tenantStub, withTenantContext } from "./helpers.js";

// Warm-lead Q3 (ROADMAP.md:76, docs/adversarial/warm-lead-thin-layer-design-
// 2026-07-16.md R1/R2) — the thread-reply path used to call
// `adapters.email.send` directly with NO send governance: no per-mailbox daily
// cap, no `sent_today` increment, no deliverability-pause check, no suppression
// re-check. An agent could loop `reply` with varied bodies and send unbounded
// mail from a day-1 mailbox while `infrastructure_status` still reported
// sentToday: 0. These tests drive the REAL HTTP surface (POST /threads/:id/
// reply), not the engine function, so the refusal's status code + structured
// body are covered end to end.

interface ReplyOk {
  messageId: string;
}

interface ReplyRefusal {
  error: string;
  code: string;
  reason: string;
  retryable: boolean;
}

interface MailboxRow {
  id: string;
  sent_today: number;
  daily_cap: number;
  [column: string]: SqlStorageValue;
}

/** Provisions one warmed mailbox, launches a one-lead campaign, and ticks it
 * so the thread has a real 'sent' event and a recorded sending mailbox — the
 * exact state `replyToThread` needs to resolve a reply-from address. */
async function seedRepliableThread(slug: string): Promise<{
  tenantId: string;
  token: string;
  threadId: string;
  leadEmail: string;
}> {
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
  // Past the ramp so the mailbox sits at the fully-warmed cap (40) — every cap
  // assertion below then moves `sent_today` explicitly rather than depending on
  // where in the ramp the fixture happens to land.
  await tenantStub(tenantId).advanceClock((WARMUP_RAMP_DAYS + 1) * ONE_DAY_MS);
  const leadEmail = `lead@${slug}-leads.com`;
  await api("/campaigns", {
    method: "POST",
    token,
    body: JSON.stringify({
      name: "c",
      offer: "x",
      leads: [{ email: leadEmail, firstName: "L", company: "Co" }],
      sequence: [{ step: 1, subject: "Hi", body: "Hi", delayDays: 0 }],
    }),
  });
  await tenantStub(tenantId).tick();

  const inbox = await api<{ threads: { threadId: string }[] }>("/inbox", { token });
  const threadId = inbox.body.threads[0]!.threadId;
  return { tenantId, token, threadId, leadEmail };
}

function readMailbox(tenantId: string): Promise<MailboxRow> {
  return runInDurableObject(tenantStub(tenantId), (_i, state) =>
    state.storage.sql.exec<MailboxRow>(`SELECT id, sent_today, daily_cap FROM mailboxes LIMIT 1`).one(),
  );
}

function updateMailbox(tenantId: string, sql: string, ...binds: unknown[]): Promise<void> {
  return runInDurableObject(tenantStub(tenantId), (_i, state) => {
    state.storage.sql.exec(sql, ...(binds as never[]));
  });
}

describe("POST /threads/:id/reply — guarded single-send (warm-lead Q3, adversary R1/R2)", () => {
  it("REFUSES a reply from a mailbox already at its daily cap, and consumes no capacity", async () => {
    const { tenantId, token, threadId } = await seedRepliableThread("replycapco");
    const before = await readMailbox(tenantId);
    await updateMailbox(tenantId, `UPDATE mailboxes SET sent_today = daily_cap WHERE id = ?`, before.id);

    const res = await api<ReplyRefusal>(`/threads/${threadId}/reply`, {
      method: "POST",
      token,
      body: JSON.stringify({ body: "one more from a mailbox that has nothing left today" }),
    });

    expect(res.status).toBe(429);
    expect(res.body.code).toBe("send_blocked");
    expect(res.body.reason).toBe("daily_cap_reached");
    expect(res.body.retryable).toBe(true);

    // The refusal must not silently bill the mailbox for a send it never made.
    const after = await readMailbox(tenantId);
    expect(after.sent_today).toBe(before.daily_cap);
  });

  it("REFUSES a reply from a deliverability-paused mailbox", async () => {
    const { tenantId, token, threadId } = await seedRepliableThread("replypausedco");
    const before = await readMailbox(tenantId);
    await updateMailbox(tenantId, `UPDATE mailboxes SET deliv_status = 'paused' WHERE id = ?`, before.id);

    const res = await api<ReplyRefusal>(`/threads/${threadId}/reply`, {
      method: "POST",
      token,
      body: JSON.stringify({ body: "sending from a mailbox the control loop pulled offline" }),
    });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("send_blocked");
    expect(res.body.reason).toBe("mailbox_paused");
    expect(res.body.retryable).toBe(false);

    const after = await readMailbox(tenantId);
    expect(after.sent_today).toBe(before.sent_today);
  });

  it("REFUSES a reply to a suppressed recipient (re-checked at send time, after the thread existed)", async () => {
    const { tenantId, token, threadId, leadEmail } = await seedRepliableThread("replysuppressedco");
    const before = await readMailbox(tenantId);
    // Suppress through the real tenant-wide opt-out path, exactly as
    // `suppress_lead` / an inbound unsubscribe would.
    const suppressed = await api(`/leads/suppress`, {
      method: "POST",
      token,
      body: JSON.stringify({ email: leadEmail }),
    });
    expect(suppressed.status).toBe(200);

    const res = await api<ReplyRefusal>(`/threads/${threadId}/reply`, {
      method: "POST",
      token,
      body: JSON.stringify({ body: "replying to someone who already opted out" }),
    });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("send_blocked");
    expect(res.body.reason).toBe("suppressed");
    expect(res.body.retryable).toBe(false);

    const after = await readMailbox(tenantId);
    expect(after.sent_today).toBe(before.sent_today);
  });

  it("SENDS a reply under the cap and meters it against sent_today", async () => {
    const { tenantId, token, threadId } = await seedRepliableThread("replyhappyco");
    const before = await readMailbox(tenantId);
    expect(before.sent_today).toBeLessThan(before.daily_cap);

    const res = await api<ReplyOk>(`/threads/${threadId}/reply`, {
      method: "POST",
      token,
      body: JSON.stringify({ body: "a perfectly ordinary reply" }),
    });

    expect(res.status).toBe(201);
    expect(res.body.messageId).toMatch(/^<.+@.+>$/);

    // The whole point of the guard: a manual reply is real sending volume, so
    // it counts against the same budget the tick meters.
    const after = await readMailbox(tenantId);
    expect(after.sent_today).toBe(before.sent_today + 1);
  });

  it("surfaces the refusal STRUCTURED over MCP too, not as a flattened message string", async () => {
    const { tenantId, token, threadId } = await seedRepliableThread("replymcpco");
    const before = await readMailbox(tenantId);
    await updateMailbox(tenantId, `UPDATE mailboxes SET sent_today = daily_cap WHERE id = ?`, before.id);

    const res = await api<{ result: { content: { text: string }[]; isError?: boolean } }>("/mcp", {
      method: "POST",
      token,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "reply", arguments: { threadId, body: "over the MCP transport" } },
      }),
    });

    expect(res.status).toBe(200);
    expect(res.body.result.isError).toBe(true);
    // The customer's agent must be able to BRANCH on this without parsing prose.
    const parsed = JSON.parse(res.body.result.content[0]!.text) as ReplyRefusal;
    expect(parsed.code).toBe("send_blocked");
    expect(parsed.reason).toBe("daily_cap_reached");
    expect(parsed.retryable).toBe(true);

    const after = await readMailbox(tenantId);
    expect(after.sent_today).toBe(before.daily_cap);
  });

  it("RELEASES the reserved capacity when the vendor send throws, and a retry then succeeds", async () => {
    // Adversary N-h — guarded-send.ts reserves capacity BEFORE the network call
    // (that reserve is what makes the cap atomic across the await). If the send
    // then throws, the reservation must be released: without it a run of
    // transient vendor failures silently burns the whole day's allowance for
    // zero delivered mail, and sent_today drifts above reality.
    const { tenantId, token, threadId } = await seedRepliableThread("replyrollbackco");
    const before = await readMailbox(tenantId);

    const failed = await withTenantContext(tenantId, async (ctx) => {
      const patched = {
        ...ctx,
        adapters: {
          ...ctx.adapters,
          email: {
            ...ctx.adapters.email,
            send: async () => {
              throw new VendorError("smtp 421 service unavailable", true);
            },
          },
        },
      };
      return replyToThread(patched, threadId, "this one dies in the vendor").catch((e: unknown) => e);
    });
    expect(failed).toBeInstanceOf(VendorError);

    // The failed attempt consumed no capacity.
    const afterFailure = await readMailbox(tenantId);
    expect(afterFailure.sent_today).toBe(before.sent_today);

    // And the mailbox is still usable — the retry goes out and meters once.
    const retry = await api<ReplyOk>(`/threads/${threadId}/reply`, {
      method: "POST",
      token,
      body: JSON.stringify({ body: "this one dies in the vendor" }),
    });
    expect(retry.status).toBe(201);
    expect((await readMailbox(tenantId)).sent_today).toBe(before.sent_today + 1);
  });

  it("caps the reply loop: a mailbox with 1 unit left sends exactly one reply, then refuses", async () => {
    const { tenantId, token, threadId } = await seedRepliableThread("replyloopco");
    const before = await readMailbox(tenantId);
    await updateMailbox(tenantId, `UPDATE mailboxes SET sent_today = daily_cap - 1 WHERE id = ?`, before.id);

    // Distinct bodies — the pre-existing content-hash dedupe (B3) must not be
    // what stops the second send; the cap must.
    const first = await api<ReplyOk>(`/threads/${threadId}/reply`, {
      method: "POST",
      token,
      body: JSON.stringify({ body: "reply number one" }),
    });
    const second = await api<ReplyRefusal>(`/threads/${threadId}/reply`, {
      method: "POST",
      token,
      body: JSON.stringify({ body: "reply number two" }),
    });

    expect(first.status).toBe(201);
    expect(second.status).toBe(429);
    expect(second.body.reason).toBe("daily_cap_reached");

    const after = await readMailbox(tenantId);
    expect(after.sent_today).toBe(before.daily_cap);
  });
});
