import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import {
  domainDnsResult,
  VendorError,
  type CancelWarmupResult,
  type DomainDnsResult,
  type DomainPort,
  type LookalikeCandidate,
  type MailboxHealth,
  type MailboxPort,
  type MailboxReadiness,
  type OwnedDomain,
  type ProvisionedMailbox,
  type PurchasedDomain,
  type ReleaseResult,
  type WarmupSubscriptionState,
} from "@coldstart/shared";
import { toErrorResponse } from "../src/error-response.js";
import { EngineMailboxClient } from "../src/engine/engine-mailbox-client.js";
import { billableMailboxCount, releaseMailboxes } from "../src/engine/lifecycle.js";
import { REQUEST_IDEMPOTENCY_PENDING_CLAIM_TTL_MS } from "../src/engine/idempotency.js";
import { mailboxIntentKey } from "../src/engine/provision-intents.js";
import { findAdoptableDomain, runSetupInfrastructure } from "../src/engine/provisioning.js";
import { SandboxOpsMailer } from "../src/ops-mail/sandbox-ops-mailer.js";
import { RealClock } from "../src/clock.js";
import { RealMailboxPort } from "../src/vendors/real/mailbox-port.js";
import { SandboxMailboxPort } from "../src/vendors/sandbox/mailbox-port.js";
import { IK_API_KEY, IK_MAILBOX_LIST_EMPTY, IK_WORKSPACE_ID } from "./fixtures/inboxkit.js";
import { activatePaidPlan, mintTenant, tenantStub, withTenantContext } from "./helpers.js";

const IK_CONFIG = { apiKey: IK_API_KEY, workspaceId: IK_WORKSPACE_ID, baseUrl: "https://ik.example.internal/v1/api" };

// THE VENDOR-TRUTH CLASS (docs/adversarial/class-sweep-vendor-truth-2026-08-18.md).
//
// One question, asked four ways: WHAT DOES THE VENDOR ACTUALLY SAY, and does
// this platform's own state machine agree with it?
//
//  A — a refusal an operator can clear was graded "permanent" and reported to
//      the customer's agent as "check your inputs". An empty provider credit
//      wallet stopped a paying customer for a week; the agent read the message,
//      correctly obeyed it, and disabled its retry loop.
//  E1 — the guard against a second BILLED warmup subscription was a local marker
//      written AFTER the vendor call, so it could not close the window it sat
//      inside. Nothing asked the vendor whether one already existed.
//  E4 — the adopt-before-buy pre-check swallowed its own failure to `null`,
//      which the caller reads as "nothing to adopt" — a check that could not
//      complete authorizing the registrar purchase it exists to prevent.
//  release() — the vendor no longer holding a mailbox is that call's GOAL
//      STATE, and it was graded a permanent failure. `released_at` was never
//      written, and `released_at IS NULL` is what the customer is billed on.
//
// Every fixture models a vendor that DISAGREES with our records, because the
// sandbox port cannot: it succeeds unconditionally and contains zero throws,
// which is exactly why a green suite coexisted with all four.

interface VendorLog {
  buys: string[];
  warmups: string[];
  warmupChecks: string[];
  releases: string[];
}

/**
 * A MailboxPort whose warmup state is the VENDOR's, not ours.
 *
 * `vendorWarmupAlready` is the crash remnant E1 exists for: `/warmup/add`
 * succeeded, the process died before the marker was written, and the paid
 * subscription is real whatever our tables say.
 */
function warmupAwareVendor(
  opts: { vendorWarmupAlready?: string[]; vendorHasItAlready?: string[]; warmupCheckInconclusive?: boolean } = {},
): { port: MailboxPort; log: VendorLog } {
  const log: VendorLog = { buys: [], warmups: [], warmupChecks: [], releases: [] };
  const listed = new Set<string>(opts.vendorHasItAlready ?? []);
  const enrolled = new Set<string>(opts.vendorWarmupAlready ?? []);

  const port: MailboxPort = {
    async provision(domain: string, localPart: string): Promise<ProvisionedMailbox> {
      const email = `${localPart}@${domain}`;
      log.buys.push(email);
      listed.add(email);
      return { email, provider: "google", provisionedAt: Date.now() };
    },
    async provisioningState(email: string): Promise<MailboxReadiness> {
      return listed.has(email) ? { kind: "ready" } : { kind: "absent" };
    },
    async startWarmup(email: string): Promise<{ started: boolean; startedAt: number }> {
      log.warmups.push(email);
      enrolled.add(email); // billing at the vendor from here on, whatever we record
      return { started: true, startedAt: Date.now() };
    },
    async warmupSubscriptionState(email: string): Promise<WarmupSubscriptionState> {
      log.warmupChecks.push(email);
      if (opts.warmupCheckInconclusive) return "inconclusive";
      return enrolled.has(email) ? "active" : "absent";
    },
    async cancelWarmup(): Promise<CancelWarmupResult> {
      return { cancelled: true, cancelledAt: Date.now() };
    },
    async getHealth(email: string): Promise<MailboxHealth> {
      return { email, reputationScore: null, bounceRate: null, complaintRate: null, placementRate: null };
    },
    async release(email: string): Promise<ReleaseResult> {
      log.releases.push(email);
      listed.delete(email);
      return { released: true, releasedAt: Date.now() };
    },
  };
  return { port, log };
}

function healthyDomainPort(overrides: Partial<DomainPort> = {}): DomainPort {
  return {
    async searchLookalikes(_brand, primaryDomain, count): Promise<LookalikeCandidate[]> {
      const slug = primaryDomain.split(".")[0];
      return Array.from({ length: count }, (_v, i) => ({ domain: `${slug}${i}.com`, available: true }));
    },
    async listOwnedDomains(): Promise<OwnedDomain[]> {
      return [];
    },
    async buy(domain: string): Promise<PurchasedDomain> {
      return { domain, purchasedAt: Date.now(), registrar: "test", connectionType: "purchased" };
    },
    async setDns(): Promise<DomainDnsResult> {
      return domainDnsResult({ kind: "ready" });
    },
    async release(): Promise<ReleaseResult> {
      return { released: true, releasedAt: Date.now() };
    },
    ...overrides,
  };
}

/** The REAL setup entry point — never a hand-built adapter bundle around the unit under test. */
async function runSetup(tenantId: string, mailbox: MailboxPort, primaryDomain: string, key: string, domain?: DomainPort): Promise<unknown> {
  return withTenantContext(tenantId, (base) =>
    runSetupInfrastructure(
      { ...base, adapters: { ...base.adapters, domain: domain ?? healthyDomainPort(), mailbox } },
      {
        brand: primaryDomain.replace(/\.com$/, ""),
        primaryDomain,
        domains: 1,
        inboxesEach: 1,
        persona: "Sender",
        physicalAddress: "1 Test St",
        senderIdentity: `S <s@${primaryDomain}>`,
        quoteOnly: false as const,
      },
      new SandboxOpsMailer(),
      key,
    ).catch((e: unknown) => e),
  );
}

function mailboxOf(primaryDomain: string): string {
  return `sender11@${primaryDomain.replace(/\.com$/, "")}0.com`;
}

/**
 * The crash state E1 is about, exactly as the class sweep describes it: intent
 * 'bought', one dispatch on record, and the per-mailbox idempotency claim left
 * 'pending' and aged past its 10-minute TTL.
 *
 * That is what a process killed INSIDE the recorded unit leaves behind —
 * `/warmup/add` already succeeded and is billing at the vendor, the marker
 * write that records it never happened, and the claim was neither completed
 * (which would replay the recorded result) nor deleted (which a throw does).
 * Aging it past the pending TTL is what lets the retry take the claim over and
 * re-run the unit, which is the only way to reach the warmup leg at all.
 */
function crashAfterWarmupEnrolment(tenantId: string, email: string, intentKey: string): Promise<void> {
  return runInDurableObject(tenantStub(tenantId), (_i, s) => {
    s.storage.sql.exec(`UPDATE mailbox_intents SET status = 'bought' WHERE email = ?`, email);
    s.storage.sql.exec(
      `UPDATE request_idempotency SET status = 'pending', response_json = NULL, created_at = ? WHERE key = ?`,
      // Just past the stale-claim window, DERIVED from the constant: the point
      // of this fixture is that attempt 2 takes the presumed-dead reclaim path
      // and re-enters the saga. A hard-coded age silently stops doing that the
      // moment the TTL moves (it did — N7 raised it 10 min -> 30 min), and the
      // test then passes for the wrong reason or fails for a fake one.
      Date.now() - (REQUEST_IDEMPOTENCY_PENDING_CLAIM_TTL_MS + 60_000),
      `provision:${intentKey}`,
    );
  });
}

function readIntentStatus(tenantId: string, email: string): Promise<string | undefined> {
  return runInDurableObject(
    tenantStub(tenantId),
    (_i, s) => s.storage.sql.exec<{ status: string }>(`SELECT status FROM mailbox_intents WHERE email = ?`, email).toArray()[0]?.status,
  );
}

function readReleasedAt(tenantId: string, email: string): Promise<number | null | undefined> {
  return runInDurableObject(
    tenantStub(tenantId),
    (_i, s) =>
      s.storage.sql.exec<{ released_at: number | null }>(`SELECT released_at FROM mailboxes WHERE email = ?`, email).toArray()[0]
        ?.released_at,
  );
}

describe("E1 — the warmup enrolment asks the VENDOR before it pays", () => {
  it("does NOT re-enrol a mailbox the vendor already has a subscription for (the crash window)", async () => {
    const { tenantId } = await mintTenant("Warmup Crash Co", "managed");
    await activatePaidPlan(tenantId, "managed");
    const primary = "warmupcrash.com";
    const email = mailboxOf(primary);

    // Attempt 1 completes for real: bought, ready, warmup enrolled and marked.
    const first = warmupAwareVendor();
    expect(await runSetup(tenantId, first.port, primary, "warm-1")).not.toBeInstanceOf(Error);
    expect(first.log.warmups).toEqual([email]);

    // THE CRASH: the marker recording the enrolment is gone. The vendor's paid
    // subscription is not.
    await crashAfterWarmupEnrolment(tenantId, email, mailboxIntentKey(tenantId, email));
    expect(await readIntentStatus(tenantId, email)).toBe("bought");

    // Attempt 2 against a vendor that still holds BOTH the mailbox and its
    // warmup subscription.
    const second = warmupAwareVendor({ vendorHasItAlready: [email], vendorWarmupAlready: [email] });
    const result = await runSetup(tenantId, second.port, primary, "warm-2");

    // THE POINT: zero further enrolments. Pre-fix the stale/rolled-back marker
    // read as "not warming yet" and this bought a SECOND $3/month subscription
    // — and every subsequent retry bought another.
    expect(second.log.warmups).toEqual([]);
    // It asked, which is the only thing that could have told it.
    expect(second.log.warmupChecks).toContain(email);
    expect(result).not.toBeInstanceOf(Error);
    // And it WROTE the missing marker: without this the record stays behind
    // reality forever and every later attempt has to re-ask.
    expect(await readIntentStatus(tenantId, email)).toBe("committed");
  });

  it("refuses to enrol — RETRYABLY — when the vendor cannot say whether a subscription exists", async () => {
    const { tenantId } = await mintTenant("Warmup Inconclusive Co", "managed");
    await activatePaidPlan(tenantId, "managed");
    const primary = "warmupunknown.com";
    const email = mailboxOf(primary);

    const vendor = warmupAwareVendor({ warmupCheckInconclusive: true });
    const result = await runSetup(tenantId, vendor.port, primary, "warm-inc");

    // An unfinished search is not proof there is no subscription. Enrolling on
    // it is a real recurring charge, so the saga stops instead — retryably,
    // because the durable intent means the retry resumes here and re-buys
    // nothing.
    expect(vendor.log.warmups).toEqual([]);
    expect(result).toBeInstanceOf(VendorError);
    expect((result as VendorError).retryable).toBe(true);
    expect(await readIntentStatus(tenantId, email)).not.toBe("warming");
  });

  // The sandbox port must be ABLE to say "already enrolled", for the same
  // reason it must be able to say "terminal" (guard D3): a port that only ever
  // answers the happy value is where the real vendor's contract goes to hide,
  // and an always-'absent' sandbox would make the second paid subscription
  // unreachable by any fixture built on it — which is how E1 shipped.
  it("SandboxMailboxPort can express an already-enrolled warmup through its fault-injection seam", async () => {
    const port = new SandboxMailboxPort(new RealClock());
    expect(await port.warmupSubscriptionState("fresh@ok0.com")).toBe("absent");
    port.warmupActive.add("enrolled@ok0.com");
    expect(await port.warmupSubscriptionState("enrolled@ok0.com")).toBe("active");
  });

  it("asks the vendor BEFORE the first paid enrolment, not only on a retry", async () => {
    const { tenantId } = await mintTenant("Warmup Precheck Co", "managed");
    await activatePaidPlan(tenantId, "managed");
    const primary = "warmupfirst.com";
    const email = mailboxOf(primary);

    const vendor = warmupAwareVendor();
    expect(await runSetup(tenantId, vendor.port, primary, "warm-first")).not.toBeInstanceOf(Error);

    // Pre-check-then-act, in that order — a check that runs only on the second
    // attempt is not a pre-check, and the crash window is on the FIRST one.
    expect(vendor.log.warmupChecks).toEqual([email]);
    expect(vendor.log.warmups).toEqual([email]);
  });
});

describe("release() is idempotent — the vendor not holding it IS the goal state", () => {
  // Driven through the REAL InboxKit adapter with a stubbed HTTP layer, not a
  // hand-built fake. A fake port is where this defect hides: the sandbox one
  // returns unconditional success and contains zero throws, so no fixture built
  // on it could ever reach the second-release path — which is exactly why the
  // suite was green while a customer stayed billed.
  it("a retried release for a mailbox the vendor already dropped writes released_at and stops the billing", async () => {
    const { tenantId } = await mintTenant("Release Retry Co", "managed");
    await activatePaidPlan(tenantId, "managed");
    const primary = "releaseretry.com";
    const email = mailboxOf(primary);

    expect(await runSetup(tenantId, warmupAwareVendor().port, primary, "rel-1")).not.toBeInstanceOf(Error);
    const billedBefore = await withTenantContext(tenantId, (ctx) => billableMailboxCount(ctx));
    expect(billedBefore).toBeGreaterThan(0);
    expect(await readReleasedAt(tenantId, email)).toBeNull();

    // THE CRASH STATE: the vendor release already succeeded — it lists nothing
    // for this address — and the process died before `released_at` was written,
    // so our row still says we hold it. This is the retry that
    // lifecycle.ts's revoke-before-mark ordering explicitly depends on.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/mailboxes/list")) {
        return new Response(JSON.stringify(IK_MAILBOX_LIST_EMPTY), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected vendor call during release: ${url}`);
    });
    try {
      const outcome = await withTenantContext(tenantId, (base) =>
        releaseMailboxes(
          { ...base, adapters: { ...base.adapters, mailbox: new RealMailboxPort(IK_CONFIG) } },
          {},
          // Explicitly unconfigured: the credential revoke is not what is under
          // test and must not reach the stubbed fetch.
          new EngineMailboxClient(undefined),
        ),
      );

      // Pre-fix this threw a PERMANENT "inboxkit has no mailbox matching …":
      // releaseMailboxes logged MAILBOX_RELEASE_FAILED and carried on,
      // `released_at` stayed NULL, and `released_at IS NULL` is what
      // syncMailboxQuantity sets the customer's Stripe quantity from — so they
      // were billed monthly, forever, for a mailbox nobody held.
      expect(outcome.failedCount).toBe(0);
      expect(outcome.releasedCount).toBe(1);
    } finally {
      fetchSpy.mockRestore();
    }

    expect(await readReleasedAt(tenantId, email)).toEqual(expect.any(Number));
    expect(await withTenantContext(tenantId, (ctx) => billableMailboxCount(ctx))).toBeLessThan(billedBefore);
  });

  it("still refuses a release it could not confirm — an inconclusive lookup is not absence", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(JSON.stringify({ error: true, message: "workspace lookup failed" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    try {
      const err = await new RealMailboxPort(IK_CONFIG).release("ghost@releaseretry0.com", "k1").catch((e) => e);
      // A failed list call proves nothing about what the vendor holds, so it
      // must NOT read as "already released" — that would mark a live, billing
      // mailbox released and strand it at the vendor forever.
      expect(err).toBeInstanceOf(VendorError);
      expect((err as VendorError).retryable).toBe(true);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe("E4 — a pre-check that cannot complete does NOT authorize the purchase", () => {
  it("findAdoptableDomain throws when the vendor's owned-domain listing fails, instead of reporting nothing to adopt", async () => {
    const { tenantId } = await mintTenant("Adopt Lookup Co", "managed");
    await activatePaidPlan(tenantId, "managed");
    const listingFailure = new VendorError("inboxkit domains/list failed: upstream", true);

    const err = await withTenantContext(tenantId, (base) =>
      findAdoptableDomain(
        {
          ...base,
          adapters: {
            ...base.adapters,
            domain: healthyDomainPort({
              listOwnedDomains: async () => {
                throw listingFailure;
              },
            }),
          },
        },
        "unasked.com",
      ).catch((e: unknown) => e),
    );

    // `null` here means "nothing to adopt", and the caller proceeds straight to
    // domain.buy — a registrar purchase authorized by a check that never ran.
    expect(err).toBe(listingFailure);
    // The adapter's own grade survives: a re-graded error would either strand a
    // retryable outage or launder a permanent one into an endless loop.
    expect((err as VendorError).retryable).toBe(true);
  });

  it("a failed adopt lookup fails the SETUP rather than buying a domain nobody checked", async () => {
    const { tenantId } = await mintTenant("Adopt Setup Co", "managed");
    await activatePaidPlan(tenantId, "managed");
    const buys: string[] = [];
    const domain = healthyDomainPort({
      listOwnedDomains: async () => {
        throw new VendorError("inboxkit domains/list failed: upstream", true);
      },
      buy: async (d: string) => {
        buys.push(d);
        return { domain: d, purchasedAt: Date.now(), registrar: "test", connectionType: "purchased" as const };
      },
    });

    const result = await runSetup(tenantId, warmupAwareVendor().port, "adoptsetup.com", "adopt-1", domain);

    expect(result).toBeInstanceOf(VendorError);
    expect(buys).toEqual([]);
  });
});

describe("class A — an operator-clearable refusal never reads as 'check your inputs'", () => {
  it("the customer response says HELD, names no fault of the caller's, and promises the same retry works", () => {
    const funding = new VendorError("inboxkit warmup/add -> HTTP 402: Insufficient wallet balance", false, {
      operatorActionable: true,
    });
    const body = toErrorResponse(funding).body;

    expect(body.code).toBe("vendor_operator_blocked");
    expect(body.operatorActionable).toBe(true);
    const message = String(body.error);
    // The two sentences the pre-fix response made, both false for this failure.
    expect(message).not.toContain("check your inputs");
    expect(message).not.toContain("Retrying as-is will not help");
    // The two it must make instead.
    expect(message).toContain("on hold");
    expect(message).toContain("same idempotency key");
  });

  it("an ordinary permanent rejection still tells the caller to check its inputs", () => {
    const body = toErrorResponse(new VendorError("inboxkit mailboxes/buy -> HTTP 422: local part rejected", false)).body;
    expect(body.code).toBe("vendor_error");
    expect(String(body.error)).toContain("check your inputs");
  });

  it("a held setup emits severity 'operator_pending', not 'terminal', with an honest body", async () => {
    const { tenantId } = await mintTenant("Held Setup Co", "managed");
    await activatePaidPlan(tenantId, "managed");
    const domain = healthyDomainPort({
      buy: async () => {
        throw new VendorError("inboxkit domains/register requires a Stripe checkout (insufficient wallet balance)", false, {
          operatorActionable: true,
        });
      },
    });

    expect(await runSetup(tenantId, warmupAwareVendor().port, "heldsetup.com", "held-1", domain)).toBeInstanceOf(VendorError);

    const message = await runInDurableObject(tenantStub(tenantId), (_i, s) =>
      s.storage.sql
        .exec<{ severity: string; body: string }>(`SELECT severity, body FROM tenant_messages WHERE kind = 'setup_failed'`)
        .toArray()[0],
    );

    // Pre-fix this row read 'terminal' — "the platform has STOPPED, retrying
    // will never help" — for a condition a top-up clears in a minute, and an
    // agent branching on severity is told never to retry a terminal.
    expect(message?.severity).toBe("operator_pending");
    expect(message?.body).toContain("on hold");
    expect(message?.body).toContain("SAME idempotency key");
    expect(message?.body).not.toContain("Retrying will not help");
  });

  it("a genuinely dead setup still emits 'terminal'", async () => {
    const { tenantId } = await mintTenant("Dead Setup Co", "managed");
    await activatePaidPlan(tenantId, "managed");
    const domain = healthyDomainPort({
      buy: async () => {
        throw new VendorError("inboxkit domains/register -> HTTP 422: not a registrable name", false);
      },
    });

    expect(await runSetup(tenantId, warmupAwareVendor().port, "deadsetup.com", "dead-1", domain)).toBeInstanceOf(VendorError);

    const message = await runInDurableObject(tenantStub(tenantId), (_i, s) =>
      s.storage.sql
        .exec<{ severity: string; body: string }>(`SELECT severity, body FROM tenant_messages WHERE kind = 'setup_failed'`)
        .toArray()[0],
    );
    expect(message?.severity).toBe("terminal");
  });
});

// env is imported for the pool's D1 binding side-effects in helpers; referenced
// here so the import cannot be dropped as unused.
void env;
