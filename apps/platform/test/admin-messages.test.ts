import { describe, expect, it } from "vitest";
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

  describe("lifecycle gating (msgchannel Inc1 gate F2's assertNotLifecycleFrozen, reused)", () => {
    it("REJECTS an operator message to a CANCELED tenant, and writes nothing", async () => {
      const { tenantId, token } = await mintTenant("Msg Op Canceled Co", "managed");
      const cancel = await api("/cancel", { method: "POST", token, body: JSON.stringify({ immediate: true }) });
      expect(cancel.status).toBe(200);

      const res = await adminApi(`/admin/tenants/${tenantId}/messages`, {
        method: "POST",
        body: JSON.stringify({ kind: "operator_notice", body: "hi" }),
      });
      expect(res.status).toBe(400);
      expect(await rowCount(tenantId)).toBe(0);
    });

    it("REJECTS an operator message to a SUSPENDED (terminated) tenant, and writes nothing", async () => {
      const { tenantId } = await mintTenant("Msg Op Suspended Co", "managed");
      const term = await adminApi(`/admin/tenants/${tenantId}/terminate`, {
        method: "POST",
        body: JSON.stringify({ reason: "test" }),
      });
      expect(term.status).toBe(200);

      const res = await adminApi(`/admin/tenants/${tenantId}/messages`, {
        method: "POST",
        body: JSON.stringify({ kind: "operator_notice", body: "hi" }),
      });
      expect(res.status).toBe(400);
      expect(await rowCount(tenantId)).toBe(0);
    });

    it("still ACCEPTS an operator message to a live (non-frozen) tenant after an unrelated tenant was frozen (no cross-tenant bleed)", async () => {
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
  });
});
