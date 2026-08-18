/// <reference types="vite/client" />
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { CapacityPendingError, VendorError, type MailboxHealth, type MailboxPort } from "@coldstart/shared";
import { getInfrastructureStatus } from "../src/engine/infrastructure-status.js";
import { toErrorResponse } from "../src/error-response.js";
import { ABSTRACT_VENDOR_STEPS, customerSafeVendorFailure } from "../src/vendor-failure.js";
import { activatePaidPlan, mintTenant, tenantStub, withTenantContext } from "./helpers.js";
import { strippedSource } from "./source-text.js";

// FOUNDER RULE: customer- and agent-facing surfaces never reveal which upstream
// provider we use (docs/adversarial/sweep-vendor-leak-2026-08-05.md). Vendor
// identity stays in internal logs.
//
// The throw->response boundary was already closed; the LIVE class was narrower
// and nastier — a VendorError CAUGHT and written into a value a customer read
// surface later returns, bypassing the boundary entirely. Plus the guard file's
// own allowlist, which passed the vendor's LITERAL endpoint paths through as
// `step`: `step:"domains/register"` is a route you can curl to identify us.
//
// Two halves below, because neither alone holds: a BEHAVIOURAL half (drive a
// real adapter error through the surfaces and inspect what comes out) and a
// SOURCE TRIPWIRE (no new emittable literal reintroduces the vendor name).

// Gate finding #4 (docs/adversarial/wave-integration-gate-2026-08-05.md): the
// scan root used to be `../src/**` only, missing `packages/shared/src` —
// whose error classes (errors.ts) carry `message` text `error-response.ts`
// returns to a tenant VERBATIM (ValidationError -> 400, IncompleteRegistrantError
// -> 400, CapacityPendingError -> 409). A vendor-naming literal there would
// reach a customer and this tripwire would never see it. Two glob roots
// (rather than one pattern spanning both) keep each pattern's relative-path
// math simple and independently verifiable.
const SOURCES = {
  ...(import.meta.glob("../src/**/*.ts", { query: "?raw", eager: true, import: "default" }) as Record<string, string>),
  ...(import.meta.glob("../../../packages/shared/src/**/*.ts", { query: "?raw", eager: true, import: "default" }) as Record<string, string>),
};

// Strips EVERY leading `../` segment (not just one) — `../src/foo.ts` and the
// deeper `../../../packages/shared/src/foo.ts` both normalize to a
// repo-root-relative path (`src/foo.ts`, `packages/shared/src/foo.ts`).
const normalize = (key: string) => key.replace(/^(\.\.\/)+/, "");

/** Files with non-comment vendor-name text, outside the layer allowed to have it. */
export function findVendorNameLeaks(sources: Record<string, string>, allowed: (file: string) => boolean): string[] {
  return Object.entries(sources)
    .filter(([key]) => !allowed(normalize(key)))
    .filter(([, source]) => /inboxkit/i.test(strippedSource(source)))
    .map(([key]) => normalize(key))
    .sort();
}

/**
 * The layer that may name the vendor in code: the adapters themselves (they ARE
 * the integration), plus the places that must READ its env/config identifiers.
 * Each entry is a deliberate decision, not a blanket exemption — a file added
 * here needs a reason that survives review.
 */
const VENDOR_NAME_ALLOWED = (file: string): boolean =>
  file.startsWith("src/vendors/") ||
  // Env-var identifiers (INBOXKIT_API_KEY etc.) and the arming/gating reads of
  // them — configuration names, never emitted to a caller.
  ["src/env.ts", "src/tenant-do.ts", "src/engine/activation.ts", "src/engine/billing.ts", "src/engine/mailbox-credential-push.ts", "src/engine/spend-ceiling.ts", "src/engine/provisioning.ts"].includes(file) ||
  // Operator-only surfaces: the founder's ops digest/alert email. Explicitly
  // OUT of the customer class — an operator needs the vendor named.
  file === "src/admin/ops-sweep.ts" ||
  // Item 1 (docs/adversarial/class-sweep-vendor-truth-2026-08-18.md) — the
  // account-wide vendor checks (admin/watchtower-vendor.ts) and their alert
  // vocabulary (admin/watchtower-alerts.ts's `vendor_wallet`/
  // `warmup_duplicates` labels). Every string these two files produce is
  // EITHER emailed to `env.OPS_ALERT_EMAIL` (watchtower-alerts.ts's
  // `alertEmailFor`, unconditionally hardcoded — never a customer address)
  // OR served from `GET /admin/ops/checks` (admin-token-gated, the same
  // operator surface ops-sweep.ts's digest is on). Same class as the entry
  // above, one file over.
  file === "src/admin/watchtower-alerts.ts" ||
  file === "src/admin/watchtower-vendor.ts";

describe("the emitted vendor-step vocabulary is abstract", () => {
  it("no abstract label contains a vendor endpoint path (the fingerprint)", () => {
    expect([...ABSTRACT_VENDOR_STEPS].filter((s) => s.includes("/"))).toEqual([]);
    expect([...ABSTRACT_VENDOR_STEPS].filter((s) => /inboxkit/i.test(s))).toEqual([]);
    expect(ABSTRACT_VENDOR_STEPS.size).toBeGreaterThan(5); // non-vacuous
  });

  it("maps a real adapter message onto its abstract label, and refuses to guess otherwise", () => {
    expect(customerSafeVendorFailure(new VendorError("inboxkit mailboxes/buy -> HTTP 500: nope", true))).toEqual({
      step: "mailbox purchase",
      retryable: true,
    });
    // Longest-match: a nested path must not resolve via its own prefix.
    expect(customerSafeVendorFailure(new VendorError("inboxkit POST /domains/nameservers/check-propagation failed", false)).step).toBe(
      "domain DNS setup",
    );
    expect(customerSafeVendorFailure(new VendorError("engine send unreachable at http://10.0.0.7:8787", true)).step).toBeUndefined();
  });

  it("still grades an error that has crossed the DO RPC boundary (no prototype, own props only)", () => {
    // Caught in development: an error thrown inside the Durable Object arrives at
    // the Worker's onError as a structurally-equivalent object whose PROTOTYPE is
    // gone, so `instanceof VendorError` is false at the one surface that matters
    // most. A grader that leans on instanceof reports every retryable vendor
    // failure as "do not retry" in the HTTP body — worse than the leak it fixes.
    // error-response.ts has always branched on err.name for this reason.
    const acrossRpc = Object.assign(new Error("domain DNS setup did not complete"), {
      name: "VendorError",
      retryable: true,
      step: "domain DNS setup",
    });
    expect(customerSafeVendorFailure(acrossRpc)).toEqual({ step: "domain DNS setup", retryable: true });
    expect(toErrorResponse(acrossRpc).body).toMatchObject({ code: "vendor_error", step: "domain DNS setup", retryable: true });
  });
});

describe("a caught vendor error never reaches a customer read-surface intact", () => {
  /** A mailbox port whose health lookup fails exactly as the real adapter's does. */
  function failingHealthPort(base: MailboxPort): MailboxPort {
    return {
      provision: (d, l, k) => base.provision(d, l, k),
      provisioningState: (e) => base.provisioningState(e),
      startWarmup: (e, k) => base.startWarmup(e, k),
      cancelWarmup: (e, k) => base.cancelWarmup(e, k),
      warmupSubscriptionState: (e) => base.warmupSubscriptionState(e),
      release: (e, k) => base.release(e, k),
      getHealth: (): Promise<MailboxHealth> => {
        throw new VendorError("inboxkit GET /email-insights/mailbox/mbx-1/health -> HTTP 500: upstream", true);
      },
    };
  }

  it("infrastructure_status degrades WITHOUT naming the provider or its endpoints", async () => {
    const { tenantId } = await mintTenant("Leak Status Co", "managed");
    await activatePaidPlan(tenantId, "managed");
    await runInDurableObject(tenantStub(tenantId), (_i, s) => {
      s.storage.sql.exec(
        `INSERT INTO domains (id, tenant_id, domain, status, purchased_at, dns_status) VALUES ('dom_leak', ?, 'leakstatus.com', 'active', 1, 'ready')`,
        tenantId,
      );
      s.storage.sql.exec(
        `INSERT INTO mailboxes (id, tenant_id, domain_id, domain, email, daily_cap, sent_today, sent_today_epoch_day, status, warmup_started_at, created_at, poll_cursor)
         VALUES ('mbx_leak', ?, 'dom_leak', 'leakstatus.com', 'sender@leakstatus.com', 5, 0, 0, 'warming', 1, 1, -1)`,
        tenantId,
      );
    });

    const status = await withTenantContext(tenantId, (base) =>
      getInfrastructureStatus({ ...base, adapters: { ...base.adapters, mailbox: failingHealthPort(base.adapters.mailbox) } }),
    );

    const serialized = JSON.stringify(status);
    // Pre-fix: vendorHealthError carried err.message verbatim — and this is the
    // ONE endpoint the tool description tells a customer's agent to poll.
    expect(serialized).not.toMatch(/inboxkit/i);
    expect(serialized).not.toMatch(/email-insights|mailboxes\/|domains\/|warmup\//);
    // Still useful: the caller can tell "the vendor says 0" from "we could not ask".
    expect(status.mailboxHealth[0]!.vendorHealth).toBe("unknown");
    expect(status.mailboxHealth[0]!.vendorHealthError).toBe("mailbox health check temporarily unavailable");

    // …and the activity row it writes (customer-readable via account()) too.
    const actions = await runInDurableObject(tenantStub(tenantId), (_i, s) =>
      s.storage.sql.exec<{ action: string; detail_json: string }>(`SELECT action, detail_json FROM deliverability_actions`).toArray(),
    );
    const unavailable = actions.filter((a) => a.action === "MAILBOX_HEALTH_UNAVAILABLE");
    expect(unavailable).toHaveLength(1);
    expect(unavailable[0]!.detail_json).not.toMatch(/inboxkit/i);
    expect(JSON.parse(unavailable[0]!.detail_json)).toMatchObject({ step: "mailbox health check", retryable: true });
  });

  it("a capacity hold tells the customer what happened without naming the provider or our inventory", () => {
    // Sibling found while writing the tripwire: CapacityPendingError's message
    // is returned VERBATIM in the 409 body, and it used to read "InboxKit
    // plan-slot capacity reached (3/10)".
    const { body } = toErrorResponse(
      new CapacityPendingError("slot_capacity", "provisioning is temporarily held: this account has reached its provisioning capacity."),
    );
    expect(JSON.stringify(body)).not.toMatch(/inboxkit/i);
    expect(body.code).toBe("capacity_pending");
    expect(body.reason).toBe("slot_capacity"); // still actionable
  });
});

describe("source tripwire — a new emittable vendor string cannot slip in", () => {
  it("sees the real source tree (non-vacuous)", () => {
    const keys = Object.keys(SOURCES).map(normalize);
    expect(keys.length).toBeGreaterThan(50);
    expect(keys).toContain("src/error-response.ts");
    expect(keys).toContain("src/vendor-failure.ts");
  });

  it("gate finding #4 (2026-08-06) — the scan root now covers packages/shared/src too", () => {
    // errors.ts defines ValidationError/IncompleteRegistrantError/
    // CapacityPendingError, whose `message` error-response.ts returns
    // verbatim to a tenant — a future vendor-naming literal there must be
    // reachable by this tripwire.
    const keys = Object.keys(SOURCES).map(normalize);
    expect(keys).toContain("packages/shared/src/errors.ts");
    expect(keys).toContain("packages/shared/src/vendor-ports.ts");
    expect(keys.filter((k) => k.startsWith("packages/shared/src/")).length).toBeGreaterThan(5);
  });

  it("no file outside the adapter/config layer contains emittable vendor-name text", () => {
    const leaks = findVendorNameLeaks(SOURCES, VENDOR_NAME_ALLOWED);
    expect(
      leaks,
      `file(s) ${leaks.join(", ")} contain the vendor's name in NON-COMMENT source text. If it can reach a ` +
        `customer/agent surface, route it through vendor-failure.ts's customerSafeVendorFailure instead. Do NOT ` +
        `simply add the file to VENDOR_NAME_ALLOWED — that list is for the adapter layer and env/config reads.`,
    ).toEqual([]);
  });

  it("the detection logic actually detects (it cannot rot into a no-op)", () => {
    const rogue = {
      "../src/engine/rogue.ts": `logAction(ctx, "X", email, { reason: "inboxkit warmup/add failed" });`,
    };
    expect(findVendorNameLeaks(rogue, () => false)).toEqual(["src/engine/rogue.ts"]);
    // …and does NOT fire on a comment, which is the false positive that would
    // get this guard deleted.
    const commented = {
      "../src/engine/documented.ts": `// InboxKit's buy is async.\n/* InboxKit again */\nconst x = 1; // trailing InboxKit note`,
    };
    expect(findVendorNameLeaks(commented, () => false)).toEqual([]);
  });
});

void env;
