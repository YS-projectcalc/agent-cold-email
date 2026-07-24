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
    await env.DB.prepare(`DELETE FROM sdn_alert_state`).run();
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
    expect(mailer.sent.some((m) => m.subject.includes("SDN list load failing"))).toBe(true);
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

  // CLASS FIX (2026-07-24, founder-reported: 160 identical emails in one day)
  // — during a persistent outage, `fetchedAt` never advances (a failure never
  // writes sdn_list_meta), so the once-daily guard's "is it due" check ALWAYS
  // falls through and every 5-min cron tick genuinely attempts a refresh. This
  // reproduces exactly that scenario end-to-end and proves the alert (not the
  // retry — retries stay per-tick, cheap and self-healing) is throttled.
  describe("alert-storm class fix — a persistent outage across MANY 5-min ticks alerts once, not per-tick", () => {
    const FIVE_MIN_MS = 5 * 60 * 1000;

    it("20 consecutive failed 5-min ticks send exactly 1 email (not 20)", async () => {
      const mailer = new SandboxOpsMailer();
      let now = 10_000_000;
      for (let tick = 0; tick < 20; tick++) {
        const outcome = await maybeRefreshSdnList(env, now, fetchReturning("", false), mailer);
        expect(outcome.reason).toBe("failed"); // confirms every tick really did attempt (the retry cadence itself)
        now += FIVE_MIN_MS;
      }
      expect(mailer.sent).toHaveLength(1);
      expect(mailer.sent[0]!.subject).toBe("[coldrig] SDN list load failing — kept prior good list");
    });

    it("a success after a failure streak sends exactly ONE recovery email, closing the loop", async () => {
      const mailer = new SandboxOpsMailer();
      let now = 20_000_000;
      for (let tick = 0; tick < 5; tick++) {
        await maybeRefreshSdnList(env, now, fetchReturning("", false), mailer);
        now += FIVE_MIN_MS;
      }
      expect(mailer.sent).toHaveLength(1); // the one first-failure alert

      const outcome = await maybeRefreshSdnList(env, now, fetchReturning(sdnValidCsv), mailer);
      expect(outcome.reason).toBe("refreshed");
      expect(mailer.sent).toHaveLength(2);
      expect(mailer.sent[1]!.subject).toBe("[coldrig] SDN list load RECOVERED");
      expect(mailer.sent[1]!.text).toContain("5 consecutive failed attempt(s)");
    });
  });
});
