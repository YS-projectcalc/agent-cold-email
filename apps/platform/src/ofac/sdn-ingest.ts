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
// ADDITIONAL defense unique to this arriving path (adversary-anticipated
// attack): a forged tiny-but-valid CSV (right shape, near-zero rows) would
// otherwise pass parseSdnCsv's structural check and neuter screening by
// swapping in an almost-empty "clean" list. MIN_SDN_ENTRIES makes stolen-token
// abuse a no-op — a legitimate SDN list can never be this small.
import { createOpsMailer, type OpsMailer } from "../ops-mail/ops-mailer.js";
import type { Env } from "../env.js";
import { parseSdnCsv, type ParsedSdnEntry } from "./sdn-parse.js";
import { swapInSdnList } from "./sdn-list.js";
import { reconcileSdnAlert } from "./sdn-alert.js";

// The real SDN.CSV is ~17k entries (design brief, 2026-07-24 fetch). No
// legitimate publication is ever anywhere near this small — a conservative
// floor well under the real count, but far above what a forged/truncated/
// stale feed could plausibly contain.
export const MIN_SDN_ENTRIES = 5000;

export interface SdnIngestOutcome {
  ok: boolean;
  reason: "ingested" | "malformed" | "below-floor" | "write-failed";
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
 * malformed/below-floor/write-failed AND the direct-fetch refresh path
 * (they're the same logical "is the SDN list loading?" streak).
 */
export async function ingestSdnCsv(
  env: Env,
  csvText: string,
  nowMs: number,
  mailer: OpsMailer = createOpsMailer(env),
): Promise<SdnIngestOutcome> {
  const outcome = await ingest(env, csvText, nowMs);
  await reconcileSdnAlert(
    env,
    { success: outcome.ok, detail: `relay ingest: ${outcome.error ?? `${outcome.entryCount} entries (${outcome.listVersion})`}` },
    mailer,
    nowMs,
  );
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

  const listVersion = `sdn-relay-${nowMs}`;
  try {
    await swapInSdnList(env, {
      listVersion,
      entries,
      publishedDate: new Date(nowMs).toISOString().slice(0, 10),
      fetchedAt: nowMs,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("SDN relay ingest: D1 write failed — keeping the prior good list", err);
    return { ok: false, reason: "write-failed", error: message };
  }

  return { ok: true, reason: "ingested", entryCount: entries.length, listVersion };
}
