import { beforeEach, describe, expect, it } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { reconcileAlerts } from "../src/admin/watchtower.js";
import { watchtowerStub } from "../src/admin/watchtower-infra.js";
import { MAX_ANNOUNCED_KEYS_PER_EPISODE } from "../src/admin/watchtower-policy.js";
import type { CheckResult } from "../src/admin/watchtower-alerts.js";
import { SandboxOpsMailer } from "../src/ops-mail/sandbox-ops-mailer.js";

// THE ESCAPE — a materiality key lets the machine tell a REPEAT from an
// ESCALATION (alert-state design §1, test-plan items 4, 5, 8, 13).
//
// The defect: inside an announced episode the machine compared a two-valued
// healthy/unhealthy status and NOTHING else. `last_detail` was overwritten and
// never read, so a second, genuinely worse condition under the same check name
// reached the founder as an edited string on an already-suppressed row. The
// naive fix — escape on `last_detail !== detail` — is worse, because every
// detail string in this codebase embeds an error message, a JSON body or a
// per-tick count, so the escape fires on every tick. Both arms are asserted
// here: a test that only reds on HEAD does not pin the mechanism.

const T0 = 1_800_000_000_000;
const SWEEP = 300_000;
const HOUR = 3_600_000;

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM watchtower_state").run();
  await runInDurableObject(watchtowerStub(env), async (_instance, state) => {
    await state.storage.deleteAll();
    await state.storage.deleteAlarm();
  });
});

function bad(name: string, materiality: string, detail: string): CheckResult {
  return { name, healthy: false, materiality, detail };
}

const subjectsOf = (mailer: SandboxOpsMailer) => mailer.sent.map((m) => m.subject);

describe("item 4 — alternating modes, with BOTH red arms", () => {
  // The exemplar: a tenant DO alternating between two failure modes every tick.
  // On HEAD the second mode is never announced at all (one email, then silence
  // for the life of the episode). On the naive `last_detail !== detail` escape
  // the same 13 ticks produce 13 emails, because the detail carries `errMsg`.
  const CHECK = "tenant_do_wedged:ten_alternating";

  it("announces the second MODE once, and says nothing about the other 11 ticks", async () => {
    const mailer = new SandboxOpsMailer();
    const actions: string[] = [];
    for (let i = 0; i < 13; i++) {
      // Same two modes, alternating — and the DETAIL differs on every single
      // tick, because it embeds the vendor's own message.
      const wedged = i % 2 === 0;
      const result = bad(
        CHECK,
        wedged ? "rpc_unreachable" : "storage_throw",
        wedged ? `Durable Object threw: connection reset (attempt ${i})` : `Durable Object threw: storage read failed (attempt ${i})`,
      );
      const [outcome] = await reconcileAlerts(env, mailer, [result], T0 + i * SWEEP);
      actions.push(outcome!.action);
    }

    // Confirmed at tick 1 on mode A; ESCALATED at tick 2 for mode B, which is
    // genuinely different and genuinely worth an email. Everything after that is
    // a repeat of one of the two, and says nothing new.
    expect(actions.slice(0, 3)).toEqual(["pending", "alerted", "escalated"]);
    expect(actions.slice(3).every((a) => a === "suppressed")).toBe(true);
    expect(mailer.sent).toHaveLength(2);
  });

  it("RED ARM 1 (HEAD) — a status-only comparison never announces the second mode", async () => {
    // Simulates HEAD by giving both modes the SAME key: that is exactly what a
    // two-valued healthy/unhealthy comparison sees. One email for 13 ticks of a
    // fault that changed shape halfway through.
    const mailer = new SandboxOpsMailer();
    for (let i = 0; i < 13; i++) {
      await reconcileAlerts(env, mailer, [bad(CHECK, "rpc_unreachable", `threw (attempt ${i})`)], T0 + i * SWEEP);
    }
    expect(mailer.sent).toHaveLength(1);
  });

  it("RED ARM 2 (the naive detail escape) — keying on the DETAIL storms at 13", async () => {
    // Simulates `last_detail !== detail` by keying on the detail string itself.
    // The cap is what stops it being 13, and the cap exists precisely because
    // the bound must not depend on every key derivation being right.
    const mailer = new SandboxOpsMailer();
    for (let i = 0; i < 13; i++) {
      await reconcileAlerts(env, mailer, [bad(CHECK, `detail-${i}`, `threw (attempt ${i})`)], T0 + i * SWEEP);
    }
    // Without the cap this is 13. With it, the storm is bounded at the cap — and
    // this is the mis-derived-key case the cap's strict inequality is FOR.
    expect(mailer.sent.length).toBeLessThanOrEqual(MAX_ANNOUNCED_KEYS_PER_EPISODE);
    expect(mailer.sent.length).toBeGreaterThan(2);
  });
});

describe("item 5 — failure_signals counts in the detail, bands in the key", () => {
  const CHECK = "failure_signals";

  it("13 ticks at counts 3..15 is ONE email; crossing to 120 is one more", async () => {
    const mailer = new SandboxOpsMailer();
    for (let i = 0; i < 13; i++) {
      const failed = 3 + i;
      await reconcileAlerts(env, mailer, [bad(CHECK, "failed_elevated", `${failed} terminal-failed send(s) in the last 60 min`)], T0 + i * SWEEP);
    }
    expect(mailer.sent).toHaveLength(1);

    // An order-of-magnitude jump IS a different condition and does escalate.
    // LOSS, STATED (§1.2): 3 -> 15 no longer escalates; 3 -> 120 does.
    await reconcileAlerts(env, mailer, [bad(CHECK, "failed_severe", "120 terminal-failed send(s) in the last 60 min")], T0 + 13 * SWEEP);
    expect(mailer.sent).toHaveLength(2);
    expect(subjectsOf(mailer)).toEqual(["[coldrig] Failure signals: UNHEALTHY", "[coldrig] Failure signals: UNHEALTHY"]);
  });
});

describe("item 8 — the cap fail-safe, and its disclosure", () => {
  const CHECK = "tenant_do_wedged:ten_capped";

  it("a fresh key every tick emails exactly the cap, then counts the overflow", async () => {
    const mailer = new SandboxOpsMailer();
    for (let i = 0; i < 12; i++) {
      await reconcileAlerts(env, mailer, [bad(CHECK, `mis-derived-${i}`, `threw ${i}`)], T0 + i * SWEEP);
    }
    // Confirm (tick 1) + escalations up to the cap. The ledger holds exactly
    // MAX_ANNOUNCED_KEYS_PER_EPISODE keys and counts the rest.
    expect(mailer.sent).toHaveLength(MAX_ANNOUNCED_KEYS_PER_EPISODE);

    const row = await env.DB.prepare(`SELECT announced_keys FROM watchtower_state WHERE check_name = ?`)
      .bind(CHECK)
      .first<{ announced_keys: string }>();
    const ledger = JSON.parse(row!.announced_keys) as { keys: string[]; overflow: number };
    expect(ledger.keys).toHaveLength(MAX_ANNOUNCED_KEYS_PER_EPISODE);
    expect(ledger.overflow).toBe(12 - 1 - MAX_ANNOUNCED_KEYS_PER_EPISODE);
  });

  it("the next LADDER email discloses that the episode holds more than it announced", async () => {
    const mailer = new SandboxOpsMailer();
    for (let i = 0; i < 12; i++) {
      await reconcileAlerts(env, mailer, [bad(CHECK, `mis-derived-${i}`, `threw ${i}`)], T0 + i * SWEEP);
    }
    const beforeLadder = mailer.sent.length;
    // Past the first re-alert gap: the ladder fires and carries the overflow.
    await reconcileAlerts(env, mailer, [bad(CHECK, "mis-derived-0", "still throwing")], T0 + 7 * HOUR);
    expect(mailer.sent).toHaveLength(beforeLadder + 1);
    expect(mailer.sent.at(-1)!.text).toContain("further distinct condition(s) on this check were not announced separately");
  });
});

describe("item 13 (gate constraint 2) — LADDER-FIRST: the cap must not delete the ladder", () => {
  // THE REGRESSION THIS PINS. Under escape-FIRST ordering a cap-suppressed tick
  // was terminal, so an episode that hit the cap and stayed broken went silent
  // FOREVER — 5 emails and then nothing, on a check that is still down. The
  // ladder row is evaluated first and the cap is the fall-through after it
  // declines, so a permanently broken check keeps its daily reminder.
  const CHECK = "tenant_do_wedged:ten_thirty_days";

  it("30 days at the cap with a churning key emits ~30 ladder emails, not 5", async () => {
    const mailer = new SandboxOpsMailer();
    let tick = 0;
    // Five minutes apart for 30 days. The key CHURNS every tick (a deliberately
    // mis-derived key), so every tick is a cap candidate.
    for (let at = T0; at <= T0 + 30 * 24 * HOUR; at += SWEEP, tick++) {
      await reconcileAlerts(env, mailer, [bad(CHECK, `churn-${tick}`, `threw ${tick}`)], at);
    }

    // The confirm + the cap's escalations + one re-alert at +6h + a daily one
    // thereafter. The number that matters is that it keeps going for 30 days.
    const ladderEmails = mailer.sent.length - MAX_ANNOUNCED_KEYS_PER_EPISODE;
    expect(ladderEmails).toBeGreaterThanOrEqual(29);
    expect(ladderEmails).toBeLessThanOrEqual(31);

    // ...and the LAST email is near the end of the window, not near the start —
    // the property "it never went silent", stated directly.
    expect(mailer.sent.length).toBeGreaterThan(MAX_ANNOUNCED_KEYS_PER_EPISODE);
  }, 60_000);

  it("an escalation is RUNG-NEUTRAL — it must not push the check onto the 24h step", async () => {
    // N1. `alertCount` was carrying two facts, and `gapMs = alertCount >= 2 ?
    // steady : first` meant ANY escalation promoted the check from the 6h rung
    // to the 24h rung — silently deleting the episode's "still broken" ping.
    const mailer = new SandboxOpsMailer();
    const check = "vendor_wallet";
    await reconcileAlerts(env, mailer, [bad(check, "unreachable", "wallet unreachable")], T0);
    await reconcileAlerts(env, mailer, [bad(check, "unreachable", "wallet unreachable")], T0 + SWEEP); // alerted
    await reconcileAlerts(env, mailer, [bad(check, "shape_drift", "wallet shape drifted")], T0 + 2 * SWEEP); // escalated
    expect(mailer.sent).toHaveLength(2);

    const row = await env.DB.prepare(`SELECT alert_count, realert_count FROM watchtower_state WHERE check_name = ?`)
      .bind(check)
      .first<{ alert_count: number; realert_count: number }>();
    // Two announcements, ZERO rungs climbed.
    expect(row).toMatchObject({ alert_count: 2, realert_count: 0 });

    // So the re-alert still lands at the SIX-hour gap, not at twenty-four.
    await reconcileAlerts(env, mailer, [bad(check, "shape_drift", "wallet shape drifted")], T0 + SWEEP + 6 * HOUR);
    expect(mailer.sent).toHaveLength(3);
  });
});

describe("§1.3 — the ledger banks only what was DELIVERED", () => {
  it("a dark-channel escalation does not bank its key, so it re-announces when the channel returns", async () => {
    // §5.4's rule, extended to the two fields this increment added. Banking a
    // key whose email never left the building is a PERMANENT deletion: the
    // condition would never be `escalated` again for the life of the episode.
    const check = "tenant_do_wedged:ten_dark";
    const live = new SandboxOpsMailer();
    await reconcileAlerts(env, live, [bad(check, "rpc_unreachable", "threw")], T0);
    await reconcileAlerts(env, live, [bad(check, "rpc_unreachable", "threw")], T0 + SWEEP);
    expect(live.sent).toHaveLength(1);

    // The channel goes dark exactly as a second, different condition arrives.
    const dark = { send: async () => { throw new Error("mail is dark"); } };
    await reconcileAlerts(env, dark as never, [bad(check, "storage_throw", "storage failed")], T0 + 2 * SWEEP);
    const banked = await env.DB.prepare(`SELECT announced_keys, alert_count FROM watchtower_state WHERE check_name = ?`)
      .bind(check)
      .first<{ announced_keys: string; alert_count: number }>();
    expect(JSON.parse(banked!.announced_keys).keys).toEqual(["rpc_unreachable"]);
    expect(banked!.alert_count).toBe(1);

    // Channel back: the same condition escalates, because it was never announced.
    await reconcileAlerts(env, live, [bad(check, "storage_throw", "storage failed")], T0 + 3 * SWEEP);
    expect(live.sent).toHaveLength(2);
  });
});
