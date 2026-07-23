import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { ingestSdnCsv, MIN_SDN_ENTRIES } from "../src/ofac/sdn-ingest.js";
import { getSdnListMeta } from "../src/ofac/sdn-list.js";
import { SandboxOpsMailer } from "../src/ops-mail/sandbox-ops-mailer.js";
import sdnEmptyCsv from "./fixtures/ofac/sdn-empty.csv?raw";
import sdnMalformedCsv from "./fixtures/ofac/sdn-malformed.csv?raw";
import sdnValidCsv from "./fixtures/ofac/sdn-valid.csv?raw"; // 4 entries — well below the floor
import sdnValidLargeCsv from "./fixtures/ofac/sdn-valid-large.csv?raw"; // 5001 entries — floor-satisfying

describe("ingestSdnCsv — droplet-relay ingest: parse/swap reuse, floor guard, fail-loud (F5)", () => {
  // D1 state persists ACROSS `it()` blocks within one test file — reset before
  // every test (same convention as ofac-sdn-refresh.test.ts).
  beforeEach(async () => {
    await env.DB.prepare(`DELETE FROM sdn_entries`).run();
    await env.DB.prepare(`DELETE FROM sdn_list_meta`).run();
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
    expect(mailer.sent.some((m) => m.subject.includes("SDN relay ingest failed (malformed)"))).toBe(true);
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
    expect(mailer.sent.some((m) => m.subject.includes("SDN relay ingest failed (below floor)"))).toBe(true);
  });

  it("idempotence — ingesting the identical CSV twice leaves exactly one active version's rows (no duplicates)", async () => {
    const mailer = new SandboxOpsMailer();
    const first = await ingestSdnCsv(env, sdnValidLargeCsv, 5_000_000, mailer);
    expect(first.ok).toBe(true);

    const second = await ingestSdnCsv(env, sdnValidLargeCsv, 5_100_000, mailer);
    expect(second.ok).toBe(true);
    // Same content -> a version BUMP (new timestamp-tagged version), not a
    // reused version string — this is the "or version bump" branch of the
    // brief's idempotence requirement.
    expect(second.listVersion).not.toBe(first.listVersion);

    const meta = await getSdnListMeta(env);
    expect(meta?.activeVersion).toBe(second.listVersion);
    expect(meta?.entryCount).toBe(5001);

    // No leftover rows from the FIRST version — swapInSdnList's post-flip
    // cleanup deletes every non-active version's rows, so the total row count
    // never grows across repeated ingests of the same content.
    const countRow = await env.DB.prepare(`SELECT COUNT(*) as c FROM sdn_entries`).first<{ c: number }>();
    expect(countRow?.c).toBe(5001);
  });
});
