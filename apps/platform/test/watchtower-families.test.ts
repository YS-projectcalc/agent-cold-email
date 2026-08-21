import { describe, expect, it } from "vitest";
import { NEXT_STEP_REASONS } from "@coldstart/shared";
import { policyFor } from "../src/admin/watchtower-alerts.js";
import { ALERT_FAMILIES, customerProgressKey, familyFor, isBudgetExemptCheck, isPerEntityCheck } from "../src/admin/watchtower-families.js";
import { MAX_ANNOUNCED_KEYS_PER_EPISODE } from "../src/admin/watchtower-policy.js";
import alertsSource from "../src/admin/watchtower-alerts.ts?raw";

// THE FAMILY TABLE, AS A FAILING-BY-CONSTRUCTION GUARD (alert-state design §6.9,
// §9.2, §9.3).
//
// The anti-storm property rests on three per-family facts — the closed key
// space, whether the family is per-entity, and whether its announcements are
// budgeted — and on ONE inequality between the cap and the widest key space. A
// hand-written list here would silently miss the next family added, so this
// parses `watchtower-alerts.ts`'s own source for every check name it declares,
// exactly as `watchtower-policy.test.ts` does for the policy table. Three
// independent sources have to agree: the name constants, the family table, and
// the cap.

/** Every check name `watchtower-alerts.ts` declares — the CHECK_LABELS keys plus
 * the exported `*_CHECK` prefixes. Same parse as the policy guard, deliberately:
 * one convention for "the set of families that exist". */
function declaredCheckNames(source: string): string[] {
  const labelBlock = source.match(/const CHECK_LABELS[^{]*\{([\s\S]*?)\n\};/)?.[1] ?? "";
  const labelKeys = [...labelBlock.matchAll(/^\s{2}([a-z_0-9]+):/gm)].map((m) => m[1]!);
  const prefixes = [...source.matchAll(/^export const [A-Z_0-9]+_CHECK = "([a-z_0-9]+:?)";/gm)].map((m) => m[1]!);
  return [...new Set([...labelKeys, ...prefixes])];
}

const DECLARED = declaredCheckNames(alertsSource);

describe("§9.2 — every family declares a key space and a budget scope", () => {
  it("found the declarations at all (a regex matching nothing makes this vacuous)", () => {
    expect(DECLARED).toContain("cron_sweep");
    expect(DECLARED).toContain("domain_dns_aging:");
    expect(DECLARED).toContain("alert_budget_exceeded");
    expect(DECLARED.length).toBeGreaterThanOrEqual(20);
  });

  it("no declared check name is missing from ALERT_FAMILIES", () => {
    const unclassified = DECLARED.filter((name) => ALERT_FAMILIES[name] === undefined);
    expect(
      unclassified,
      "a new watchtower check was added without declaring its materiality keys: add a row to ALERT_FAMILIES " +
        "(admin/watchtower-families.ts) stating its CLOSED key space, whether it is per-entity, and whether its " +
        "announcements are budgeted — there is no default, because every one of the three is load-bearing for the " +
        "per-day inbox bound",
    ).toEqual([]);
  });

  it("no family row is a leftover for a check name that no longer exists", () => {
    const orphaned = Object.keys(ALERT_FAMILIES).filter((name) => !DECLARED.includes(name));
    expect(orphaned).toEqual([]);
  });

  it("every declared family also has a classified alert policy, through a concrete instance", () => {
    for (const name of DECLARED) {
      const concrete = name.endsWith(":") ? `${name}instance` : name;
      const policy = policyFor(concrete);
      expect({ name, confirm: policy.confirmAfterObservations > 0, recover: policy.recoverAfterObservations > 0 }).toEqual({
        name,
        confirm: true,
        recover: true,
      });
    }
  });
});

describe("§9.3 — the cap is STRICTLY greater than the widest declared key space", () => {
  // THE WHOLE SAFETY ARGUMENT (B3). Strictly greater, not `>=`: the cap then can
  // never bind on a correctly-declared family and binds only on a MIS-DERIVED or
  // UNDECLARED key. That is what makes the anti-storm bound independent of all
  // 26 key derivations being right. v1's version of this invariant was
  // UNSATISFIABLE — `cron_legs` keyed on the combinatorial SET of failing legs
  // and `customer_progress_*` on all 12 next-step reasons — which is why those
  // two spaces were narrowed rather than the cap raised.
  const widest = Object.entries(ALERT_FAMILIES).reduce(
    (acc, [name, family]) => (family.keys.length > acc.size ? { name, size: family.keys.length } : acc),
    { name: "(none)", size: 0 },
  );

  it(`caps at ${MAX_ANNOUNCED_KEYS_PER_EPISODE}, widest space is 4`, () => {
    expect(widest.size).toBe(4);
    expect(MAX_ANNOUNCED_KEYS_PER_EPISODE).toBeGreaterThan(widest.size);
  });

  it("holds for EVERY family individually, including cron_legs and customer_progress_*", () => {
    for (const [name, family] of Object.entries(ALERT_FAMILIES)) {
      expect({ name, fits: family.keys.length < MAX_ANNOUNCED_KEYS_PER_EPISODE }).toEqual({ name, fits: true });
    }
    // Named explicitly because these two are the ones the design narrowed to
    // make the invariant satisfiable — a later widening must red here.
    expect(ALERT_FAMILIES["cron_legs"]!.keys.length).toBe(3);
    expect(ALERT_FAMILIES["customer_progress_operator:"]!.keys.length).toBe(4);
  });

  it("declares no duplicate keys within a family", () => {
    for (const [name, family] of Object.entries(ALERT_FAMILIES)) {
      expect({ name, unique: new Set(family.keys).size }).toEqual({ name, unique: family.keys.length });
    }
  });
});

describe("the customer_progress action-class map is closed over all 12 next-step reasons", () => {
  // Keying on the reason gives 12 and blows the cap; keying on `waitingOn` is
  // near-constant per name, because the blame is already IN the name. A 13th
  // reason must red HERE rather than silently take a default.
  it("maps every NEXT_STEP_REASON into the declared key space", () => {
    const space = new Set(ALERT_FAMILIES["customer_progress_operator:"]!.keys);
    for (const reason of NEXT_STEP_REASONS) {
      expect({ reason, key: customerProgressKey([reason]), inSpace: space.has(customerProgressKey([reason])) }).toMatchObject({
        reason,
        inSpace: true,
      });
    }
  });

  it("uses the HIGHEST-PRECEDENCE owed step — the producer's own derivation order", () => {
    // `owedSignals` emits reasons in the order `next-steps.ts` derived them
    // (state, messages, credentials, launch), so the head is the one the founder
    // would act on first.
    expect(customerProgressKey(["setup_operator_blocked", "ready_to_launch"])).toBe("ours_to_fix");
    expect(customerProgressKey(["ready_to_launch", "setup_operator_blocked"])).toBe("customer_side");
  });
});

describe("scope and exemption are readable through a concrete check name", () => {
  it("resolves per-entity families through their prefix, not their bare name", () => {
    expect(isPerEntityCheck("tenant_do_wedged:ten_abc")).toBe(true);
    expect(isPerEntityCheck("domain_dns_aging:example.com")).toBe(true);
    expect(isPerEntityCheck("failure_signals")).toBe(false);
    expect(isPerEntityCheck("cron_legs")).toBe(false);
  });

  it("matches the LONGEST prefix — the two customer_progress names must not collide", () => {
    expect(familyFor("customer_progress_operator:ten_x")).toBe(ALERT_FAMILIES["customer_progress_operator:"]);
    expect(familyFor("customer_progress_agent:ten_x")).toBe(ALERT_FAMILIES["customer_progress_agent:"]);
  });

  it("exempts exactly the three groups the design names, and nothing else", () => {
    const exempt = Object.keys(ALERT_FAMILIES).filter((name) => isBudgetExemptCheck(name.endsWith(":") ? `${name}x` : name));
    expect(new Set(exempt)).toEqual(
      new Set([
        // Group 1 — the check of last resort.
        "cron_sweep",
        // Group 2 — one-shot, money-bearing.
        "mailbox_provisioning:",
        "mailbox_rebuy:",
        "mailbox_release_failed:",
        "domain_ordinal_failed:",
        "mailbox_slot_failed:",
        // Group 3 — the alarm on the budget itself.
        "alert_budget_exceeded",
      ]),
    );
  });

  it("an unknown check name has NO family — the caller must treat that as cannot-alert", () => {
    expect(familyFor("something_nobody_declared")).toBeNull();
    expect(familyFor("unknown_prefix:instance")).toBeNull();
  });
});
