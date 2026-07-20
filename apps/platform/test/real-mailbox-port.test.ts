import { afterEach, describe, expect, it, vi } from "vitest";
import { NotActivatedError, VendorError } from "@coldstart/shared";
import { RealMailboxPort } from "../src/vendors/real/mailbox-port.js";
import {
  IK_API_KEY,
  IK_MAILBOX_ALREADY_EXISTS,
  IK_MAILBOX_BUY_SUCCESS,
  IK_MAILBOX_CANCEL_SUCCESS,
  IK_MAILBOX_HEALTH_SUCCESS,
  IK_MAILBOX_LIST_EMPTY,
  IK_MAILBOX_LIST_SUCCESS,
  IK_WARMUP_ADD_SUCCESS,
  IK_WORKSPACE_ID,
} from "./fixtures/inboxkit.js";

// Contract test for RealMailboxPort (InboxKit, ACTIVATION.md Gate 0). `fetch`
// is stubbed with sanitized fixtures derived from real captured/documented
// InboxKit responses (test/fixtures/inboxkit.ts) — no real network call.

const CONFIG = { apiKey: IK_API_KEY, workspaceId: IK_WORKSPACE_ID, baseUrl: "https://ik.example.internal/v1/api" };

function stubFetchSequence(responses: Array<{ status: number; body: unknown }>) {
  const spy = vi.spyOn(globalThis, "fetch");
  for (const res of responses) {
    spy.mockImplementationOnce(async () => new Response(JSON.stringify(res.body), { status: res.status, headers: { "content-type": "application/json" } }));
  }
  return spy;
}

afterEach(() => vi.restoreAllMocks());

describe("RealMailboxPort — dark until configured", () => {
  it("throws NotActivatedError on every method with no InboxKit config (deployed default)", async () => {
    const port = new RealMailboxPort();
    await expect(port.provision("example.com", "john.doe", "k1")).rejects.toBeInstanceOf(NotActivatedError);
    await expect(port.getHealth("john.doe@example.com")).rejects.toBeInstanceOf(NotActivatedError);
    await expect(port.startWarmup("john.doe@example.com", "k1")).rejects.toBeInstanceOf(NotActivatedError);
    await expect(port.release("john.doe@example.com", "k1")).rejects.toBeInstanceOf(NotActivatedError);
  });
});

describe("RealMailboxPort — configured (InboxKit)", () => {
  it("provision() POSTs /mailboxes/buy with names derived from localPart and returns the deterministic email", async () => {
    const spy = stubFetchSequence([{ status: 200, body: IK_MAILBOX_BUY_SUCCESS }]);
    const result = await new RealMailboxPort(CONFIG).provision("example-lookalike.com", "john.doe", "k1");

    expect(result).toEqual({ email: "john.doe@example-lookalike.com", provider: "google", provisionedAt: expect.any(Number) });
    const [url, init] = spy.mock.calls[0]!;
    expect(url).toBe("https://ik.example.internal/v1/api/mailboxes/buy");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({
      use_wallet_balance: true,
      mailboxes: [{ first_name: "John", last_name: "Doe", username: "john.doe", platform: "GOOGLE", domain_name: "example-lookalike.com" }],
    });
  });

  it("provision() treats a vendor 'already exists' error as an idempotent success (no idempotency-key support upstream)", async () => {
    stubFetchSequence([{ status: 409, body: IK_MAILBOX_ALREADY_EXISTS }]);
    const result = await new RealMailboxPort(CONFIG).provision("example-lookalike.com", "john.doe", "retry-key");
    expect(result).toEqual({ email: "john.doe@example-lookalike.com", provider: "google", provisionedAt: expect.any(Number) });
  });

  it("provision() surfaces a non-'already exists' vendor failure as a VendorError", async () => {
    stubFetchSequence([{ status: 402, body: { error: true, message: "Insufficient wallet balance to purchase mailboxes" } }]);
    const err = await new RealMailboxPort(CONFIG).provision("example-lookalike.com", "john.doe", "k1").catch((e) => e);
    expect(err).toBeInstanceOf(VendorError);
    expect((err as VendorError).message).toContain("Insufficient wallet balance");
  });

  it("getHealth() resolves the mailbox uid via /mailboxes/list then reads /email-insights/mailbox/{uid}/health", async () => {
    const spy = stubFetchSequence([{ status: 200, body: IK_MAILBOX_LIST_SUCCESS }, { status: 200, body: IK_MAILBOX_HEALTH_SUCCESS }]);
    const health = await new RealMailboxPort(CONFIG).getHealth("john.doe@example-lookalike.com");

    expect(health.email).toBe("john.doe@example-lookalike.com");
    expect(health.bounceRate).toBeCloseTo(0.018, 5); // 1.8% -> fraction
    expect(health.reputationScore).toBe(90); // healthy -> 90 (approximation, documented in the adapter)
    expect(health.complaintRate).toBe(0); // not exposed by InboxKit's health endpoint
    expect(health.placementRate).toBeCloseTo(0.982, 5);

    const [listUrl] = spy.mock.calls[0]!;
    expect(listUrl).toBe("https://ik.example.internal/v1/api/mailboxes/list");
    const [healthUrl] = spy.mock.calls[1]!;
    expect(healthUrl).toBe("https://ik.example.internal/v1/api/email-insights/mailbox/mbx-11111111-2222-3333-4444-555555555555/health");
  });

  it("getHealth() fails permanently when the mailbox can't be resolved to a uid", async () => {
    stubFetchSequence([{ status: 200, body: IK_MAILBOX_LIST_EMPTY }]);
    const err = await new RealMailboxPort(CONFIG).getHealth("ghost@example-lookalike.com").catch((e) => e);
    expect(err).toBeInstanceOf(VendorError);
    expect((err as VendorError).retryable).toBe(false);
  });

  it("startWarmup() resolves the uid then POSTs /warmup/add with activate_immediately:true", async () => {
    const spy = stubFetchSequence([{ status: 200, body: IK_MAILBOX_LIST_SUCCESS }, { status: 200, body: IK_WARMUP_ADD_SUCCESS }]);
    const result = await new RealMailboxPort(CONFIG).startWarmup("john.doe@example-lookalike.com", "k1");

    expect(result.started).toBe(true);
    expect(typeof result.startedAt).toBe("number");
    const [, init] = spy.mock.calls[1]!;
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      mailbox_uids: ["mbx-11111111-2222-3333-4444-555555555555"],
      activate_immediately: true,
    });
  });

  it("release() resolves the uid then POSTs /mailboxes/cancel and reports released:true", async () => {
    const spy = stubFetchSequence([{ status: 200, body: IK_MAILBOX_LIST_SUCCESS }, { status: 200, body: IK_MAILBOX_CANCEL_SUCCESS }]);
    const result = await new RealMailboxPort(CONFIG).release("john.doe@example-lookalike.com", "k1");

    expect(result).toEqual({ released: true, releasedAt: expect.any(Number) });
    const [, init] = spy.mock.calls[1]!;
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ uids: ["mbx-11111111-2222-3333-4444-555555555555"] });
  });
});
