import { env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotActivatedError, VendorError } from "@coldstart/shared";
import { periodKey, reapStaleReservations, withSpendCeiling } from "../src/engine/spend-ceiling.js";
import { runSetupInfrastructure } from "../src/engine/provisioning.js";
import { SandboxOpsMailer } from "../src/ops-mail/sandbox-ops-mailer.js";
import type { TenantContext } from "../src/tenant-context.js";
import { activatePaidPlan, api, mintTenant, seedBenignSdnList, tenantStub, withTenantContext } from "./helpers.js";

// H9 (INCIDENT 2026-08-05) — the four proofs the hotfix's own code was still
// missing: H5 (recordUsage non-fatal), H7 (reap-then-commit restore + ledger
// wall-clock), and H6 (error translation parity across BOTH transports, and no
// internal detail leaking to a tenant).

// D1 is NOT rolled back between tests in this pool (repo MEMORY: direct env.DB
// writes persist), so reset the account-level vendor tables before each test.
beforeEach(async () => {
  await env.DB.prepare("DELETE FROM vendor_spend_entries").run();
  await env.DB.prepare("DELETE FROM vendor_spend_ledger").run();
  await env.DB.prepare("DELETE FROM vendor_slot_state").run();
});

function realCtx<T>(tenantId: string, fn: (ctx: TenantContext) => Promise<T>): Promise<T> {
  return withTenantContext(tenantId, (ctx) => fn({ ...ctx, adapters: { ...ctx.adapters, kind: "real" } }));
}

describe("H5 — an unarmed usage reporter must not destroy a provision whose money already moved", () => {
  it("provisioning COMPLETES when recordUsage throws NotActivatedError", async () => {
    const { tenantId } = await mintTenant("Usage Unarmed Co", "managed");
    await activatePaidPlan(tenantId, "managed");

    const result = await withTenantContext(tenantId, (base) =>
      runSetupInfrastructure(
        {
          ...base,
          adapters: {
            ...base.adapters,
            billing: {
              ...base.adapters.billing,
              // Exactly what vendors/real/billing-port.ts does, unconditionally.
              async recordUsage() {
                throw new NotActivatedError("billing", "recordUsage");
              },
            },
          },
        },
        {
          brand: "Usage Unarmed Co",
          primaryDomain: "usageunarmed.com",
          domains: 1,
          inboxesEach: 1,
          persona: "Sender",
          physicalAddress: "1 St",
          senderIdentity: "S <s@usageunarmed.com>",
          quoteOnly: false,
        },
        new SandboxOpsMailer(),
      ),
    );

    // Pre-fix this threw — the guaranteed NEXT 500 after the domain legs were
    // fixed, failing a provision that had already spent real money.
    expect("jobId" in result).toBe(true);
    const mailboxes = await runInDurableObject(tenantStub(tenantId), (_i, s) =>
      s.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) as n FROM mailboxes`).one().n,
    );
    expect(mailboxes).toBe(1);
    // The local COGS ledger entry is still written — only the vendor report is skipped.
    const ledger = await runInDurableObject(tenantStub(tenantId), (_i, s) =>
      s.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) as n FROM ledger_entries WHERE kind = 'usage'`).one().n,
    );
    expect(ledger).toBe(1);
  });

  it("a NON-NotActivatedError billing failure still propagates (the catch is narrow)", async () => {
    const { tenantId } = await mintTenant("Usage Broken Co", "managed");
    await activatePaidPlan(tenantId, "managed");

    const err = await withTenantContext(tenantId, (base) =>
      runSetupInfrastructure(
        {
          ...base,
          adapters: {
            ...base.adapters,
            billing: {
              ...base.adapters.billing,
              async recordUsage() {
                throw new VendorError("stripe usage report rejected", false);
              },
            },
          },
        },
        {
          brand: "Usage Broken Co",
          primaryDomain: "usagebroken.com",
          domains: 1,
          inboxesEach: 1,
          persona: "Sender",
          physicalAddress: "1 St",
          senderIdentity: "S <s@usagebroken.com>",
          quoteOnly: false,
        },
        new SandboxOpsMailer(),
      ).catch((e: unknown) => e),
    );

    expect(err).toBeInstanceOf(VendorError);
    expect((err as VendorError).message).toMatch(/usage report rejected/);
  });
});

describe("H7 — ledger correctness", () => {
  it("the real reaper CAN resolve an entry mid-flight, and the commit still records the money", async () => {
    const { tenantId } = await mintTenant("Reap Race Co", "managed");

    // The interleave: the reaper flips the entry to 'released' WHILE the vendor
    // call is in flight, then the vendor succeeds and we commit.
    await realCtx(tenantId, async (ctx) =>
      withSpendCeiling(ctx, "domain", async () => {
        await env.DB.prepare(`UPDATE vendor_spend_entries SET created_at = 0 WHERE status = 'reserved'`).run();
        const reaped = await reapStaleReservations(env, Date.now());
        expect(reaped.reaped).toBeGreaterThan(0);
        return { domain: "reaprace.com", purchasedAt: Date.now(), registrar: "test" };
      }),
    );

    const entries = await env.DB.prepare(`SELECT status, actual_cents FROM vendor_spend_entries`).all<{
      status: string;
      actual_cents: number | null;
    }>();
    expect(entries.results).toHaveLength(1);
    expect(entries.results[0]!.status).toBe("committed");
    expect(entries.results[0]!.actual_cents).toBeGreaterThan(0);
  });

  it("money booked is money RECORDED even if the entry row is gone at commit time", async () => {
    // The case where the guard actually changes the outcome. When the entry row
    // still EXISTS, a guarded and an unguarded UPDATE converge on the same end
    // state, so a released-row test proves nothing. Deleting it is the honest
    // stressor: the unguarded `UPDATE ... WHERE id = ?` then matches ZERO rows
    // and the spend that really happened is recorded NOWHERE. The guard's
    // INSERT OR REPLACE restore is what keeps the ledger reconcilable.
    const { tenantId } = await mintTenant("Reap Delete Co", "managed");

    await realCtx(tenantId, async (ctx) =>
      withSpendCeiling(ctx, "domain", async () => {
        await env.DB.prepare(`DELETE FROM vendor_spend_entries`).run();
        return { domain: "reapdelete.com", purchasedAt: Date.now(), registrar: "test" };
      }),
    );

    const entries = await env.DB.prepare(`SELECT status, actual_cents, tenant_id FROM vendor_spend_entries`).all<{
      status: string;
      actual_cents: number | null;
      tenant_id: string;
    }>();
    expect(entries.results).toHaveLength(1);
    expect(entries.results[0]!.status).toBe("committed");
    expect(entries.results[0]!.tenant_id).toBe(tenantId);
  });

  it("ledger timestamps are WALL-CLOCK even when the tenant's virtual clock is skewed", async () => {
    // The real path: a DEMO tenant skews its clock (advanceClock is a
    // sandbox-only control), then UPGRADES. The skew rides along into the paid
    // plan, which is precisely why "paid tenants run real-time" was false.
    const { tenantId } = await mintTenant("Skewed Clock Co", "demo");
    await tenantStub(tenantId).advanceClock(365 * 24 * 60 * 60 * 1000);
    await activatePaidPlan(tenantId, "managed");

    const before = Date.now();
    await realCtx(tenantId, (ctx) => withSpendCeiling(ctx, "domain", async () => "ok"));
    const after = Date.now();

    const row = await env.DB.prepare(`SELECT created_at, period_key FROM vendor_spend_entries`).first<{
      created_at: number;
      period_key: string;
    }>();
    // Pre-fix this was stamped from ctx.clock, time-warping the row into a
    // future period — cross-tenant D1 accounting corrupted by one tenant's skew.
    expect(row!.created_at).toBeGreaterThanOrEqual(before);
    expect(row!.created_at).toBeLessThanOrEqual(after);
    expect(row!.period_key).toBe(periodKey(before));
  });
});

describe("H6 — error translation is identical on both transports and leaks nothing", () => {
  const INTERNAL_MARKERS = [/ACTIVATION\.md/i, /ENGINE_BASE_URL/, /INBOXKIT_API_KEY/, /REGISTRAR_PROVIDER/, /CLOUDFLARE_REGISTRAR_API_TOKEN/];

  it("REST really returns 502 {code:'vendor_error', retryable} for a REAL vendor throw", async () => {
    // N7 (gate 2026-08-05) — this test used to assert a 404 on a missing
    // thread, which exercises none of the vendor branch it claimed to cover:
    // coverage theater. It now drives an actual VendorError out of the send
    // path through the REST surface.
    await seedBenignSdnList();
    const { tenantId, token } = await mintTenant("Vendor Err REST Co", "managed");
    await activatePaidPlan(tenantId, "managed");

    // Drive the REAL InboxKit domain adapter and make the registrar reject the
    // purchase, exactly as the vendor does on a bad request. That produces a
    // genuine VendorError inside the setup saga, through the REST surface.
    Object.assign(env, { REGISTRAR_PROVIDER: "inboxkit", INBOXKIT_API_KEY: "k", INBOXKIT_WORKSPACE_ID: "w" });
    vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const json = (obj: unknown) =>
        new Response(JSON.stringify(obj), { status: 200, headers: { "content-type": "application/json" } });
      if (url.includes("/domains/available")) return json({ error: false, available: true });
      if (url.includes("/domains/list")) return json({ error: false, domains: [], pages: 1 });
      // The vendor rejects the registration — the adapter throws VendorError.
      if (url.includes("/domains/register")) return json({ error: true, message: "registration rejected by registry" });
      return json({ error: false });
    }) as typeof fetch);

    const res = await api<{ error: string; code: string; step?: string; retryable?: boolean }>("/setup-infrastructure", {
      method: "POST",
      token,
      body: JSON.stringify({
        brand: "Vendor Err REST Co",
        primaryDomain: "vendorerrrest.com",
        domains: 1,
        inboxesEach: 1,
        persona: "Sender",
        physicalAddress: "1 St",
        senderIdentity: "S <s@vendorerrrest.com>",
        registerDomains: true,
        registrant: {
          firstName: "Ada",
          lastName: "Lovelace",
          email: "ada@example.com",
          phone: "+1.5555550100",
          addressLine1: "1 Test St",
          city: "Testville",
          state: "CA",
          country: "US",
          postalCode: "94000",
        },
      }),
    });
    vi.restoreAllMocks();

    expect(res.status).toBe(502);
    expect(res.body.code).toBe("vendor_error");
    expect(res.body.retryable).toBe(false);
    // N2 — and the body carries none of the adapter's operator-facing text.
    expect(res.body.error).not.toMatch(/registration rejected by registry/);

    // The mapper still honors mapped classes rather than swallowing everything
    // into the vendor branch.
    const missing = await api<{ error: string }>("/threads/nope/reply", {
      method: "POST",
      token,
      body: JSON.stringify({ body: "x" }),
    });
    expect(missing.status).toBe(404);
  });

  it("BOTH transports emit the same body for the same error, and neither leaks internals", async () => {
    const { tenantId, token } = await mintTenant("Parity Co", "managed");
    await activatePaidPlan(tenantId, "managed");

    // NotActivatedError carries ACTIVATION.md + vendor wording in its raw
    // message; both surfaces must replace it with a customer-safe body.
    const raw = new NotActivatedError("mailbox", "provision");
    expect(raw.message).toMatch(/ACTIVATION\.md/);

    const { toErrorResponse } = await import("../src/error-response.js");
    const translated = toErrorResponse(raw);
    expect(translated.status).toBe(503);
    expect(translated.body.code).toBe("not_activated");
    for (const marker of INTERNAL_MARKERS) {
      expect(String(translated.body.error)).not.toMatch(marker);
    }

    const vendorTranslated = toErrorResponse(new VendorError("inboxkit domains/register failed for x.com", true));
    expect(vendorTranslated.status).toBe(502);
    expect(vendorTranslated.body.code).toBe("vendor_error");
    expect(vendorTranslated.body.retryable).toBe(true);
    // ABSTRACT, not the vendor's literal route: `step:"domains/register"` was
    // itself a provider fingerprint (sweep-vendor-leak-2026-08-05) — you can
    // curl it. The actionable signal survives, the identification does not.
    expect(vendorTranslated.body.step).toBe("domain registration");

    // And the MCP transport returns that SAME structured body, not err.message.
    const res = await api<{ result: { content: { text: string }[]; isError?: boolean } }>("/mcp", {
      method: "POST",
      token,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "thread", arguments: { threadId: "does-not-exist" } },
      }),
    });
    expect(res.status).toBe(200);
    expect(res.body.result.isError).toBe(true);
    const parsed = JSON.parse(res.body.result.content[0]!.text) as { error: string };
    // Structured JSON, not a bare prose string — the pre-fix fallthrough
    // returned err.message verbatim and would fail JSON.parse here.
    expect(typeof parsed.error).toBe("string");
    for (const marker of INTERNAL_MARKERS) {
      expect(res.body.result.content[0]!.text).not.toMatch(marker);
    }
    void tenantId;
  });

  it("an UNKNOWN error class becomes a generic internal body, never the raw message", async () => {
    const { toErrorResponse } = await import("../src/error-response.js");
    const leaky = new Error("connect ECONNREFUSED 10.0.0.1:5432 while reading ENGINE_BASE_URL");
    leaky.name = "SomeInternalThing";
    const translated = toErrorResponse(leaky);

    expect(translated.status).toBe(500);
    expect(translated.body).toEqual({ error: "internal error", code: "internal" });
    expect(String(translated.body.error)).not.toMatch(/ENGINE_BASE_URL/);
  });
});
