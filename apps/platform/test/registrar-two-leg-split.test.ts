import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RegistrarUnarmedError } from "@coldstart/shared";
import { toErrorResponse } from "../src/error-response.js";
import { selectRealDomainPort } from "../src/vendors/factory.js";
import { RegistrarUnarmedDomainPort } from "../src/vendors/real/domain-port.js";
import { RealInboxKitDomainPort } from "../src/vendors/real/inboxkit-domain-port.js";
import { activatePaidPlan, api, mintTenant, seedBenignSdnList } from "./helpers.js";
import { fakeInboxKit, REGISTRANT } from "./fixtures/inboxkit-workspace.js";
import { IK_API_KEY, IK_WORKSPACE_ID } from "./fixtures/inboxkit.js";

// I3 — THE `registrar_unarmed` TWO-LEG SPLIT (design §7.8, gate L2).
//
// `selectRealDomainPort` holds two booleans — `armed` (the operator's global
// env switch) and `optIn` (THIS request's consent) — and used to throw both
// away, so ONE message served two very different conditions.
//
// For the ENV leg the 503 is right: an operator has to arm something.
// For the OPT-IN leg it was wrong twice. It said *account* when the truth was
// *this request*, and its "no human has been notified" clause routed an
// unattended agent to escalate over something its own next call fixes. That is
// the vendor-truth wave's class A surviving one seam over — a self-clearable
// refusal graded as "no action of yours can work" — and it is the live
// incident: tickets sup_dce385a8 / sup_9d2c9a3a, where the customer's own
// retraction said the wording that would have self-corrected is
// "registerDomains was not set on this request".
//
// THE DECOUPLE GUARD IS UNTOUCHED. Both legs still gate the real port; only the
// message changes.

const COMPLETE_REGISTRANT = REGISTRANT;
const INBOXKIT_CONFIG = { apiKey: IK_API_KEY, workspaceId: IK_WORKSPACE_ID };

function setupBody(over: Record<string, unknown>): string {
  return JSON.stringify({
    brand: "Two Leg Co",
    primaryDomain: "twolegco.com",
    domains: 1,
    inboxesEach: 1,
    persona: "Sales",
    physicalAddress: "1 Main St",
    senderIdentity: "Sales Team",
    ...over,
  });
}

describe("I3 — the failing leg is threaded factory -> port -> error", () => {
  it("opt-in missing (env armed) selects the hard-block port and names the OPT-IN leg", async () => {
    const port = selectRealDomainPort(INBOXKIT_CONFIG, { armed: true, optIn: false, registrant: COMPLETE_REGISTRANT });
    expect(port).toBeInstanceOf(RegistrarUnarmedDomainPort);
    await expect(port.searchLookalikes("b", "b.com", 1)).rejects.toMatchObject({
      name: "RegistrarUnarmedError",
      reason: "opt_in",
    });
  });

  it("env unarmed selects the hard-block port and names the ENV leg, even with opt-in true", async () => {
    const port = selectRealDomainPort(INBOXKIT_CONFIG, { armed: false, optIn: true, registrant: COMPLETE_REGISTRANT });
    expect(port).toBeInstanceOf(RegistrarUnarmedDomainPort);
    await expect(port.searchLookalikes("b", "b.com", 1)).rejects.toMatchObject({
      name: "RegistrarUnarmedError",
      reason: "env",
    });
  });

  it("BOTH legs missing reports the ENV leg — the operator's switch is the outer gate", async () => {
    const port = selectRealDomainPort(INBOXKIT_CONFIG, { armed: false, optIn: false, registrant: COMPLETE_REGISTRANT });
    await expect(port.buy("x.com", "k")).rejects.toMatchObject({ reason: "env" });
  });

  it("both legs present still selects the REAL port — the decouple guard is unchanged", () => {
    const port = selectRealDomainPort(INBOXKIT_CONFIG, { armed: true, optIn: true, registrant: COMPLETE_REGISTRANT });
    expect(port).toBeInstanceOf(RealInboxKitDomainPort);
  });

  // Non-blocking 9, folded here. Inert today (the name-branch in
  // error-response.ts precedes the VendorError branch), but if that branch is
  // ever removed the error takes the "check your inputs" arm — B1's original
  // defect, latent. The flag must be honest per leg on the day it starts being
  // read, not on the day someone notices it is not.
  it("operatorActionable is honest per leg: an operator clears the env leg, the tenant clears its own", () => {
    expect(new RegistrarUnarmedError("buy", "env").operatorActionable).toBe(true);
    expect(new RegistrarUnarmedError("buy", "opt_in").operatorActionable).toBe(false);
    expect(new RegistrarUnarmedError("buy", "env").retryable).toBe(false);
    expect(new RegistrarUnarmedError("buy", "opt_in").retryable).toBe(false);
  });
});

describe("I3 — the customer response, per leg", () => {
  it("the OPT-IN leg is a 400 naming the field, with no escalation clause", () => {
    const { status, body } = toErrorResponse(new RegistrarUnarmedError("searchLookalikes", "opt_in"));
    expect(status).toBe(400);
    expect(body.code).toBe("registrar_optin_missing");
    const error = String(body.error);
    // The customer's own retraction wording: the refusal must say THIS REQUEST,
    // name the field, and say what to resend.
    expect(error).toContain("registerDomains");
    expect(error).toContain("this request");
    expect(error).toContain("No purchase was attempted");
    // It must NOT tell an agent a human is or is not on it: nobody needs to be.
    expect(error).not.toContain("operator");
    expect(error).not.toContain("not yet enabled for this account");
  });

  it("the ENV leg is today's 503, byte-for-byte", () => {
    const { status, body } = toErrorResponse(new RegistrarUnarmedError("searchLookalikes", "env"));
    expect(status).toBe(503);
    expect(body.code).toBe("registrar_unarmed");
    expect(String(body.error)).toContain("Domain registration is not yet enabled for this account");
    expect(String(body.error)).toContain("No purchase was made");
  });

  // An error thrown inside the DO reaches the Worker's onError with its own
  // properties but WITHOUT its subclass prototype, so `instanceof
  // RegistrarUnarmedError` is false at the one surface that matters most. The
  // leg must therefore be read as a FIELD. Same fixture shape
  // vendor-identity-leak.test.ts pins for `retryable`/`step`.
  it("maps an error that has crossed the RPC boundary the same way — the class is gone, the field is not", () => {
    const optInAcrossRpc = Object.assign(new Error("domain.buy is blocked"), {
      name: "RegistrarUnarmedError",
      reason: "opt_in",
    });
    expect(toErrorResponse(optInAcrossRpc).status).toBe(400);
    expect(toErrorResponse(optInAcrossRpc).body.code).toBe("registrar_optin_missing");

    const envAcrossRpc = Object.assign(new Error("domain.buy is blocked"), { name: "RegistrarUnarmedError", reason: "env" });
    expect(toErrorResponse(envAcrossRpc).status).toBe(503);
    expect(toErrorResponse(envAcrossRpc).body.code).toBe("registrar_unarmed");
  });

  // A pre-split error — one recorded or in flight before this change — carries
  // no `reason` at all. It must keep taking today's 503, never fall through to
  // a generic 500 or, worse, tell a customer to resend a field that would not
  // help.
  it("an error with NO reason keeps today's 503", () => {
    const legacy = Object.assign(new Error("domain.buy is blocked"), { name: "RegistrarUnarmedError" });
    expect(toErrorResponse(legacy).status).toBe(503);
    expect(toErrorResponse(legacy).body.code).toBe("registrar_unarmed");
  });
});

describe("I3 — end to end: the live incident's call", () => {
  const saved = {
    REGISTRAR_PROVIDER: env.REGISTRAR_PROVIDER,
    INBOXKIT_API_KEY: env.INBOXKIT_API_KEY,
    INBOXKIT_WORKSPACE_ID: env.INBOXKIT_WORKSPACE_ID,
  };
  afterEach(() => {
    vi.restoreAllMocks();
    Object.assign(env, saved);
  });
  beforeEach(async () => {
    await seedBenignSdnList();
    await env.DB.prepare("DELETE FROM vendor_spend_entries").run();
    await env.DB.prepare("DELETE FROM vendor_spend_ledger").run();
    await env.DB.prepare("DELETE FROM vendor_slot_state").run();
  });

  // THE INCIDENT. An unattended agent omitted `registerDomains` on a
  // buy-bearing call against a tenant whose consent was already persisted, and
  // got "Domain registration is not yet enabled for this account" — a sentence
  // indistinguishable from a platform fault, which is why it filed a ticket
  // instead of resending one field.
  it("omitting registerDomains on a buy-bearing call 400s naming the field, and buys nothing", async () => {
    Object.assign(env, { REGISTRAR_PROVIDER: "inboxkit", INBOXKIT_API_KEY: "k", INBOXKIT_WORKSPACE_ID: "w" });
    const { token, tenantId } = await mintTenant("Two Leg Co", "managed");
    await activatePaidPlan(tenantId, "managed");

    const fixture = fakeInboxKit({ domains: [] });
    const res = await api<{ code?: string; error?: string }>("/setup-infrastructure", {
      method: "POST",
      token,
      body: setupBody({}),
    });

    expect(res.status).toBe(400);
    expect(res.body?.code).toBe("registrar_optin_missing");
    expect(res.body?.error).toContain("registerDomains");
    expect(fixture.countOf("/domains/register")).toBe(0);
  });

  it("the env leg still 503s — the decouple guard holds and its wording is unchanged", async () => {
    Object.assign(env, { REGISTRAR_PROVIDER: undefined, INBOXKIT_API_KEY: "k", INBOXKIT_WORKSPACE_ID: "w" });
    const { token, tenantId } = await mintTenant("Two Leg Co", "managed");
    await activatePaidPlan(tenantId, "managed");

    const fixture = fakeInboxKit({ domains: [] });
    const res = await api<{ code?: string; error?: string }>("/setup-infrastructure", {
      method: "POST",
      token,
      body: setupBody({ registerDomains: true, registrant: COMPLETE_REGISTRANT }),
    });

    expect(res.status).toBe(503);
    expect(res.body?.code).toBe("registrar_unarmed");
    expect(fixture.countOf("/domains/register")).toBe(0);
  });
});
