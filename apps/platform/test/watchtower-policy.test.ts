import { describe, expect, it } from "vitest";
import { CRON_LEGS_CHECK, CRON_SWEEP_CHECK, D1_CHECK, policyFor } from "../src/admin/watchtower-alerts.js";
import {
  credPushAgingCheckName,
  domainDnsAgingCheckName,
  mailboxProvisioningCheckName,
  mailboxRebuyCheckName,
  sendStarvedCheckName,
  tenantDoWedgedCheckName,
} from "../src/admin/watchtower.js";
import { decideAlert, type AlertAction, type AlertState } from "../src/admin/watchtower-policy.js";
import alertsSource from "../src/admin/watchtower-alerts.ts?raw";

// The founder's 2026-08-16 ruling has ONE hard exemption (the cron dead-man)
// and one hard ceiling (a genuinely-down service still pages in ~10-15 min).
// Both are properties of a TABLE — `policyFor` — so this file pins the table
// itself: the exemptions by name, the ladder each policy produces, and a
// failing-by-construction guard so the NEXT check added cannot inherit a policy
// nobody chose for it.

const HOUR = 3_600_000;
const SWEEP = 300_000;
const T0 = 1_800_000_000_000;

/** Drive one check through a timeline of (nowMs, healthy) observations and
 * return the action for each — the whole policy, as its observable behaviour. */
function run(checkName: string, observations: Array<{ at: number; healthy: boolean }>): AlertAction[] {
  const policy = policyFor(checkName);
  let state: AlertState | null = null;
  return observations.map(({ at, healthy }) => {
    const transition = decideAlert(state, healthy, at, policy);
    state = transition.next;
    return transition.action;
  });
}

/** Every observation is unhealthy, at the live 5-minute cadence, for `hours`. */
function sustained(checkName: string, hours: number): number[] {
  const emailedAt: number[] = [];
  const policy = policyFor(checkName);
  let state: AlertState | null = null;
  for (let at = 0; at <= hours * HOUR; at += SWEEP) {
    const transition = decideAlert(state, false, T0 + at, policy);
    state = transition.next;
    if (transition.action === "alerted" || transition.action === "realerted") emailedAt.push(at);
  }
  return emailedAt;
}

describe("C — the cron dead-man is exempt, and its timing is unchanged", () => {
  it("alerts on the FIRST stale observation — no debounce", () => {
    expect(run(CRON_SWEEP_CHECK, [{ at: T0, healthy: false }])).toEqual(["alerted"]);
    // The contrast that makes this a real assertion: any ordinary check would
    // have been silent on that same observation.
    expect(run("do_storage", [{ at: T0, healthy: false }])).toEqual(["pending"]);
  });

  it("keeps the 6h re-alert cadence — the 24h backoff must not reach it", () => {
    // 30h of a dead cron: alert immediately, then every 6h. This is the
    // pre-2026-08-16 schedule, byte for byte.
    expect(sustained(CRON_SWEEP_CHECK, 30)).toEqual([0, 6 * HOUR, 12 * HOUR, 18 * HOUR, 24 * HOUR, 30 * HOUR]);
  });

  it("recovers on the first healthy observation, as before", () => {
    expect(
      run(CRON_SWEEP_CHECK, [
        { at: T0, healthy: false },
        { at: T0 + SWEEP, healthy: true },
      ]),
    ).toEqual(["alerted", "recovered"]);
  });
});

describe("the debounced default", () => {
  it("confirms on the second consecutive observation, then backs off 6h -> 24h -> 24h", () => {
    // 60h of a stuck check: confirmed one sweep in, +6h, then daily.
    expect(sustained("domain_dns_aging:stuck.test", 60)).toEqual([
      SWEEP,
      SWEEP + 6 * HOUR,
      SWEEP + 30 * HOUR,
      SWEEP + 54 * HOUR,
    ]);
  });

  it("pages a sustained failure within the 10-15 minute ceiling", () => {
    // Worst case: onset one moment after a sweep, so the first observation is a
    // full cron period late and the confirming one another period after that.
    const confirmedAt = sustained("do_storage", 1)[0]!;
    expect(confirmedAt + SWEEP).toBeLessThanOrEqual(15 * 60_000);
  });

  it("says nothing at all about a single-observation flap", () => {
    expect(
      run(tenantDoWedgedCheckName("ten_flap"), [
        { at: T0, healthy: false },
        { at: T0 + SWEEP, healthy: true },
      ]),
    ).toEqual(["pending", "healthy"]);
  });
});

describe("the exemptions carry their own reason, and each is load-bearing", () => {
  it("ONE-SHOT event reports alert on their only observation — a debounce would silence them forever", () => {
    // engine/mailbox-acquisition.ts raises these once, around real vendor spend.
    // Nothing re-observes them, so `pending` here would mean "never".
    expect(run(mailboxProvisioningCheckName("a@example.com"), [{ at: T0, healthy: false }])).toEqual(["alerted"]);
    expect(run(mailboxRebuyCheckName("a@example.com"), [{ at: T0, healthy: false }])).toEqual(["alerted"]);
  });

  it("cron_legs alerts on its first REPORTED observation — it is already damped over 3 ticks upstream", () => {
    // sweep-signals.ts only reports this check after LEG_ALERT_AFTER_SWEEPS
    // consecutive bad ticks (15 min). Debouncing it again would page at 20 min
    // and breach the ceiling.
    expect(run(CRON_LEGS_CHECK, [{ at: T0, healthy: false }])).toEqual(["alerted"]);
  });

  it("still backs off to 24h for both — the exemption is from the DEBOUNCE only", () => {
    expect(sustained(CRON_LEGS_CHECK, 60)).toEqual([0, 6 * HOUR, 30 * HOUR, 54 * HOUR]);
  });

  it("the ordinary cron-sampled checks are NOT exempt", () => {
    for (const name of [
      D1_CHECK,
      "do_storage",
      "engine",
      "failure_signals",
      "warmup_cancel_gave_up",
      credPushAgingCheckName("a@example.com"),
      domainDnsAgingCheckName("example.com"),
      sendStarvedCheckName("ten_x"),
      tenantDoWedgedCheckName("ten_x"),
    ]) {
      expect({ name, action: run(name, [{ at: T0, healthy: false }])[0] }).toEqual({ name, action: "pending" });
    }
  });
});

describe("failing-by-construction — a new check cannot inherit an unchosen policy", () => {
  // Parses watchtower-alerts.ts's own source for every check name it declares
  // (the CHECK_LABELS keys + the exported `*_CHECK` prefixes). A per-name list
  // written by hand here would silently miss the next check added; this cannot.
  const EXPECTED_CONFIRM_OBSERVATIONS: Record<string, number> = {
    // Exempt — see policyFor for each reason.
    cron_sweep: 1,
    cron_legs: 1,
    "mailbox_provisioning:": 1,
    "mailbox_rebuy:": 1,
    // Debounced (the default).
    d1: 2,
    do_storage: 2,
    engine: 2,
    failure_signals: 2,
    warmup_cancel_gave_up: 2,
    "cred_push_aging:": 2,
    "send_starved:": 2,
    "tenant_do_wedged:": 2,
    "domain_dns_aging:": 2,
    // Item 1/2 (docs/adversarial/class-sweep-vendor-truth-2026-08-18.md) — the
    // watchtower re-samples all four every cron tick, exactly like
    // domain_dns_aging above; NOT one-shot event reports.
    vendor_wallet: 2,
    warmup_duplicates: 2,
    "mailbox_orphan:": 2,
    "domain_orphan:": 2,
  };

  function declaredCheckNames(source: string): string[] {
    const labelBlock = source.match(/const CHECK_LABELS[^{]*\{([\s\S]*?)\n\};/)?.[1] ?? "";
    const labelKeys = [...labelBlock.matchAll(/^\s{2}([a-z_0-9]+):/gm)].map((m) => m[1]!);
    const prefixes = [...source.matchAll(/^export const [A-Z_0-9]+_CHECK = "([a-z_0-9]+:?)";/gm)].map((m) => m[1]!);
    return [...new Set([...labelKeys, ...prefixes])];
  }

  it("every check name declared in watchtower-alerts.ts has a classified policy", () => {
    const declared = declaredCheckNames(alertsSource);
    // Sanity: the parse really found the table (a regex that silently matches
    // nothing would make this whole guard vacuous).
    expect(declared).toContain(CRON_SWEEP_CHECK);
    expect(declared).toContain("domain_dns_aging:");
    expect(declared.length).toBeGreaterThanOrEqual(13);

    const unclassified = declared.filter((name) => EXPECTED_CONFIRM_OBSERVATIONS[name] === undefined);
    expect(
      unclassified,
      "a new watchtower check was added without deciding its alert policy: classify it in policyFor " +
        "(admin/watchtower-alerts.ts) and in this table — the default is DEBOUNCED, which is wrong for a " +
        "one-shot event report or a check already damped upstream",
    ).toEqual([]);

    for (const [name, confirmAfterObservations] of Object.entries(EXPECTED_CONFIRM_OBSERVATIONS)) {
      // Prefix names are exercised through a concrete instance, the way the
      // state machine sees them.
      const concrete = name.endsWith(":") ? `${name}instance` : name;
      expect({ name, confirm: policyFor(concrete).confirmAfterObservations }).toEqual({
        name,
        confirm: confirmAfterObservations,
      });
    }
  });
});
