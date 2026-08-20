import { afterEach, describe, expect, it, vi } from "vitest";
import { VendorError } from "@coldstart/shared";
import { InboxKitClient, INBOXKIT_MAX_ATTEMPTS } from "../src/vendors/real/inboxkit-client.js";
import { IK_API_KEY, IK_WORKSPACE_ID } from "./fixtures/inboxkit.js";

// S3 (docs/adversarial/scale-readiness-audit-2026-08-17.md) — the client had a
// 30s timeout and NOTHING else against a documented 10 req/min bulk limit:
// `mapInboxKitError` graded 429 retryable, but nothing ever retried, and
// `Retry-After` was not read anywhere in the vendors tree. The mailbox-readiness
// ladder's single 2-second backoff is shorter than the 6s window one request
// costs at that limit, so a 429 retried straight into another 429 and the saga
// failed. The audit measured this biting at TWO concurrent checkouts.

const CONFIG = { apiKey: IK_API_KEY, workspaceId: IK_WORKSPACE_ID, baseUrl: "https://ik.example.internal/v1/api" };

/** Records what the client WOULD have slept, without a test ever waiting. */
function recordingSleeper() {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number) => void waits.push(ms) };
}

function client(sleep: (ms: number) => Promise<void>) {
  return new InboxKitClient({ ...CONFIG, sleep });
}

/** Queues one response (or thrown error) per call, in order. */
function stubResponses(...responses: Array<{ status: number; body?: unknown; headers?: Record<string, string> } | Error>) {
  let call = 0;
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    const next = responses[Math.min(call, responses.length - 1)]!;
    call++;
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next.body ?? { error: false }), {
      status: next.status,
      headers: { "content-type": "application/json", ...next.headers },
    });
  });
  return spy;
}

afterEach(() => vi.restoreAllMocks());

describe("S3 — a 429 is retried on the vendor's own schedule", () => {
  it("honors Retry-After (delta-seconds) and succeeds on the retry", async () => {
    const spy = stubResponses(
      { status: 429, body: { error: true, message: "rate limited" }, headers: { "retry-after": "4" } },
      { status: 200, body: { error: false, ok: true } },
    );
    const { waits, sleep } = recordingSleeper();

    const out = await client(sleep).request<{ ok: boolean }>("buyMailbox", "POST", "/mailboxes/buy");

    expect(out).toEqual({ error: false, ok: true });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(waits).toEqual([4000]); // the vendor's number, not ours
  });

  it("honors Retry-After given as an HTTP-date", async () => {
    const when = new Date(Date.now() + 3000).toUTCString();
    stubResponses(
      { status: 429, body: { error: true }, headers: { "retry-after": when } },
      { status: 200, body: { error: false } },
    );
    const { waits, sleep } = recordingSleeper();

    await client(sleep).request("listDomains", "GET", "/domains/list");

    expect(waits).toHaveLength(1);
    // Derived from a wall-clock delta, so assert the band rather than the value.
    expect(waits[0]).toBeGreaterThan(1000);
    expect(waits[0]).toBeLessThanOrEqual(3000);
  });

  it("backs off with JITTER when the vendor sends no Retry-After", async () => {
    stubResponses({ status: 429, body: { error: true } }, { status: 200, body: { error: false } });
    const { waits, sleep } = recordingSleeper();

    await client(sleep).request("op", "GET", "/account");

    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeGreaterThan(0);
    // Jittered, so it must not be the raw base delay every time — bounded above
    // by the base for full jitter.
    expect(waits[0]).toBeLessThanOrEqual(2000);
  });
});

describe("S3 — the retry is BOUNDED, and exhausting it never grades permanent", () => {
  it("stops after a fixed number of attempts against a vendor that only ever 429s", async () => {
    const spy = stubResponses({ status: 429, body: { error: true, message: "rate limited" } });
    const { sleep } = recordingSleeper();

    const err = await client(sleep)
      .request("buyMailbox", "POST", "/mailboxes/buy")
      .catch((e: unknown) => e);

    expect(spy).toHaveBeenCalledTimes(INBOXKIT_MAX_ATTEMPTS);
    expect(err).toBeInstanceOf(VendorError);
    // THE GRADING CONTRACT (class A, class-sweep-vendor-truth-2026-08-18.md): a
    // 429 is transient. Exhausting OUR retry budget must not convert the
    // vendor's "later" into "check your inputs" — the customer's agent reads
    // that and disables its retry loop.
    expect((err as VendorError).retryable).toBe(true);
    expect((err as VendorError).operatorActionable).toBe(false);
  });

  it("does not sleep on an absurd Retry-After — it fails fast, still retryable", async () => {
    const spy = stubResponses({ status: 429, body: { error: true }, headers: { "retry-after": "3600" } });
    const { waits, sleep } = recordingSleeper();

    const err = await client(sleep)
      .request("buyMailbox", "POST", "/mailboxes/buy")
      .catch((e: unknown) => e);

    // An hour is longer than any caller's budget; waiting it out would wedge the
    // saga far worse than returning a retryable refusal to the layer above.
    expect(waits).toEqual([]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect((err as VendorError).retryable).toBe(true);
  });
});

// THE MONEY RULE. A 429 is an explicit REFUSAL — the vendor did nothing, so
// re-sending cannot double-buy. Every other failure mode is ambiguous: a 500 or
// a dropped socket on POST /mailboxes/buy may well have bought the mailbox, and
// a blind retry there is a double charge with no idempotency key to collapse it.
describe("S3 — only an explicit refusal is retried, never an ambiguous failure", () => {
  it("does NOT retry a 5xx on a money-out call", async () => {
    const spy = stubResponses({ status: 502, body: { error: true, message: "bad gateway" } });
    const { waits, sleep } = recordingSleeper();

    const err = await client(sleep)
      .request("buyMailbox", "POST", "/mailboxes/buy")
      .catch((e: unknown) => e);

    expect(spy).toHaveBeenCalledTimes(1); // exactly one charge attempt
    expect(waits).toEqual([]);
    expect((err as VendorError).retryable).toBe(true); // still transient, for the CALLER to decide
  });

  it("does NOT retry a network throw", async () => {
    const spy = stubResponses(new Error("socket hang up"));
    const { sleep } = recordingSleeper();

    await client(sleep)
      .request("buyMailbox", "POST", "/mailboxes/buy")
      .catch(() => undefined);

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry a 402/403 — an operator clears those, a retry cannot", async () => {
    const spy = stubResponses({ status: 402, body: { error: true, message: "Insufficient wallet balance" } });
    const { sleep } = recordingSleeper();

    const err = await client(sleep)
      .request("buyMailbox", "POST", "/mailboxes/buy")
      .catch((e: unknown) => e);

    expect(spy).toHaveBeenCalledTimes(1);
    expect((err as VendorError).retryable).toBe(false);
    expect((err as VendorError).operatorActionable).toBe(true);
  });
});

describe("S3 — one client does not fan out concurrent requests at the vendor", () => {
  it("serializes overlapping calls instead of bursting them", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return new Response(JSON.stringify({ error: false }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const { sleep } = recordingSleeper();
    const c = client(sleep);

    await Promise.all([
      c.request("op", "GET", "/account"),
      c.request("op", "GET", "/account"),
      c.request("op", "GET", "/account"),
    ]);

    expect(maxInFlight).toBe(1);
  });

  it("a throwing call does not wedge the queue behind it", async () => {
    const spy = stubResponses(
      { status: 402, body: { error: true, message: "Insufficient wallet balance" } },
      { status: 200, body: { error: false, ok: true } },
    );
    const { sleep } = recordingSleeper();
    const c = client(sleep);

    await c.request("op", "POST", "/mailboxes/buy").catch(() => undefined);
    // If the failure left the serialization chain rejected, this would never resolve.
    await expect(c.request<{ ok: boolean }>("op", "GET", "/account")).resolves.toEqual({ error: false, ok: true });
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
