import { describe, expect, it } from "vitest";
import { adminApi } from "./helpers.js";

interface TriageResponse {
  ticketId: string;
  category: string;
  draft: string | null;
  status: string;
}

interface DigestResponse {
  counts: { open: number; escalated: number };
  tickets: { id: string; category: string; status: string; fromEmail: string }[];
}

// D1 (brief) — the required test cases: "billing question -> classified
// billing + FAQ draft; abuse report -> escalated; digest lists them."
describe("POST /admin/support/triage + GET /admin/support/digest — D1 AI support triage", () => {
  it("classifies a billing question, drafts an FAQ answer, and logs it 'open'", async () => {
    const res = await adminApi<TriageResponse>("/admin/support/triage", {
      method: "POST",
      body: JSON.stringify({
        from: "customer@example.com",
        subject: "Question about my invoice",
        body: "Hi, I was charged $299 this month but I thought I was on the Launch plan — can you explain the billing?",
      }),
    });
    expect(res.status).toBe(201);
    expect(res.body.category).toBe("billing");
    expect(res.body.status).toBe("open");
    expect(res.body.draft).toBeTruthy();
    expect(res.body.draft).toMatch(/\$99/); // grounded in the real Launch price, SPEC.md §18
  });

  it("escalates an abuse report with NO auto-drafted answer", async () => {
    const res = await adminApi<TriageResponse>("/admin/support/triage", {
      method: "POST",
      body: JSON.stringify({
        from: "reporter@example.com",
        subject: "Reporting abuse from your platform",
        body: "One of your customers is sending phishing emails impersonating our brand. This is unauthorized use of our name.",
      }),
    });
    expect(res.status).toBe(201);
    expect(res.body.category).toBe("abuse-report");
    expect(res.body.status).toBe("escalated");
    expect(res.body.draft).toBeNull();
  });

  it("digest lists both the drafted and escalated tickets", async () => {
    const billing = await adminApi<TriageResponse>("/admin/support/triage", {
      method: "POST",
      body: JSON.stringify({ from: "a@example.com", subject: "billing question", body: "why was my card charged?" }),
    });
    const abuse = await adminApi<TriageResponse>("/admin/support/triage", {
      method: "POST",
      body: JSON.stringify({ from: "b@example.com", subject: "abuse report", body: "this is a phishing scam, fraud, report abuse" }),
    });

    const digest = await adminApi<DigestResponse>("/admin/support/digest");
    expect(digest.status).toBe(200);
    const ids = digest.body.tickets.map((t) => t.id);
    expect(ids).toContain(billing.body.ticketId);
    expect(ids).toContain(abuse.body.ticketId);
    expect(digest.body.counts.open).toBeGreaterThanOrEqual(1);
    expect(digest.body.counts.escalated).toBeGreaterThanOrEqual(1);
  });

  it("rejects an invalid triage payload (boundary validation, CLAUDE.md rule h)", async () => {
    const res = await adminApi("/admin/support/triage", {
      method: "POST",
      body: JSON.stringify({ from: "not-an-email", subject: "", body: "" }),
    });
    expect(res.status).toBe(400);
  });
});
