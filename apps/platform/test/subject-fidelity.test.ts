import { describe, expect, it } from "vitest";
import { ONE_DAY_MS, WARMUP_RAMP_DAYS } from "../src/engine/warmup.js";
import { api, signup, tenantStub } from "./helpers.js";

// SPEC.md §19.4 [NEW-3] backend gap: inbox v2's subject/snippet were
// json_extract'd against `campaigns.sequence_json` — the TEMPLATE, not what
// was actually sent. Root cause (deeper than the inbox query): NOTHING in the
// send path (engine/tick.ts) ever substituted `{{firstName}}`/`{{company}}`
// against the lead's own fields before handing the subject/body to
// EmailPort.send() — every real send (and the 'sent' event's own recorded
// metadata) carried the literal template. This asserts the whole class is
// fixed: the SEND itself, the event it records, and every surface (thread
// detail, inbox v2) that reads that event back.

const TEMPLATED_SEQUENCE = [
  { step: 1, subject: "Quick question about {{company}}", body: "Hi {{firstName}}, quick question.", delayDays: 0 },
];

interface ThreadDetail {
  threadId: string;
  messages: { type: string; metadata: Record<string, unknown> }[];
}

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

describe("template variable rendering at send time (SPEC.md §19.4 [NEW-3] root cause)", () => {
  it("the ACTUAL vendor send carries the lead's rendered firstName/company, not the literal template", async () => {
    const { tenantId, token } = await setupReadyTenant("Render Send Co", "rendersendco.com");
    await api("/campaigns", {
      method: "POST",
      token,
      body: JSON.stringify({
        name: "c",
        offer: "x",
        leads: [{ email: "a@rendersendco-leads.com", firstName: "Ada", company: "Analytical Engines Inc" }],
        sequence: TEMPLATED_SEQUENCE,
      }),
    });
    await tenantStub(tenantId).tick();

    const account = await api<{ campaigns: number }>("/account", { token }); // sanity: tick actually sent
    expect(account.body.campaigns).toBe(1);

    const inbox = await api<{ threads: { threadId: string; subject: string | null }[] }>("/inbox", { token });
    const threadId = inbox.body.threads[0]!.threadId;
    const thread = await api<ThreadDetail>(`/threads/${threadId}`, { token });
    const sentMsg = thread.body.messages.find((m) => m.type === "sent")!;
    expect(sentMsg.metadata.subject).toBe("Quick question about Analytical Engines Inc");
    // B4: the sent body now carries an appended compliance footer (sender identity, postal address, unsubscribe link)
    // (engine/tick.ts's appendUnsubscribeFooter) — the rendered greeting
    // itself is still the exact substitution this test is about.
    expect(sentMsg.metadata.body).toContain("Hi Ada, quick question.");
    expect(sentMsg.metadata.body).toContain("unsubscribe");
    expect(sentMsg.metadata.subject).not.toContain("{{");
  });

  it("GET /inbox v2's subject reflects the RENDERED value, not campaigns.sequence_json's template", async () => {
    const { tenantId, token } = await setupReadyTenant("Render Inbox Co", "renderinboxco.com");
    await api("/campaigns", {
      method: "POST",
      token,
      body: JSON.stringify({
        name: "c",
        offer: "x",
        leads: [{ email: "reply.prospect@renderinboxco-leads.com", firstName: "Grace", company: "Compiler Corp" }],
        sequence: TEMPLATED_SEQUENCE,
      }),
    });
    await tenantStub(tenantId).tick();
    await tenantStub(tenantId).pollInbox(); // a reply follows the send — proves subject isn't blanked/re-templated by it

    const inbox = await api<{ threads: { threadId: string; subject: string | null; snippet: string | null }[] }>("/inbox", { token });
    const row = inbox.body.threads[0]!;
    // Subject stays keyed to the last SENT step (via last_sent/last_sent_event
    // — NOT blanked/re-templated by the reply that followed it, matching the
    // existing [NEW-3] contract this file's header comment documents).
    expect(row.subject).toBe("Quick question about Compiler Corp");
    expect(row.subject).not.toContain("{{");
    // The snippet tracks the THREAD'S LAST EVENT (by design — see
    // engine/inbox.ts's header doc), which is now the reply itself; the
    // sandbox's simulated reply body quotes the (rendered) subject it's
    // replying to, proving the rendering flowed through as far as the
    // reply-triggering send.
    expect(row.snippet).toBe("Sandbox-simulated reply to: Quick question about Compiler Corp");
  });

  it("a demo run's sample thread shows the lead's rendered subject, not the literal {{company}} template", async () => {
    const { token } = await signup("Demo Render Co", "demo-render@demo-render-test.example");
    await api("/setup-infrastructure", {
      method: "POST",
      token,
      body: JSON.stringify({
        brand: "Demo Render Co",
        primaryDomain: "demorenderco.com",
        domains: 1,
        inboxesEach: 2,
        persona: "Sender",
        physicalAddress: "1 Demo St",
        senderIdentity: "Sender <s@demorenderco.com>",
      }),
    });
    const demo = await api<{ sampleThread: ThreadDetail | null }>("/demo/run", { method: "POST", token });
    expect(demo.status).toBe(200);
    const sampleThread = demo.body.sampleThread;
    expect(sampleThread).not.toBeNull();
    const sentMsg = sampleThread!.messages.find((m) => m.type === "sent")!;
    expect(sentMsg.metadata.subject).not.toContain("{{");
    // demo.ts's DEMO_LEADS: the sample thread belongs to the REPLIED lead
    // (morgan.reply@...), company "Reply Co" — see engine/demo.ts.
    expect(sentMsg.metadata.subject).toBe("Quick question about Reply Co");
  });
});
