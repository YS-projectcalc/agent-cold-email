import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyActions } from "../src/engine/deliverability-actions.js";
import { env } from "cloudflare:test";
import { activatePaidPlan, mintTenant, seedBenignSdnList, tenantStub, withTenantContext } from "./helpers.js";

// Quantity-billing §7.1 (adversary B2-rework, BLOCKING) — RED-proof of the
// silent double-bill. Before §7.1, REPLACE_DOMAIN only PAUSED the burned
// domain's mailboxes (deliv_status='paused', NOT released_at), so they kept
// counting; the burned N + the N replacements = 2N, and the autonomous
// reconcile pushed set-to-2N to Stripe with no quote — a surprise 2x invoice on
// a routine deliverability event. §7.1 releases the burned mailboxes on the
// unconditional retire leg, so the swap nets to zero (release N, provision N).
// This asserts the set-to-N quantity (fetch-stubbed) is N, not 2N. Reverting the
// `releaseMailboxes` call in applyReplaceDomain makes this FAIL at 2N.

const CAPTURE: { url: string; body: string }[] = [];

function stubStripeFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init: RequestInit) => {
      CAPTURE.push({ url: String(url), body: String(init.body ?? "") });
      return new Response("{}", { status: 200 });
    }),
  );
}

async function withStripeKey<T>(fn: () => Promise<T>): Promise<T> {
  const saved = env.STRIPE_SECRET_KEY;
  (env as { STRIPE_SECRET_KEY?: string }).STRIPE_SECRET_KEY = "sk_test_fake_burn";
  try {
    return await fn();
  } finally {
    (env as { STRIPE_SECRET_KEY?: string }).STRIPE_SECRET_KEY = saved;
  }
}

/** Seeds an active managed tenant with a burning-candidate domain + N live mailboxes on it. */
async function seedBurnableTenant(brand: string, domainId: string, mailboxCount: number, syncedQty = mailboxCount) {
  await seedBenignSdnList();
  const { tenantId, token } = await mintTenant(brand, "managed");
  await activatePaidPlan(tenantId, "managed");
  await runInDurableObject(tenantStub(tenantId), async (_i, state) => {
    state.storage.sql.exec(
      `UPDATE tenant_profile SET primary_domain = ?, stripe_subscription_id = 'sub_burn', stripe_mailbox_item_id = 'si_mbx', mailbox_qty_synced = ? WHERE id = ?`,
      `${brand.toLowerCase().replace(/\W+/g, "")}.com`,
      syncedQty,
      tenantId,
    );
    state.storage.sql.exec(
      `INSERT INTO domains (id, tenant_id, domain, status, purchased_at) VALUES (?, ?, 'burning-candidate.com', 'active', 0)`,
      domainId,
      tenantId,
    );
    for (let i = 0; i < mailboxCount; i++) {
      state.storage.sql.exec(
        `INSERT INTO mailboxes (id, tenant_id, domain_id, domain, email, daily_cap, sent_today, sent_today_epoch_day, status, warmup_started_at, created_at)
         VALUES (?, ?, ?, 'burning-candidate.com', ?, 5, 0, 0, 'active', 0, ?)`,
        `mbx_${crypto.randomUUID()}`,
        tenantId,
        domainId,
        `m${i}@burning-candidate.com`,
        i,
      );
    }
  });
  return { tenantId, token };
}

describe("REPLACE_DOMAIN is bill-neutral (§7.1 — no silent double-bill)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    CAPTURE.length = 0;
  });

  it("releases the burned mailboxes so the swap nets to zero — reconcile pushes set-to-N, not set-to-2N", async () => {
    const domainId = "dom_burn_1";
    const N = 6; // > 5 so 2N (12) is distinguishable from N (6) and both clear the floor
    // synced=5 (drift below the true count) so the reconcile actually PUSHES —
    // this reproduces the adversary's "reconcile pushes set-to-2N" scenario.
    const { tenantId } = await seedBurnableTenant("Burn Neutral Co", domainId, N, 5);

    await withStripeKey(() =>
      withTenantContext(tenantId, async (ctx) => {
        stubStripeFetch();
        await applyActions(ctx, [{ type: "REPLACE_DOMAIN", domainId, domain: "burning-candidate.com", reason: "bounce spike" }]);
      }),
    );

    // The set-to-N request went out at N=6 (release 6 burned + provision 6 = 6 live),
    // NOT 12. On the pre-§7.1 code the burned 6 keep counting -> this is 12.
    const setReq = CAPTURE.find((c) => c.url.endsWith("/subscription_items/si_mbx"));
    expect(setReq).toBeDefined();
    expect(new URLSearchParams(setReq!.body).get("quantity")).toBe("6");
    expect(new URLSearchParams(setReq!.body).get("proration_behavior")).toBe("create_prorations"); // 5 -> 6 is an increase

    const state = await runInDurableObject(tenantStub(tenantId), async (_i, s) => {
      const synced = s.storage.sql.exec<{ q: number }>(`SELECT mailbox_qty_synced as q FROM tenant_profile WHERE id = ?`, tenantId).one().q;
      const live = s.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) as n FROM mailboxes WHERE tenant_id = ? AND released_at IS NULL`, tenantId).one().n;
      const burnedLive = s.storage.sql
        .exec<{ n: number }>(`SELECT COUNT(*) as n FROM mailboxes WHERE tenant_id = ? AND domain_id = ? AND released_at IS NULL`, tenantId, domainId)
        .one().n;
      return { synced, live, burnedLive };
    });
    expect(state.synced).toBe(6);
    expect(state.live).toBe(6); // 6 replacements only — the burned 6 are released
    expect(state.burnedLive).toBe(0); // every burned mailbox stopped counting
  });

  it("withheld replacement (spawn cap hit) is bill-LOWERING (-N): burned released, none provisioned", async () => {
    const domainId = "dom_burn_2";
    const { tenantId } = await seedBurnableTenant("Burn Capped Co", domainId, 6);

    await withStripeKey(() =>
      withTenantContext(tenantId, async (ctx) => {
        stubStripeFetch();
        // Pre-fill the replacement window to the cap so THIS replace is withheld.
        for (let i = 0; i < 3; i++) {
          ctx.sql.exec(
            `INSERT INTO deliverability_actions (id, tenant_id, action, target, detail_json, ts) VALUES (?, ?, 'REPLACE_DOMAIN', 'x', '{}', ?)`,
            `dact_${i}`,
            ctx.tenantId,
            ctx.clock.now(),
          );
        }
        await applyActions(ctx, [{ type: "REPLACE_DOMAIN", domainId, domain: "burning-candidate.com", reason: "bounce spike" }]);
      }),
    );

    // Withheld -> release 6, provision 0 -> live count 0 -> desired floors at 5.
    const setReq = CAPTURE.find((c) => c.url.endsWith("/subscription_items/si_mbx"));
    expect(setReq).toBeDefined();
    expect(new URLSearchParams(setReq!.body).get("quantity")).toBe("5"); // floor, never +N
    expect(new URLSearchParams(setReq!.body).get("proration_behavior")).toBe("none"); // a decrease never credits
  });
});
