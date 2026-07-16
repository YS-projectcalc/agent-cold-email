import { describe, expect, it } from "vitest";
import { DEFAULT_THRESHOLDS, evaluate, type DomainStat, type MailboxHealthSignal } from "../src/engine/deliverability.js";

// SPEC.md §20.2/B1 — a primary (or subdomain-of-primary "elevated") domain
// can NEVER be burn-replaced (§7/§10's REPLACE_DOMAIN assumes a disposable,
// platform-owned domain). `evaluate()` must route these through the windowed
// §20.2 breaker instead, emitting HARD_PAUSE_DOMAIN/SOFT_FLAG_DOMAIN — never
// REPLACE_DOMAIN — regardless of how the ALL-TIME complaint/bounce rate
// (the standard burn-threshold's own units) looks.

function mbx(over: Partial<MailboxHealthSignal> = {}): MailboxHealthSignal {
  return {
    mailboxId: "m1",
    email: "a@primary.com",
    domain: "primary.com",
    delivStatus: "healthy",
    warmupStatus: "active",
    warmupDay: 30,
    dailyCap: 20,
    sentToday: 0,
    sendReady: true,
    sends: 1000,
    bounces: 0,
    complaints: 0,
    bounceRate: 0,
    complaintRate: 0,
    softBounces: 0,
    softBounceRate: 0,
    lastPolledAt: null,
    ...over,
  };
}

function dom(over: Partial<DomainStat> = {}): DomainStat {
  return {
    domainId: "d1",
    domain: "primary.com",
    status: "active",
    mailboxCount: 1,
    sends: 1000,
    bounces: 0,
    complaints: 0,
    bounceRate: 0,
    complaintRate: 0,
    isPrimary: true,
    breakerTier: "primary",
    windowSends: 0,
    windowComplaints: 0,
    ...over,
  };
}

const NO_PENDING = { pendingSends: 0 };

describe("evaluate — primary/elevated domains never burn-replace", () => {
  it("HARD_PAUSEs a primary domain once the windowed breaker trips, even with an all-time complaint rate WAY under the generic burn line", () => {
    // All-time complaintRate here is 0 (never crosses burnComplaintRate), but
    // the trailing-7d window has tripped the breaker -- proves the standard
    // burn-threshold path is never even consulted for a primary domain.
    const d = dom({ complaintRate: 0, windowSends: 5000, windowComplaints: 10 });
    const actions = evaluate([mbx()], [d], DEFAULT_THRESHOLDS, NO_PENDING);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ type: "HARD_PAUSE_DOMAIN", domainId: "d1", domain: "primary.com" });
    expect(actions.some((a) => a.type === "REPLACE_DOMAIN")).toBe(false);
  });

  it("SOFT_FLAGs a primary domain below the volume floor with a single complaint, never hard-pausing", () => {
    const d = dom({ windowSends: 15, windowComplaints: 1 });
    const actions = evaluate([mbx()], [d], DEFAULT_THRESHOLDS, NO_PENDING);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ type: "SOFT_FLAG_DOMAIN", domainId: "d1" });
  });

  it("takes NO action on a primary domain within the breaker's normal operating band", () => {
    const d = dom({ windowSends: 500, windowComplaints: 2 });
    const actions = evaluate([mbx()], [d], DEFAULT_THRESHOLDS, NO_PENDING);
    expect(actions).toHaveLength(0);
  });

  it("does NOT also individually PAUSE a mailbox on a hard-paused primary domain (the whole-domain action supersedes it)", () => {
    // This mailbox's OWN per-mailbox complaint rate would independently PAUSE
    // it under the generic per-mailbox thresholds -- but it must not fire a
    // SEPARATE PAUSE action once its domain is being hard-paused (mirrors
    // REPLACE_DOMAIN's existing "not also individually paused" guarantee).
    const m = mbx({ complaintRate: 0.01, complaints: 10, sends: 1000 });
    const d = dom({ windowSends: 5000, windowComplaints: 10 });
    const actions = evaluate([m], [d], DEFAULT_THRESHOLDS, NO_PENDING);
    expect(actions.filter((a) => a.type === "HARD_PAUSE_DOMAIN")).toHaveLength(1);
    expect(actions.some((a) => a.type === "PAUSE")).toBe(false);
  });

  it("is idempotent -- an already paused_primary domain is never re-evaluated", () => {
    const d = dom({ status: "paused_primary", windowSends: 5000, windowComplaints: 10 });
    const actions = evaluate([mbx()], [d], DEFAULT_THRESHOLDS, NO_PENDING);
    expect(actions).toHaveLength(0);
  });

  it("routes an 'elevated' (subdomain-of-primary) domain through the SAME breaker as 'primary', never REPLACE_DOMAIN", () => {
    const d = dom({ isPrimary: false, breakerTier: "elevated", windowSends: 5000, windowComplaints: 10 });
    const actions = evaluate([mbx()], [d], DEFAULT_THRESHOLDS, NO_PENDING);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ type: "HARD_PAUSE_DOMAIN" });
  });

  it("leaves a 'standard'-tier domain (provisioned OR fresh-standalone BYO) on the EXISTING burn-threshold/REPLACE_DOMAIN path, unaffected by windowSends/windowComplaints", () => {
    const d = dom({
      isPrimary: false,
      breakerTier: "standard",
      complaintRate: 0.01,
      complaints: 100,
      sends: 10_000,
      // Deliberately set windowed fields that WOULD trip the breaker if
      // consulted -- must be ignored entirely for a 'standard' domain.
      windowSends: 5000,
      windowComplaints: 10,
    });
    const m = mbx({ complaintRate: 0.01, complaints: 100, sends: 10_000 });
    const actions = evaluate([m], [d], DEFAULT_THRESHOLDS, NO_PENDING);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ type: "REPLACE_DOMAIN" });
  });
});
