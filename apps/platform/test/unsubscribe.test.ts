import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ONE_DAY_MS, WARMUP_RAMP_DAYS } from "../src/engine/warmup.js";
import { signUnsubscribeToken } from "../src/unsubscribe-token.js";
import { api, signup, tenantStub } from "./helpers.js";

// B4 opt-out — the hosted RFC 8058 one-click endpoint (routes/unsubscribe.ts)
// + the header/footer it drives from engine/tick.ts. Unauthenticated (no
// bearer token) by design: a signed (tenant, email, sig) triplet in the query
// string IS the credential (unsubscribe-token.ts). The security posture that
// matters here: (a) a forged/tampered token must never suppress ANY address
// (a mass-suppression primitive against a competitor's campaign otherwise),
// and (b) once a genuine token is presented, the opt-out is honored
// IMMEDIATELY (no CAN-SPAM-style grace window) and is idempotent.

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

function unsubUrl(tenant: string, email: string, sig: string): string {
  return `/unsubscribe?${new URLSearchParams({ tenant, email, sig }).toString()}`;
}

async function validToken(tenantId: string, email: string): Promise<string> {
  return signUnsubscribeToken(env.TOKEN_HASH_PEPPER, tenantId, email);
}

function suppressionRow(tenantId: string, email: string): Promise<{ reason: string } | undefined> {
  return runInDurableObject(tenantStub(tenantId), async (_instance, state) =>
    state.storage.sql
      .exec<{ reason: string }>(`SELECT reason FROM suppressions WHERE tenant_id = ? AND email = ?`, tenantId, email)
      .toArray()[0],
  );
}

function unsubscribeEventCount(tenantId: string): Promise<number> {
  return runInDurableObject(tenantStub(tenantId), async (_instance, state) =>
    state.storage.sql
      .exec<{ n: number }>(`SELECT COUNT(*) as n FROM events WHERE tenant_id = ? AND type = 'unsubscribe'`, tenantId)
      .one().n,
  );
}

const ONE_STEP = [{ step: 1, subject: "Hi", body: "Hi there", delayDays: 0 }];

describe("token forgery/tamper is rejected and never mutates suppression state", () => {
  it("a flipped byte in sig is rejected 400 and writes nothing", async () => {
    const { tenantId } = await setupReadyTenant("Tamper Co", "tampertoken.com");
    const email = "prospect@tampertoken-leads.com";
    const sig = await validToken(tenantId, email);
    const flipped = (sig[0] === "0" ? "1" : "0") + sig.slice(1);

    const res = await api(unsubUrl(tenantId, email, flipped), { method: "POST" });
    expect(res.status).toBe(400);
    expect(await suppressionRow(tenantId, email)).toBeUndefined();
  });

  it("a sig valid for a DIFFERENT tenant is rejected 400 against this tenant", async () => {
    const { tenantId: victimId } = await setupReadyTenant("Victim Co", "victimtoken.com");
    const { tenantId: attackerId } = await setupReadyTenant("Attacker Co", "attackertoken.com");
    const email = "shared-looking@example.com";
    const sigForAttacker = await validToken(attackerId, email);

    const res = await api(unsubUrl(victimId, email, sigForAttacker), { method: "POST" });
    expect(res.status).toBe(400);
    expect(await suppressionRow(victimId, email)).toBeUndefined();
  });

  it("a sig valid for a DIFFERENT email is rejected 400 against this email (no reusing one leaked token to mass-suppress)", async () => {
    const { tenantId } = await setupReadyTenant("Wrong Email Co", "wrongemailtoken.com");
    const realEmail = "real-recipient@wrongemailtoken-leads.com";
    const sigForReal = await validToken(tenantId, realEmail);
    const otherEmail = "someone-else@wrongemailtoken-leads.com";

    const res = await api(unsubUrl(tenantId, otherEmail, sigForReal), { method: "POST" });
    expect(res.status).toBe(400);
    expect(await suppressionRow(tenantId, otherEmail)).toBeUndefined();
    expect(await suppressionRow(tenantId, realEmail)).toBeUndefined();
  });

  it("a missing/malformed query is rejected 400", async () => {
    const res = await api("/unsubscribe", { method: "POST" });
    expect(res.status).toBe(400);
  });
});

describe("a valid POST suppresses immediately and is idempotent", () => {
  it("200s, writes the suppression row, and repeat calls stay 200 without duplicating the unsubscribe event", async () => {
    const { tenantId } = await setupReadyTenant("Idempotent Co", "idempotenttoken.com");
    const email = "prospect@idempotenttoken-leads.com";
    const sig = await validToken(tenantId, email);

    const first = await api(unsubUrl(tenantId, email, sig), { method: "POST" });
    expect(first.status).toBe(200);
    expect(await suppressionRow(tenantId, email)).toEqual({ reason: "unsubscribe" });

    const second = await api(unsubUrl(tenantId, email, sig), { method: "POST" });
    expect(second.status).toBe(200);
    const third = await api(unsubUrl(tenantId, email, sig), { method: "POST" });
    expect(third.status).toBe(200);

    // No lead exists for this email in this test, so there's nothing to cancel/
    // event — this proves the endpoint never errors on an unknown address either.
    expect(await unsubscribeEventCount(tenantId)).toBe(0);
  });

  it("cancels a real lead's pending steps and records exactly one 'unsubscribe' event across repeat clicks", async () => {
    const { tenantId, token } = await setupReadyTenant("Cancels Co", "cancelstoken.com");
    const email = "prospect@cancelstoken-leads.com";
    await api("/campaigns", {
      method: "POST",
      token,
      body: JSON.stringify({
        name: "c",
        offer: "x",
        leads: [{ email, firstName: "P", company: "Co" }],
        sequence: [
          { step: 1, subject: "Hi", body: "Hi", delayDays: 0 },
          { step: 2, subject: "Follow up", body: "Following up", delayDays: 5 },
        ],
      }),
    });

    const sig = await validToken(tenantId, email);
    const first = await api(unsubUrl(tenantId, email, sig), { method: "POST" });
    expect(first.status).toBe(200);
    expect(await unsubscribeEventCount(tenantId)).toBe(1);

    const leadStatus = await runInDurableObject(tenantStub(tenantId), async (_i, state) =>
      state.storage.sql.exec<{ global_status: string }>(`SELECT global_status FROM leads LIMIT 1`).one().global_status,
    );
    expect(leadStatus).toBe("suppressed");

    const pendingCount = await runInDurableObject(tenantStub(tenantId), async (_i, state) =>
      state.storage.sql
        .exec<{ n: number }>(`SELECT COUNT(*) as n FROM scheduled_sends WHERE status = 'pending'`)
        .one().n,
    );
    expect(pendingCount).toBe(0); // both steps cancelled, not just the due one

    // Repeat click — still 200, but no SECOND unsubscribe event.
    const second = await api(unsubUrl(tenantId, email, sig), { method: "POST" });
    expect(second.status).toBe(200);
    expect(await unsubscribeEventCount(tenantId)).toBe(1);
  });
});

describe("GET renders a confirm page; POST-confirm performs the suppression", () => {
  it("GET with an invalid token returns a generic error page, not the confirm form", async () => {
    const { tenantId } = await setupReadyTenant("Get Invalid Co", "getinvalidtoken.com");
    const email = "prospect@getinvalidtoken-leads.com";
    const res = await api<string>(unsubUrl(tenantId, email, "not-a-real-signature"), { method: "GET" });
    expect(res.status).toBe(400);
    expect(String(res.body)).not.toContain("<form");
  });

  it("GET with a valid token shows a confirm form (not yet suppressed); the form's own POST suppresses", async () => {
    const { tenantId } = await setupReadyTenant("Get Confirm Co", "getconfirmtoken.com");
    const email = "prospect@getconfirmtoken-leads.com";
    const sig = await validToken(tenantId, email);

    const getRes = await api<string>(unsubUrl(tenantId, email, sig), { method: "GET" });
    expect(getRes.status).toBe(200);
    expect(String(getRes.body)).toContain("<form");
    expect(String(getRes.body)).toContain(email);
    expect(await suppressionRow(tenantId, email)).toBeUndefined(); // GET alone never suppresses

    const postRes = await api(unsubUrl(tenantId, email, sig), { method: "POST" });
    expect(postRes.status).toBe(200);
    expect(await suppressionRow(tenantId, email)).toEqual({ reason: "unsubscribe" });
  });
});

describe("immediacy: a suppression written via the hosted endpoint is honored the very next tick (no grace window)", () => {
  it("a lead unsubscribed BEFORE its due send is skipped, not sent, on the next tick", async () => {
    const { tenantId, token } = await setupReadyTenant("Immediate Co", "immediatetoken.com");
    const email = "prospect@immediatetoken-leads.com";
    const launched = await api<{ campaignId: string }>("/campaigns", {
      method: "POST",
      token,
      body: JSON.stringify({ name: "c", offer: "x", leads: [{ email, firstName: "P", company: "Co" }], sequence: ONE_STEP }),
    });

    const sig = await validToken(tenantId, email);
    const unsub = await api(unsubUrl(tenantId, email, sig), { method: "POST" });
    expect(unsub.status).toBe(200);

    await tenantStub(tenantId).tick();

    // "skipped" is a scheduled_sends STATUS, not an events type (a plain skip
    // records no event row) — CampaignResults only counts event-backed types,
    // so the send-side proof reads scheduled_sends.status directly.
    const results = await api<{ sent: number }>(`/campaigns/${launched.body.campaignId}/results`, { token });
    expect(results.body.sent).toBe(0);
    const sendStatus = await runInDurableObject(tenantStub(tenantId), async (_i, state) =>
      state.storage.sql.exec<{ status: string }>(`SELECT status FROM scheduled_sends LIMIT 1`).one().status,
    );
    expect(sendStatus).toBe("skipped");
  });
});

describe("both List-Unsubscribe forms + List-Unsubscribe-Post are emitted, and the body carries the CAN-SPAM footer", () => {
  it("a real send carries mailto + the hosted https URL, the Post header, and an in-body unsubscribe link", async () => {
    const { tenantId, token } = await setupReadyTenant("Headers Co", "headerstoken.com");
    const email = "prospect@headerstoken-leads.com";
    await api("/campaigns", {
      method: "POST",
      token,
      body: JSON.stringify({ name: "c", offer: "x", leads: [{ email, firstName: "P", company: "Co" }], sequence: ONE_STEP }),
    });

    interface SentInput {
      listUnsubscribe?: string;
      listUnsubscribePost?: string;
      body: string;
      toEmail: string;
    }
    const sentInputs = await runInDurableObject(tenantStub(tenantId), async (instance) => {
      await instance.tick();
      return (instance as unknown as { adapters: { email: { sentInputs: SentInput[] } } }).adapters.email.sentInputs;
    });

    const sent = sentInputs.find((s) => s.toEmail === email);
    expect(sent).toBeDefined();
    expect(sent!.listUnsubscribe).toContain("<mailto:");
    expect(sent!.listUnsubscribe).toMatch(/<https:\/\/[^>]+\/unsubscribe\?[^>]+>/);
    expect(sent!.listUnsubscribePost).toBe("List-Unsubscribe=One-Click");
    expect(sent!.body).toContain("unsubscribe");

    // The https form embeds a token this SAME tenant+email verifies — proves
    // the minted link and the verification endpoint agree end to end.
    const httpsMatch = /<(https:\/\/[^>]+\/unsubscribe\?[^>]+)>/.exec(sent!.listUnsubscribe!);
    expect(httpsMatch).not.toBeNull();
    const mintedUrl = new URL(httpsMatch![1]!);
    const res = await api(
      `/unsubscribe?${mintedUrl.searchParams.toString()}`,
      { method: "GET" },
    );
    expect(res.status).toBe(200);
  });

  // Fix-round (adversarial gate finding #1, 2026-07-14): the footer must
  // ALSO carry the sender identity + physical postal address CAN-SPAM
  // requires (15 U.S.C. §7704(a)(5)) — not just the opt-out link.
  it("the sent body carries the tenant's physical address + sender identity, and the recorded 'sent' event matches it exactly", async () => {
    const { tenantId, token } = await setupReadyTenant("Footer Co", "footertoken.com");
    const email = "prospect@footertoken-leads.com";
    await api("/campaigns", {
      method: "POST",
      token,
      body: JSON.stringify({ name: "c", offer: "x", leads: [{ email, firstName: "P", company: "Co" }], sequence: ONE_STEP }),
    });

    interface SentInput {
      body: string;
      toEmail: string;
    }
    const sentInputs = await runInDurableObject(tenantStub(tenantId), async (instance) => {
      await instance.tick();
      return (instance as unknown as { adapters: { email: { sentInputs: SentInput[] } } }).adapters.email.sentInputs;
    });
    const sent = sentInputs.find((s) => s.toEmail === email);
    expect(sent).toBeDefined();
    // setupReadyTenant's own setup-infrastructure call values (see above).
    expect(sent!.body).toContain("Sender <s@footertoken.com>");
    expect(sent!.body).toContain("1 Test St");

    const inbox = await api<{ threads: { threadId: string }[] }>("/inbox", { token });
    const threadId = inbox.body.threads[0]!.threadId;
    const thread = await api<{ messages: { type: string; metadata: { body: string } }[] }>(`/threads/${threadId}`, { token });
    const sentEvent = thread.body.messages.find((m) => m.type === "sent")!;
    // [NEW-3] fidelity: the send and its recorded metadata never diverge.
    expect(sentEvent.metadata.body).toBe(sent!.body);
  });
});

describe("compliance fail-safe: an empty physical_address/sender_identity refuses to send rather than mail a non-compliant message", () => {
  it("marks the row 'failed' with an ops-visible event instead of sending, when physical_address is blanked", async () => {
    const { tenantId, token } = await setupReadyTenant("Blank Address Co", "blankaddresstoken.com");
    const email = "prospect@blankaddresstoken-leads.com";
    await api("/campaigns", {
      method: "POST",
      token,
      body: JSON.stringify({ name: "c", offer: "x", leads: [{ email, firstName: "P", company: "Co" }], sequence: ONE_STEP }),
    });

    // Not reachable through the real API (setup_infrastructure validates
    // min(1) on both fields) — simulates the "should never happen" state the
    // fail-safe guards, by writing directly to DO storage.
    await runInDurableObject(tenantStub(tenantId), async (_i, state) => {
      state.storage.sql.exec(`UPDATE tenant_profile SET physical_address = '' WHERE id = ?`, tenantId);
    });

    const sentCountBefore = await runInDurableObject(tenantStub(tenantId), async (instance) => {
      await instance.tick();
      return (instance as unknown as { adapters: { email: { sentInputs: unknown[] } } }).adapters.email.sentInputs.length;
    });
    expect(sentCountBefore).toBe(0); // never sent

    const row = await runInDurableObject(tenantStub(tenantId), async (_i, state) =>
      state.storage.sql.exec<{ status: string }>(`SELECT status FROM scheduled_sends LIMIT 1`).one(),
    );
    expect(row.status).toBe("failed");

    const failedEvent = await runInDurableObject(tenantStub(tenantId), async (_i, state) =>
      state.storage.sql
        .exec<{ metadata_json: string }>(`SELECT metadata_json FROM events WHERE tenant_id = ? AND type = 'failed'`, tenantId)
        .one(),
    );
    const metadata = JSON.parse(failedEvent.metadata_json) as { stage: string; reason: string };
    expect(metadata.stage).toBe("compliance");
    expect(metadata.reason).toContain("physical_address");
  });

  it("marks the row 'failed' when sender_identity is blanked (the other required field)", async () => {
    const { tenantId, token } = await setupReadyTenant("Blank Identity Co", "blankidentitytoken.com");
    const email = "prospect@blankidentitytoken-leads.com";
    await api("/campaigns", {
      method: "POST",
      token,
      body: JSON.stringify({ name: "c", offer: "x", leads: [{ email, firstName: "P", company: "Co" }], sequence: ONE_STEP }),
    });

    await runInDurableObject(tenantStub(tenantId), async (_i, state) => {
      state.storage.sql.exec(`UPDATE tenant_profile SET sender_identity = '' WHERE id = ?`, tenantId);
    });

    await tenantStub(tenantId).tick();

    const row = await runInDurableObject(tenantStub(tenantId), async (_i, state) =>
      state.storage.sql.exec<{ status: string }>(`SELECT status FROM scheduled_sends LIMIT 1`).one(),
    );
    expect(row.status).toBe("failed");
  });
});

describe("typed-unsubscribe reply detection end to end (backend gaps brief item 3)", () => {
  it("an EXACT unsubscribe-intent reply suppresses + cancels pending steps, even with stopOnReply=false", async () => {
    const { tenantId, token } = await setupReadyTenant("Typed Exact Co", "typedexact.com");
    await api("/campaigns", {
      method: "POST",
      token,
      body: JSON.stringify({
        name: "c",
        offer: "x",
        leads: [{ email: "unsubexact.prospect@typedexact-leads.com", firstName: "P", company: "Co" }],
        sequence: [
          { step: 1, subject: "Hi", body: "Hi", delayDays: 0 },
          { step: 2, subject: "Follow up", body: "Following up", delayDays: 2 },
        ],
        stopOnReply: false,
      }),
    });

    await tenantStub(tenantId).tick();
    await tenantStub(tenantId).pollInbox();

    const leadStatus = await runInDurableObject(tenantStub(tenantId), async (_i, state) =>
      state.storage.sql.exec<{ global_status: string }>(`SELECT global_status FROM leads LIMIT 1`).one().global_status,
    );
    expect(leadStatus).toBe("suppressed"); // NOT 'replied' — the unsub branch overrides it

    const pendingCount = await runInDurableObject(tenantStub(tenantId), async (_i, state) =>
      state.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) as n FROM scheduled_sends WHERE status = 'pending'`).one().n,
    );
    expect(pendingCount).toBe(0); // cancelled DESPITE stopOnReply=false

    expect(await suppressionRow(tenantId, "unsubexact.prospect@typedexact-leads.com")).toEqual({ reason: "unsubscribe" });
    expect(await unsubscribeEventCount(tenantId)).toBe(1);
  });

  it("a reply that merely MENTIONS 'unsubscribe' mid-sentence behaves exactly like an ordinary reply (byte-identical to today)", async () => {
    const { tenantId, token } = await setupReadyTenant("Typed Mention Co", "typedmention.com");
    await api("/campaigns", {
      method: "POST",
      token,
      body: JSON.stringify({
        name: "c",
        offer: "x",
        leads: [{ email: "unsubmention.prospect@typedmention-leads.com", firstName: "P", company: "Co" }],
        sequence: [
          { step: 1, subject: "Hi", body: "Hi", delayDays: 0 },
          { step: 2, subject: "Follow up", body: "Following up", delayDays: 2 },
        ],
        stopOnReply: false,
      }),
    });

    await tenantStub(tenantId).tick();
    await tenantStub(tenantId).pollInbox();

    const leadStatus = await runInDurableObject(tenantStub(tenantId), async (_i, state) =>
      state.storage.sql.exec<{ global_status: string }>(`SELECT global_status FROM leads LIMIT 1`).one().global_status,
    );
    expect(leadStatus).toBe("replied"); // ordinary reply handling, NOT suppressed

    const pendingCount = await runInDurableObject(tenantStub(tenantId), async (_i, state) =>
      state.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) as n FROM scheduled_sends WHERE status = 'pending'`).one().n,
    );
    expect(pendingCount).toBe(1); // step 2 NOT cancelled — stopOnReply=false honored, matching a normal reply

    expect(await suppressionRow(tenantId, "unsubmention.prospect@typedmention-leads.com")).toBeUndefined();
    expect(await unsubscribeEventCount(tenantId)).toBe(0);
  });
});
