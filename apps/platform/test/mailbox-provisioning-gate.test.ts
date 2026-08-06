import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  VendorError,
  type CancelWarmupResult,
  type DnsRecordSet,
  type DomainPort,
  type LookalikeCandidate,
  type MailboxHealth,
  type MailboxPort,
  type MailboxProvisioningState,
  type OwnedDomain,
  type ProvisionedMailbox,
  type PurchasedDomain,
  type ReleaseResult,
} from "@coldstart/shared";
import { billableMailboxCount, releaseMailboxes } from "../src/engine/lifecycle.js";
import { ABSENCE_MIN_AGE_MS } from "../src/engine/mailbox-acquisition.js";
import { runSetupInfrastructure } from "../src/engine/provisioning.js";
import { SandboxOpsMailer } from "../src/ops-mail/sandbox-ops-mailer.js";
import { activatePaidPlan, mintTenant, tenantStub, withTenantContext } from "./helpers.js";

// L2 (docs/adversarial/forward-path-audit-2026-08-05.md) — "buy accepted ==
// resource usable" is false for this vendor, and the code assumed it.
//
// `/mailboxes/buy` is ASYNC: it answers "scheduled". The very next line resolved
// the mailbox's uid to start warmup, which throws PERMANENTLY while the mailbox
// is unlistable — and that throw unwound past the buy, deleting the
// request-idempotency claim (by design: failures are never cached). So the
// retry BOUGHT THE MAILBOX AGAIN. Double charge, orphaned vendor mailbox, and a
// tenant permanently unable to complete setup.
//
// The sandbox mailbox port cannot express any of this — provision() returning IS
// the mailbox existing there — which is exactly why a green suite coexisted with
// a 100%-failing live path. These fixtures model the real async window.

interface VendorLog {
  buys: string[];
  warmups: string[];
  stateChecks: string[];
}

/**
 * A MailboxPort with a REAL vendor's async shape: a buy is ACCEPTED, and the
 * mailbox only becomes listable/ready after `readyAfterChecks` further status
 * checks. `buyThrows` models the ambiguous failure — the call throws, and
 * whether the order landed is unknowable from here.
 */
function asyncMailboxVendor(opts: { readyAfterChecks?: number; buyThrows?: VendorError; vendorHasItAlready?: string[] } = {}): {
  port: MailboxPort;
  log: VendorLog;
} {
  const log: VendorLog = { buys: [], warmups: [], stateChecks: [] };
  const bought = new Set<string>(opts.vendorHasItAlready ?? []);
  const checks = new Map<string, number>();
  const readyAfter = opts.readyAfterChecks ?? 0;

  const port: MailboxPort = {
    async provision(domain: string, localPart: string): Promise<ProvisionedMailbox> {
      const email = `${localPart}@${domain}`;
      log.buys.push(email);
      if (opts.buyThrows) throw opts.buyThrows;
      bought.add(email);
      return { email, provider: "google", provisionedAt: Date.now() };
    },
    async provisioningState(email: string): Promise<MailboxProvisioningState> {
      log.stateChecks.push(email);
      if (!bought.has(email)) return "absent";
      const seen = (checks.get(email) ?? 0) + 1;
      checks.set(email, seen);
      return seen > readyAfter ? "ready" : "pending";
    },
    async startWarmup(email: string): Promise<{ started: boolean; startedAt: number }> {
      log.warmups.push(email);
      // What the REAL port does: it resolves the mailbox's uid first, and a
      // mailbox the vendor has not finished creating is not listable, so the
      // lookup throws PERMANENTLY. This is the exact throw that used to unwind
      // past the successful buy and delete the idempotency claim.
      if (!bought.has(email) || (checks.get(email) ?? 0) <= readyAfter) {
        throw new VendorError(`inboxkit has no mailbox matching ${email}`, false);
      }
      return { started: true, startedAt: Date.now() };
    },
    async cancelWarmup(): Promise<CancelWarmupResult> {
      return { cancelled: true, cancelledAt: Date.now() };
    },
    async getHealth(email: string): Promise<MailboxHealth> {
      return { email, reputationScore: 90, bounceRate: 0, complaintRate: 0, placementRate: 1 };
    },
    async release(email: string): Promise<ReleaseResult> {
      bought.delete(email);
      return { released: true, releasedAt: Date.now() };
    },
  };
  return { port, log };
}

/** A domain port that always succeeds — the domain leg is not the subject here. */
function healthyDomainPort(): DomainPort {
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
    async setDns(): Promise<DnsRecordSet> {
      return { mx: true, spf: true, dkim: true, dmarc: true, rdns: true };
    },
    async release(): Promise<ReleaseResult> {
      return { released: true, releasedAt: Date.now() };
    },
  };
}

async function runSetup(tenantId: string, mailbox: MailboxPort, primaryDomain: string, key: string): Promise<unknown> {
  const brand = primaryDomain.replace(/\.com$/, "");
  return withTenantContext(tenantId, (base) =>
    runSetupInfrastructure(
      { ...base, adapters: { ...base.adapters, domain: healthyDomainPort(), mailbox } },
      {
        brand,
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

function readMailboxRows(tenantId: string): Promise<{ email: string }[]> {
  return runInDurableObject(tenantStub(tenantId), (_i, s) =>
    s.storage.sql.exec<{ email: string }>(`SELECT email FROM mailboxes WHERE released_at IS NULL`).toArray(),
  );
}

function readMailboxIntents(tenantId: string): Promise<{ email: string; status: string }[]> {
  return runInDurableObject(tenantStub(tenantId), (_i, s) =>
    s.storage.sql.exec<{ email: string; status: string }>(`SELECT email, status FROM mailbox_intents`).toArray(),
  );
}

/**
 * Ages the durable buy-dispatch record past the window in which the provider is
 * still allowed to be catching up (engine/mailbox-acquisition.ts). Its timestamp
 * is REAL wall clock by design — the provider's lag is a real-world duration —
 * so a test moves the record rather than a tenant clock.
 */
function ageDispatchBeyondAbsenceWindow(tenantId: string, email: string): Promise<void> {
  return runInDurableObject(tenantStub(tenantId), (_i, s) => {
    s.storage.sql.exec(
      `UPDATE mailbox_buy_dispatches SET last_dispatched_at = ? WHERE email = ?`,
      Date.now() - ABSENCE_MIN_AGE_MS - 60_000,
      email,
    );
  });
}

function readIdempotencyKeys(tenantId: string): Promise<string[]> {
  return runInDurableObject(tenantStub(tenantId), (_i, s) =>
    s.storage.sql
      .exec<{ key: string }>(`SELECT key FROM request_idempotency`)
      .toArray()
      .map((r) => r.key),
  );
}

describe("L2 — the mailbox buy is followed by a readiness gate, and never repeated blind", () => {
  it("a buy the vendor has ACCEPTED but not finished leaves no billable row, no warmup, and a retryable error", async () => {
    const { tenantId } = await mintTenant("Async Buy Co", "managed");
    await activatePaidPlan(tenantId, "managed");
    const { port, log } = asyncMailboxVendor({ readyAfterChecks: 99 });

    const err = await runSetup(tenantId, port, "asyncbuy.com", "async-1");

    expect(err).toBeInstanceOf(VendorError);
    expect((err as VendorError).retryable).toBe(true);
    expect(log.buys).toHaveLength(1);
    // Pre-fix: startWarmup ran IMMEDIATELY after the buy and its uid lookup threw.
    expect(log.warmups).toEqual([]);
    // (e) — the billing meter counts mailbox rows, so a row here would bill a
    // customer monthly for a mailbox whose provisioning never completed.
    expect(await readMailboxRows(tenantId)).toEqual([]);
    // But the PURCHASE is durably recorded: that is what a retry reads.
    expect(await readMailboxIntents(tenantId)).toEqual([{ email: "sender11@asyncbuy0.com", status: "bought" }]);
  });

  it("the RETRY resumes at the wait and NEVER re-buys — the double-charge", async () => {
    const { tenantId } = await mintTenant("Async Buy Co", "managed");
    await activatePaidPlan(tenantId, "managed");
    // Ready on the 3rd status check: attempt 1 burns its 2-check budget, attempt
    // 2 finds it ready — the real "vendor caught up between retries" sequence.
    const { port, log } = asyncMailboxVendor({ readyAfterChecks: 2 });

    const first = await runSetup(tenantId, port, "resumebuy.com", "resume-1");
    expect(first).toBeInstanceOf(VendorError);

    const second = await runSetup(tenantId, port, "resumebuy.com", "resume-1");

    // THE POINT, asserted first: one purchase across both attempts. Pre-fix this
    // was 2 — a second paid mailbox at the vendor, invisible to us.
    expect(log.buys).toHaveLength(1);
    expect(second).not.toBeInstanceOf(Error);
    expect(log.warmups).toHaveLength(1);
    expect(await readMailboxRows(tenantId)).toEqual([{ email: "sender11@resumebuy0.com" }]);
    expect(await readMailboxIntents(tenantId)).toEqual([{ email: "sender11@resumebuy0.com", status: "committed" }]);
  });

  it("a buy that THROWS asks the vendor before deciding, and adopts what it already holds", async () => {
    const { tenantId } = await mintTenant("Dangling Buy Co", "managed");
    await activatePaidPlan(tenantId, "managed");

    // Attempt 1: the buy call fails ambiguously — it may or may not have landed.
    const failing = asyncMailboxVendor({ buyThrows: new VendorError("inboxkit mailboxes/buy -> HTTP 503: upstream", true) });
    await runSetup(tenantId, failing.port, "danglingbuy.com", "dangling-1");
    expect(await readMailboxIntents(tenantId)).toEqual([{ email: "sender11@danglingbuy0.com", status: "dangling" }]);

    // Attempt 2: it HAD landed. Asking is what distinguishes this from "the
    // order never went through" — and the answer decides, not an error string.
    const recovered = asyncMailboxVendor({ vendorHasItAlready: ["sender11@danglingbuy0.com"] });
    const err = await runSetup(tenantId, recovered.port, "danglingbuy.com", "dangling-1");

    expect(err).not.toBeInstanceOf(Error);
    expect(recovered.log.buys).toEqual([]); // adopted, not re-bought
    expect(await readMailboxRows(tenantId)).toEqual([{ email: "sender11@danglingbuy0.com" }]);
  });

  it("a dangling buy the vendor does NOT hold is bought — but only once the absence means something", async () => {
    const { tenantId } = await mintTenant("Lost Buy Co", "managed");
    await activatePaidPlan(tenantId, "managed");
    const email = "sender11@lostbuy0.com";

    const failing = asyncMailboxVendor({ buyThrows: new VendorError("inboxkit mailboxes/buy -> HTTP 503: upstream", true) });
    await runSetup(tenantId, failing.port, "lostbuy.com", "lost-1");

    // A throw is not proof the order never landed — it is proof we do not know.
    // A buy call that timed out AFTER the provider processed it looks identical
    // from here, and the provider's list lags a just-accepted order, so a
    // seconds-old "absent" would re-buy a mailbox we own. Under the guarded
    // re-buy (founder ruling 2026-08-06) this second dispatch waits for the
    // absence to be corroborated, exactly as the 'intent' case does.
    const tooSoon = asyncMailboxVendor();
    const held = await runSetup(tenantId, tooSoon.port, "lostbuy.com", "lost-1");
    expect(tooSoon.log.buys).toEqual([]);
    expect((held as VendorError).retryable).toBe(true);

    await ageDispatchBeyondAbsenceWindow(tenantId, email);

    // Now the throw really is established as having preceded the order, and
    // buying is the only way forward.
    const retry = asyncMailboxVendor();
    await runSetup(tenantId, retry.port, "lostbuy.com", "lost-1");
    expect(retry.log.buys).toEqual([email]);
  }, 30_000);
});

describe("N4 — teardown invalidates the record that says we already own the mailbox", () => {
  it("a re-provision after release BUYS again instead of inserting an unbacked billable row", async () => {
    const { tenantId } = await mintTenant("Rebuy After Teardown Co", "managed");
    await activatePaidPlan(tenantId, "managed");
    const { port, log } = asyncMailboxVendor();

    await runSetup(tenantId, port, "rebuyafter.com", "rebuy-1");
    expect(log.buys).toHaveLength(1);
    expect(billableAfter(await readMailboxRows(tenantId))).toBe(1);

    // Cancel: every mailbox goes back to the vendor.
    await withTenantContext(tenantId, (base) =>
      releaseMailboxes({ ...base, adapters: { ...base.adapters, domain: healthyDomainPort(), mailbox: port } }, {}),
    );
    expect(await readMailboxRows(tenantId)).toEqual([]);
    // The claim that says "this address is already provisioned" must be gone
    // with the resource it described.
    expect(await readIdempotencyKeys(tenantId)).not.toContain(`provision:mbx:${tenantId}:sender11@rebuyafter0.com`);
    expect(await readMailboxIntents(tenantId)).toEqual([{ email: "sender11@rebuyafter0.com", status: "released" }]);

    // Re-subscribe and provision again.
    await runSetup(tenantId, port, "rebuyafter.com", "rebuy-2");

    // Pre-fix: the stale claim replayed, the vendor buy was SKIPPED entirely,
    // and a billable row was inserted for a mailbox that no longer existed.
    expect(log.buys).toHaveLength(2);
    expect(billableAfter(await readMailboxRows(tenantId))).toBe(1);
  });
});

describe("billing counts only vendor-confirmed mailboxes (L7)", () => {
  it("an incomplete provision leaves the billable count at zero", async () => {
    const { tenantId } = await mintTenant("Unbilled Co", "managed");
    await activatePaidPlan(tenantId, "managed");
    const { port } = asyncMailboxVendor({ readyAfterChecks: 99 });

    await runSetup(tenantId, port, "unbilled.com", "unbilled-1");

    const billable = await withTenantContext(tenantId, (ctx) => billableMailboxCount(ctx));
    expect(billable).toBe(0);
  });
});

function billableAfter(rows: { email: string }[]): number {
  return rows.length;
}

void env;
