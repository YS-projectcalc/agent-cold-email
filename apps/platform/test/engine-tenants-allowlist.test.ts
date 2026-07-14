import { describe, expect, it } from "vitest";
import { NotActivatedError } from "@coldstart/shared";
import type { SendEmailInput } from "@coldstart/shared";
import { VirtualClock } from "../src/clock.js";
import { createVendorAdapters, parseEngineTenants } from "../src/vendors/factory.js";
import { SandboxEmailPort } from "../src/vendors/sandbox/email-port.js";
import { SandboxDomainPort } from "../src/vendors/sandbox/domain-port.js";
import { SandboxMailboxPort } from "../src/vendors/sandbox/mailbox-port.js";
import { SandboxBillingPort } from "../src/vendors/sandbox/billing-port.js";
import { RealEmailPort } from "../src/vendors/real/email-port.js";

// ROADMAP "Mordy-pilot activation lane" / engine-host arc open item (1):
// ENGINE_TENANTS is a per-tenant allowlist that lets a comped pilot tenant
// reach the REAL EmailPort while every other port (and every other tenant)
// stays sandbox. See src/vendors/factory.ts for the five guards this proves.

const clock = new VirtualClock(Date.now(), 0, 1);
const ENGINE_CONFIG = { baseUrl: "https://engine.example.internal", authSecret: "s" };

const SEND_INPUT: SendEmailInput = {
  fromEmail: "sender@coldstart.test",
  toEmail: "lead@example.com",
  subject: "hi",
  body: "hello",
  threadId: "thr_1",
  inReplyToMessageId: null,
};

describe("parseEngineTenants — total, fail-closed CSV parsing", () => {
  it("unset -> empty allowlist", () => {
    expect(parseEngineTenants(undefined).size).toBe(0);
  });

  it("empty string -> empty allowlist", () => {
    expect(parseEngineTenants("").size).toBe(0);
  });

  it("parses a clean comma-separated list", () => {
    const set = parseEngineTenants("ten_a,ten_b");
    expect([...set].sort()).toEqual(["ten_a", "ten_b"]);
  });

  it("trims whitespace around entries", () => {
    const set = parseEngineTenants(" ten_a , ten_b ");
    expect([...set].sort()).toEqual(["ten_a", "ten_b"]);
  });

  it("drops blank entries from trailing/duplicate commas rather than erroring", () => {
    const set = parseEngineTenants("ten_a,,ten_b,");
    expect([...set].sort()).toEqual(["ten_a", "ten_b"]);
  });

  it("drops whitespace-only junk entries", () => {
    const set = parseEngineTenants("ten_a,   ,ten_b");
    expect([...set].sort()).toEqual(["ten_a", "ten_b"]);
  });

  it("a bare '*' is malformed -> dropped, never a match-everything wildcard", () => {
    expect(parseEngineTenants("*").size).toBe(0);
  });

  it("a wildcard token is dropped even mixed with valid entries; valid ones survive", () => {
    const set = parseEngineTenants("ten_a,*,ten_b");
    expect(set.has("*")).toBe(false);
    expect([...set].sort()).toEqual(["ten_a", "ten_b"]);
  });

  it("never throws on garbage input (total function)", () => {
    expect(() => parseEngineTenants("!!!,,, \t\n ,???,ten_ok")).not.toThrow();
    expect(parseEngineTenants("!!!,,, \t\n ,???,ten_ok").has("ten_ok")).toBe(true);
  });

  it("matches by exact string equality only — no prefix/substring matching", () => {
    const set = parseEngineTenants("ten_pilot");
    expect(set.has("ten_pilot_2")).toBe(false);
    expect(set.has("ten_pil")).toBe(false);
  });
});

describe("createVendorAdapters — ENGINE_TENANTS gates ONLY the EmailPort", () => {
  it("guard 1 (default-empty): ENGINE_TENANTS unset -> sandbox email even for an allowlist-shaped tenantId", () => {
    const bundle = createVendorAdapters("launch", clock, true, ENGINE_CONFIG, "ten_pilot", undefined);
    expect(bundle.email).toBeInstanceOf(SandboxEmailPort);
  });

  it("guard 1: a literal '*' activates nobody", () => {
    const bundle = createVendorAdapters("launch", clock, true, ENGINE_CONFIG, "ten_pilot", "*");
    expect(bundle.email).toBeInstanceOf(SandboxEmailPort);
  });

  it("guard 2 (fail-closed malformed): trailing-comma/whitespace junk around the real id still activates it correctly and never throws", () => {
    expect(() =>
      createVendorAdapters("launch", clock, true, ENGINE_CONFIG, "ten_pilot", " ten_pilot, ,,"),
    ).not.toThrow();
    const bundle = createVendorAdapters("launch", clock, true, ENGINE_CONFIG, "ten_pilot", " ten_pilot, ,,");
    expect(bundle.email).toBeInstanceOf(RealEmailPort);
  });

  it("guard 3 (plan-check dominant): an allowlisted DEMO tenant still gets sandbox email", () => {
    const bundle = createVendorAdapters("demo", clock, true, ENGINE_CONFIG, "ten_pilot", "ten_pilot");
    expect(bundle.email).toBeInstanceOf(SandboxEmailPort);
    expect(bundle.kind).toBe("sandbox");
  });

  it("guard 3: an allowlisted FREE tenant still gets sandbox email", () => {
    const bundle = createVendorAdapters("free", clock, true, ENGINE_CONFIG, "ten_pilot", "ten_pilot");
    expect(bundle.email).toBeInstanceOf(SandboxEmailPort);
  });

  it("guard 4 (global gate dominant): global gate OFF -> an allowlisted PAID tenant still gets sandbox email", () => {
    const bundle = createVendorAdapters("launch", clock, false, ENGINE_CONFIG, "ten_pilot", "ten_pilot");
    expect(bundle.email).toBeInstanceOf(SandboxEmailPort);
  });

  it("guard 4: global gate ON but tenant NOT on the allowlist -> sandbox email", () => {
    const bundle = createVendorAdapters("launch", clock, true, ENGINE_CONFIG, "ten_other", "ten_pilot");
    expect(bundle.email).toBeInstanceOf(SandboxEmailPort);
  });

  it("guard 4: global ON + allowlisted + paid, but engine env vars absent -> RealEmailPort is constructed but stays dark (NotActivatedError on first use, defense in depth)", async () => {
    const bundle = createVendorAdapters("launch", clock, true, undefined, "ten_pilot", "ten_pilot");
    await expect(bundle.email.send(SEND_INPUT, "k1")).rejects.toBeInstanceOf(NotActivatedError);
  });

  it("guard 4 positive control: ALL FOUR conjuncts true -> genuinely a RealEmailPort", () => {
    const bundle = createVendorAdapters("launch", clock, true, ENGINE_CONFIG, "ten_pilot", "ten_pilot");
    expect(bundle.email).toBeInstanceOf(RealEmailPort);
  });

  it("scope discipline: allowlisted + activated + paid tenant STILL gets sandbox domain/mailbox/billing ports", () => {
    const bundle = createVendorAdapters("launch", clock, true, ENGINE_CONFIG, "ten_pilot", "ten_pilot");
    expect(bundle.domain).toBeInstanceOf(SandboxDomainPort);
    expect(bundle.mailbox).toBeInstanceOf(SandboxMailboxPort);
    expect(bundle.billing).toBeInstanceOf(SandboxBillingPort);
  });

  it("sandbox email actually works (positive control — the guard isn't just returning broken adapters)", async () => {
    const bundle = createVendorAdapters("launch", clock, true, ENGINE_CONFIG, "ten_other", "ten_pilot");
    const result = await bundle.email.send(SEND_INPUT, "k2");
    expect(result.messageId).toMatch(/@sandbox\.local>$/);
  });
});
