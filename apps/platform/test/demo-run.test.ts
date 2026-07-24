import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { api, mintTenant, signup, tenantStub } from "./helpers.js";

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
  });

  // panel-02 abuse-cost-dos: /demo/run had no per-tenant rate limit, so one
  // free token could loop it indefinitely. A rapid second run is now rejected.
  it("rate-limits a rapid second /demo/run for the same tenant with 429", async () => {
    const { token } = await signup("Demo Run Twice Co", "demo-run-twice@test.example");
    await api("/setup-infrastructure", {
      method: "POST",
      token,
      body: JSON.stringify({ ...SETUP_BODY, brand: "Demo Run Twice Co", primaryDomain: "demoruntwice.com" }),
    });

    const first = await api<DemoRunSummary>("/demo/run", { method: "POST", token });
    expect(first.status).toBe(200);
    expect(first.body.sent).toBeGreaterThan(0);

    const second = await api<{ error: string }>("/demo/run", { method: "POST", token });
    expect(second.status).toBe(429);
    expect(second.body.error).toMatch(/rate limited/i);
  });

  // panel-02 abuse-cost-dos: runDemo appended state every call, growing DO
  // SQLite unbounded. It now RESETs prior demo state, so repeated runs don't
  // accumulate campaigns/leads/sends. We clear the throttle row directly (a
  // legitimate use of the test harness's DO-internals access) to run twice.
  it("runDemo resets prior demo state so storage stays bounded across runs", async () => {
    const { tenantId, token } = await signup("Demo Reset Co", "demo-reset@test.example");
    await api("/setup-infrastructure", {
      method: "POST",
      token,
      body: JSON.stringify({ ...SETUP_BODY, brand: "Demo Reset Co", primaryDomain: "demoresetco.com" }),
    });

    await runInDurableObject(tenantStub(tenantId), async (instance, state) => {
      await instance.demoRun();
      const countDemo = () =>
        state.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) as n FROM campaigns WHERE is_demo = 1`).one().n;
      const countSends = () =>
        state.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) as n FROM scheduled_sends`).one().n;

      expect(countDemo()).toBe(1);
      const sendsAfterFirst = countSends();

      // Clear the throttle row so a second run is allowed, then run again.
      state.storage.sql.exec(`DELETE FROM demo_run_state`);
      await instance.demoRun();

      // Reset means prior demo rows were deleted, not appended: still exactly
      // one demo campaign, and scheduled_sends did not grow. (Old code kept the
      // first run's campaign/sends AND added the second run's -> 2 campaigns,
      // more sends.)
      expect(countDemo()).toBe(1);
      expect(countSends()).toBeLessThanOrEqual(sendsAfterFirst);
    });
  });

  it("structurally rejects a non-demo/free-plan tenant with 403 — never exposes tick over HTTP to real tenants", async () => {
    const { token } = await mintTenant("Paid Co", "managed");
    const res = await api("/demo/run", { method: "POST", token });
    expect(res.status).toBe(403);
  });

  it("requires auth like every other tenant-scoped intent", async () => {
    const res = await api("/demo/run", { method: "POST" });
    expect(res.status).toBe(401);
  });
});
