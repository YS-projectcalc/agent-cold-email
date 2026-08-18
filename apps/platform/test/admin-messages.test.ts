import { describe, expect, it } from "vitest";
import { isLifecycleFrozen } from "../src/engine/billing-state.js";
import { emitTenantMessage } from "../src/engine/tenant-messages.js";
import { adminApi, api, mintTenant, withTenantContext } from "./helpers.js";

// msgchannel increment 2 — the operator route (POST
// /admin/tenants/:id/messages, routes/admin-messages.ts). Writes a
// source='operator' row into the SAME tenant_messages store increment 1's
// emitTenantMessage writes into (engine/tenant-messages.ts).

interface OperatorMessageResponse {
  tenantId: string;
  emitted: boolean;
}

function rowCount(tenantId: string) {
  return withTenantContext(tenantId, (ctx) =>
    ctx.sql.exec<{ n: number }>(`SELECT COUNT(*) as n FROM tenant_messages WHERE tenant_id = ?`, tenantId).one().n,
  );
}

describe("POST /admin/tenants/:id/messages — msgchannel increment 2 operator route", () => {
  describe("auth", () => {
    it("401s with no Authorization header", async () => {
      const { tenantId } = await mintTenant("Msg Op NoAuth Co", "managed");
      const res = await api(`/admin/tenants/${tenantId}/messages`, {
        method: "POST",
        body: JSON.stringify({ kind: "operator_notice", body: "hi" }),
      });
      expect(res.status).toBe(401);
    });

    it("401s with a wrong admin token", async () => {
      const { tenantId } = await mintTenant("Msg Op WrongAuth Co", "managed");
      const res = await adminApi(`/admin/tenants/${tenantId}/messages`, {
        method: "POST",
        adminToken: "not-the-admin-token",
        body: JSON.stringify({ kind: "operator_notice", body: "hi" }),
      });
      expect(res.status).toBe(401);
    });

    it("401s a tenant's OWN bearer token — this is an admin-only surface", async () => {
      const { tenantId, token } = await mintTenant("Msg Op TenantAuth Co", "managed");
      const res = await api(`/admin/tenants/${tenantId}/messages`, {
        method: "POST",
        token,
        body: JSON.stringify({ kind: "operator_notice", body: "hi" }),
      });
      expect(res.status).toBe(401);
      expect(await rowCount(tenantId)).toBe(0);
    });
  });

  it("404s an unknown tenant id before writing anything", async () => {
    const res = await adminApi("/admin/tenants/does-not-exist/messages", {
      method: "POST",
      body: JSON.stringify({ kind: "operator_notice", body: "hi" }),
    });
    expect(res.status).toBe(404);
  });

  describe("validation — enumerated kind + bounded body", () => {
    it("rejects an unenumerated kind", async () => {
      const { tenantId } = await mintTenant("Msg Op BadKind Co", "managed");
      const res = await adminApi(`/admin/tenants/${tenantId}/messages`, {
        method: "POST",
        body: JSON.stringify({ kind: "not_a_real_kind", body: "hi" }),
      });
      expect(res.status).toBe(400);
      expect(await rowCount(tenantId)).toBe(0);
    });

    it("rejects an empty body", async () => {
      const { tenantId } = await mintTenant("Msg Op EmptyBody Co", "managed");
      const res = await adminApi(`/admin/tenants/${tenantId}/messages`, {
        method: "POST",
        body: JSON.stringify({ kind: "operator_notice", body: "" }),
      });
      expect(res.status).toBe(400);
    });

    it("rejects a body over the 2000-char bound", async () => {
      const { tenantId } = await mintTenant("Msg Op LongBody Co", "managed");
      const res = await adminApi(`/admin/tenants/${tenantId}/messages`, {
        method: "POST",
        body: JSON.stringify({ kind: "operator_notice", body: "x".repeat(2001) }),
      });
      expect(res.status).toBe(400);
      expect(await rowCount(tenantId)).toBe(0);
    });

    it("accepts a body AT the 2000-char bound", async () => {
      const { tenantId } = await mintTenant("Msg Op MaxBody Co", "managed");
      const res = await adminApi<OperatorMessageResponse>(`/admin/tenants/${tenantId}/messages`, {
        method: "POST",
        body: JSON.stringify({ kind: "operator_notice", body: "x".repeat(2000) }),
      });
      expect(res.status).toBe(201);
    });
  });

  it("writes a source='operator' row on a live tenant, defaulting severity to 'info'", async () => {
    const { tenantId } = await mintTenant("Msg Op Happy Co", "managed");
    const res = await adminApi<OperatorMessageResponse>(`/admin/tenants/${tenantId}/messages`, {
      method: "POST",
      body: JSON.stringify({ kind: "operator_notice", body: "We fixed the DNS issue on your account." }),
    });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ tenantId, emitted: true });

    const row = await withTenantContext(tenantId, (ctx) =>
      ctx.sql
        .exec<{ kind: string; severity: string; body: string; source: string; read_at: number | null }>(
          `SELECT kind, severity, body, source, read_at FROM tenant_messages WHERE tenant_id = ?`,
          tenantId,
        )
        .one(),
    );
    expect(row).toEqual({
      kind: "operator_notice",
      severity: "info",
      body: "We fixed the DNS issue on your account.",
      source: "operator",
      read_at: null,
    });
  });

  it("honors an explicit severity of 'action_required'", async () => {
    const { tenantId } = await mintTenant("Msg Op Severity Co", "managed");
    await adminApi(`/admin/tenants/${tenantId}/messages`, {
      method: "POST",
      body: JSON.stringify({ kind: "operator_notice", severity: "action_required", body: "Please re-verify your domain." }),
    });
    const row = await withTenantContext(tenantId, (ctx) =>
      ctx.sql.exec<{ severity: string }>(`SELECT severity FROM tenant_messages WHERE tenant_id = ?`, tenantId).one(),
    );
    expect(row.severity).toBe("action_required");
  });

  it("surfaces the operator message through GET /infrastructure-status alongside system ones", async () => {
    const { tenantId, token } = await mintTenant("Msg Op Surface Co", "managed");
    await adminApi(`/admin/tenants/${tenantId}/messages`, {
      method: "POST",
      body: JSON.stringify({ kind: "operator_notice", body: "Heads up from the team." }),
    });
    const status = await api<{ messages: { kind: string; source: string; body: string }[] }>("/infrastructure-status", { token });
    expect(status.status).toBe(200);
    expect(status.body.messages).toHaveLength(1);
    expect(status.body.messages[0]).toMatchObject({ kind: "operator_notice", source: "operator", body: "Heads up from the team." });
  });

  // Gate fix (msgchannel-inc23-gate-2026-08-06 F2, orchestrator ruling): the
  // operator route is DELIBERATELY NOT lifecycle-gated — a human operator
  // reaching a tenant in a trouble state ("your card failed, update it at
  // <link>") is the channel's canonical use case (ROADMAP.md's msgchannel
  // entry: "incident notices"), not a case to block. Only SYSTEM-templated
  // wires (whose body asserts something a freeze would falsify) still gate —
  // pinned here via the shared primitive, and independently by
  // credential-ready-message.test.ts's own F2 tests for wire B.
  describe("lifecycle STATE has no effect on the operator route (gate fix F2)", () => {
    it("DELIVERS an operator message to a CANCELED (immediate) tenant", async () => {
      const { tenantId, token } = await mintTenant("Msg Op Canceled Co", "managed");
      const cancel = await api("/cancel", { method: "POST", token, body: JSON.stringify({ immediate: true }) });
      expect(cancel.status).toBe(200);

      const res = await adminApi<OperatorMessageResponse>(`/admin/tenants/${tenantId}/messages`, {
        method: "POST",
        body: JSON.stringify({ kind: "operator_notice", body: "hi" }),
      });
      expect(res.status).toBe(201);
      expect(res.body).toEqual({ tenantId, emitted: true });
      expect(await rowCount(tenantId)).toBe(1);
    });

    // The gate's PROBE D1 scenario: an end-of-period cancel leaves
    // status='active', billing_state='canceling' — still frozen by
    // isLifecycleFrozen, and a state this exact channel needs to reach
    // ("your cancellation is scheduled for X").
    it("DELIVERS an operator message to a CANCELING (end-of-period cancel) tenant", async () => {
      const { tenantId, token } = await mintTenant("Msg Op Canceling Co", "managed");
      const cancel = await api("/cancel", { method: "POST", token, body: JSON.stringify({ immediate: false }) });
      expect(cancel.status).toBe(200);
      expect(cancel.body).toMatchObject({ billingState: "canceling" });

      const res = await adminApi<OperatorMessageResponse>(`/admin/tenants/${tenantId}/messages`, {
        method: "POST",
        body: JSON.stringify({ kind: "operator_notice", body: "your cancellation is scheduled for period end" }),
      });
      expect(res.status).toBe(201);
      expect(await rowCount(tenantId)).toBe(1);
    });

    // The single highest-value real message this channel exists to carry
    // (gate F2): "your card failed, update it to resume sending" to the
    // exact dunning-suspended tenant it's for.
    it("DELIVERS an operator message to a SUSPENDED (dunning/terminated) tenant", async () => {
      const { tenantId } = await mintTenant("Msg Op Suspended Co", "managed");
      const term = await adminApi(`/admin/tenants/${tenantId}/terminate`, {
        method: "POST",
        body: JSON.stringify({ reason: "test" }),
      });
      expect(term.status).toBe(200);

      const res = await adminApi<OperatorMessageResponse>(`/admin/tenants/${tenantId}/messages`, {
        method: "POST",
        body: JSON.stringify({ kind: "operator_notice", body: "your card failed, update it at <link> to resume sending" }),
      });
      expect(res.status).toBe(201);
      expect(await rowCount(tenantId)).toBe(1);
    });

    it("a live (non-frozen) tenant is unaffected by an unrelated frozen sibling (no cross-tenant bleed either direction)", async () => {
      const frozen = await mintTenant("Msg Op Frozen Sibling Co", "managed");
      await api("/cancel", { method: "POST", token: frozen.token, body: JSON.stringify({ immediate: true }) });

      const live = await mintTenant("Msg Op Live Sibling Co", "managed");
      const res = await adminApi(`/admin/tenants/${live.tenantId}/messages`, {
        method: "POST",
        body: JSON.stringify({ kind: "operator_notice", body: "hi" }),
      });
      expect(res.status).toBe(201);
      expect(await rowCount(live.tenantId)).toBe(1);
    });

    // Regression pin for the shared primitive itself: the fix removed the
    // GATE from the operator path, not the PREDICATE. If a future edit
    // accidentally weakened isLifecycleFrozen (rather than just not calling
    // it here), wire A (provisioning.ts's assertNotLifecycleFrozen) and wire
    // B (mailbox-credential-push.ts's isLifecycleFrozen check) would both
    // silently stop gating too — this pins that the predicate itself still
    // reports every frozen state as frozen.
    it("the shared isLifecycleFrozen predicate (still used by wires A/B) is untouched", () => {
      expect(isLifecycleFrozen("active", "canceling")).toBe(true);
      expect(isLifecycleFrozen("active", "canceled")).toBe(true);
      expect(isLifecycleFrozen("active", "disputed")).toBe(true);
      expect(isLifecycleFrozen("suspended", "active")).toBe(true);
      expect(isLifecycleFrozen("active", "active")).toBe(false);
    });
  });
});

// The read twin — GET /admin/tenants/:id/messages. Same auth/404 pattern as
// the POST route above, reading the SAME tenant_messages store both
// increment 1 (emitTenantMessage) and increment 2 (emitOperatorMessage,
// exercised above via the POST route) write into.

interface OperatorMessageForOperatorDTO {
  id: string;
  kind: string;
  severity: string;
  body: string;
  actionHint: Record<string, unknown> | null;
  source: "system" | "operator";
  createdAt: number;
  readAt: number | null;
  expiresAt: number | null;
}

interface OperatorMessageListResponse {
  tenantId: string;
  messages: OperatorMessageForOperatorDTO[];
  total: number;
}

describe("GET /admin/tenants/:id/messages — the read twin of the operator route", () => {
  describe("auth", () => {
    it("401s with no Authorization header", async () => {
      const { tenantId } = await mintTenant("Msg Read NoAuth Co", "managed");
      const res = await api(`/admin/tenants/${tenantId}/messages`);
      expect(res.status).toBe(401);
    });

    it("401s with a wrong admin token", async () => {
      const { tenantId } = await mintTenant("Msg Read WrongAuth Co", "managed");
      const res = await adminApi(`/admin/tenants/${tenantId}/messages`, { adminToken: "not-the-admin-token" });
      expect(res.status).toBe(401);
    });

    it("401s a tenant's OWN bearer token — this is an admin-only surface", async () => {
      const { tenantId, token } = await mintTenant("Msg Read TenantAuth Co", "managed");
      const res = await api(`/admin/tenants/${tenantId}/messages`, { token });
      expect(res.status).toBe(401);
    });
  });

  it("404s an unknown tenant id", async () => {
    const res = await adminApi("/admin/tenants/does-not-exist/messages");
    expect(res.status).toBe(404);
  });

  it("round-trips a system-emitted and an operator-emitted message, newest-first, with the full field shape", async () => {
    const { tenantId } = await mintTenant("Msg Read Roundtrip Co", "managed");
    await withTenantContext(tenantId, (ctx) =>
      emitTenantMessage(ctx, { kind: "retry_setup", severity: "action_required", body: "system says hi" }),
    );
    const post = await adminApi(`/admin/tenants/${tenantId}/messages`, {
      method: "POST",
      body: JSON.stringify({ kind: "operator_notice", body: "operator says hi" }),
    });
    expect(post.status).toBe(201);

    const res = await adminApi<OperatorMessageListResponse>(`/admin/tenants/${tenantId}/messages`);
    expect(res.status).toBe(200);
    expect(res.body.tenantId).toBe(tenantId);
    expect(res.body.total).toBe(2);
    expect(res.body.messages).toHaveLength(2);

    // Newest first: the operator message was emitted second.
    const [newest, oldest] = res.body.messages;
    expect(newest).toMatchObject({
      kind: "operator_notice",
      severity: "info",
      body: "operator says hi",
      source: "operator",
      readAt: null,
      expiresAt: null,
    });
    expect(typeof newest!.id).toBe("string");
    expect(typeof newest!.createdAt).toBe("number");
    expect(oldest).toMatchObject({
      kind: "retry_setup",
      severity: "action_required",
      body: "system says hi",
      source: "system",
      readAt: null,
      expiresAt: null,
    });
  });

  it("an acked message shows a non-null readAt in the GET (ack via the existing agent-facing ack path)", async () => {
    const { tenantId, token } = await mintTenant("Msg Read Ack Co", "managed");
    await withTenantContext(tenantId, (ctx) => emitTenantMessage(ctx, { kind: "k", severity: "info", body: "ack me" }));

    const before = await adminApi<OperatorMessageListResponse>(`/admin/tenants/${tenantId}/messages`);
    const id = before.body.messages[0]!.id;
    expect(before.body.messages[0]!.readAt).toBeNull();

    const ack = await api(`/messages/${id}/ack`, { method: "POST", token });
    expect(ack.status).toBe(200);

    const after = await adminApi<OperatorMessageListResponse>(`/admin/tenants/${tenantId}/messages`);
    expect(after.body.messages[0]!.id).toBe(id);
    expect(after.body.messages[0]!.readAt).not.toBeNull();
    expect(typeof after.body.messages[0]!.readAt).toBe("number");
  });

  it("?unreadOnly=1 excludes acked messages (both from the list and from total)", async () => {
    const { tenantId, token } = await mintTenant("Msg Read Unread Co", "managed");
    await withTenantContext(tenantId, (ctx) => emitTenantMessage(ctx, { kind: "k", severity: "info", body: "one" }));
    await withTenantContext(tenantId, (ctx) => emitTenantMessage(ctx, { kind: "k", severity: "info", body: "two" }));

    const all = await adminApi<OperatorMessageListResponse>(`/admin/tenants/${tenantId}/messages`);
    expect(all.body.total).toBe(2);
    const toAck = all.body.messages.find((m) => m.body === "one")!.id;
    const ack = await api(`/messages/${toAck}/ack`, { method: "POST", token });
    expect(ack.status).toBe(200);

    const unreadOnly = await adminApi<OperatorMessageListResponse>(`/admin/tenants/${tenantId}/messages?unreadOnly=1`);
    expect(unreadOnly.body.messages).toHaveLength(1);
    expect(unreadOnly.body.messages[0]!.body).toBe("two");
    expect(unreadOnly.body.total).toBe(1);

    // Without the filter, both are still there (the ack didn't delete anything).
    const everything = await adminApi<OperatorMessageListResponse>(`/admin/tenants/${tenantId}/messages`);
    expect(everything.body.messages).toHaveLength(2);
    expect(everything.body.total).toBe(2);
  });

  it("tenant isolation — tenant A's messages never appear under tenant B's id", async () => {
    const a = await mintTenant("Msg Read Iso A Co", "managed");
    const b = await mintTenant("Msg Read Iso B Co", "managed");
    await withTenantContext(a.tenantId, (ctx) => emitTenantMessage(ctx, { kind: "k", severity: "info", body: "for A" }));

    const resA = await adminApi<OperatorMessageListResponse>(`/admin/tenants/${a.tenantId}/messages`);
    expect(resA.body.messages.map((m) => m.body)).toEqual(["for A"]);

    const resB = await adminApi<OperatorMessageListResponse>(`/admin/tenants/${b.tenantId}/messages`);
    expect(resB.body.messages).toEqual([]);
    expect(resB.body.total).toBe(0);
  });

  it("?limit= bounds the page but `total` still reports the un-truncated count", async () => {
    const { tenantId } = await mintTenant("Msg Read Limit Co", "managed");
    for (let i = 0; i < 5; i++) {
      // eslint-disable-next-line no-await-in-loop
      await withTenantContext(tenantId, (ctx) => emitTenantMessage(ctx, { kind: "k", severity: "info", body: `m-${i}` }));
    }
    const res = await adminApi<OperatorMessageListResponse>(`/admin/tenants/${tenantId}/messages?limit=2`);
    expect(res.body.messages).toHaveLength(2);
    expect(res.body.total).toBe(5);
    expect(res.body.messages[0]!.body).toBe("m-4"); // newest first
  });

  // Mirrors the POST route's own gate-F2 tests above — this channel's
  // canonical use case is reaching a tenant IN a trouble state, so the
  // operator reading what was already sent to one must work identically.
  describe("lifecycle STATE has no effect on the GET route (mirrors the POST's gate-F2)", () => {
    it("reads a CANCELED (immediate) tenant's messages", async () => {
      const { tenantId, token } = await mintTenant("Msg Read Canceled Co", "managed");
      await withTenantContext(tenantId, (ctx) => emitTenantMessage(ctx, { kind: "k", severity: "info", body: "hi" }));
      const cancel = await api("/cancel", { method: "POST", token, body: JSON.stringify({ immediate: true }) });
      expect(cancel.status).toBe(200);

      const res = await adminApi<OperatorMessageListResponse>(`/admin/tenants/${tenantId}/messages`);
      expect(res.status).toBe(200);
      expect(res.body.messages).toHaveLength(1);
    });

    it("reads a SUSPENDED (dunning/terminated) tenant's messages", async () => {
      const { tenantId } = await mintTenant("Msg Read Suspended Co", "managed");
      await withTenantContext(tenantId, (ctx) => emitTenantMessage(ctx, { kind: "k", severity: "info", body: "hi" }));
      const term = await adminApi(`/admin/tenants/${tenantId}/terminate`, {
        method: "POST",
        body: JSON.stringify({ reason: "test" }),
      });
      expect(term.status).toBe(200);

      const res = await adminApi<OperatorMessageListResponse>(`/admin/tenants/${tenantId}/messages`);
      expect(res.status).toBe(200);
      expect(res.body.messages).toHaveLength(1);
    });
  });
});
