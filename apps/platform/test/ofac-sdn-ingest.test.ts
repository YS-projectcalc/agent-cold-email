import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { ingestSdnCsv, MIN_SDN_ENTRIES } from "../src/ofac/sdn-ingest.js";
import { getSdnListMeta } from "../src/ofac/sdn-list.js";
import { SandboxOpsMailer } from "../src/ops-mail/sandbox-ops-mailer.js";
import sdnEmptyCsv from "./fixtures/ofac/sdn-empty.csv?raw";
import sdnMalformedCsv from "./fixtures/ofac/sdn-malformed.csv?raw";
import sdnValidCsv from "./fixtures/ofac/sdn-valid.csv?raw"; // 4 entries — well below the floor
import sdnValidLargeCsv from "./fixtures/ofac/sdn-valid-large.csv?raw"; // 5001 entries — floor-satisfying
import sdnValidLarge2Csv from "./fixtures/ofac/sdn-valid-large2.csv?raw"; // 10000 entries, DIFFERENT content — for the entry-count-regression case

describe("ingestSdnCsv — droplet-relay ingest: parse/swap reuse, floor guard, fail-loud (F5)", () => {
  // D1 state persists ACROSS `it()` blocks within one test file — reset before
  // every test (same convention as ofac-sdn-refresh.test.ts).
  beforeEach(async () => {
    await env.DB.prepare(`DELETE FROM sdn_entries`).run();
    await env.DB.prepare(`DELETE FROM sdn_list_meta`).run();
    await env.DB.prepare(`DELETE FROM sdn_alert_state`).run();
  });

  it("a floor-satisfying valid CSV ingests, tagged sdn-relay-<ts>, no alert", async () => {
    const mailer = new SandboxOpsMailer();
    const outcome = await ingestSdnCsv(env, sdnValidLargeCsv, 1_000_000, mailer);

    expect(outcome).toMatchObject({ ok: true, reason: "ingested", entryCount: 5001 });
    expect(outcome.listVersion).toBe("sdn-relay-1000000");
    const meta = await getSdnListMeta(env);
    expect(meta?.entryCount).toBe(5001);
    expect(meta?.activeVersion).toBe("sdn-relay-1000000");
    expect(mailer.sent).toHaveLength(0);
  });

  it("a malformed CSV is rejected — keeps the prior good list and alerts", async () => {
    const mailer = new SandboxOpsMailer();
    await ingestSdnCsv(env, sdnValidLargeCsv, 2_000_000, mailer);
    const before = await getSdnListMeta(env);
    expect(before?.entryCount).toBe(5001);

    const outcome = await ingestSdnCsv(env, sdnMalformedCsv, 2_100_000, mailer);

    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe("malformed");
    const after = await getSdnListMeta(env);
    expect(after?.activeVersion).toBe(before?.activeVersion);
    expect(after?.entryCount).toBe(5001);
    expect(mailer.sent.some((m) => m.subject.includes("SDN list load failing"))).toBe(true);
  });

  it("an empty CSV is rejected the same way", async () => {
    const mailer = new SandboxOpsMailer();
    await ingestSdnCsv(env, sdnValidLargeCsv, 3_000_000, mailer);
    const before = await getSdnListMeta(env);

    const outcome = await ingestSdnCsv(env, sdnEmptyCsv, 3_100_000, mailer);

    expect(outcome.reason).toBe("malformed");
    const after = await getSdnListMeta(env);
    expect(after?.activeVersion).toBe(before?.activeVersion);
    expect(after?.entryCount).toBe(before?.entryCount);
  });

  // MIN_SDN_ENTRIES FLOOR GUARD — the adversary-anticipated attack this guard
  // closes: a forged tiny-but-valid CSV (right shape, near-zero rows) would
  // otherwise pass parseSdnCsv's structural check and neuter screening. This
  // is the RED-proof test (spec-builder protocol): see the builder's report
  // for the revert-fail-restore quote proving this assertion is load-bearing,
  // not vacuous.
  it("a well-formed but below-floor CSV (4 entries) is REJECTED, not swapped in", async () => {
    const mailer = new SandboxOpsMailer();
    await ingestSdnCsv(env, sdnValidLargeCsv, 4_000_000, mailer);
    const before = await getSdnListMeta(env);
    expect(before?.entryCount).toBe(5001);

    const outcome = await ingestSdnCsv(env, sdnValidCsv, 4_100_000, mailer);

    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe("below-floor");
    expect(outcome.entryCount).toBe(4);
    expect(outcome.error).toContain(String(MIN_SDN_ENTRIES));
    const after = await getSdnListMeta(env);
    // The prior (large, legitimate) list is UNCHANGED — a stolen-token
    // forged-CSV attack ends as a no-op, never a swap.
    expect(after?.activeVersion).toBe(before?.activeVersion);
    expect(after?.entryCount).toBe(5001);
    expect(mailer.sent.some((m) => m.subject.includes("SDN list load failing"))).toBe(true);
  });

  // Idempotence — ingesting the identical CSV twice must never leave
  // duplicate active lists. UPDATED (adversary finding 2, monotonicity guard
  // 2026-07-24): the SECOND identical ingest is now explicitly REJECTED as a
  // stale duplicate-content replay (not silently accepted as a version bump)
  // — a stronger form of the same "clean no-op" guarantee: byte-identical
  // resubmission adds no fresher data and would only reset the refresh
  // clock, so the guard says so instead of pretending it's a real update.
  it("idempotence — re-ingesting the IDENTICAL CSV is rejected as a stale duplicate (no version bump, no duplicate rows)", async () => {
    const mailer = new SandboxOpsMailer();
    const first = await ingestSdnCsv(env, sdnValidLargeCsv, 5_000_000, mailer);
    expect(first.ok).toBe(true);

    const second = await ingestSdnCsv(env, sdnValidLargeCsv, 5_100_000, mailer);
    expect(second).toMatchObject({ ok: false, reason: "stale" });
    expect(second.error).toContain("byte-identical");

    const meta = await getSdnListMeta(env);
    expect(meta?.activeVersion).toBe(first.listVersion); // unchanged — no version bump
    expect(meta?.entryCount).toBe(5001);

    const countRow = await env.DB.prepare(`SELECT COUNT(*) as c FROM sdn_entries`).first<{ c: number }>();
    expect(countRow?.c).toBe(5001); // no duplicate rows from the rejected re-ingest
  });

  // Scope addition (2026-07-24, "born throttled" requirement): the ingest
  // alert MUST share the SAME alert-storm throttle as maybeRefreshSdnList —
  // repeated failing ingests (e.g. a droplet retried manually, or a bad CSV
  // pushed several times in a row) must alert once, not once per attempt.
  describe("alert throttle — the ingest failure alert is born throttled", () => {
    it("10 consecutive malformed-CSV ingests send exactly 1 email (not 10)", async () => {
      const mailer = new SandboxOpsMailer();
      let now = 6_000_000;
      for (let i = 0; i < 10; i++) {
        const outcome = await ingestSdnCsv(env, sdnMalformedCsv, now, mailer);
        expect(outcome.ok).toBe(false); // confirms every call really did attempt
        now += 60_000;
      }
      expect(mailer.sent).toHaveLength(1);
      expect(mailer.sent[0]!.subject).toBe("[coldrig] SDN list load failing — kept prior good list");
    });

    it("a floor-satisfying ingest after a failure streak sends exactly ONE recovery email", async () => {
      const mailer = new SandboxOpsMailer();
      let now = 7_000_000;
      for (let i = 0; i < 3; i++) {
        await ingestSdnCsv(env, sdnMalformedCsv, now, mailer);
        now += 60_000;
      }
      expect(mailer.sent).toHaveLength(1);

      const outcome = await ingestSdnCsv(env, sdnValidLargeCsv, now, mailer);
      expect(outcome.ok).toBe(true);
      expect(mailer.sent).toHaveLength(2);
      expect(mailer.sent[1]!.subject).toBe("[coldrig] SDN list load RECOVERED");
      expect(mailer.sent[1]!.text).toContain("3 consecutive failed attempt(s)");
    });
  });

  // Adversary finding 2 (docs/adversarial/sdn-relay-review-2026-07-24.md) —
  // monotonicity guard: reject a candidate that looks like a stale replay
  // (byte-identical content) or a suspicious entry-count regression from the
  // active list, vs a genuinely fresh/different-but-legitimate update.
  describe("monotonicity guard — rejects stale replay, accepts genuine fresh updates", () => {
    it("a byte-identical re-ingest of the CURRENTLY active content is rejected as stale (covered above by the idempotence test) — sanity: a DIFFERENT-content, SAME-size update is accepted", async () => {
      const first = await ingestSdnCsv(env, sdnValidLargeCsv, 8_000_000); // 5001 entries
      expect(first.ok).toBe(true);

      // A different, still-floor-satisfying list of a SIMILAR size (not a
      // >10% drop) — a genuine fresh publication must still go through.
      const second = await ingestSdnCsv(env, sdnValidLarge2Csv, 8_100_000); // 10000 entries, different content
      expect(second).toMatchObject({ ok: true, reason: "ingested", entryCount: 10000 });
      const meta = await getSdnListMeta(env);
      expect(meta?.activeVersion).toBe(second.listVersion);
      expect(meta?.entryCount).toBe(10000);
    });

    it("a candidate with a suspicious entry-count REGRESSION (>10% drop) from the active list is REJECTED, even with different content", async () => {
      const first = await ingestSdnCsv(env, sdnValidLarge2Csv, 9_000_000); // 10000 entries — becomes "current"
      expect(first.ok).toBe(true);

      // sdnValidLargeCsv (5001 entries, DIFFERENT content than sdnValidLarge2Csv)
      // is a ~50% drop from 10000 — organic SDN churn is never this large a
      // single-step regression; this must be rejected as stale, not accepted.
      const second = await ingestSdnCsv(env, sdnValidLargeCsv, 9_100_000);
      expect(second).toMatchObject({ ok: false, reason: "stale", entryCount: 5001 });
      expect(second.error).toContain("drop");

      const meta = await getSdnListMeta(env);
      expect(meta?.activeVersion).toBe(first.listVersion); // unchanged
      expect(meta?.entryCount).toBe(10000);
    });

    it("the FIRST-EVER ingest (no prior active list) is NEVER rejected by the monotonicity guard — nothing to compare against", async () => {
      const outcome = await ingestSdnCsv(env, sdnValidLargeCsv, 8_500_000);
      expect(outcome).toMatchObject({ ok: true, reason: "ingested" });
    });
  });
});
