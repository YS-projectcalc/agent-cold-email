import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import { api, mintTenant, postWebhook, signStripeEvent, tenantStub } from "./helpers.js";

type Profile = {
  plan: string;
  billing_state: string;
};

function readProfile(tenantId: string): Promise<Profile> {
  return runInDurableObject(tenantStub(tenantId), async (_i, state) =>
    state.storage.sql
      .exec<Profile>(`SELECT plan, billing_state FROM tenant_profile WHERE id = ?`, tenantId)
      .one(),
  );
}

// Adversarial panel-03 finding #1 (LIVE-PROVEN): with STRIPE_WEBHOOK_SECRET
// unset, the OLD route skipped signature verification and mutated whatever
// tenant the unsigned body named — an anonymous free plan-upgrade + freeze-any-
// tenant vector. The fix FAILS CLOSED. The signature check is the ONLY
// cross-tenant guard, so trusting an unsigned event's metadata.tenantId is the
// whole vulnerability.
describe("POST /webhooks/stripe — signature is mandatory (panel-03 finding #1)", () => {
  it("FAILS CLOSED with no secret configured: an unsigned forged event is rejected 503 and the tenant is unchanged", async () => {
    const { tenantId } = await mintTenant("Fail Closed Co", "demo");
    const before = await readProfile(tenantId);
    expect(before.plan).toBe("demo");
    expect(before.billing_state).toBe("none");

    const forged = JSON.stringify({
      id: `evt_${crypto.randomUUID()}`,
      type: "checkout.session.completed",
      data: { object: { metadata: { tenantId, plan: "managed" } } },
    });

    const savedSecret = env.STRIPE_WEBHOOK_SECRET;
    try {
      // Reproduce the live deployment's state: no webhook secret configured.
      (env as { STRIPE_WEBHOOK_SECRET?: string }).STRIPE_WEBHOOK_SECRET = undefined;
      // Anonymous, UNSIGNED — exactly the attacker's request.
      const res = await api("/webhooks/stripe", { method: "POST", body: forged });
      expect(res.status).toBe(503);
    } finally {
      (env as { STRIPE_WEBHOOK_SECRET?: string }).STRIPE_WEBHOOK_SECRET = savedSecret;
    }

    // The forged free-upgrade never landed.
    const after = await readProfile(tenantId);
    expect(after.plan).toBe("demo");
    expect(after.billing_state).toBe("none");
  });

  it("rejects an unsigned event 400 when a secret IS configured", async () => {
    const { tenantId } = await mintTenant("Unsigned Co", "demo");
    const res = await api("/webhooks/stripe", {
      method: "POST",
      body: JSON.stringify({
        id: `evt_${crypto.randomUUID()}`,
        type: "checkout.session.completed",
        data: { object: { metadata: { tenantId, plan: "managed" } } },
      }),
    });
    expect(res.status).toBe(400);
    const after = await readProfile(tenantId);
    expect(after.plan).toBe("demo");
  });

  it("rejects a mis-signed event 400 (signature over a DIFFERENT body)", async () => {
    const { tenantId } = await mintTenant("Bad Sig Co", "demo");
    const realBody = JSON.stringify({
      id: `evt_${crypto.randomUUID()}`,
      type: "checkout.session.completed",
      data: { object: { metadata: { tenantId, plan: "managed" } } },
    });
    // Sign a DIFFERENT payload, then send `realBody` — signature won't match.
    const wrongSig = await signStripeEvent("{}");
    const res = await api("/webhooks/stripe", {
      method: "POST",
      headers: { "stripe-signature": wrongSig },
      body: realBody,
    });
    expect(res.status).toBe(400);
    expect((await readProfile(tenantId)).plan).toBe("demo");
  });

  it("accepts a correctly-signed event (control)", async () => {
    const { tenantId } = await mintTenant("Signed OK Co", "demo");
    const res = await postWebhook<{ applied: boolean; plan?: string }>({
      id: `evt_${crypto.randomUUID()}`,
      type: "checkout.session.completed",
      data: { object: { metadata: { tenantId, plan: "managed" } } },
    });
    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(true);
    expect((await readProfile(tenantId)).plan).toBe("managed");
  });

  // Adversarial panel-03 finding #8 — the unauthenticated webhook had no
  // Content-Length body cap (a parse-cost amplifier).
  it("rejects an over-cap body with 413 before reading/verifying it (finding #8)", async () => {
    const oversized = JSON.stringify({ id: "evt_x", type: "noop", pad: "x".repeat(9 * 1024) });
    const res = await api("/webhooks/stripe", {
      method: "POST",
      headers: { "stripe-signature": await signStripeEvent(oversized) },
      body: oversized,
    });
    expect(res.status).toBe(413);
  });
});
