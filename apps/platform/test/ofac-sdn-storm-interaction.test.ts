import { beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { ingestSdnCsv } from "../src/ofac/sdn-ingest.js";
import { maybeRefreshSdnList } from "../src/ofac/sdn-refresh.js";
import { SandboxOpsMailer } from "../src/ops-mail/sandbox-ops-mailer.js";
import sdnValidLargeCsv from "./fixtures/ofac/sdn-valid-large.csv?raw";

// Adversary NO-SHIP (docs/adversarial/sdn-unchanged-fix-review-2026-07-27.md,
// finding 1 + finding 4): the "unchanged" relabel (sdn-ingest.ts) was tested
// in ISOLATION only — no test ever co-fired it against the Worker's OWN
// 5-min direct-refresh cron (maybeRefreshSdnList, sdn-refresh.ts), which is
// the ACTUAL source of the reported weekend alert storm (Treasury 525s every
// Worker-origin fetch once `fetched_at` is >24h stale). This file is that
// missing co-run — it proves fix A (touchSdnListFreshness advancing
// `fetched_at` on a verified-unchanged push) actually quiets the direct
// refresh, rather than merely relabeling the relay's own outcome.
const FIVE_MIN_MS = 5 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Always 525s — the real prod condition (Treasury blocks Worker egress;
 * see admin-sdn-ingest.ts's header comment + push-sdn.sh). A fresh mock per
 * call so `toHaveBeenCalledTimes` assertions (if ever added) stay per-call. */
function always525(): typeof fetch {
  return vi.fn(async () => new Response("", { status: 525 })) as unknown as typeof fetch;
}

describe("weekend-storm interaction — direct-refresh 5-min cron co-firing with the daily droplet relay (fix A)", () => {
  beforeEach(async () => {
    await env.DB.prepare(`DELETE FROM sdn_entries`).run();
    await env.DB.prepare(`DELETE FROM sdn_list_meta`).run();
    await env.DB.prepare(`DELETE FROM sdn_alert_state`).run();
  });

  it("a daily unchanged relay push keeps the direct-refresh 525 loop quiet across a simulated weekend — no alert storm, no false RECOVERED/failing flap — and the genuine-staleness backstop still fires once the relay stops", async () => {
    const mailer = new SandboxOpsMailer();
    let now = 0;

    // Friday: a real content ingest establishes the baseline (fetched_at = 0).
    const seed = await ingestSdnCsv(env, sdnValidLargeCsv, now, mailer);
    expect(seed.ok).toBe(true);
    expect(mailer.sent).toHaveLength(0);

    // Two simulated "weekend" days. Each day: the direct-refresh 5-min cron
    // ticks at a few representative offsets (just-after-reset, midday,
    // just-before-staleness) — Treasury 525s every attempt — then, once a
    // day, the droplet relay re-pushes the byte-identical CSV BEFORE the 24h
    // freshness window would otherwise lapse.
    const tickOffsetsMs = [FIVE_MIN_MS, 12 * 60 * 60 * 1000, DAY_MS - FIVE_MIN_MS];
    for (let day = 1; day <= 2; day++) {
      const dayStart = now;
      for (const offset of tickOffsetsMs) {
        const tickNow = dayStart + offset;
        const refreshOutcome = await maybeRefreshSdnList(env, tickNow, always525(), mailer);
        // (c) — as long as the relay keeps touching fetched_at daily, the
        // direct refresh must see "fresh" and never actually attempt/fail.
        expect(refreshOutcome).toEqual({ refreshed: false, reason: "fresh" });
      }
      // The relay's daily push lands right at the 24h mark, resetting the
      // freshness window before the direct refresh would ever see staleness.
      now = dayStart + DAY_MS;
      const relayOutcome = await ingestSdnCsv(env, sdnValidLargeCsv, now, mailer);
      expect(relayOutcome).toMatchObject({ ok: true, reason: "unchanged" });
    }

    // (a) no alert storm, (b) no false RECOVERED/failing flap — across 2
    // simulated days of direct-refresh ticks + daily relay pushes, ZERO
    // emails: the direct refresh never actually attempted/failed (always
    // "fresh"), so no failure streak ever existed for an "unchanged" push to
    // falsely "recover".
    expect(mailer.sent).toHaveLength(0);

    // (d) backstop — the relay STOPS delivering (e.g. droplet down). Once
    // `fetched_at` is genuinely >24h stale, the direct refresh resumes
    // attempting and hits the real 525 failure path, alerting exactly as
    // before this fix — the genuine-staleness alarm is NOT weakened.
    const afterRelayStops = now + DAY_MS + FIVE_MIN_MS;
    const backstopOutcome = await maybeRefreshSdnList(env, afterRelayStops, always525(), mailer);
    expect(backstopOutcome.reason).toBe("failed");
    expect(mailer.sent.some((m) => m.subject.includes("SDN list load failing"))).toBe(true);
  });
});
