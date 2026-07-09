import { describe, expect, it } from "vitest";
import {
  DEFAULT_THRESHOLDS,
  evaluate,
  type DomainStat,
  type MailboxHealthSignal,
} from "../src/engine/deliverability.js";

// Unit tests for the PURE decision function. No DO / DB / clock — hand-built
// signals in, actions out. These pin the monitor->decide half of the B6 control
// loop (SPEC.md §10) independently of how signals are gathered or applied.

function mbx(over: Partial<MailboxHealthSignal> = {}): MailboxHealthSignal {
  return {
    mailboxId: "m1",
    email: "a@lookalike.com",
    domain: "lookalike.com",
    delivStatus: "healthy",
    warmupStatus: "active",
    warmupDay: 30,
    dailyCap: 40,
    sentToday: 0,
    sendReady: true,
    sends: 1000,
    bounces: 0,
    complaints: 0,
    bounceRate: 0,
    complaintRate: 0,
    ...over,
  };
}

function dom(over: Partial<DomainStat> = {}): DomainStat {
  return {
    domainId: "d1",
    domain: "lookalike.com",
    status: "active",
    mailboxCount: 1,
    sends: 1000,
    bounces: 0,
    complaints: 0,
    bounceRate: 0,
    complaintRate: 0,
    ...over,
  };
}

const NO_PENDING = { pendingSends: 0 };

describe("evaluate — the deliverability decision function", () => {
  it("THROTTLEs a mailbox whose complaint rate is in the warn band (below the Gmail red line)", () => {
    // 0.0015 = 0.15% : above warnComplaintRate (0.001) but below hardComplaintRate (0.003).
    const m = mbx({ complaintRate: 0.0015, complaints: 15, sends: 10_000 });
    const actions = evaluate([m], [dom({ complaintRate: 0.0015, complaints: 15, sends: 10_000 })], DEFAULT_THRESHOLDS, NO_PENDING);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ type: "THROTTLE", mailboxId: "m1", newCap: DEFAULT_THRESHOLDS.throttleFloorCap });
  });

  it("PAUSEs a mailbox that crosses the hard complaint threshold (Gmail 0.30% = 0.003)", () => {
    // 0.004 = 0.40% : over the hard line, but the domain aggregate is held
    // just under the burn line so this isolates the per-mailbox PAUSE.
    const m = mbx({ complaintRate: 0.004, complaints: 40, sends: 10_000 });
    const actions = evaluate([m], [dom({ complaintRate: 0.004, complaints: 40, sends: 10_000 })], DEFAULT_THRESHOLDS, NO_PENDING);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ type: "PAUSE", mailboxId: "m1" });
  });

  it("REPLACEs a burning domain and does NOT also individually pause its mailboxes", () => {
    // Domain complaint aggregate 1% >= burnComplaintRate 0.005 -> retire+replace.
    const m = mbx({ complaintRate: 0.01, complaints: 100, sends: 10_000 });
    const d = dom({ complaintRate: 0.01, complaints: 100, sends: 10_000 });
    const actions = evaluate([m], [d], DEFAULT_THRESHOLDS, NO_PENDING);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ type: "REPLACE_DOMAIN", domainId: "d1", domain: "lookalike.com" });
    // The mailbox is NOT separately paused — REPLACE_DOMAIN pauses the whole domain.
    expect(actions.some((a) => a.type === "PAUSE")).toBe(false);
  });

  it("REPLACEs a domain whose BOUNCE aggregate exceeds the burn band (~15%, top of the normal 8-18%/mo)", () => {
    const m = mbx({ bounceRate: 0.2, bounces: 2000, sends: 10_000 });
    const d = dom({ bounceRate: 0.2, bounces: 2000, sends: 10_000 });
    const actions = evaluate([m], [d], DEFAULT_THRESHOLDS, NO_PENDING);
    expect(actions.some((a) => a.type === "REPLACE_DOMAIN")).toBe(true);
  });

  it("emits ROTATE when a mailbox is paused, sends are pending, and a healthy mailbox remains", () => {
    const bad = mbx({ mailboxId: "m1", email: "bad@a.com", domain: "a.com", complaintRate: 0.004, complaints: 40, sends: 10_000 });
    const good = mbx({ mailboxId: "m2", email: "good@b.com", domain: "b.com" });
    const domains = [
      dom({ domainId: "dA", domain: "a.com", complaintRate: 0.004, complaints: 40, sends: 10_000 }),
      dom({ domainId: "dB", domain: "b.com" }),
    ];
    const actions = evaluate([bad, good], domains, DEFAULT_THRESHOLDS, { pendingSends: 5 });
    expect(actions.some((a) => a.type === "PAUSE" && a.mailboxId === "m1")).toBe(true);
    const rotate = actions.find((a) => a.type === "ROTATE");
    expect(rotate).toMatchObject({ type: "ROTATE", pendingSends: 5, healthyTargets: 1 });
  });

  it("is idempotent: never re-PAUSEs an already-paused mailbox nor re-REPLACEs an already-burning domain", () => {
    const m = mbx({ delivStatus: "paused", complaintRate: 1, complaints: 500, sends: 500 });
    const d = dom({ status: "burning", complaintRate: 1, complaints: 500, sends: 500 });
    const actions = evaluate([m], [d], DEFAULT_THRESHOLDS, { pendingSends: 100 });
    expect(actions).toEqual([]);
  });

  it("does not re-THROTTLE an already-throttled mailbox still in the warn band", () => {
    const m = mbx({ delivStatus: "throttled", dailyCap: 5, complaintRate: 0.0015, complaints: 15, sends: 10_000 });
    const actions = evaluate([m], [dom({ complaintRate: 0.0015, complaints: 15, sends: 10_000 })], DEFAULT_THRESHOLDS, NO_PENDING);
    expect(actions).toEqual([]);
  });

  it("takes NO action below the minimum sample size (statistically thin data)", () => {
    // 2 complaints in 3 sends = 67% rate, but only 3 sends -> ignored.
    const m = mbx({ complaintRate: 2 / 3, complaints: 2, sends: 3 });
    const d = dom({ complaintRate: 2 / 3, complaints: 2, sends: 3 });
    const actions = evaluate([m], [d], DEFAULT_THRESHOLDS, { pendingSends: 10 });
    expect(actions).toEqual([]);
  });
});
