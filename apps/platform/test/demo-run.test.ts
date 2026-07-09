import { describe, expect, it } from "vitest";
import { api, mintTenant, signup } from "./helpers.js";

interface DemoRunSummary {
  sent: number;
  replies: number;
  bounces: number;
  complaints: number;
  stopOnReplyProof: { leadEmail: string; remainingStepsCancelled: boolean } | null;
  sampleThread: { threadId: string; messages: { type: string }[] } | null;
}

const SETUP_BODY = {
  brand: "Demo Run Co",
  primaryDomain: "demorunco.com",
  domains: 1,
  inboxesEach: 2,
  persona: "Sender",
  physicalAddress: "1 Demo St",
  senderIdentity: "Sender <s@demorunco.com>",
};

describe("POST /demo/run — sandbox-only accelerated pipeline run", () => {
  it("drives the full pipe for a demo tenant: non-zero sends, at least one reply + bounce, stop-on-reply proof", async () => {
    const { token } = await signup("Demo Run Co", "demo-run@test.example");
    await api("/setup-infrastructure", { method: "POST", token, body: JSON.stringify(SETUP_BODY) });

    const res = await api<DemoRunSummary>("/demo/run", { method: "POST", token });
    expect(res.status).toBe(200);

    // Behavior, not existence: real numbers, not just "the field exists".
    expect(res.body.sent).toBeGreaterThan(0);
    expect(res.body.replies).toBeGreaterThanOrEqual(1);
    expect(res.body.bounces).toBeGreaterThanOrEqual(1);
    expect(res.body.complaints).toBe(0);

    expect(res.body.stopOnReplyProof).not.toBeNull();
    expect(res.body.stopOnReplyProof!.remainingStepsCancelled).toBe(true);

    expect(res.body.sampleThread).not.toBeNull();
    expect(res.body.sampleThread!.messages.map((m) => m.type)).toContain("reply");

    // Account usage reflects the sends /demo/run actually made (proves it's
    // driving the SAME engine tick the rest of the platform uses, not a
    // canned/fabricated summary).
    const account = await api<{ usageCents: number }>("/account", { token });
    expect(account.body.usageCents).toBeGreaterThan(0);
  });

  it("running /demo/run twice for the same tenant keeps working (idempotent-enough for a repeatable demo)", async () => {
    const { token } = await signup("Demo Run Twice Co", "demo-run-twice@test.example");
    await api("/setup-infrastructure", {
      method: "POST",
      token,
      body: JSON.stringify({ ...SETUP_BODY, brand: "Demo Run Twice Co", primaryDomain: "demoruntwice.com" }),
    });

    const first = await api<DemoRunSummary>("/demo/run", { method: "POST", token });
    expect(first.body.sent).toBeGreaterThan(0);

    const second = await api<DemoRunSummary>("/demo/run", { method: "POST", token });
    expect(second.status).toBe(200);
    expect(second.body.sent).toBeGreaterThan(0);
  });

  it("structurally rejects a non-demo/free-plan tenant with 403 — never exposes tick over HTTP to real tenants", async () => {
    const { token } = await mintTenant("Paid Co", "paid");
    const res = await api("/demo/run", { method: "POST", token });
    expect(res.status).toBe(403);
  });

  it("requires auth like every other tenant-scoped intent", async () => {
    const res = await api("/demo/run", { method: "POST" });
    expect(res.status).toBe(401);
  });
});
