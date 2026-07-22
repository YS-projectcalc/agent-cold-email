import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { api, signup, tenantStub } from "./helpers.js";

// SPEC.md §22 — warm-lead thin layer, increment #2: update_lead (contact-level
// disposition upsert) + suppress_lead (tenant-wide manual opt-out). Both
// transports (REST + MCP) drive the SAME TenantDO facade (parity law).
// list_leads coverage lives in test/list-leads.test.ts.

interface DispositionView {
  email: string;
  interestStatus: string;
  notes: string;
  tags: string[];
  source: string;
  updatedAt: number;
}

async function mcp<T = unknown>(token: string, name: string, args: Record<string, unknown>): Promise<T> {
  const res = await api<{ result: { content: { text: string }[]; isError?: boolean } }>("/mcp", {
    method: "POST",
    token,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  if (res.body.result.isError) throw new Error(`tool ${name} errored: ${res.body.result.content[0]!.text}`);
  return JSON.parse(res.body.result.content[0]!.text) as T;
}

async function launchOneStepCampaign(token: string, email: string, name = "c") {
  return api<{ campaignId: string }>("/campaigns", {
    method: "POST",
    token,
    body: JSON.stringify({
      name,
      offer: "x",
      leads: [{ email, firstName: "P", company: "Co" }],
      sequence: [{ step: 1, subject: "Hi", body: "Hi", delayDays: 0 }],
    }),
  });
}

function suppressionRow(tenantId: string, email: string): Promise<{ reason: string } | undefined> {
  return runInDurableObject(tenantStub(tenantId), async (_i, state) =>
    state.storage.sql
      .exec<{ reason: string }>(`SELECT reason FROM suppressions WHERE tenant_id = ? AND email = ?`, tenantId, email)
      .toArray()[0],
  );
}

describe("update_lead — contact-level disposition upsert (REST)", () => {
  it("upserts interestStatus/notes/tags; a PARTIAL follow-up patch leaves omitted fields unchanged", async () => {
    const { token } = await signup("Disposition Co", "founder@dispositionco.com");
    const email = "lead@dispositionco-leads.com";

    const first = await api<DispositionView>("/leads/disposition", {
      method: "POST",
      token,
      body: JSON.stringify({ email, interestStatus: "interested", notes: "asked for pricing", tags: ["warm"] }),
    });
    expect(first.status).toBe(200);
    expect(first.body.interestStatus).toBe("interested");
    expect(first.body.notes).toBe("asked for pricing");
    expect(first.body.tags).toEqual(["warm"]);
    expect(first.body.source).toBe("api");

    // Partial patch — only notes changes; interestStatus/tags carry over.
    const second = await api<DispositionView>("/leads/disposition", {
      method: "POST",
      token,
      body: JSON.stringify({ email, notes: "booked a call" }),
    });
    expect(second.status).toBe(200);
    expect(second.body.notes).toBe("booked a call");
    expect(second.body.interestStatus).toBe("interested"); // unchanged
    expect(second.body.tags).toEqual(["warm"]); // unchanged
  });

  it("rejects an unknown interestStatus (server-enforced enum, Q2) and an empty patch (no fields)", async () => {
    const { token } = await signup("Enum Co", "founder@enumco.com");
    const email = "lead@enumco-leads.com";

    const badEnum = await api("/leads/disposition", {
      method: "POST",
      token,
      body: JSON.stringify({ email, interestStatus: "do_not_contact" }),
    });
    expect(badEnum.status).toBe(400); // NOT a member — routes to suppress_lead instead

    const empty = await api("/leads/disposition", {
      method: "POST",
      token,
      body: JSON.stringify({ email }),
    });
    expect(empty.status).toBe(400);
  });

  it("accepts every widened enum member (Q2 refinement: out_of_office, wrong_person)", async () => {
    const { token } = await signup("Widened Enum Co", "founder@widenedenumco.com");
    for (const status of ["none", "interested", "meeting_booked", "not_now", "not_interested", "bad_fit", "out_of_office", "wrong_person"]) {
      const res = await api<DispositionView>("/leads/disposition", {
        method: "POST",
        token,
        body: JSON.stringify({ email: `lead-${status}@widenedenumco-leads.com`, interestStatus: status }),
      });
      expect(res.status, status).toBe(200);
      expect(res.body.interestStatus).toBe(status);
    }
  });

  it("is keyed CONTACT-level (tenant, email) — visible even with no launched campaign lead for that email (Q1)", async () => {
    const { token } = await signup("No Campaign Co", "founder@nocampaignco.com");
    const res = await api<DispositionView>("/leads/disposition", {
      method: "POST",
      token,
      body: JSON.stringify({ email: "cold@nocampaignco-leads.com", interestStatus: "interested" }),
    });
    expect(res.status).toBe(200);
  });
});

describe("update_lead — MCP parity", () => {
  it("update_lead tool drives the SAME facade as the REST route", async () => {
    const { token } = await signup("Mcp Disposition Co", "founder@mcpdispositionco.com");
    const email = "lead@mcpdispositionco-leads.com";

    const result = await mcp<DispositionView>(token, "update_lead", { email, interestStatus: "meeting_booked", tags: ["hot"] });
    expect(result.interestStatus).toBe("meeting_booked");
    expect(result.tags).toEqual(["hot"]);
    expect(result.source).toBe("mcp");
  });
});

describe("suppress_lead — tenant-wide manual opt-out (REST)", () => {
  it("suppresses tenant-wide with reason='manual' and cancels a real lead's pending steps", async () => {
    const { tenantId, token } = await signup("Suppress Co", "founder@suppressco.com");
    const email = "prospect@suppressco-leads.com";
    await launchOneStepCampaign(token, email);

    const res = await api("/leads/suppress", { method: "POST", token, body: JSON.stringify({ email }) });
    expect(res.status).toBe(200);
    expect(await suppressionRow(tenantId, email)).toEqual({ reason: "manual" });

    const leadStatus = await runInDurableObject(tenantStub(tenantId), async (_i, state) =>
      state.storage.sql.exec<{ global_status: string }>(`SELECT global_status FROM leads LIMIT 1`).one().global_status,
    );
    expect(leadStatus).toBe("suppressed");
  });

  it("rejects a reason other than 'manual' at the boundary — the ONLY value this tool may honestly claim", async () => {
    const { token } = await signup("Reason Lock Co", "founder@reasonlockco.com");
    const res = await api("/leads/suppress", {
      method: "POST",
      token,
      body: JSON.stringify({ email: "prospect@reasonlockco-leads.com", reason: "complaint" }),
    });
    expect(res.status).toBe(400);
  });

  it("accepts and ignores an optional note (schema symmetry, not persisted — mirrors configure_webhook's note)", async () => {
    const { token } = await signup("Note Co", "founder@noteco.com");
    const res = await api("/leads/suppress", {
      method: "POST",
      token,
      body: JSON.stringify({ email: "prospect@noteco-leads.com", note: "asked to stop by phone" }),
    });
    expect(res.status).toBe(200);
  });

  it("suppressing an already-complaint/unsubscribe-suppressed address relabels the reason to 'manual' (last-write-wins, adversary R2)", async () => {
    const { tenantId, token } = await signup("Overwrite Co", "founder@overwriteco.com");
    const email = "prospect@overwriteco-leads.com";
    await launchOneStepCampaign(token, email);
    // Prime a 'complaint' suppression the way the engine would (direct write —
    // no complaint-trigger tool exists on this facade).
    await runInDurableObject(tenantStub(tenantId), async (_i, state) => {
      state.storage.sql.exec(
        `INSERT INTO suppressions (tenant_id, email, reason, ts) VALUES (?, ?, 'complaint', ?)`,
        tenantId,
        email,
        1_800_000_000_000,
      );
    });
    expect(await suppressionRow(tenantId, email)).toEqual({ reason: "complaint" });

    await api("/leads/suppress", { method: "POST", token, body: JSON.stringify({ email }) });
    expect(await suppressionRow(tenantId, email)).toEqual({ reason: "manual" });
  });
});

describe("suppress_lead — MCP parity", () => {
  it("suppress_lead tool drives the SAME facade as the REST route", async () => {
    const { tenantId, token } = await signup("Mcp Suppress Co", "founder@mcpsuppressco.com");
    const email = "prospect@mcpsuppressco-leads.com";
    const result = await mcp<{ suppressed: boolean }>(token, "suppress_lead", { email });
    expect(result.suppressed).toBe(true);
    expect(await suppressionRow(tenantId, email)).toEqual({ reason: "manual" });
  });
});

describe("tenant isolation — disposition/suppression never cross a DO boundary (rule h)", () => {
  it("tenant B suppressing/annotating an email tenant A also used never touches tenant A's own rows", async () => {
    const a = await signup("Iso A Co", "a@leadiso.example");
    const b = await signup("Iso B Co", "b@leadiso.example");
    const sharedEmail = "shared@leadiso-leads.example";

    await launchOneStepCampaign(a.token, sharedEmail);
    await api("/leads/disposition", {
      method: "POST",
      token: a.token,
      body: JSON.stringify({ email: sharedEmail, interestStatus: "interested" }),
    });

    // B suppresses the SAME email string — only B's own tenant-scoped row is affected.
    const bSuppress = await api("/leads/suppress", { method: "POST", token: b.token, body: JSON.stringify({ email: sharedEmail }) });
    expect(bSuppress.status).toBe(200);

    expect(await suppressionRow(a.tenantId, sharedEmail)).toBeUndefined(); // A untouched
    expect(await suppressionRow(b.tenantId, sharedEmail)).toEqual({ reason: "manual" });

    // A's lead is still 'active' — B's action didn't cancel A's pending steps.
    const aLeadStatus = await runInDurableObject(tenantStub(a.tenantId), async (_i, state) =>
      state.storage.sql.exec<{ global_status: string }>(`SELECT global_status FROM leads LIMIT 1`).one().global_status,
    );
    expect(aLeadStatus).toBe("active");

    // B never launched a campaign with the shared email — its own list_leads
    // has no row for it at all (A's disposition is invisible, not just
    // filtered out), proving the JOIN never crosses the DO boundary either.
    const bList = await api<{ leads: unknown[] }>("/leads", { token: b.token });
    expect(bList.status).toBe(200);
    expect(bList.body.leads).toEqual([]);
  });
});
