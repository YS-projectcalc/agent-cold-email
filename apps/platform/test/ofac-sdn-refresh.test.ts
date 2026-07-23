import { beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { maybeRefreshSdnList } from "../src/ofac/sdn-refresh.js";
import { getSdnListMeta } from "../src/ofac/sdn-list.js";
import { SandboxOpsMailer } from "../src/ops-mail/sandbox-ops-mailer.js";
import sdnEmptyCsv from "./fixtures/ofac/sdn-empty.csv?raw";
import sdnMalformedCsv from "./fixtures/ofac/sdn-malformed.csv?raw";
import sdnValidCsv from "./fixtures/ofac/sdn-valid.csv?raw";
import sdnValidCsvV2 from "./fixtures/ofac/sdn-valid-v2.csv?raw";

const DAY_MS = 24 * 60 * 60 * 1000;

function fetchReturning(text: string, ok = true, status = 200): typeof fetch {
  return vi.fn(async () => new Response(text, { status: ok ? status : 500 })) as unknown as typeof fetch;
}

describe("maybeRefreshSdnList — shadow-swap + once-daily guard + fail-loud (F5)", () => {
  // D1 state persists ACROSS `it()` blocks within one test file (it's a
  // per-FILE resource, not per-test) — reset before every test so each one's
  // "fresh env" / staleness-forcing arithmetic is self-consistent regardless
  // of execution order.
  beforeEach(async () => {
    await env.DB.prepare(`DELETE FROM sdn_entries`).run();
    await env.DB.prepare(`DELETE FROM sdn_list_meta`).run();
  });

  it("a fresh env (no meta row) refreshes, swapping in the fetched entries", async () => {
    const mailer = new SandboxOpsMailer();
    const fetchImpl = fetchReturning(sdnValidCsv);
    const outcome = await maybeRefreshSdnList(env, 1_000_000, fetchImpl, mailer);

    expect(outcome).toMatchObject({ refreshed: true, reason: "refreshed", entryCount: 4 });
    const meta = await getSdnListMeta(env);
    expect(meta?.entryCount).toBe(4);
    expect(meta?.activeVersion).toBeTruthy();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(mailer.sent).toHaveLength(0); // success -> no alert
  });

  it("once-daily guard: a second call within 24h does NOT re-fetch (idempotent)", async () => {
    const mailer = new SandboxOpsMailer();
    const firstFetch = fetchReturning(sdnValidCsv);
    const now = 2_000_000;
    await maybeRefreshSdnList(env, now, firstFetch, mailer);
    expect(firstFetch).toHaveBeenCalledTimes(1);

    const secondFetch = fetchReturning(sdnValidCsv);
    const outcome = await maybeRefreshSdnList(env, now + 60_000, secondFetch, mailer); // 1 min later — still fresh
    expect(outcome).toEqual({ refreshed: false, reason: "fresh" });
    expect(secondFetch).not.toHaveBeenCalled();
  });

  it("a corrupt (malformed) fetch NEVER swaps in a bad list — keeps the prior good version and alerts", async () => {
    const mailer = new SandboxOpsMailer();
    const now = 3_000_000;
    await maybeRefreshSdnList(env, now, fetchReturning(sdnValidCsv), mailer);
    const before = await getSdnListMeta(env);
    expect(before?.entryCount).toBe(4);

    // Force staleness (>24h later) so the guard attempts a second refresh.
    const laterNow = now + DAY_MS + 60_000;
    const outcome = await maybeRefreshSdnList(env, laterNow, fetchReturning(sdnMalformedCsv), mailer);

    expect(outcome.refreshed).toBe(false);
    expect(outcome.reason).toBe("failed");
    const after = await getSdnListMeta(env);
    // The prior good list is UNCHANGED — same version, same entry count.
    expect(after?.activeVersion).toBe(before?.activeVersion);
    expect(after?.entryCount).toBe(4);
    expect(mailer.sent.some((m) => m.subject.includes("SDN list refresh failed"))).toBe(true);
  });

  it("an empty fetch ALSO keeps the prior good list and alerts", async () => {
    const mailer = new SandboxOpsMailer();
    const now = 4_000_000;
    await maybeRefreshSdnList(env, now, fetchReturning(sdnValidCsv), mailer);
    const before = await getSdnListMeta(env);

    const laterNow = now + DAY_MS + 60_000;
    const outcome = await maybeRefreshSdnList(env, laterNow, fetchReturning(sdnEmptyCsv), mailer);

    expect(outcome.reason).toBe("failed");
    const after = await getSdnListMeta(env);
    expect(after?.activeVersion).toBe(before?.activeVersion);
    expect(after?.entryCount).toBe(before?.entryCount);
  });

  it("an HTTP failure (non-2xx) ALSO keeps the prior good list and alerts", async () => {
    const mailer = new SandboxOpsMailer();
    const now = 5_000_000;
    await maybeRefreshSdnList(env, now, fetchReturning(sdnValidCsv), mailer);
    const before = await getSdnListMeta(env);

    const laterNow = now + DAY_MS + 60_000;
    const outcome = await maybeRefreshSdnList(env, laterNow, fetchReturning("", false), mailer);

    expect(outcome.reason).toBe("failed");
    const after = await getSdnListMeta(env);
    expect(after?.activeVersion).toBe(before?.activeVersion);
  });

  it("a GOOD refresh after a prior good one replaces the list (v2 fixture has 5 entries)", async () => {
    const mailer = new SandboxOpsMailer();
    const now = 6_000_000;
    await maybeRefreshSdnList(env, now, fetchReturning(sdnValidCsv), mailer);
    const before = await getSdnListMeta(env);

    const laterNow = now + DAY_MS + 60_000;
    const outcome = await maybeRefreshSdnList(env, laterNow, fetchReturning(sdnValidCsvV2), mailer);

    expect(outcome).toMatchObject({ refreshed: true, entryCount: 5 });
    const after = await getSdnListMeta(env);
    expect(after?.entryCount).toBe(5);
    expect(after?.activeVersion).not.toBe(before?.activeVersion);
  });
});
