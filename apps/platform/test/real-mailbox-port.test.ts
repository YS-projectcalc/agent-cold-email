import { afterEach, describe, expect, it, vi } from "vitest";
import { NotActivatedError, VendorError } from "@coldstart/shared";
import { RealMailboxPort } from "../src/vendors/real/mailbox-port.js";
import {
  IK_API_KEY,
  IK_MAILBOX_ALREADY_EXISTS,
  IK_MAILBOX_BUY_SUCCESS,
  IK_MAILBOX_CANCEL_SUCCESS,
  IK_MAILBOX_CREDENTIALS_SUCCESS,
  IK_MAILBOX_HEALTH_SUCCESS,
  IK_MAILBOX_LIST_EMPTY,
  IK_MAILBOX_LIST_SUCCESS,
  IK_WARMUP_ADD_SUCCESS,
  IK_WARMUP_CANCEL_NONE,
  IK_WARMUP_CANCEL_SUCCESS,
  IK_WARMUP_LIST_ACTIVE,
  IK_WARMUP_LIST_EMPTY,
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
    await expect(port.cancelWarmup("john.doe@example.com", "k1")).rejects.toBeInstanceOf(NotActivatedError);
    await expect(port.release("john.doe@example.com", "k1")).rejects.toBeInstanceOf(NotActivatedError);
    await expect(port.showMailboxCredentials("john.doe@example.com")).rejects.toBeInstanceOf(NotActivatedError);
  });
});

describe("RealMailboxPort — showMailboxCredentials (I3 credential push)", () => {
  it("resolves the uid then GETs /mailboxes/{uid}/credentials and maps IMAP+SMTP into the engine endpoint shape", async () => {
    const spy = stubFetchSequence([{ status: 200, body: IK_MAILBOX_LIST_SUCCESS }, { status: 200, body: IK_MAILBOX_CREDENTIALS_SUCCESS }]);
    const creds = await new RealMailboxPort(CONFIG).showMailboxCredentials("john.doe@example-lookalike.com");

    expect(creds.imap).toEqual({ host: "imap.gmail.com", port: 993, secure: true, user: "john.doe@example-lookalike.com", pass: "imap-app-pass" });
    expect(creds.smtp).toEqual({ host: "smtp.gmail.com", port: 465, secure: true, user: "john.doe@example-lookalike.com", pass: "smtp-app-pass" });
    const [credUrl, init] = spy.mock.calls[1]!;
    expect(credUrl).toBe("https://ik.example.internal/v1/api/mailboxes/mbx-11111111-2222-3333-4444-555555555555/credentials");
    expect((init as RequestInit).method).toBe("GET");
  });

  it("fails LOUD (permanent) when the response carries no usable IMAP credentials (UNVERIFIED shape mismatch)", async () => {
    const spy = stubFetchSequence([{ status: 200, body: IK_MAILBOX_LIST_SUCCESS }, { status: 200, body: { data: {} } }]);
    const err = await new RealMailboxPort(CONFIG).showMailboxCredentials("john.doe@example-lookalike.com").catch((e) => e);
    expect(err).toBeInstanceOf(VendorError);
    expect((err as VendorError).retryable).toBe(false);
    void spy;
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

  it("provision() no longer swallows an 'already exists' error via message-substring (gate c): idempotency is the caller's withRequestIdempotency, so a raw buy conflict surfaces as a VendorError", async () => {
    // Pre-gate-(c) this returned an idempotent success by /already exists/i
    // matching — a fragile hack a vendor wording change would silently break.
    // The durable retry-safety now lives at the caller (provisioning.ts wraps
    // the buy in withRequestIdempotency), so the adapter no longer inspects
    // error text; a direct buy conflict is a plain VendorError.
    stubFetchSequence([{ status: 409, body: IK_MAILBOX_ALREADY_EXISTS }]);
    const err = await new RealMailboxPort(CONFIG).provision("example-lookalike.com", "john.doe", "retry-key").catch((e) => e);
    expect(err).toBeInstanceOf(VendorError);
    expect((err as VendorError).message).toContain("already exists");
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

  // Adversary N2 (wave-2 design review): this number goes straight into
  // `mailboxes.warmup_started_at`, the ramp's only anchor. A non-finite anchor
  // made computeWarmupDay fall through every `<=` threshold to the fully-warmed
  // branch — cap 40/day on a brand-new mailbox, and send-ready, which also makes
  // the warmup-cancel sweep cancel the paid subscription immediately.
  it("startWarmup() refuses an unparseable vendor start time instead of writing a non-finite anchor", async () => {
    stubFetchSequence([
      { status: 200, body: IK_MAILBOX_LIST_SUCCESS },
      {
        status: 200,
        body: {
          ...IK_WARMUP_ADD_SUCCESS,
          subscriptions: [{ ...IK_WARMUP_ADD_SUCCESS.subscriptions[0], started_at: null, createdAt: "not-a-date" }],
        },
      },
    ]);
    const err = await new RealMailboxPort(CONFIG).startWarmup("john.doe@example-lookalike.com", "k1").catch((e) => e);

    expect(err).toBeInstanceOf(VendorError);
    // NON-retryable on purpose: the billed subscription already exists by this
    // point, and a vendor whose date format we cannot read answers the retry the
    // same way — a retryable grade would enrol a fresh paid subscription per attempt.
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

  // Gate (b) — the keyword search returns a mailbox whose email does NOT match
  // the one asked for (a fuzzy near-match). The destructive cancel must NOT run
  // on that wrong mailbox.
  it("release() REFUSES to cancel when the keyword match is a non-exact email (never cancels the wrong paid mailbox)", async () => {
    // IK_MAILBOX_LIST_SUCCESS resolves to john.doe@example-lookalike.com; we ask
    // to release a DIFFERENT address that merely keyword-matches.
    const spy = stubFetchSequence([{ status: 200, body: IK_MAILBOX_LIST_SUCCESS }]);
    const err = await new RealMailboxPort(CONFIG).release("john@example-lookalike.com", "k1").catch((e) => e);

    expect(err).toBeInstanceOf(VendorError);
    expect((err as VendorError).retryable).toBe(false);
    expect((err as VendorError).message).toMatch(/non-exact/i);
    // Only the /mailboxes/list call happened — the /mailboxes/cancel was never reached.
    expect(spy.mock.calls).toHaveLength(1);
    const [listUrl] = spy.mock.calls[0]!;
    expect(listUrl).toBe("https://ik.example.internal/v1/api/mailboxes/list");
  });

  it("release() proceeds on an EXACT keyword match (the guard doesn't block legitimate cancels)", async () => {
    const spy = stubFetchSequence([{ status: 200, body: IK_MAILBOX_LIST_SUCCESS }, { status: 200, body: IK_MAILBOX_CANCEL_SUCCESS }]);
    const result = await new RealMailboxPort(CONFIG).release("john.doe@example-lookalike.com", "k1");
    expect(result.released).toBe(true);
    expect(spy.mock.calls).toHaveLength(2); // list + cancel
  });
});

// Adversary N-d (2026-08-02): `MailboxPort.cancelWarmup`'s own contract says an
// implementation "must be safe to invoke more than once for the same mailbox",
// because the engine sweep retries. An already-cancelled subscription will not
// appear in /warmup/cancel's results.success, so treating that absence as
// failure made the retry burn its whole attempt budget and file a FALSE
// "may still be billing" give-up. Absence is disambiguated by ASKING the vendor
// (/warmup/list), never by matching error text.
describe("RealMailboxPort — cancelWarmup (warmup-pool auto-cancel, N-d idempotency)", () => {
  const EMAIL = "john.doe@example-lookalike.com";

  it("cancels on the happy path: resolve uid -> POST /warmup/cancel, no list lookup needed", async () => {
    const spy = stubFetchSequence([{ status: 200, body: IK_MAILBOX_LIST_SUCCESS }, { status: 200, body: IK_WARMUP_CANCEL_SUCCESS }]);
    const result = await new RealMailboxPort(CONFIG).cancelWarmup(EMAIL, "k1");

    expect(result.cancelled).toBe(true);
    expect(spy.mock.calls).toHaveLength(2); // mailboxes/list + warmup/cancel — no extra round trip
    const [cancelUrl, init] = spy.mock.calls[1]!;
    expect(cancelUrl).toBe("https://ik.example.internal/v1/api/warmup/cancel");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      mailbox_uids: ["mbx-11111111-2222-3333-4444-555555555555"],
    });
  });

  it("REPEAT cancel succeeds: nothing in results.success, and /warmup/list proves no active subscription", async () => {
    const spy = stubFetchSequence([
      { status: 200, body: IK_MAILBOX_LIST_SUCCESS },
      { status: 200, body: IK_WARMUP_CANCEL_NONE },
      { status: 200, body: IK_WARMUP_LIST_EMPTY },
    ]);
    const result = await new RealMailboxPort(CONFIG).cancelWarmup(EMAIL, "k1");

    // The goal state holds regardless of who achieved it — this is what makes
    // the crash-between-vendor-200-and-marker-write retry converge.
    expect(result.cancelled).toBe(true);
    expect(spy.mock.calls).toHaveLength(3);
    const [listUrl, listInit] = spy.mock.calls[2]!;
    expect(listUrl).toBe("https://ik.example.internal/v1/api/warmup/list");
    expect(JSON.parse((listInit as RequestInit).body as string)).toMatchObject({ status: "active", include_cancelled: false });
  });

  it("a GENUINE failure still throws (retryable) when the subscription is verifiably still active", async () => {
    const spy = stubFetchSequence([
      { status: 200, body: IK_MAILBOX_LIST_SUCCESS },
      { status: 200, body: IK_WARMUP_CANCEL_NONE },
      { status: 200, body: IK_WARMUP_LIST_ACTIVE },
    ]);
    const err = await new RealMailboxPort(CONFIG).cancelWarmup(EMAIL, "k1").catch((e) => e);

    expect(err).toBeInstanceOf(VendorError);
    expect((err as VendorError).retryable).toBe(true);
    expect((err as VendorError).message).toMatch(/still active/i);
    void spy;
  });

  it("an INCONCLUSIVE lookup throws rather than reporting a cancel that may not have happened", async () => {
    // The lookup itself failing proves nothing. Reporting success here would
    // mark a possibly-live subscription as cancelled and leak the charge — the
    // one outcome worth failing loudly for.
    const spy = stubFetchSequence([
      { status: 200, body: IK_MAILBOX_LIST_SUCCESS },
      { status: 200, body: IK_WARMUP_CANCEL_NONE },
      { status: 500, body: { error: true, message: "internal" } },
    ]);
    const err = await new RealMailboxPort(CONFIG).cancelWarmup(EMAIL, "k1").catch((e) => e);

    expect(err).toBeInstanceOf(VendorError);
    expect((err as VendorError).retryable).toBe(true);
    void spy;
  });
});
