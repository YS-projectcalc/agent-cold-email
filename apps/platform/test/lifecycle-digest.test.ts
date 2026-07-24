import { describe, expect, it } from "vitest";
import { activatePaidPlan, adminApi, api, mintTenant, postWebhook } from "./helpers.js";

interface OpsDigestResponse {
  lifecycle: { canceled: number; terminated: number; disputed: number; annualDomainLiabilityCents: number };
  watchdogAlerts: string[];
}

async function provisionTwoDomains(token: string, brand: string): Promise<void> {
  const slug = brand.toLowerCase().replace(/[^a-z0-9]/g, "");
  await api("/setup-infrastructure", {
    method: "POST",
    token,
    body: JSON.stringify({
      brand,
      primaryDomain: `${slug}.com`,
      domains: 2,
      inboxesEach: 1,
      persona: "Sender",
      physicalAddress: "1 Test St",
      senderIdentity: `Sender <s@${slug}.com>`,
    }),
  });
}

// D5.4 — the owner digest surfaces lifecycle health. Storage is isolated per
// test case (vitest-pool-workers), so exactly the three tenants minted here
// exist in the D1 index and the aggregate counts are exact.
describe("GET /admin/ops/digest — D5 lifecycle wiring", () => {
  it("aggregates canceled / terminated / disputed counts + total annual-domain liability", async () => {
    // 1 canceled (voluntary IMMEDIATE, so teardown runs now and books
    // liability — an end-of-period cancel DEFERS teardown, finding #7).
    const canceled = await mintTenant("Digest Canceled Co", "managed");
    await activatePaidPlan(canceled.tenantId, "managed");
    await provisionTwoDomains(canceled.token, "DigestCanceled");
    await api("/cancel", { method: "POST", token: canceled.token, body: JSON.stringify({ immediate: true }) });

    // 1 terminated (abuse), with 2 domains -> books liability + enforcement row.
    const terminated = await mintTenant("Digest Terminated Co", "managed");
    await activatePaidPlan(terminated.tenantId, "managed");
    await provisionTwoDomains(terminated.token, "DigestTerminated");
    await adminApi(`/admin/tenants/${terminated.tenantId}/terminate`, {
      method: "POST",
      body: JSON.stringify({ reason: "abuse" }),
    });

    // 1 disputed (chargeback).
    const disputed = await mintTenant("Digest Disputed Co", "managed");
    await activatePaidPlan(disputed.tenantId, "managed");
    await postWebhook({
      id: `evt_${crypto.randomUUID()}`,
      type: "charge.dispute.created",
      data: { object: { id: "dp_digest_1", amount: 9900, metadata: { tenantId: disputed.tenantId } } },
    });

    const digest = await adminApi<OpsDigestResponse>("/admin/ops/digest");
    expect(digest.status).toBe(200);
    expect(digest.body.lifecycle.canceled).toBe(1);
    expect(digest.body.lifecycle.terminated).toBe(1);
    expect(digest.body.lifecycle.disputed).toBe(1);
    // 4 domains reclaimed across the canceled + terminated tenants, near the
    // start of their annual term -> ~4 x $11.08.
    expect(digest.body.lifecycle.annualDomainLiabilityCents).toBeGreaterThan(4000);
    expect(digest.body.watchdogAlerts.some((a) => a.includes("chargeback dispute"))).toBe(true);
  });
});
