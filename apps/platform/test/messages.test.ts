import { describe, expect, it } from "vitest";
import { emitTenantMessage } from "../src/engine/tenant-messages.js";
import { ackMessage, listMessagesPage } from "../src/engine/tenant-messages.js";
import { api, signup, tenantStub, withTenantContext } from "./helpers.js";

// msgchannel increment 3 — the full paginated read surface (list_messages)
// plus the one place `read_at` is ever written (ack_message), both as REST
// (routes/messages.ts) and MCP tools (mcp/tools.ts). Increment 1's
// listSurfacedTenantMessages (test/tenant-messages.test.ts) already covers
// the fixed cap-5 preview in depth — these tests cover what's NEW here:
// pagination, the unread/read cursor boundary, ack idempotency, and (most
// important) tenant isolation across both transports.

interface JsonRpcSuccess<T = unknown> {
  jsonrpc: "2.0";
  id: number;
  result: T;
}

function rpc(method: string, params?: unknown) {
  return JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
}

async function callTool<T = unknown>(token: string, name: string, args: unknown): Promise<T> {
  const res = await api<JsonRpcSuccess<{ content: { type: string; text: string }[]; isError?: boolean }>>("/mcp", {
    method: "POST",
    token,
    body: rpc("tools/call", { name, arguments: args }),
  });
  expect(res.status).toBe(200);
  expect(res.body.result.isError).not.toBe(true);
  return JSON.parse(res.body.result.content[0]!.text) as T;
}

async function callToolExpectError<T = { error: string }>(token: string, name: string, args: unknown): Promise<T> {
  const res = await api<JsonRpcSuccess<{ content: { type: string; text: string }[]; isError?: boolean }>>("/mcp", {
    method: "POST",
    token,
    body: rpc("tools/call", { name, arguments: args }),
  });
  expect(res.status).toBe(200);
  expect(res.body.result.isError).toBe(true);
  return JSON.parse(res.body.result.content[0]!.text) as T;
}

interface MessageDTO {
  id: string;
  body: string;
  readAt: number | null;
}
interface MessageListPageDTO {
  messages: MessageDTO[];
  nextCursor: string | null;
}

async function emit(tenantId: string, body: string): Promise<void> {
  await withTenantContext(tenantId, (ctx) => emitTenantMessage(ctx, { kind: "k", severity: "info", body }));
}

describe("listMessagesPage — engine-level pagination + ordering", () => {
  it("pages through more rows than one limit, concatenating to the same set a single big call returns", async () => {
    const { tenantId } = await signup("Page Co", "founder@pageco.test");
    for (let i = 0; i < 12; i++) {
      // eslint-disable-next-line no-await-in-loop
      await emit(tenantId, `m-${i}`);
    }

    const whole = await withTenantContext(tenantId, (ctx) => listMessagesPage(ctx, { limit: 12 }));
    expect(whole.messages).toHaveLength(12);
    expect(whole.nextCursor).toBeNull();

    const collected: MessageDTO[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 10; guard++) {
      // eslint-disable-next-line no-await-in-loop
      const page: MessageListPageDTO = await withTenantContext(tenantId, (ctx) => listMessagesPage(ctx, { limit: 5, cursor }));
      collected.push(...page.messages);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(collected.map((m) => m.body)).toEqual(whole.messages.map((m) => m.body));
    expect(collected.map((m) => m.body)[0]).toBe("m-11"); // newest first
  });

  it("a message inserted mid-pagination (sorting AHEAD of the issued cursor) never appears on the already-started page 2 (stability)", async () => {
    const { tenantId } = await signup("Stable Co", "founder@stableco.test");
    for (let i = 0; i < 5; i++) {
      // eslint-disable-next-line no-await-in-loop
      await emit(tenantId, `m-${i}`);
    }
    const page1 = await withTenantContext(tenantId, (ctx) => listMessagesPage(ctx, { limit: 3 }));
    expect(page1.messages.map((m) => m.body)).toEqual(["m-4", "m-3", "m-2"]);
    expect(page1.nextCursor).not.toBeNull();

    // A NEW unread message lands after page 1 was issued but before page 2 is fetched.
    await emit(tenantId, "m-new");

    const page2 = await withTenantContext(tenantId, (ctx) => listMessagesPage(ctx, { limit: 3, cursor: page1.nextCursor! }));
    // Still exactly the two remaining ORIGINAL rows — "m-new" (which would
    // sort ahead of the cursor boundary in a fresh listing) is excluded, and
    // nothing is skipped or duplicated.
    expect(page2.messages.map((m) => m.body)).toEqual(["m-1", "m-0"]);
    expect(page2.nextCursor).toBeNull();
  });

  it("unread rows sort ahead of read ones, and pagination correctly crosses that boundary", async () => {
    const { tenantId } = await signup("Boundary Co", "founder@boundaryco.test");
    await emit(tenantId, "m0");
    await emit(tenantId, "m1");
    await emit(tenantId, "m2");
    // Ack the MIDDLE one — it must now sort AFTER m0/m2 despite being newer than m0.
    const m1Id = await withTenantContext(tenantId, (ctx) =>
      ctx.sql.exec<{ id: string }>(`SELECT id FROM tenant_messages WHERE body = 'm1'`).one().id,
    );
    await withTenantContext(tenantId, (ctx) => ackMessage(ctx, m1Id));

    const page1 = await withTenantContext(tenantId, (ctx) => listMessagesPage(ctx, { limit: 2 }));
    expect(page1.messages.map((m) => m.body)).toEqual(["m2", "m0"]); // unread, newest-first
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await withTenantContext(tenantId, (ctx) => listMessagesPage(ctx, { limit: 2, cursor: page1.nextCursor! }));
    expect(page2.messages.map((m) => m.body)).toEqual(["m1"]); // read, arrives last
    expect(page2.nextCursor).toBeNull();
  });

  it("filters out expired rows, same as the capped preview", async () => {
    const { tenantId } = await signup("Page Expiry Co", "founder@pageexpiryco.test");
    const past = await withTenantContext(tenantId, (ctx) => ctx.clock.now() - 1000);
    await withTenantContext(tenantId, (ctx) => emitTenantMessage(ctx, { kind: "k", severity: "info", body: "expired", expiresAt: past }));
    await emit(tenantId, "live");
    const page = await withTenantContext(tenantId, (ctx) => listMessagesPage(ctx, { limit: 50 }));
    expect(page.messages.map((m) => m.body)).toEqual(["live"]);
  });
});

describe("ackMessage — engine-level idempotency + tenant isolation", () => {
  it("acks an unread message, setting read_at", async () => {
    const { tenantId } = await signup("Ack Co", "founder@ackco.test");
    await emit(tenantId, "hi");
    const id = await withTenantContext(tenantId, (ctx) => ctx.sql.exec<{ id: string }>(`SELECT id FROM tenant_messages`).one().id);

    const result = await withTenantContext(tenantId, (ctx) => ackMessage(ctx, id));
    expect(result).toEqual({ acked: true, alreadyAcked: false });

    const readAt = await withTenantContext(tenantId, (ctx) => ctx.sql.exec<{ read_at: number | null }>(`SELECT read_at FROM tenant_messages WHERE id = ?`, id).one().read_at);
    expect(readAt).not.toBeNull();
  });

  it("is IDEMPOTENT — a second ack is a no-op success, not a second write", async () => {
    const { tenantId } = await signup("Ack Idem Co", "founder@ackidemco.test");
    await emit(tenantId, "hi");
    const id = await withTenantContext(tenantId, (ctx) => ctx.sql.exec<{ id: string }>(`SELECT id FROM tenant_messages`).one().id);

    await withTenantContext(tenantId, (ctx) => ackMessage(ctx, id));
    const firstReadAt = await withTenantContext(tenantId, (ctx) => ctx.sql.exec<{ read_at: number }>(`SELECT read_at FROM tenant_messages WHERE id = ?`, id).one().read_at);

    // Advance the tenant's clock so a second WRITE (if one happened) would be detectable.
    await tenantStub(tenantId).advanceClock(1_000_000);

    const second = await withTenantContext(tenantId, (ctx) => ackMessage(ctx, id));
    expect(second).toEqual({ acked: true, alreadyAcked: true });

    const secondReadAt = await withTenantContext(tenantId, (ctx) => ctx.sql.exec<{ read_at: number }>(`SELECT read_at FROM tenant_messages WHERE id = ?`, id).one().read_at);
    expect(secondReadAt).toBe(firstReadAt); // UNCHANGED — proves no second write
  });

  it("throws NotFoundError for an unknown message id", async () => {
    const { tenantId } = await signup("Ack NotFound Co", "founder@acknotfoundco.test");
    await expect(withTenantContext(tenantId, (ctx) => ackMessage(ctx, "tmsg_does_not_exist"))).rejects.toThrow(/not found/);
  });

  it("CRITICAL — tenant A cannot ack tenant B's message: 404s and leaves it unread", async () => {
    const { tenantId: a } = await signup("Ack Iso A", "founder@ackisoa.test");
    const { tenantId: b } = await signup("Ack Iso B", "founder@ackisob.test");
    await emit(a, "a's message");
    const aMsgId = await withTenantContext(a, (ctx) => ctx.sql.exec<{ id: string }>(`SELECT id FROM tenant_messages WHERE tenant_id = ?`, a).one().id);

    await expect(withTenantContext(b, (ctx) => ackMessage(ctx, aMsgId))).rejects.toThrow(/not found/);

    const aReadAt = await withTenantContext(a, (ctx) => ctx.sql.exec<{ read_at: number | null }>(`SELECT read_at FROM tenant_messages WHERE id = ?`, aMsgId).one().read_at);
    expect(aReadAt).toBeNull(); // untouched by B's attempt
  });

  it("CRITICAL — tenant A's messages never appear in tenant B's listMessagesPage", async () => {
    const { tenantId: a } = await signup("List Iso A", "founder@listisoa.test");
    const { tenantId: b } = await signup("List Iso B", "founder@listisob.test");
    await emit(a, "a's message");
    await emit(b, "b's message");

    const bPage = await withTenantContext(b, (ctx) => listMessagesPage(ctx, { limit: 50 }));
    expect(bPage.messages.map((m) => m.body)).toEqual(["b's message"]);
  });

  // Every DO already holds exactly one tenant's storage (ARCHITECTURE.md #3),
  // so the two isolation tests above can never actually exercise the
  // `tenant_id = ?` WHERE clause itself — tenant B's storage never contains
  // tenant A's row regardless of that clause. These two tests inject a
  // FOREIGN-tenant_id row directly into ONE tenant's own storage (something a
  // real write path can never do — emitTenantMessage always writes
  // ctx.tenantId) to prove the SQL-level guard is real belt-and-suspenders
  // defense (CLAUDE.md rule h), not merely inherited from DO separation.
  it("CRITICAL (SQL-layer) — ackMessage never touches a foreign-tenant_id row even in ITS OWN storage", async () => {
    const { tenantId } = await signup("Ack SqlGuard Co", "founder@acksqlguardco.test");
    const foreignId = "tmsg_foreign_ack";
    await withTenantContext(tenantId, (ctx) => {
      ctx.sql.exec(
        `INSERT INTO tenant_messages (id, tenant_id, kind, severity, body, source, created_at, read_at) VALUES (?, 'some-other-tenant', 'k', 'info', 'not yours', 'system', ?, NULL)`,
        foreignId,
        ctx.clock.now(),
      );
    });
    await expect(withTenantContext(tenantId, (ctx) => ackMessage(ctx, foreignId))).rejects.toThrow(/not found/);
    const stillUnread = await withTenantContext(tenantId, (ctx) =>
      ctx.sql.exec<{ read_at: number | null }>(`SELECT read_at FROM tenant_messages WHERE id = ?`, foreignId).one().read_at,
    );
    expect(stillUnread).toBeNull();
  });

  it("CRITICAL (SQL-layer) — listMessagesPage never returns a foreign-tenant_id row even from ITS OWN storage", async () => {
    const { tenantId } = await signup("List SqlGuard Co", "founder@listsqlguardco.test");
    await emit(tenantId, "mine");
    await withTenantContext(tenantId, (ctx) => {
      ctx.sql.exec(
        `INSERT INTO tenant_messages (id, tenant_id, kind, severity, body, source, created_at, read_at) VALUES ('tmsg_foreign_list', 'some-other-tenant', 'k', 'info', 'not yours', 'system', ?, NULL)`,
        ctx.clock.now(),
      );
    });
    const page = await withTenantContext(tenantId, (ctx) => listMessagesPage(ctx, { limit: 50 }));
    expect(page.messages.map((m) => m.body)).toEqual(["mine"]);
  });
});

describe("GET /messages + POST /messages/:id/ack — REST parity", () => {
  it("lists this tenant's messages, cursor-paginated, and acks one by id", async () => {
    const { tenantId, token } = await signup("Rest Msg Co", "founder@restmsgco.test");
    await emit(tenantId, "first");
    await emit(tenantId, "second");

    const page1 = await api<MessageListPageDTO>("/messages?limit=1", { token });
    expect(page1.status).toBe(200);
    expect(page1.body.messages.map((m) => m.body)).toEqual(["second"]);
    expect(page1.body.nextCursor).not.toBeNull();

    const page2 = await api<MessageListPageDTO>(`/messages?limit=1&cursor=${encodeURIComponent(page1.body.nextCursor!)}`, { token });
    expect(page2.body.messages.map((m) => m.body)).toEqual(["first"]);

    const toAck = page2.body.messages[0]!.id;
    const ack = await api<{ acked: boolean; alreadyAcked: boolean }>(`/messages/${toAck}/ack`, { method: "POST", token });
    expect(ack.status).toBe(200);
    expect(ack.body).toEqual({ acked: true, alreadyAcked: false });

    const reAck = await api<{ acked: boolean; alreadyAcked: boolean }>(`/messages/${toAck}/ack`, { method: "POST", token });
    expect(reAck.status).toBe(200);
    expect(reAck.body).toEqual({ acked: true, alreadyAcked: true });
  });

  it("404s acking an unknown message id", async () => {
    const { token } = await signup("Rest Msg NotFound Co", "founder@restmsgnotfoundco.test");
    const res = await api("/messages/tmsg_does_not_exist/ack", { method: "POST", token });
    expect(res.status).toBe(404);
  });

  it("CRITICAL — tenant isolation holds over the real HTTP transport: two different bearer tokens never cross", async () => {
    const a = await signup("Rest Iso A", "founder@restisoa.test");
    const b = await signup("Rest Iso B", "founder@restisob.test");
    await emit(a.tenantId, "a's message");

    const bList = await api<MessageListPageDTO>("/messages", { token: b.token });
    expect(bList.body.messages).toEqual([]);

    const aList = await api<MessageListPageDTO>("/messages", { token: a.token });
    const aMsgId = aList.body.messages[0]!.id;
    const bAckAttempt = await api(`/messages/${aMsgId}/ack`, { method: "POST", token: b.token });
    expect(bAckAttempt.status).toBe(404); // B can't even discover A's message exists
  });
});

describe("MCP list_messages / ack_message — end-to-end through /mcp", () => {
  it("lists and acks via the tool surface, tenant-isolated across two tokens", async () => {
    const a = await signup("MCP Msg A", "founder@mcpmsga.test");
    const b = await signup("MCP Msg B", "founder@mcpmsgb.test");
    await emit(a.tenantId, "a's mcp message");

    const bList = await callTool<MessageListPageDTO>(b.token, "list_messages", {});
    expect(bList.messages).toEqual([]);

    const aList = await callTool<MessageListPageDTO>(a.token, "list_messages", {});
    expect(aList.messages).toHaveLength(1);
    const msgId = aList.messages[0]!.id;

    // B cannot ack A's message via the tool surface either.
    const bAckAttempt = await callToolExpectError<{ error: string }>(b.token, "ack_message", { messageId: msgId });
    expect(bAckAttempt.error).toContain("not found");

    const acked = await callTool<{ acked: boolean; alreadyAcked: boolean }>(a.token, "ack_message", { messageId: msgId });
    expect(acked).toEqual({ acked: true, alreadyAcked: false });

    const reAcked = await callTool<{ acked: boolean; alreadyAcked: boolean }>(a.token, "ack_message", { messageId: msgId });
    expect(reAcked).toEqual({ acked: true, alreadyAcked: true });
  });
});
