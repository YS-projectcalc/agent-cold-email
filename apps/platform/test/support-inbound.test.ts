import { describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { handleInboundSupportEmail } from "../src/admin/support-inbound.js";

// D1 (brief) — inbound support@ ingestion. Builds a real raw-MIME message so
// postal-mime actually parses it (not a stubbed parser), and a mock
// ForwardableEmailMessage whose `forward`/`reply` are spies.

interface MockMsgOptions {
  from: string;
  to: string;
  subject: string;
  body: string;
  messageId?: string;
  forwardImpl?: () => Promise<unknown>;
}

function makeMessage(opts: MockMsgOptions) {
  const messageId = opts.messageId ?? "<gen-" + crypto.randomUUID() + "@example.com>";
  const rawMime =
    `From: ${opts.from}\r\n` +
    `To: ${opts.to}\r\n` +
    `Subject: ${opts.subject}\r\n` +
    `Message-ID: ${messageId}\r\n` +
    `Content-Type: text/plain; charset=utf-8\r\n` +
    `\r\n` +
    opts.body +
    `\r\n`;

  const forward = vi.fn(opts.forwardImpl ?? (async () => ({ messageId: "fwd" })));
  const reply = vi.fn(async () => ({ messageId: "reply" }));
  const setReject = vi.fn();

  // `raw` is single-use — the handler must buffer it exactly once.
  const raw = new Response(rawMime).body as ReadableStream<Uint8Array>;
  const headers = new Headers({ "message-id": messageId, subject: opts.subject });

  const message = {
    from: opts.from,
    to: opts.to,
    raw,
    rawSize: rawMime.length,
    headers,
    forward,
    reply,
    setReject,
  } as unknown as ForwardableEmailMessage;

  return { message, forward, reply, setReject, messageId };
}

async function ticketByMessageId(messageId: string) {
  return env.DB.prepare(
    `SELECT from_email, subject, body, tenant_id, category, draft, status, message_id FROM support_tickets WHERE message_id = ?`,
  )
    .bind(messageId)
    .first<{ from_email: string; subject: string; body: string; tenant_id: string | null; category: string; draft: string | null; status: string; message_id: string }>();
}

describe("inbound support@ handler", () => {
  it("parses, triages (how-to -> drafted/open), persists an ops ticket, and forwards to the founder", async () => {
    const { message, forward, reply, messageId } = makeMessage({
      from: "jane@prospect.com",
      to: "support@coldrig.dev",
      subject: "How do I get an API key?",
      body: "I want to connect my agent — how do I get a token to set up the MCP?",
    });

    const outcome = await handleInboundSupportEmail(message, env);

    expect(outcome).toMatchObject({ inserted: true, category: "how-to", status: "open", forwarded: true });
    // Forwarded to the founder address, exactly once. NEVER auto-replied.
    expect(forward).toHaveBeenCalledTimes(1);
    expect(forward).toHaveBeenCalledWith(env.OPS_ALERT_EMAIL);
    expect(reply).not.toHaveBeenCalled();

    const row = await ticketByMessageId(messageId);
    expect(row).toBeTruthy();
    expect(row?.from_email).toBe("jane@prospect.com"); // envelope sender
    expect(row?.subject).toBe("How do I get an API key?");
    expect(row?.tenant_id).toBeNull(); // unresolved-tenant inbound
    expect(row?.category).toBe("how-to");
    expect(row?.status).toBe("open");
    expect(row?.draft).toBeTruthy(); // FAQ-drafted, but NOT sent (draft stays a draft)
  });

  it("escalates an abuse report (no draft) and still forwards", async () => {
    const { message, forward, messageId } = makeMessage({
      from: "reporter@somewhere.com",
      to: "support@coldrig.dev",
      subject: "Reporting abuse",
      body: "One of your users is sending phishing emails impersonating my bank.",
    });

    const outcome = await handleInboundSupportEmail(message, env);
    expect(outcome).toMatchObject({ inserted: true, category: "abuse-report", status: "escalated", forwarded: true });
    expect(forward).toHaveBeenCalledWith(env.OPS_ALERT_EMAIL);

    const row = await ticketByMessageId(messageId);
    expect(row?.status).toBe("escalated");
    expect(row?.draft).toBeNull();
  });

  it("a forward failure (dark/unverified destination) is caught — the ticket still persists", async () => {
    const { message, messageId } = makeMessage({
      from: "someone@x.com",
      to: "support@coldrig.dev",
      subject: "billing question",
      body: "when will I be charged? what's the price?",
      forwardImpl: async () => {
        throw new Error("destination not verified");
      },
    });

    // Must not throw despite the forward failing.
    const outcome = await handleInboundSupportEmail(message, env);
    expect(outcome.inserted).toBe(true);
    expect(outcome.forwarded).toBe(false);
    expect(await ticketByMessageId(messageId)).toBeTruthy();
  });
});
