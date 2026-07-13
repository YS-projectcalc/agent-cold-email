import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { InboxQueryInput } from "@coldstart/shared";
import { ONE_DAY_MS, WARMUP_RAMP_DAYS } from "../src/engine/warmup.js";
import { api, signup, tenantStub } from "./helpers.js";

interface InboxRow {
  threadId: string;
  campaignId: string;
  campaignName: string;
  leadEmail: string;
  subject: string | null;
  snippet: string | null;
  mailboxEmail: string | null;
  mailboxDelivStatus: string | null;
  label: string | null;
  labelSource: string | null;
  lastEventType: string;
  lastEventTs: number;
  markStatus: string;
}
interface InboxPage {
  threads: InboxRow[];
  nextCursor: string | null;
}

async function setupReadyTenant(brand: string, primaryDomain: string, inboxesEach = 1) {
  const { tenantId, token } = await signup(brand, `founder@${primaryDomain}`);
  await api("/setup-infrastructure", {
    method: "POST",
    token,
    body: JSON.stringify({
      brand,
      primaryDomain,
      domains: 1,
      inboxesEach,
      persona: "Sender",
      physicalAddress: "1 Test St",
      senderIdentity: `Sender <s@${primaryDomain}>`,
    }),
  });
  await tenantStub(tenantId).advanceClock((WARMUP_RAMP_DAYS + 1) * ONE_DAY_MS);
  return { tenantId, token };
}

const TWO_STEP = [
  { step: 1, subject: "Quick question", body: "Hi", delayDays: 0 },
  { step: 2, subject: "Following up", body: "Bump", delayDays: 2 },
];

describe("GET /inbox v2 — backward-compatible defaults + row shape", () => {
  it("a bare GET /inbox (no params) returns EVERY thread incl. bounces (matches pre-v2 behavior)", async () => {
    const { tenantId, token } = await setupReadyTenant("Backcompat Co", "backcompat.com");
    await api("/campaigns", {
      method: "POST",
      token,
      body: JSON.stringify({
        name: "c",
        offer: "x",
        leads: [
          { email: "reply.prospect@backcompat-leads.com", firstName: "R", company: "Co" },
          { email: "bounce.prospect@backcompat-leads.com", firstName: "B", company: "Co" },
        ],
        sequence: TWO_STEP,
      }),
    });
    await tenantStub(tenantId).tick();
    await tenantStub(tenantId).pollInbox();

    const res = await api<InboxPage>("/inbox", { token });
    expect(res.status).toBe(200);
    expect(res.body.threads).toHaveLength(2);
    expect(res.body.nextCursor).toBeNull();

    const replyRow = res.body.threads.find((t) => t.leadEmail === "reply.prospect@backcompat-leads.com")!;
    // [NEW-3] step-1 subject ("Quick question") resolved via json_extract
    // against campaigns.sequence_json, not hardcoded / blanked by the reply.
    expect(replyRow.subject).toBe("Quick question");
    expect(replyRow.snippet).toBeTruthy();
    expect(replyRow.mailboxEmail).toMatch(/^.+@.+\..+$/); // a real mailbox email (sandbox mints its own lookalike domain)
    expect(replyRow.mailboxDelivStatus).toBe("healthy");
    expect(replyRow.markStatus).toBe("unread");
    expect(replyRow.label).toBeNull();
  });
});

describe("GET /inbox v2 — cursor pagination", () => {
  it("paginates without loss/duplication across pages with DISTINCT timestamps", async () => {
    const { tenantId, token } = await setupReadyTenant("Paginate Co", "paginate.com");
    // THREE separate single-lead campaigns, each launched+ticked (then the
    // clock advanced) one at a time -> each thread's 'sent' event gets a
    // genuinely distinct ts (engine/tick.ts reads `now` once per tick() call).
    for (const email of ["a@paginate-leads.com", "b@paginate-leads.com", "c@paginate-leads.com"]) {
      await api("/campaigns", {
        method: "POST",
        token,
        body: JSON.stringify({
          name: `c-${email}`,
          offer: "x",
          leads: [{ email, firstName: "L", company: "Co" }],
          sequence: [{ step: 1, subject: "Hi", body: "Hi", delayDays: 0 }],
        }),
      });
      await tenantStub(tenantId).tick();
      await tenantStub(tenantId).advanceClock(1000);
    }

    const full = await api<InboxPage>("/inbox", { token });
    expect(full.body.threads).toHaveLength(3);
    const distinctTs = new Set(full.body.threads.map((t) => t.lastEventTs));
    expect(distinctTs.size).toBe(3); // confirms these are genuinely distinct, not a tie

    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let i = 0; i < 5; i++) {
      const query = new URLSearchParams({ limit: "1", ...(cursor ? { cursor } : {}) });
      const page = await api<InboxPage>(`/inbox?${query.toString()}`, { token });
      expect(page.body.threads.length).toBeLessThanOrEqual(1);
      for (const t of page.body.threads) seen.add(t.threadId);
      if (!page.body.nextCursor) break;
      cursor = page.body.nextCursor;
    }
    expect(seen.size).toBe(3); // no loss, no duplication
  });

  it("[NEW-2] a SAME-timestamp boundary (two threads sent in the SAME tick) is lossless/dup-free", async () => {
    const { tenantId, token } = await setupReadyTenant("SameTs Co", "samets.com");
    await api("/campaigns", {
      method: "POST",
      token,
      body: JSON.stringify({
        name: "c",
        offer: "x",
        leads: [
          { email: "x@samets-leads.com", firstName: "X", company: "Co" },
          { email: "y@samets-leads.com", firstName: "Y", company: "Co" },
        ],
        sequence: [{ step: 1, subject: "Hi", body: "Hi", delayDays: 0 }],
      }),
    });
    // A single tick() reads `now` ONCE (engine/tick.ts) and stamps every send
    // in this batch with the IDENTICAL ts — a real same-ts tie, not a fixture.
    await tenantStub(tenantId).tick();

    const fullQuery = InboxQueryInput.parse({});
    const full = await runInDurableObject(tenantStub(tenantId), (instance) => instance.inbox(fullQuery));
    expect(full.threads).toHaveLength(2);
    expect(full.threads[0]!.lastEventTs).toBe(full.threads[1]!.lastEventTs); // confirms the tie exists

    const page1 = await api<InboxPage>("/inbox?limit=1", { token });
    expect(page1.body.threads).toHaveLength(1);
    expect(page1.body.nextCursor).not.toBeNull();

    const page2 = await api<InboxPage>(`/inbox?limit=1&cursor=${encodeURIComponent(page1.body.nextCursor!)}`, { token });
    expect(page2.body.threads).toHaveLength(1);

    const ids = [page1.body.threads[0]!.threadId, page2.body.threads[0]!.threadId];
    expect(new Set(ids).size).toBe(2); // no duplicate across the tied boundary
    expect(page2.body.nextCursor).toBeNull();
  });
});

describe("GET /inbox v2 — filters", () => {
  it("campaign filter narrows to one campaign; label filter matches only labeled threads; read filter matches mark status", async () => {
    const { tenantId, token } = await setupReadyTenant("Filter Co", "filterco.com");
    const c1 = await api<{ campaignId: string }>("/campaigns", {
      method: "POST",
      token,
      body: JSON.stringify({ name: "c1", offer: "x", leads: [{ email: "p1@filterco-leads.com", firstName: "P1", company: "Co" }], sequence: [{ step: 1, subject: "Hi", body: "Hi", delayDays: 0 }] }),
    });
    const c2 = await api<{ campaignId: string }>("/campaigns", {
      method: "POST",
      token,
      body: JSON.stringify({ name: "c2", offer: "x", leads: [{ email: "p2@filterco-leads.com", firstName: "P2", company: "Co" }], sequence: [{ step: 1, subject: "Hi", body: "Hi", delayDays: 0 }] }),
    });
    await tenantStub(tenantId).tick();

    const byCampaign = await api<InboxPage>(`/inbox?campaign=${c1.body.campaignId}`, { token });
    expect(byCampaign.body.threads).toHaveLength(1);
    expect(byCampaign.body.threads[0]!.campaignId).toBe(c1.body.campaignId);
    void c2;

    const all = await api<InboxPage>("/inbox", { token });
    const threadId = all.body.threads[0]!.threadId;

    await api(`/threads/${threadId}/label`, { method: "POST", token, body: JSON.stringify({ label: "interested" }) });
    const byLabel = await api<InboxPage>("/inbox?label=interested", { token });
    expect(byLabel.body.threads).toHaveLength(1);
    expect(byLabel.body.threads[0]!.threadId).toBe(threadId);
    const byOtherLabel = await api<InboxPage>("/inbox?label=not_now", { token });
    expect(byOtherLabel.body.threads).toHaveLength(0);

    await api(`/threads/${threadId}/mark`, { method: "POST", token, body: JSON.stringify({ status: "read" }) });
    const readOnly = await api<InboxPage>("/inbox?read=true", { token });
    expect(readOnly.body.threads.map((t) => t.threadId)).toContain(threadId);
    const unreadOnly = await api<InboxPage>("/inbox?read=false", { token });
    expect(unreadOnly.body.threads.map((t) => t.threadId)).not.toContain(threadId);
  });

  it("include_nonreply=false hides bounce/complaint threads; default (omitted) still shows them", async () => {
    const { tenantId, token } = await setupReadyTenant("Nonreply Co", "nonreplyco.com");
    await api("/campaigns", {
      method: "POST",
      token,
      body: JSON.stringify({
        name: "c",
        offer: "x",
        leads: [
          { email: "reply.prospect@nonreplyco-leads.com", firstName: "R", company: "Co" },
          { email: "bounce.prospect@nonreplyco-leads.com", firstName: "B", company: "Co" },
        ],
        sequence: [{ step: 1, subject: "Hi", body: "Hi", delayDays: 0 }],
      }),
    });
    await tenantStub(tenantId).tick();
    await tenantStub(tenantId).pollInbox();

    const defaultView = await api<InboxPage>("/inbox", { token });
    expect(defaultView.body.threads).toHaveLength(2); // backward-compatible default: bounces included

    const hidden = await api<InboxPage>("/inbox?include_nonreply=false", { token });
    expect(hidden.body.threads).toHaveLength(1);
    expect(hidden.body.threads[0]!.leadEmail).toBe("reply.prospect@nonreplyco-leads.com");
  });
});

describe("GET /inbox v2 — no N+1 (single query regardless of thread count)", () => {
  it("issues exactly ONE ctx.sql.exec call for the listing, whether 1 or 20 threads exist", async () => {
    const { tenantId, token } = await setupReadyTenant("NoNplus1 Co", "nonplus1.com");
    const leads = Array.from({ length: 20 }, (_, i) => ({ email: `lead${i}@nonplus1-leads.com`, firstName: `L${i}`, company: "Co" }));
    await api("/campaigns", {
      method: "POST",
      token,
      body: JSON.stringify({ name: "bulk", offer: "x", leads, sequence: [{ step: 1, subject: "Hi", body: "Hi", delayDays: 0 }] }),
    });
    await tenantStub(tenantId).tick();

    const query = InboxQueryInput.parse({});
    const execCount = await runInDurableObject(tenantStub(tenantId), async (instance, state) => {
      let count = 0;
      const original = state.storage.sql.exec.bind(state.storage.sql);
      state.storage.sql.exec = ((...args: Parameters<typeof original>) => {
        count++;
        return original(...args);
      }) as typeof state.storage.sql.exec;
      const page = await instance.inbox(query);
      expect(page.threads).toHaveLength(20);
      return count;
    });
    expect(execCount).toBe(1);
  });
});
