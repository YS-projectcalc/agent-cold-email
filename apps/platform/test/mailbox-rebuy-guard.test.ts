import { env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
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
import { mailboxProvisioningCheckName, mailboxRebuyCheckName } from "../src/admin/watchtower.js";
import { ABSENCE_MIN_AGE_MS } from "../src/engine/mailbox-acquisition.js";
import { provisionMailboxesForDomain } from "../src/engine/mailbox-provisioning.js";
import { releaseMailboxes } from "../src/engine/lifecycle.js";
import { runSetupInfrastructure } from "../src/engine/provisioning.js";
import { SandboxOpsMailer } from "../src/ops-mail/sandbox-ops-mailer.js";
import { activatePaidPlan, mintTenant, tenantStub, withTenantContext } from "./helpers.js";

// GUARDED MAILBOX RE-BUY (founder ruling 2026-08-06) — one automatic re-buy per
// stuck purchase, only after the provider confirms the first produced NOTHING,
// with an alert on entering the stuck state and on the re-buy's outcome.
//
// The two defects this closes are the same question wearing different clothes:
//
//  (a) wave-integration gate finding #3 — a kill between the provider ACCEPTING
//      a buy and our status write leaves `mailbox_intents` at 'intent', which
//      the old code read as "nothing was ever sent" and bought again. Real
//      money, silently, for a mailbox the customer already owned.
//  (b) wave 1's sibling finding — a buy the provider accepts and never fulfils
//      wedges forever, because the saga (correctly, for money) never re-bought
//      on 'bought'.
//
// Every fixture here models a provider that can be WRONG in the ways that
// matter: it can accept an order and never produce the mailbox, and its listing
// call can fail outright. A fake where "provision() returned" means "the mailbox
// exists" cannot express either defect — which is exactly how both shipped.

interface VendorLog {
  buys: string[];
  stateChecks: string[];
}

type FulfilMode =
  /** Accepts the buy and lists the mailbox — ready after `readyAfterChecks` looks. */
  | "fulfils"
  /** Accepts the buy and NEVER lists the mailbox: the wedge. */
  | "accepts-but-never-fulfils";

/**
 * A MailboxPort with the real provider's failure surface: an accepted buy is not
 * a mailbox, and `provisioningState` is a network call that can fail rather than
 * answer. `listingThrows` is the difference between "the provider says no" and
 * "the provider could not be asked" — the distinction that decides whether a
 * second purchase is authorized.
 */
function fallibleMailboxVendor(
  opts: {
    mode?: FulfilMode;
    readyAfterChecks?: number;
    listingThrows?: VendorError;
    buyThrows?: VendorError;
    vendorHasItAlready?: string[];
  } = {},
): { port: MailboxPort; log: VendorLog } {
  const log: VendorLog = { buys: [], stateChecks: [] };
  const listed = new Set<string>(opts.vendorHasItAlready ?? []);
  const checks = new Map<string, number>();
  const readyAfter = opts.readyAfterChecks ?? 0;
  const mode = opts.mode ?? "fulfils";

  const port: MailboxPort = {
    async provision(domain: string, localPart: string): Promise<ProvisionedMailbox> {
      const email = `${localPart}@${domain}`;
      log.buys.push(email);
      if (opts.buyThrows) throw opts.buyThrows;
      // The order is ACCEPTED either way. Whether a mailbox ever appears is a
      // separate fact, which is the whole point.
      if (mode === "fulfils") listed.add(email);
      return { email, provider: "google", provisionedAt: Date.now() };
    },
    async provisioningState(email: string): Promise<MailboxProvisioningState> {
      log.stateChecks.push(email);
      if (opts.listingThrows) throw opts.listingThrows;
      if (!listed.has(email)) return "absent";
      const seen = (checks.get(email) ?? 0) + 1;
      checks.set(email, seen);
      return seen > readyAfter ? "ready" : "pending";
    },
    async startWarmup(email: string): Promise<{ started: boolean; startedAt: number }> {
      if (!listed.has(email)) throw new VendorError(`no mailbox matching ${email}`, false);
      return { started: true, startedAt: Date.now() };
    },
    async cancelWarmup(): Promise<CancelWarmupResult> {
      return { cancelled: true, cancelledAt: Date.now() };
    },
    async getHealth(email: string): Promise<MailboxHealth> {
      return { email, reputationScore: 90, bounceRate: 0, complaintRate: 0, placementRate: 1 };
    },
    async release(email: string): Promise<ReleaseResult> {
      listed.delete(email);
      return { released: true, releasedAt: Date.now() };
    },
  };
  return { port, log };
}

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

/** The REAL setup entry point — never a hand-built adapter bundle around the unit under test. */
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

function mailboxOf(primaryDomain: string): string {
  return `sender11@${primaryDomain.replace(/\.com$/, "")}0.com`;
}

function readIntents(tenantId: string): Promise<{ email: string; status: string }[]> {
  return runInDurableObject(tenantStub(tenantId), (_i, s) =>
    s.storage.sql.exec<{ email: string; status: string }>(`SELECT email, status FROM mailbox_intents`).toArray(),
  );
}

function readDispatches(tenantId: string): Promise<{ email: string; attempts: number; last_dispatched_at: number; reconstructed: number }[]> {
  return runInDurableObject(tenantStub(tenantId), (_i, s) =>
    s.storage.sql
      .exec<{ email: string; attempts: number; last_dispatched_at: number; reconstructed: number }>(
        `SELECT email, attempts, last_dispatched_at, reconstructed FROM mailbox_buy_dispatches`,
      )
      .toArray(),
  );
}

function readMailboxRows(tenantId: string): Promise<{ email: string }[]> {
  return runInDurableObject(tenantStub(tenantId), (_i, s) =>
    s.storage.sql.exec<{ email: string }>(`SELECT email FROM mailboxes WHERE released_at IS NULL`).toArray(),
  );
}

/** Models the ONE thing a kill between the accepted buy and our bookkeeping destroys: the status write. */
function loseStatusWrite(tenantId: string, email: string): Promise<void> {
  return runInDurableObject(tenantStub(tenantId), (_i, s) => {
    s.storage.sql.exec(`UPDATE mailbox_intents SET status = 'intent' WHERE email = ?`, email);
  });
}

/**
 * Ages the durable dispatch record past the window in which the provider is
 * still allowed to be catching up. The timestamp is REAL wall clock by design
 * (the provider's lag is a real-world duration), so a test moves it rather than
 * moving a tenant clock.
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

function watchtowerRow(checkName: string) {
  return env.DB.prepare(`SELECT status, since_ts, last_alert_ts, last_detail FROM watchtower_state WHERE check_name = ?`)
    .bind(checkName)
    .first<{ status: string; since_ts: number; last_alert_ts: number | null; last_detail: string }>();
}

// watchtower_state is cross-tenant D1 and is NOT rolled back between tests in
// this pool — each test drives its own alert timeline from empty.
beforeEach(async () => {
  await env.DB.prepare("DELETE FROM watchtower_state").run();
});

describe("gate finding #3 — a buy the provider accepted, recorded as 'intent' by a lost status write", () => {
  it("adopts what the provider holds instead of buying a SECOND paid mailbox", async () => {
    const { tenantId } = await mintTenant("Lost Write Co", "managed");
    await activatePaidPlan(tenantId, "managed");
    const primary = "lostwrite.com";
    const email = mailboxOf(primary);

    // Attempt 1 runs for real: it claims the dispatch, the provider accepts the
    // buy, and the readiness gate throws because the mailbox is not listable yet.
    const first = fallibleMailboxVendor({ readyAfterChecks: 99 });
    expect(await runSetup(tenantId, first.port, primary, "lost-1")).toBeInstanceOf(VendorError);
    expect(first.log.buys).toEqual([email]);

    // THE CRASH: everything the process wrote after the provider answered is
    // gone. Only the status write is undone — the dispatch claim is written
    // BEFORE the vendor call precisely so it survives this.
    await loseStatusWrite(tenantId, email);
    expect(await readIntents(tenantId)).toEqual([{ email, status: "intent" }]);

    // Attempt 2: the provider has caught up and lists the mailbox we already own.
    const second = fallibleMailboxVendor({ vendorHasItAlready: [email] });
    const result = await runSetup(tenantId, second.port, primary, "lost-1");

    // THE POINT: zero further purchases. Pre-fix this bought a second mailbox
    // because 'intent' was read as "no purchase has been attempted".
    expect(second.log.buys).toEqual([]);
    expect(result).not.toBeInstanceOf(Error);
    expect(await readMailboxRows(tenantId)).toEqual([{ email }]);
    expect(await readIntents(tenantId)).toEqual([{ email, status: "committed" }]);
    // One dispatch, claimed before the only buy that ever happened.
    expect(await readDispatches(tenantId)).toEqual([expect.objectContaining({ email, attempts: 1, reconstructed: 0 })]);
  });

  it("an intent row from BEFORE the dispatch table existed is not bought a second time either", async () => {
    const { tenantId } = await mintTenant("Legacy Intent Co", "managed");
    await activatePaidPlan(tenantId, "managed");
    const primary = "legacyintent.com";
    const email = mailboxOf(primary);

    const first = fallibleMailboxVendor({ readyAfterChecks: 99 });
    expect(await runSetup(tenantId, first.port, primary, "legacy-1")).toBeInstanceOf(VendorError);

    // Every mailbox provisioned before this table shipped is in exactly this
    // state: a 'bought' intent with no dispatch record. Reading that as zero
    // dispatches would re-buy a live customer's mailbox on the next retry.
    await runInDurableObject(tenantStub(tenantId), (_i, s) => {
      s.storage.sql.exec(`DELETE FROM mailbox_buy_dispatches`);
    });

    const second = fallibleMailboxVendor({ vendorHasItAlready: [email] });
    await runSetup(tenantId, second.port, primary, "legacy-1");

    expect(second.log.buys).toEqual([]);
    // Reconstructed, and marked as such: its dispatch time is unknowable, so the
    // absence clock restarts now rather than pretending to know.
    expect(await readDispatches(tenantId)).toEqual([expect.objectContaining({ email, attempts: 1, reconstructed: 1 })]);
  });
});

describe("the wedge — a purchase the provider accepted and never fulfilled", () => {
  it("re-buys exactly ONCE after the provider confirms nothing exists, then hard-stops", async () => {
    const { tenantId } = await mintTenant("Wedged Co", "managed");
    await activatePaidPlan(tenantId, "managed");
    const primary = "wedged.com";
    const email = mailboxOf(primary);
    // Accepts every order; never lists a mailbox. The wedge, exactly.
    const { port, log } = fallibleMailboxVendor({ mode: "accepts-but-never-fulfils" });

    // Attempt 1 — the original buy.
    expect(await runSetup(tenantId, port, primary, "wedge-1")).toBeInstanceOf(VendorError);
    expect(log.buys).toHaveLength(1);

    // Attempt 2, immediately — the provider says absent, but a just-dispatched
    // order is absent too. Absence this fresh authorizes NOTHING.
    const tooSoon = await runSetup(tenantId, port, primary, "wedge-1");
    expect(tooSoon).toBeInstanceOf(VendorError);
    expect((tooSoon as VendorError).retryable).toBe(true);
    expect(log.buys).toHaveLength(1);

    // Attempt 3, once the provider has had long enough for "absent" to mean it.
    await ageDispatchBeyondAbsenceWindow(tenantId, email);
    const rebuy = await runSetup(tenantId, port, primary, "wedge-1");
    expect(rebuy).toBeInstanceOf(VendorError);
    expect(log.buys).toHaveLength(2); // the ONE authorized re-buy
    expect(await readDispatches(tenantId)).toEqual([expect.objectContaining({ email, attempts: 2 })]);

    // Attempt 4 — the re-buy failed to produce a mailbox too. The budget is
    // spent: a third purchase is never made, and the answer stops being "retry".
    await ageDispatchBeyondAbsenceWindow(tenantId, email);
    const abandoned = await runSetup(tenantId, port, primary, "wedge-1");
    expect(abandoned).toBeInstanceOf(VendorError);
    expect((abandoned as VendorError).retryable).toBe(false);
    expect(log.buys).toHaveLength(2);

    // Even repeated, it never spends again.
    await ageDispatchBeyondAbsenceWindow(tenantId, email);
    await runSetup(tenantId, port, primary, "wedge-1");
    expect(log.buys).toHaveLength(2);
    expect(await readMailboxRows(tenantId)).toEqual([]);

    // Both halves of the ruling reported: the stuck state, and the outcome.
    expect(await watchtowerRow(mailboxProvisioningCheckName(email))).toMatchObject({ status: "unhealthy" });
    const rebuyAlert = await watchtowerRow(mailboxRebuyCheckName(email));
    expect(rebuyAlert).toMatchObject({ status: "unhealthy" });
    expect(rebuyAlert!.last_detail).toContain("abandoned");
    // Five setup attempts, each re-polling the provider across its own backoff.
  }, 60_000);

  it("a re-buy that WORKS completes the mailbox and clears the stuck alert", async () => {
    const { tenantId } = await mintTenant("Recovered Co", "managed");
    await activatePaidPlan(tenantId, "managed");
    const primary = "recovered.com";
    const email = mailboxOf(primary);

    const lost = fallibleMailboxVendor({ mode: "accepts-but-never-fulfils" });
    expect(await runSetup(tenantId, lost.port, primary, "recover-1")).toBeInstanceOf(VendorError);
    await ageDispatchBeyondAbsenceWindow(tenantId, email);
    expect(await watchtowerRow(mailboxProvisioningCheckName(email))).toBeNull();

    // A fresh provider that both accepts AND fulfils — the re-buy lands.
    const working = fallibleMailboxVendor();
    const result = await runSetup(tenantId, working.port, primary, "recover-1");

    expect(working.log.buys).toEqual([email]);
    expect(result).not.toBeInstanceOf(Error);
    expect(await readMailboxRows(tenantId)).toEqual([{ email }]);
    // Stuck -> resolved: the state machine's recovery transition is what reports
    // a SUCCESSFUL re-buy to the founder.
    expect(await watchtowerRow(mailboxProvisioningCheckName(email))).toMatchObject({ status: "healthy" });
    expect(await watchtowerRow(mailboxRebuyCheckName(email))).toBeNull();
  });
});

describe("a listing that FAILS is not a listing that says no", () => {
  it("never authorizes a re-buy when the provider could not be asked", async () => {
    const { tenantId } = await mintTenant("Blind Lookup Co", "managed");
    await activatePaidPlan(tenantId, "managed");
    const primary = "blindlookup.com";
    const email = mailboxOf(primary);

    const first = fallibleMailboxVendor({ mode: "accepts-but-never-fulfils" });
    expect(await runSetup(tenantId, first.port, primary, "blind-1")).toBeInstanceOf(VendorError);
    // Old enough that a genuine "absent" WOULD authorize the re-buy — so the
    // only thing withholding it below is the failed lookup itself.
    await ageDispatchBeyondAbsenceWindow(tenantId, email);

    const blind = fallibleMailboxVendor({
      listingThrows: new VendorError("mailboxes/list -> HTTP 503: upstream", true),
      vendorHasItAlready: [email],
    });
    const err = await runSetup(tenantId, blind.port, primary, "blind-1");

    expect(blind.log.buys).toEqual([]);
    expect(err).toBeInstanceOf(VendorError);
    expect((err as VendorError).retryable).toBe(true);
    expect(await watchtowerRow(mailboxProvisioningCheckName(email))).toMatchObject({ status: "unhealthy" });
    expect((await watchtowerRow(mailboxProvisioningCheckName(email)))!.last_detail).toContain("could not be asked");
  });
});

describe("the re-buy claim is crash-safe", () => {
  it("a crash mid-re-buy cannot yield a THIRD purchase", async () => {
    const { tenantId } = await mintTenant("Crash Midrebuy Co", "managed");
    await activatePaidPlan(tenantId, "managed");
    const primary = "crashmid.com";
    const email = mailboxOf(primary);
    const { port, log } = fallibleMailboxVendor({ mode: "accepts-but-never-fulfils" });

    expect(await runSetup(tenantId, port, primary, "crash-1")).toBeInstanceOf(VendorError);
    await ageDispatchBeyondAbsenceWindow(tenantId, email);
    await runSetup(tenantId, port, primary, "crash-1"); // the one authorized re-buy
    expect(log.buys).toHaveLength(2);

    // THE CRASH, this time during the re-buy: the claim is on disk, everything
    // written after the provider answered is not. The intent looks untouched.
    await loseStatusWrite(tenantId, email);
    await ageDispatchBeyondAbsenceWindow(tenantId, email);

    const err = await runSetup(tenantId, port, primary, "crash-1");

    // The claim, not the status, is what the budget is counted from.
    expect(log.buys).toHaveLength(2);
    expect((err as VendorError).retryable).toBe(false);
  }, 60_000);
});

describe("teardown drops the dispatch record with the resource it describes", () => {
  it("a re-provision after release spends its FIRST buy, not its re-buy budget", async () => {
    const { tenantId } = await mintTenant("Rebuy Budget Co", "managed");
    await activatePaidPlan(tenantId, "managed");
    const primary = "rebuybudget.com";
    const email = mailboxOf(primary);
    const { port, log } = fallibleMailboxVendor();

    await runSetup(tenantId, port, primary, "budget-1");
    expect(await readMailboxRows(tenantId)).toEqual([{ email }]);

    await withTenantContext(tenantId, (base) =>
      releaseMailboxes({ ...base, adapters: { ...base.adapters, domain: healthyDomainPort(), mailbox: port } }, {}),
    );
    // A surviving dispatch record would make the next provision's FIRST buy look
    // like a re-buy — burning the whole budget, and (worse) asking the provider
    // about an address it has correctly forgotten.
    expect(await readDispatches(tenantId)).toEqual([]);

    // Re-provision THE SAME address (a fresh setup would pick a new lookalike
    // domain and prove nothing about this one).
    const domainId = await runInDurableObject(tenantStub(tenantId), (_i, s) =>
      s.storage.sql.exec<{ id: string }>(`SELECT id FROM domains WHERE domain = ?`, `${primary.replace(/\.com$/, "")}0.com`).one().id,
    );
    await withTenantContext(tenantId, (base) =>
      provisionMailboxesForDomain(
        { ...base, adapters: { ...base.adapters, mailbox: port } },
        { domainId, domain: `${primary.replace(/\.com$/, "")}0.com`, domainOrdinal: 0, personaSlug: "sender", inboxesEach: 1 },
      ),
    );

    // A second BUY, not a re-buy: the address starts its dispatch budget over.
    expect(log.buys).toEqual([email, email]);
    expect(await readDispatches(tenantId)).toEqual([expect.objectContaining({ email, attempts: 1, reconstructed: 0 })]);
    expect(await readMailboxRows(tenantId)).toEqual([{ email }]);
  }, 30_000);
});

describe("the founder alerts", () => {
  it("name the address and the situation without naming the provider, and do not storm", async () => {
    const { tenantId } = await mintTenant("Alert Co", "managed");
    await activatePaidPlan(tenantId, "managed");
    const domain = "alertco0.com";
    const email = `sender11@${domain}`;
    const { port } = fallibleMailboxVendor({ mode: "accepts-but-never-fulfils" });
    const mailer = new SandboxOpsMailer();

    const provision = () =>
      withTenantContext(tenantId, (base) =>
        provisionMailboxesForDomain(
          { ...base, adapters: { ...base.adapters, mailbox: port } },
          { domainId: "dom_alert", domain, domainOrdinal: 0, personaSlug: "sender", inboxesEach: 1, mailer },
        ).catch((e: unknown) => e),
      );

    await provision();
    await ageDispatchBeyondAbsenceWindow(tenantId, email);
    await provision(); // stuck confirmed -> alert + the one re-buy (which also fails)

    const stuck = mailer.sent.filter((m) => m.subject.includes("Mailbox provisioning"));
    expect(stuck).toHaveLength(1);
    expect(stuck[0]!.subject).toBe(`[coldrig] Mailbox provisioning ${email}: UNHEALTHY`);
    expect(stuck[0]!.to).toBe(env.OPS_ALERT_EMAIL);
    expect(stuck[0]!.text).toContain(tenantId);
    expect(stuck[0]!.text).toContain("produced nothing");

    // Every retry re-enters the stuck path; the state machine's cooldown is what
    // keeps a tenant retrying each minute from emailing the founder each minute.
    const alertedAt = (await watchtowerRow(mailboxProvisioningCheckName(email)))!.last_alert_ts;
    await ageDispatchBeyondAbsenceWindow(tenantId, email);
    await provision();
    await ageDispatchBeyondAbsenceWindow(tenantId, email);
    await provision();

    expect(mailer.sent.filter((m) => m.subject.includes("Mailbox provisioning"))).toHaveLength(1);
    expect((await watchtowerRow(mailboxProvisioningCheckName(email)))!.last_alert_ts).toBe(alertedAt);

    // The re-buy's own outcome is reported under its own name, so the stuck
    // alert seconds earlier cannot swallow it — and it is deduped in turn.
    const rebuyFailed = mailer.sent.filter((m) => m.subject.includes("Mailbox re-buy"));
    expect(rebuyFailed).toHaveLength(1);
    expect(rebuyFailed[0]!.subject).toBe(`[coldrig] Mailbox re-buy ${email}: UNHEALTHY`);
    // Nothing ever became real here, so nothing may claim recovery.
    expect(mailer.sent.filter((m) => m.subject.includes("RECOVERED"))).toEqual([]);

    // Internal alerts may be specific, but naming the vendor is never useful and
    // these bodies are one copy-paste from a customer-visible surface.
    for (const message of mailer.sent) {
      expect(`${message.subject} ${message.text} ${message.html}`.toLowerCase()).not.toContain("inboxkit");
    }
  }, 60_000);
});
