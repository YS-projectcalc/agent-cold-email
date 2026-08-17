// Closure gate for docs/adversarial/agent-channel-product-audit-2026-08-17.md
// — the operator<->agent channel's surfacing and ack semantics (F9, F7, A4).
import { runInDurableObject } from "cloudflare:test";
import { ListMessagesQueryInput } from "@coldstart/shared";
import { describe, expect, it } from "vitest";
import { emitOperatorMessage, emitTenantMessage, listMessagesPage, listSurfacedTenantMessages } from "../src/engine/tenant-messages.js";
import { admitContactOperatorCall } from "../src/engine/contact-operator-guard.js";
import { activatePaidPlan, mintTenant, tenantStub, withTenantContext } from "./helpers.js";

describe("F9 — a refreshed system message must not push an operator reply out of infrastructure_status's newest-5", () => {
  it("6 domains each re-triggering retry_setup after the operator reply", async () => {
    const { tenantId } = await mintTenant("Displace Co", "managed");
    await activatePaidPlan(tenantId, "managed");

    await withTenantContext(tenantId, (ctx) => {
      // 1. The operator replies FIRST (the real sequence: we replied 2026-08-14).
      emitOperatorMessage(ctx, {
        kind: "operator_note",
        severity: "action_required",
        body: "OPERATOR: retry the same idempotency key, it is spend-safe.",
      });
      return undefined;
    });

    // 2. Six later setup retries each re-emit/refresh a per-domain retry_setup
    //    (dedupKey = domain), each stamping created_at = now.
    for (let i = 0; i < 6; i++) {
      await withTenantContext(tenantId, (ctx) => {
        emitTenantMessage(ctx, {
          kind: "retry_setup",
          severity: "action_required",
          body: `Setup for d${i}.com has not finished yet.`,
          actionHint: { tool: "setup_infrastructure", idempotencyKey: "k" },
          dedupKey: `d${i}.com`,
        });
        return undefined;
      });
      await new Promise((r) => setTimeout(r, 3));
    }

    const inline = await withTenantContext(tenantId, (ctx) => listSurfacedTenantMessages(ctx));
    const full = await withTenantContext(tenantId, (ctx) => listMessagesPage(ctx, { limit: 50 }));

    // The infrastructure_status tool description says: "poll this alongside the
    // mailbox fields so you never miss one."
    expect(inline.some((m) => m.source === "operator")).toBe(true);
    // The unread operator message sorts FIRST, ahead of the newer system churn.
    expect(inline[0]!.source).toBe("operator");
    // The full surface still carries everything, newest-first within each group.
    expect(full.messages.length).toBe(7);
  }, 60_000);

  it("operator-first ordering does not disturb the newest-first order among system messages", async () => {
    const { tenantId } = await mintTenant("Order Co", "managed");
    await activatePaidPlan(tenantId, "managed");
    for (const kind of ["first", "second", "third"]) {
      await withTenantContext(tenantId, (ctx) => {
        emitTenantMessage(ctx, { kind, severity: "info", body: kind });
        return undefined;
      });
      await new Promise((r) => setTimeout(r, 3));
    }
    const inline = await withTenantContext(tenantId, (ctx) => listSurfacedTenantMessages(ctx));
    expect(inline.map((m) => m.kind)).toEqual(["third", "second", "first"]);
  }, 60_000);
});

// SCOPE NOTE — this is the audit's fix-list item 9 (F7), which the
// channel-truth wave brief did NOT include: shortening the dedup window is a
// storm-guard POLICY change (contact-operator-guard.ts also carries the
// 5-per-hour cap and the ops-email throttle), not a truthfulness fix, so it is
// the orchestrator's call rather than this wave's. The assertion is preserved
// verbatim as the closure gate for whoever takes item 9.
describe.skip("F7 — contact_operator dedup: two DISTINCT follow-ups must not collapse into one ticket", () => {
  it("same short text sent twice an hour apart-ish (within the 1h window)", async () => {
    const { tenantId } = await mintTenant("Dedupe Co", "managed");
    await activatePaidPlan(tenantId, "managed");
    const now = Date.now();
    const results = await withTenantContext(tenantId, (ctx) => {
      const a = admitContactOperatorCall(ctx, { body: "Any update?", urgency: "normal" }, now);
      // 50 minutes later — a genuine follow-up, same words.
      const b = admitContactOperatorCall(ctx, { body: "Any update?", urgency: "normal" }, now + 50 * 60_000);
      return [a, b];
    });
    expect(results[1]!.kind).not.toBe("duplicate");
  }, 60_000);
});

describe("A4 — ack is idempotent and tenant-scoped", () => {
  it("acking sets read_at once; a second ack is a no-op success", async () => {
    const { tenantId } = await mintTenant("Ack Co", "managed");
    await activatePaidPlan(tenantId, "managed");
    await withTenantContext(tenantId, (ctx) => {
      emitOperatorMessage(ctx, { kind: "operator_note", severity: "info", body: "hello" });
      return undefined;
    });
    const stub = tenantStub(tenantId);
    // Driven through the DO's own RPC methods (mcp-tool-annotations.test.ts's
    // idiom) rather than the stub proxy: `MessageListPage.actionHint` is
    // `Record<string, unknown>`, which the stub's Rpc.Serializable return
    // constraint cannot type, so `stub.listMessages(...)` resolves to `never`.
    const { first, second, row } = await runInDurableObject(stub, async (instance, s) => {
      const page = instance.listMessages(ListMessagesQueryInput.parse({ limit: 10 }));
      const id = page.messages[0]!.id;
      return {
        first: await instance.ackMessage(id),
        second: await instance.ackMessage(id),
        row: s.storage.sql
          .exec<{ read_at: number | null }>(`SELECT read_at FROM tenant_messages WHERE tenant_id = ?`, tenantId)
          .toArray(),
      };
    });
    expect(first.alreadyAcked).toBe(false);
    expect(second.alreadyAcked).toBe(true);
    expect(row[0]!.read_at).not.toBeNull();
  }, 60_000);
});
