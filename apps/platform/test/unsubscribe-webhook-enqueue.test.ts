import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ONE_DAY_MS, WARMUP_RAMP_DAYS } from "../src/engine/warmup.js";
import { signUnsubscribeToken } from "../src/unsubscribe-token.js";
import { api, signup, tenantStub } from "./helpers.js";

async function setupReadyTenant(brand: string, primaryDomain: string) {
  const { tenantId, token } = await signup(brand, `founder@${primaryDomain}`);
  await api("/setup-infrastructure", {
    method: "POST",
    token,
    body: JSON.stringify({
      brand,
      primaryDomain,
      domains: 1,
      inboxesEach: 1,
      persona: "Sender",
      physicalAddress: "1 Test St",
      senderIdentity: `Sender <s@${primaryDomain}>`,
    }),
  });
  await tenantStub(tenantId).advanceClock((WARMUP_RAMP_DAYS + 1) * ONE_DAY_MS);
  return { tenantId, token };
}

// SPEC.md §22 — closing the "unsubscribe is poll-only" gap needs BOTH changes
// together (adding 'unsubscribe' to WEBHOOK_EVENT_TYPES AND routing the
// direct suppression-event INSERT through the recordEventIfNew choke point)
// "or the fix is inert" — the enum addition alone changes nothing, since the
// webhook enqueue fan-out lives ONLY inside that choke point
// (engine/reply-processor.ts's recordEventIfNew, now shared via
// engine/events.ts). This file proves BOTH halves landed together.

interface WebhookSummary {
  id: string;
  eventTypes: string[];
}

async function createUnsubscribeSub(token: string) {
  return api<WebhookSummary & { secret: string }>("/webhook-subscriptions", {
    method: "POST",
    token,
    body: JSON.stringify({ url: "https://hooks.example.com/unsub", eventTypes: ["unsubscribe"] }),
  });
}

function deliveryTypes(tenantId: string): Promise<string[]> {
  return runInDurableObject(tenantStub(tenantId), async (_i, state) =>
    state.storage.sql
      .exec<{ event_type: string }>(`SELECT event_type FROM webhook_deliveries WHERE tenant_id = ?`, tenantId)
      .toArray()
      .map((r) => r.event_type),
  );
}

describe("unsubscribe closes the webhook gap (SPEC.md §22) — both halves land together", () => {
  it("configure_webhook accepts eventTypes: ['unsubscribe'] (the enum half)", async () => {
    const { token } = await signup("Enum Half Co", "founder@enumhalfco.com");
    const created = await createUnsubscribeSub(token);
    expect(created.status).toBe(201);
    expect(created.body.eventTypes).toEqual(["unsubscribe"]);
  });

  it("a typed-unsubscribe reply enqueues a delivery to a subscription filtered on 'unsubscribe' (the choke-point half)", async () => {
    // A real mailbox (setupReadyTenant, past warmup) is required here — the
    // OTHER cases in this file drive unsubscribeEmail via the hosted
    // endpoint directly (no send needed), but THIS case needs tick() to
    // genuinely SEND the step so the sandbox EmailPort queues its synthetic
    // typed-unsubscribe reply for pollInbox() to find (vendors/sandbox/
    // email-port.ts) — with zero mailbox capacity tick() would defer the
    // send forever and no reply would ever be queued.
    const { tenantId, token } = await setupReadyTenant("Choke Point Co", "chokepointco.com");
    await createUnsubscribeSub(token);

    // The sandbox EmailPort keys its synthetic poll() behavior off the
    // recipient local-part (vendors/sandbox/email-port.ts) — "unsubexact"
    // queues a reply whose body is EXACTLY "unsubscribe", which
    // isUnsubscribeIntentReply matches (same fixture convention as
    // test/unsubscribe.test.ts's "typed-unsubscribe reply detection" suite).
    await api("/campaigns", {
      method: "POST",
      token,
      body: JSON.stringify({
        name: "c",
        offer: "x",
        leads: [{ email: "unsubexact.prospect@chokepointco-leads.com", firstName: "P", company: "Co" }],
        sequence: [{ step: 1, subject: "Hi", body: "Hi", delayDays: 0 }],
      }),
    });

    await tenantStub(tenantId).tick();
    await tenantStub(tenantId).pollInbox(); // the typed-intent matcher fires unsubscribeEmail

    // FAILS on old code: the pre-fix direct INSERT never called
    // enqueueEventWebhooks at all, so this would be 0 even WITH the enum
    // widened — proving the enum alone is inert without the choke-point route.
    expect(await deliveryTypes(tenantId)).toEqual(["unsubscribe"]);
  });

  it("the hosted RFC 8058 one-click endpoint ALSO enqueues a delivery (same unsubscribeEmail path, different caller)", async () => {
    const { tenantId, token } = await signup("Hosted Link Co", "founder@hostedlinkco.com");
    await createUnsubscribeSub(token);
    const email = "prospect@hostedlinkco-leads.com";
    // A real lead (with a thread) is required: unsubscribeEmail's per-lead
    // loop — where the event write + webhook enqueue happen — walks the
    // `leads` table by email and, per lead, needs a scheduled_sends row to
    // resolve a thread_id to attach the event to (engine/suppression.ts).
    await api("/campaigns", {
      method: "POST",
      token,
      body: JSON.stringify({
        name: "c",
        offer: "x",
        leads: [{ email, firstName: "P", company: "Co" }],
        sequence: [{ step: 1, subject: "Hi", body: "Hi", delayDays: 0 }],
      }),
    });

    const sig = await signUnsubscribeToken(env.TOKEN_HASH_PEPPER, tenantId, email);
    const res = await api(`/unsubscribe?${new URLSearchParams({ tenant: tenantId, email, sig }).toString()}`, { method: "POST" });
    expect(res.status).toBe(200);

    expect(await deliveryTypes(tenantId)).toEqual(["unsubscribe"]);
  });

  it("a subscription that does NOT list 'unsubscribe' receives nothing for an opt-out event", async () => {
    const { tenantId, token } = await signup("Filtered Out Co", "founder@filteredoutco.com");
    await api("/webhook-subscriptions", {
      method: "POST",
      token,
      body: JSON.stringify({ url: "https://hooks.example.com/replies-only", eventTypes: ["reply"] }),
    });
    const email = "prospect@filteredoutco-leads.com";
    // A real lead so the event write genuinely happens (and would enqueue if
    // ANY subscription matched) — proving the FILTER excludes it, not that
    // nothing was ever recorded to begin with.
    await api("/campaigns", {
      method: "POST",
      token,
      body: JSON.stringify({
        name: "c",
        offer: "x",
        leads: [{ email, firstName: "P", company: "Co" }],
        sequence: [{ step: 1, subject: "Hi", body: "Hi", delayDays: 0 }],
      }),
    });
    const sig = await signUnsubscribeToken(env.TOKEN_HASH_PEPPER, tenantId, email);
    await api(`/unsubscribe?${new URLSearchParams({ tenant: tenantId, email, sig }).toString()}`, { method: "POST" });

    expect(await deliveryTypes(tenantId)).toEqual([]);
  });

  it("repeat unsubscribe clicks for the SAME lead enqueue no SECOND delivery (idempotent, matches the single-event guarantee)", async () => {
    const { tenantId, token } = await signup("Idempotent Enqueue Co", "founder@idempotentenqueueco.com");
    await createUnsubscribeSub(token);
    const email = "prospect@idempotentenqueueco-leads.com";
    await api("/campaigns", {
      method: "POST",
      token,
      body: JSON.stringify({
        name: "c",
        offer: "x",
        leads: [{ email, firstName: "P", company: "Co" }],
        sequence: [{ step: 1, subject: "Hi", body: "Hi", delayDays: 0 }],
      }),
    });

    const sig = await signUnsubscribeToken(env.TOKEN_HASH_PEPPER, tenantId, email);
    const url = `/unsubscribe?${new URLSearchParams({ tenant: tenantId, email, sig }).toString()}`;

    await api(url, { method: "POST" });
    await api(url, { method: "POST" });
    await api(url, { method: "POST" });

    // The per-lead cancel+event loop only runs the FIRST time an address is
    // suppressed (unsubscribeEmail's `alreadySuppressed` gate) — one delivery,
    // not three, across three repeat clicks.
    expect(await deliveryTypes(tenantId)).toEqual(["unsubscribe"]);
  });
});
