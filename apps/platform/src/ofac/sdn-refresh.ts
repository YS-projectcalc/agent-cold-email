// G1a — fetch + once-daily refresh guard for the SDN list. Called from the
// existing 5-min ops-sweep cron (scheduled.ts) as a single self-contained
// function call — no second `[triggers] crons` entry (design line 49: "the
// piggyback is lower-friction for v1").
//
// FAIL-LOUD (F5 convention): a corrupt/empty/unreachable fetch NEVER swaps in
// a bad list — sdn-parse.ts throws on a malformed feed, swapInSdnList never
// advances `sdn_list_meta` on that throw, and this function catches it, alerts
// the founder (THROTTLED — see sdn-alert.ts's reconcileSdnAlert, class fix
// 2026-07-24), and leaves the once-daily guard's cursor UNCHANGED so the next
// 5-min sweep retries sooner than waiting a full day.
import { createOpsMailer, type OpsMailer } from "../ops-mail/ops-mailer.js";
import type { Env } from "../env.js";
import { parseSdnCsv } from "./sdn-parse.js";
import { getSdnListFetchedAt, swapInSdnList } from "./sdn-list.js";
import { reconcileSdnAlert } from "./sdn-alert.js";

// Public Treasury OFAC download — no API key, no auth (design "Founder-tunable
// knobs" table: `OFAC_LIST_URL`, overridable if OFAC moves the endpoint).
const DEFAULT_OFAC_LIST_URL = "https://www.treasury.gov/ofac/downloads/sdn.csv";

const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface SdnRefreshOutcome {
  refreshed: boolean;
  reason: "fresh" | "refreshed" | "failed";
  entryCount?: number;
  error?: string;
}

/**
 * `fetchImpl` is injectable — same pattern as every other real-vendor call
 * site in this codebase (OpsMailer, alertRegistrarUnarmed): tests inject a
 * fixture-backed fake, production uses the real global `fetch`. NEVER a live
 * treasury.gov call in tests (build brief hard rule) — the live fetch is
 * verified once at the arming session instead.
 */
export async function maybeRefreshSdnList(
  env: Env,
  nowMs: number,
  fetchImpl: typeof fetch = fetch,
  mailer: OpsMailer = createOpsMailer(env),
): Promise<SdnRefreshOutcome> {
  const fetchedAt = await getSdnListFetchedAt(env);
  if (fetchedAt !== null && nowMs - fetchedAt < REFRESH_INTERVAL_MS) {
    return { refreshed: false, reason: "fresh" };
  }

  const url = env.OFAC_LIST_URL ?? DEFAULT_OFAC_LIST_URL;
  try {
    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(`SDN.CSV fetch failed: HTTP ${res.status}`);
    const text = await res.text();
    const entries = parseSdnCsv(text);

    const listVersion = `sdn-${nowMs}`;
    await swapInSdnList(env, {
      listVersion,
      entries,
      publishedDate: new Date(nowMs).toISOString().slice(0, 10),
      fetchedAt: nowMs,
    });
    await reconcileSdnAlert(env, { success: true, detail: `direct refresh succeeded — ${entries.length} entries` }, mailer, nowMs);
    return { refreshed: true, reason: "refreshed", entryCount: entries.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("SDN list refresh failed — keeping the prior good list", err);
    await reconcileSdnAlert(env, { success: false, detail: `direct refresh: ${message}` }, mailer, nowMs);
    return { refreshed: false, reason: "failed", error: message };
  }
}
