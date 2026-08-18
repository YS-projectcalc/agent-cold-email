import { afterEach, describe, expect, it, vi } from "vitest";
import { NotActivatedError, VendorError } from "@coldstart/shared";
import { RealMailboxPort } from "../src/vendors/real/mailbox-port.js";
import {
  IK_API_KEY,
  IK_MAILBOX_ALREADY_EXISTS,
  IK_MAILBOX_BUY_SUCCESS,
  IK_MAILBOX_CANCEL_SUCCESS,
  IK_MAILBOX_CREDENTIALS_NOT_FOUND,
  IK_MAILBOX_HEALTH_NO_METRICS,
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

// The success-path test that stood here is DELETED, not updated. It stubbed an
// invented credentials payload and asserted our mapper could read it — the
// endpoint does not exist (live 2026-08-18: the gateway 404s it), so the test
// proved only that a fixture written alongside the code agrees with the code.
// See test/fixtures/inboxkit.ts's IK_MAILBOX_CREDENTIALS_NOT_FOUND.
describe("RealMailboxPort — showMailboxCredentials (I3 credential push)", () => {
  it("grades the endpoint's 404 as OPERATOR-ACTIONABLE, not 'check your inputs'", async () => {
    stubFetchSequence([
      { status: 200, body: IK_MAILBOX_LIST_SUCCESS },
      { status: 404, body: IK_MAILBOX_CREDENTIALS_NOT_FOUND },
    ]);
    const err = await new RealMailboxPort(CONFIG).showMailboxCredentials("john.doe@example-lookalike.com").catch((e) => e);
    expect(err).toBeInstanceOf(VendorError);
    // A route the vendor does not serve is not the caller's fault and is not
    // forever: someone ships the right path and the same call works.
    expect((err as VendorError).retryable).toBe(false);
    expect((err as VendorError).operatorActionable).toBe(true);
  });

  it("fails LOUD (permanent, operator-actionable) when the response carries no usable IMAP credentials", async () => {
    stubFetchSequence([{ status: 200, body: IK_MAILBOX_LIST_SUCCESS }, { status: 200, body: { data: {} } }]);
    const err = await new RealMailboxPort(CONFIG).showMailboxCredentials("john.doe@example-lookalike.com").catch((e) => e);
    expect(err).toBeInstanceOf(VendorError);
    expect((err as VendorError).retryable).toBe(false);
    expect((err as VendorError).operatorActionable).toBe(true);
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

  it("getHealth() reads the LIVE health fields and reports the three the vendor does not send as null", async () => {
    const spy = stubFetchSequence([{ status: 200, body: IK_MAILBOX_LIST_SUCCESS }, { status: 200, body: IK_MAILBOX_HEALTH_SUCCESS }]);
    const health = await new RealMailboxPort(CONFIG).getHealth("john.doe@example-lookalike.com");

    expect(health.email).toBe("john.doe@example-lookalike.com");
    expect(health.bounceRate).toBeCloseTo(0.018, 5); // bounce_rate_30d 1.8% -> fraction
    // NOT ON THE WIRE. These were 90 (from a `health_status` enum the endpoint
    // does not return), 0 and 0.982 (the complement of a bounce rate that was
    // itself NaN). The vendor reports no reputation, no complaint and no
    // placement signal, and null is how this port says so.
    expect(health.reputationScore).toBeNull();
    expect(health.complaintRate).toBeNull();
    expect(health.placementRate).toBeNull();

    const [listUrl] = spy.mock.calls[0]!;
    expect(listUrl).toBe("https://ik.example.internal/v1/api/mailboxes/list");
    const [healthUrl] = spy.mock.calls[1]!;
    expect(healthUrl).toBe("https://ik.example.internal/v1/api/email-insights/mailbox/mbx-11111111-2222-3333-4444-555555555555/health");
  });

  // THE DEFECT, PINNED (class F member F1). On the pre-fix adapter this exact
  // response produced `bounceRate: NaN` and `placementRate: NaN` — it
  // destructured `bounce_rate` from a payload that has never carried it, and
  // `Math.min(1, Math.max(0, NaN))` is NaN, so the clamp that looked like a
  // guard passed it through into a customer-facing rate.
  it("getHealth() reports NO bounce rate — never NaN, never 0 — when the vendor omits the metric", async () => {
    stubFetchSequence([{ status: 200, body: IK_MAILBOX_LIST_SUCCESS }, { status: 200, body: IK_MAILBOX_HEALTH_NO_METRICS }]);
    const health = await new RealMailboxPort(CONFIG).getHealth("john.doe@example-lookalike.com");

    expect(health.bounceRate).toBeNull();
    expect(Number.isNaN(health.bounceRate as unknown as number)).toBe(false);
  });

  // The seam itself (class F member F3): `request<T>` used to end in `return
  // body as T`, so a response that agreed with NO part of the model sailed
  // through and failed later, somewhere else, as a TypeError.
  it("getHealth() throws a graded VendorError — not a TypeError — when the response shape drifts", async () => {
    stubFetchSequence([{ status: 200, body: IK_MAILBOX_LIST_SUCCESS }, { status: 200, body: { data: { bounce_rate_30d: "not-a-number" } } }]);
    const err = await new RealMailboxPort(CONFIG).getHealth("john.doe@example-lookalike.com").catch((e) => e);

    expect(err).toBeInstanceOf(VendorError);
    expect((err as VendorError).retryable).toBe(false);
    expect((err as VendorError).operatorActionable).toBe(true);
    expect((err as VendorError).message).toContain("bounce_rate_30d");
  });

  it("getHealth() throws a graded VendorError when a 200 carries no parseable JSON body at all", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    spy.mockImplementationOnce(async () => new Response(JSON.stringify(IK_MAILBOX_LIST_SUCCESS), { status: 200, headers: { "content-type": "application/json" } }));
    spy.mockImplementationOnce(async () => new Response("<html>gateway</html>", { status: 200, headers: { "content-type": "text/html" } }));
    const err = await new RealMailboxPort(CONFIG).getHealth("john.doe@example-lookalike.com").catch((e) => e);

    expect(err).toBeInstanceOf(VendorError);
    expect((err as VendorError).message).toContain("no parseable JSON body");
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

  // IDEMPOTENCY (canon finding 2). The port contract calls a retry-after-crash
  // the normal case, and for a RELEASE the vendor holding nothing IS the goal
  // state. This used to throw a PERMANENT "inboxkit has no mailbox matching …"
  // via resolveMailboxUid, so `released_at` could never be written and the row
  // stayed billable forever.
  it("release() reports SUCCESS when the vendor already holds nothing for the address", async () => {
    const spy = stubFetchSequence([{ status: 200, body: IK_MAILBOX_LIST_EMPTY }]);
    const result = await new RealMailboxPort(CONFIG).release("john.doe@example-lookalike.com", "k1");

    expect(result).toEqual({ released: true, releasedAt: expect.any(Number) });
    // No cancel call: there is nothing left to cancel, and a second
    // /mailboxes/cancel for an unknown uid is not what "idempotent" means.
    expect(spy.mock.calls).toHaveLength(1);
  });

  it("release() treats a TERMINAL vendor state as already released", async () => {
    const cancelled = {
      ...IK_MAILBOX_LIST_SUCCESS,
      mailboxes: [{ ...IK_MAILBOX_LIST_SUCCESS.mailboxes[0], status: "scheduled_for_deletion" }],
    };
    const spy = stubFetchSequence([{ status: 200, body: cancelled }]);
    const result = await new RealMailboxPort(CONFIG).release("john.doe@example-lookalike.com", "k1");

    expect(result.released).toBe(true);
    expect(spy.mock.calls).toHaveLength(1);
  });

  it("release() does NOT read an inconclusive lookup as absence — that would strand a live paid mailbox", async () => {
    stubFetchSequence([{ status: 200, body: { error: true, message: "workspace lookup failed" } }]);
    const err = await new RealMailboxPort(CONFIG).release("john.doe@example-lookalike.com", "k1").catch((e) => e);

    expect(err).toBeInstanceOf(VendorError);
    expect((err as VendorError).retryable).toBe(true);
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
