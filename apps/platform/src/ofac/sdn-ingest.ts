// G1a droplet-relay (design: droplet-relay-2026-07-24) — the ARRIVING side of
// the relay. A droplet that CAN reach Treasury (routes/admin-sdn-ingest.ts's
// auth gate + tools/sdn-relay/push-sdn.sh) posts the raw SDN.CSV text here.
// Feeds the SAME parseSdnCsv -> swapInSdnList path maybeRefreshSdnList uses
// (CLAUDE.md rule c) — every existing defense stays: fail-loud parse (throws
// on a wrong column count or zero usable rows), shadow-swap atomic flip,
// keep-prior-on-failure, THROTTLED ops alert on failure (sdn-alert.ts's
// reconcileSdnAlert — class fix 2026-07-24, "born throttled" per the same
// alert-storm class that hit maybeRefreshSdnList), list-version tagging.
//
// ADDITIONAL defenses unique to this arriving path, an untrusted-relative to
// the direct Worker fetch (a stolen/leaked SDN_INGEST_TOKEN is a real threat
// model here in a way it isn't for sdn-refresh.ts's fixed Treasury URL):
//
//  1. MIN_SDN_ENTRIES — a forged TINY-but-structurally-valid CSV (right
//     shape, near-zero rows) would otherwise pass parseSdnCsv's structural
//     check and neuter screening by swapping in an almost-empty "clean"
//     list. This makes that SPECIFIC attack a no-op.
//
//  HONEST LIMIT (corrected 2026-07-24, adversary finding 2 — the original
//  comment here overstated this): MIN_SDN_ENTRIES does NOT make "stolen-token
//  abuse a no-op" in general. Two residuals it does NOT close:
//    (a) STALENESS — a stolen token could replay an OLD but genuinely
//        ≥floor-sized real list. The monotonicity guard below (2) narrows
//        this one.
//    (b) TARGETED REMOVAL — a doctored ~17k-entry list with specific names
//        surgically removed still clears the floor and would silently drop
//        those names from screening. This is FUNDAMENTAL and NOT closeable
//        by any check this code can perform: Treasury does not sign the
//        SDN.CSV feed, so there is no cryptographic way to prove a candidate
//        list is unmodified. Token secrecy (the droplet-local env file, the
//        dedicated narrow-scope secret) is legitimately the PRIMARY control
//        for this residual, not a fallback — see the honesty statement
//        (docs/research/ofac-v1-honesty-statement-2026-07-23.md) for the
//        full trust-model writeup.
//
//  2. Monotonicity guard — rejects a candidate with a suspicious entry-count
//     regression from the active list (organic SDN churn is never a large
//     single-step drop). SDN.CSV carries no reliable publication-date column
//     (sdn-parse.ts's column contract), so this uses the cheapest honest
//     signal available: entry-count sanity. This is a narrowing measure
//     against a naive stale/truncated feed, NOT a defense against (b)
//     above — a well-crafted doctored list with a plausible entry count
//     sails through this guard exactly as (b) says it must, absent a
//     signed feed.
//
//     A candidate that is byte-identical to the active list (content hash
//     match) is a DIFFERENT case, handled separately — see "unchanged"
//     below.
//
//     CLASS FIX (2026-07-27, "benign no-new-publication conflated with
//     refresh failure" — REVISED same day, fix A, per adversary NO-SHIP
//     docs/adversarial/sdn-unchanged-fix-review-2026-07-27.md; the first cut
//     of this fix was itself defective, see "WHY fetched_at must advance"
//     below): Treasury publishes no SDN updates on weekends, so the
//     droplet's daily relay re-pushes the same byte-identical CSV — that
//     used to be treated as reason:"stale"/ok:false, extending the ops-alert
//     failure streak and emailing the founder a false "SDN list NOT loading"
//     alarm every weekend. A byte-identical push is NOT a failure: it is
//     proof the droplet reached Treasury and confirmed the active list IS
//     current. It returns { ok:true, reason:"unchanged" } WITHOUT calling
//     swapInSdnList (no new version, no rows written) — but it DOES call
//     `touchSdnListFreshness` (sdn-list.ts) to advance ONLY `fetched_at`.
//
//     WHY fetched_at must advance (the actual weekend-storm fix): the
//     recurring alarm was never driven by the once-daily relay itself — it
//     is driven by the Worker's OWN 5-min direct-fetch cron
//     (maybeRefreshSdnList, sdn-refresh.ts), which 525s on EVERY attempt
//     once `fetched_at` is >24h stale (Treasury blocks Worker egress — see
//     this file's own header comment + push-sdn.sh). The FIRST version of
//     this fix deliberately left `fetched_at` untouched on "unchanged",
//     reasoning that it would let the direct refresh "keep retrying" — but
//     since that refresh ALWAYS 525s in prod, "keep retrying" meant "storm
//     every 5 minutes all weekend," and a weekend-straddling failure streak
//     also produced a false "RECOVERED" email on the next unchanged push,
//     immediately followed by a fresh un-throttled "failing" alert
//     (adversary finding 1 — worse than the original incident). Advancing
//     `fetched_at` on a verified-unchanged push satisfies exactly the
//     freshness `maybeRefreshSdnList`'s guard keys on (`nowMs - fetchedAt <
//     REFRESH_INTERVAL_MS`) — the direct refresh returns "fresh" and skips
//     its own fetch entirely for another 24h, so the 525 loop actually goes
//     quiet. The genuine-staleness backstop is PRESERVED, not weakened: if
//     the relay itself stops delivering (droplet down), `fetched_at` goes
//     stale after 24h exactly as before, the direct refresh resumes
//     attempting, 525s, and the alarm fires — co-fired proof in
//     test/ofac-sdn-storm-interaction.test.ts.
import { createOpsMailer, type OpsMailer } from "../ops-mail/ops-mailer.js";
import type { Env } from "../env.js";
import { parseSdnCsv, type ParsedSdnEntry } from "./sdn-parse.js";
import { getSdnListMeta, swapInSdnList, touchSdnListFreshness } from "./sdn-list.js";
import { reconcileSdnAlert } from "./sdn-alert.js";

// The real SDN.CSV is ~17k entries (design brief, 2026-07-24 fetch). No
// legitimate publication is ever anywhere near this small — a conservative
// floor well under the real count, but far above what a forged/truncated/
// stale feed could plausibly contain.
export const MIN_SDN_ENTRIES = 5000;

// Monotonicity guard (adversary finding 2) — a candidate whose entry count is
// more than a 10% drop from the currently active list is rejected as a
// probable stale/incomplete feed, not organic churn. OFAC's SDN list changes
// by small deltas tick-to-tick; a double-digit-percent single-step
// REGRESSION has no legitimate organic explanation. This is a sanity check,
// not a defense against a small, deliberately-crafted removal (see the module
// doc comment's residual (b) — that is fundamentally unclosable here).
const MAX_ACCEPTABLE_SHRINK_RATIO = 0.9;

export interface SdnIngestOutcome {
  ok: boolean;
  reason: "ingested" | "malformed" | "below-floor" | "stale" | "unchanged" | "write-failed";
  entryCount?: number;
  listVersion?: string;
  error?: string;
}

/**
 * `mailer` is injectable — same pattern as maybeRefreshSdnList (sdn-refresh.ts):
 * tests inject a fixture-backed fake, production uses the real OpsMailer.
 * Every EXIT of this function (success or any failure reason) goes through
 * exactly ONE `reconcileSdnAlert` call at the end — the specific reason still
 * rides in the `detail` text, but the alert-storm throttle is shared across
 * malformed/below-floor/stale/write-failed AND the direct-fetch refresh path
 * (they're the same logical "is the SDN list loading?" streak).
 */
export async function ingestSdnCsv(
  env: Env,
  csvText: string,
  nowMs: number,
  mailer: OpsMailer = createOpsMailer(env),
): Promise<SdnIngestOutcome> {
  const outcome = await ingest(env, csvText, nowMs);
  const detail =
    outcome.reason === "unchanged"
      ? `relay ingest: unchanged — candidate is byte-identical to the active list (${outcome.entryCount} entries, ${outcome.listVersion}); verified-fresh, no swap performed`
      : `relay ingest: ${outcome.error ?? `${outcome.entryCount} entries (${outcome.listVersion})`}`;
  // Single-pathed: `success` always rides `outcome.ok` (true for both
  // "ingested" and "unchanged") — only the `detail` text distinguishes them.
  await reconcileSdnAlert(env, { success: outcome.ok, detail }, mailer, nowMs);
  return outcome;
}

async function ingest(env: Env, csvText: string, nowMs: number): Promise<SdnIngestOutcome> {
  let entries: ParsedSdnEntry[];
  try {
    entries = parseSdnCsv(csvText);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("SDN relay ingest: parse failed — keeping the prior good list", err);
    return { ok: false, reason: "malformed", error: message };
  }

  if (entries.length < MIN_SDN_ENTRIES) {
    const message = `only ${entries.length} usable entries after parsing (minimum ${MIN_SDN_ENTRIES}) — a real SDN list is ~17k entries; this looks like a truncated/forged/stale feed, not a legitimate publication`;
    console.error(`SDN relay ingest: below-floor — keeping the prior good list (${message})`);
    return { ok: false, reason: "below-floor", entryCount: entries.length, error: message };
  }

  const contentHash = await sha256Hex(csvText);
  const currentMeta = await getSdnListMeta(env);
  if (currentMeta?.activeVersion) {
    if (currentMeta.contentHash && currentMeta.contentHash === contentHash) {
      // Byte-identical replay — NOT a failure (class fix 2026-07-27, fix A:
      // see the module doc comment's "WHY fetched_at must advance"). No
      // swapInSdnList (no new version, no rows written) — but DOES advance
      // fetched_at so the direct-fetch refresh's 24h freshness guard sees
      // this as current and skips its own 525-doomed fetch attempt.
      await touchSdnListFreshness(env, nowMs);
      console.log(`SDN relay ingest: unchanged (duplicate content, verified fresh) — keeping the prior good list, no swap, fetched_at advanced`);
      return { ok: true, reason: "unchanged", entryCount: entries.length, listVersion: currentMeta.activeVersion };
    }
    const minAcceptable = Math.floor(currentMeta.entryCount * MAX_ACCEPTABLE_SHRINK_RATIO);
    if (entries.length < minAcceptable) {
      const dropPct = Math.round((1 - entries.length / currentMeta.entryCount) * 100);
      const message = `candidate has ${entries.length} entries, a ${dropPct}% drop from the active list's ${currentMeta.entryCount} — organic SDN list churn is never this large a single-step regression; likely a stale/incomplete feed`;
      console.error(`SDN relay ingest: stale (entry-count regression) — keeping the prior good list (${message})`);
      return { ok: false, reason: "stale", entryCount: entries.length, error: message };
    }
  }

  const listVersion = `sdn-relay-${nowMs}`;
  try {
    await swapInSdnList(env, {
      listVersion,
      entries,
      publishedDate: new Date(nowMs).toISOString().slice(0, 10),
      fetchedAt: nowMs,
      contentHash,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("SDN relay ingest: D1 write failed — keeping the prior good list", err);
    return { ok: false, reason: "write-failed", error: message };
  }

  return { ok: true, reason: "ingested", entryCount: entries.length, listVersion };
}

async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
