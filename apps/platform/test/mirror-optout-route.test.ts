import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { signMirrorOptOutToken, signUnsubscribeToken } from "../src/unsubscribe-token.js";
import { adminApi, api, signup, tenantStub } from "./helpers.js";

// msgchannel Increment 4 — §9 T10. Same two-step shape as test/
// unsubscribe.test.ts's own route tests (routes/unsubscribe.ts's precedent),
// but verified with `verifyMirrorOptOutToken` — its OWN token, distinct from
// the lead-facing `verifyUnsubscribeToken` (gate B1,
// docs/adversarial/msgchannel-inc4-gate-2026-08-24.md): the two are
// deliberately NOT interchangeable, and the "forged/foreign tokens" describe
// block below proves that in both directions.

function optOutUrl(tenant: string, email: string, sig: string): string {
  return `/messages/mirror/optout?${new URLSearchParams({ tenant, email, sig }).toString()}`;
}

/** The mirror's OWN token — what a real opt-out link carries. */
async function validToken(tenantId: string, email: string): Promise<string> {
  return signMirrorOptOutToken(env.TOKEN_HASH_PEPPER, tenantId, email);
}

function optOutState(tenantId: string): Promise<number | null> {
  return runInDurableObject(tenantStub(tenantId), async (_instance, state) =>
    state.storage.sql
      .exec<{ mirror_email_optout_at: number | null }>(`SELECT mirror_email_optout_at FROM tenant_profile WHERE id = ?`, tenantId)
      .one().mirror_email_optout_at,
  );
}

describe("T10 — GET is prefetch-safe, POST performs, twice is idempotent", () => {
  it("GET with a valid token renders a confirm page and mutates NOTHING", async () => {
    const { tenantId } = await signup("Mirror OptOut Get Co", "getconfirm@mirroroptout.test");
    const sig = await validToken(tenantId, "getconfirm@mirroroptout.test");

    const res = await api<string>(optOutUrl(tenantId, "getconfirm@mirroroptout.test", sig), { method: "GET" });
    expect(res.status).toBe(200);
    expect(String(res.body)).toContain("<form");
    expect(String(res.body)).toContain("getconfirm@mirroroptout.test");
    expect(await optOutState(tenantId)).toBeNull(); // GET alone never opts out
  });

  it("POST with a valid token opts the tenant out, and is idempotent on repeat", async () => {
    const { tenantId } = await signup("Mirror OptOut Post Co", "post@mirroroptout.test");
    const sig = await validToken(tenantId, "post@mirroroptout.test");

    const first = await api(optOutUrl(tenantId, "post@mirroroptout.test", sig), { method: "POST" });
    expect(first.status).toBe(200);
    const stampedAt = await optOutState(tenantId);
    expect(stampedAt).not.toBeNull();

    const second = await api(optOutUrl(tenantId, "post@mirroroptout.test", sig), { method: "POST" });
    expect(second.status).toBe(200);
    expect(await optOutState(tenantId)).toBe(stampedAt); // no second write
  });
});

describe("T10 — forged/foreign tokens get the generic invalid-link page, no enumeration", () => {
  it("a flipped-byte sig is rejected 400 and opts out nothing", async () => {
    const { tenantId } = await signup("Mirror OptOut Forge Co", "forge@mirroroptout.test");
    const sig = await validToken(tenantId, "forge@mirroroptout.test");
    const flipped = (sig[0] === "0" ? "1" : "0") + sig.slice(1);

    const res = await api<string>(optOutUrl(tenantId, "forge@mirroroptout.test", flipped), { method: "GET" });
    expect(res.status).toBe(400);
    expect(String(res.body)).not.toContain("<form");
    expect(await optOutState(tenantId)).toBeNull();
  });

  it("a sig valid for a DIFFERENT tenant is rejected 400 against this tenant — no cross-tenant leverage", async () => {
    const { tenantId: victim } = await signup("Mirror OptOut Victim Co", "victim@mirroroptout.test");
    const { tenantId: attacker } = await signup("Mirror OptOut Attacker Co", "attacker@mirroroptout.test");
    const sigForAttacker = await validToken(attacker, "shared-looking@mirroroptout.test");

    const res = await api(optOutUrl(victim, "shared-looking@mirroroptout.test", sigForAttacker), { method: "POST" });
    expect(res.status).toBe(400);
    expect(await optOutState(victim)).toBeNull();
  });

  it("a missing/malformed query is rejected 400", async () => {
    const res = await api("/messages/mirror/optout", { method: "POST" });
    expect(res.status).toBe(400);
  });
});

describe("Gate B1 — the mirror token cannot be minted for a foreign email, and the two token PURPOSES do not cross", () => {
  // The exact failure the gate proved by execution: `engine/tick.ts` mints a
  // signed (tenantId, leadEmail) unsubscribe link into EVERY cold email a
  // tenant sends. Before the fix, that same triplet also verified on this
  // route, so any recipient of any cold email from tenant X could disable
  // X's mirror by swapping the path. Three legs, all must 400 + leave state
  // untouched.

  it("a mirror-token sig valid for THIS tenant but a DIFFERENT email is rejected 400 — the token alone is not enough, contact_email must match", async () => {
    const { tenantId } = await signup("Gate B1 Wrong Email Co", "real-contact@b1gate.test");
    // A correctly-signed mirror token, but for an email that is NOT this
    // tenant's contact_email (the shape a stranger who somehow obtained a
    // signature for their OWN inbox, or a stale token from before a contact
    // change, would present).
    const sigForStrangerEmail = await validToken(tenantId, "stranger@b1gate.test");

    const res = await api(optOutUrl(tenantId, "stranger@b1gate.test", sigForStrangerEmail), { method: "POST" });
    expect(res.status).toBe(400);
    expect(await optOutState(tenantId)).toBeNull();
  });

  it("a LEAD-FACING unsubscribe token (the one minted into every cold email) is REJECTED on this route", async () => {
    const { tenantId } = await signup("Gate B1 Cross Purpose Co", "victim@b1gate.test");
    // The exact triplet engine/tick.ts embeds in an outbound cold email —
    // signed with the UNSUBSCRIBE key, for the tenant's OWN contact email
    // (the worst case: even the "right" email doesn't help, because the KEY
    // is wrong).
    const unsubscribeSig = await signUnsubscribeToken(env.TOKEN_HASH_PEPPER, tenantId, "victim@b1gate.test");

    const res = await api(optOutUrl(tenantId, "victim@b1gate.test", unsubscribeSig), { method: "POST" });
    expect(res.status).toBe(400);
    expect(await optOutState(tenantId)).toBeNull();
  });

  it("REVERSE direction: a mirror-opt-out token is REJECTED on /unsubscribe", async () => {
    const { tenantId } = await signup("Gate B1 Reverse Co", "reverse@b1gate.test");
    const mirrorSig = await signMirrorOptOutToken(env.TOKEN_HASH_PEPPER, tenantId, "reverse@b1gate.test");

    const res = await api(
      `/unsubscribe?${new URLSearchParams({ tenant: tenantId, email: "reverse@b1gate.test", sig: mirrorSig }).toString()}`,
      { method: "POST" },
    );
    expect(res.status).toBe(400);
  });
});

describe("T10 — operator PATCH honours a phoned-in request through the SAME RPC", () => {
  it("PATCH /admin/tenants/:id/mirror flips the same column an opt-out link would", async () => {
    const { tenantId } = await signup("Mirror OptOut Admin Co", "admin@mirroroptout.test");
    expect(await optOutState(tenantId)).toBeNull();

    const patched = await adminApi(`/admin/tenants/${tenantId}/mirror`, {
      method: "PATCH",
      body: JSON.stringify({ optedOut: true }),
    });
    expect(patched.status).toBe(200);
    expect(await optOutState(tenantId)).not.toBeNull();

    const unpatched = await adminApi(`/admin/tenants/${tenantId}/mirror`, {
      method: "PATCH",
      body: JSON.stringify({ optedOut: false }),
    });
    expect(unpatched.status).toBe(200);
    expect(await optOutState(tenantId)).toBeNull();
  });

  it("404s for an unknown tenant, same as the other admin message routes", async () => {
    const res = await adminApi(`/admin/tenants/ten_does_not_exist/mirror`, {
      method: "PATCH",
      body: JSON.stringify({ optedOut: true }),
    });
    expect(res.status).toBe(404);
  });
});
