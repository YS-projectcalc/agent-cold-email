// The vendor-verdict class (docs/adversarial/vendor-verdict-class-sweep-2026-08-14.md).
//
// CLASS: a terminal vendor state graded as a transient not-yet, because (facet 1)
// the port collapses "the vendor says dead" and "the vendor says not yet" into one
// indistinguishable return value that no type forces it to discriminate, and
// (facet 2) nothing bounds the resulting durable pending state, so it never
// becomes a failure.
//
// The confirmed live defect it closes (docs/adversarial/c3-postship-reattack-2026-08-14.md
// Finding 1): a permanently-dead purchased registration was reported to the
// customer as 202 `provisioning:"pending"` FOREVER — paid domain, zero mailboxes,
// info-severity messages, nothing escalating.
//
// These tests are ADAPTED from the adversary's executable attacks (ATTACK C-1 /
// C-2, which asserted the DEFECT) — every assertion below is flipped to the FIXED
// behavior, so the whole file is RED on the pre-fix tree.
//
// LOAD-BEARING ASYMMETRY (never delete): guessing not-ready costs a retry;
// guessing ready bills a customer for a dead mailbox. Nothing here may make a
// not-ready state read as ready, and a terminal verdict never triggers a re-buy.

import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import type {
  DomainConnectionType,
  DomainDnsResult,
  DomainPort,
  LookalikeCandidate,
  MailboxHealth,
  MailboxPort,
  MailboxReadiness,
  OwnedDomain,
  ProvisionedMailbox,
  PurchasedDomain,
  ReleaseResult,
  VendorReadiness,
} from "@coldstart/shared";
import { DNS_PENDING_MAX_MS, setDnsWithRetry } from "../src/engine/domain-dns.js";
import { runProvisioningReconcile } from "../src/engine/provisioning-reconcile.js";
import { runSetupInfrastructure } from "../src/engine/provisioning.js";
import { runDeliverabilitySweep } from "../src/engine/deliverability-actions.js";
import { DEFAULT_THRESHOLDS } from "../src/engine/deliverability.js";
import { ONE_DAY_MS, WARMUP_RAMP_DAYS } from "../src/engine/warmup.js";
import { sendPipelineChecks } from "../src/admin/watchtower.js";
import { RegistrarUnarmedDomainPort } from "../src/vendors/real/domain-port.js";
import { RealInboxKitDomainPort } from "../src/vendors/real/inboxkit-domain-port.js";
import { RealMailboxPort } from "../src/vendors/real/mailbox-port.js";
import { SandboxDomainPort } from "../src/vendors/sandbox/domain-port.js";
import { SandboxMailboxPort } from "../src/vendors/sandbox/mailbox-port.js";
import { RealClock } from "../src/clock.js";
import { SandboxOpsMailer } from "../src/ops-mail/sandbox-ops-mailer.js";
import { activatePaidPlan, api, mintTenant, seedBenignSdnList, signup, tenantStub, withTenantContext } from "./helpers.js";

// Local copy of the bound, so this file's arithmetic never depends on the very
// constant it is asserting into existence (an `undefined` import would silently
// turn every age computation into NaN instead of failing on the assertion).
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

const ALL_FALSE = { mx: false, spf: false, dkim: false, dmarc: false, rdns: false };
const ALL_TRUE = { mx: true, spf: true, dkim: true, dmarc: true, rdns: true };

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubJson(body: unknown): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
}

function domainPort(): RealInboxKitDomainPort {
  return new RealInboxKitDomainPort(
    { apiKey: "k", workspaceId: "w", baseUrl: "https://stub.invalid/v1/api" },
    {
      firstName: "A",
      lastName: "B",
      email: "a@b.com",
      phone: "1",
      organization: "O",
      addressLine1: "1 St",
      city: "C",
      state: "S",
      country: "US",
      postalCode: "1",
    },
  );
}

function mailboxPort(): RealMailboxPort {
  return new RealMailboxPort({ apiKey: "k", workspaceId: "w", baseUrl: "https://stub.invalid/v1/api" });
}

// --- guard A, domain side: the port answers a VERDICT ----------------------

describe("guard A — the real domain port reports a TERMINAL vendor state as terminal", () => {
  // ATTACK C-1, flipped. Pre-fix these five all returned an all-false
  // DnsRecordSet — byte-identical to a registration accepted two seconds ago.
  // 'scheduled_for_deletion' (rider, gate delta 2026-08-14, UNVERIFIABLE #1):
  // observed LIVE 2026-08-14 on the real InboxKit workspace (`/domains/list`
  // returned a domain with this exact status) — a live observation, not a
  // plausible synonym, so vendor-lifecycle.ts's own extension rule is met.
  for (const status of ["expired", "suspended", "pending_deletion", "failed", "cancelled", "deleted", "scheduled_for_deletion"]) {
    it(`vendor lists the purchased domain with status='${status}' -> verdict TERMINAL`, async () => {
      stubJson({
        error: false,
        pages: 1,
        domains: [{ uid: "u1", name: "deadco0.com", status, connection_type: "purchased", assigned_mailboxes: 0 }],
      });
      const result: DomainDnsResult = await domainPort().setDns("deadco0.com", "k", "purchased");
      expect(result.verdict).toEqual({ kind: "terminal", vendorState: status });
      // Never ready: the records half must not contradict the verdict.
      expect(result.records).toEqual(ALL_FALSE);
    });
  }

  it("CONTROL — a genuinely active purchased domain is READY (all-true records)", async () => {
    stubJson({
      error: false,
      pages: 1,
      domains: [{ uid: "u1", name: "liveco0.com", status: "active", connection_type: "purchased", assigned_mailboxes: 0 }],
    });
    const result = await domainPort().setDns("liveco0.com", "k", "purchased");
    expect(result.verdict).toEqual({ kind: "ready" });
    expect(result.records).toEqual(ALL_TRUE);
  });

  it("CONTROL — a real /domains/list API error still THROWS (the split the C3 gate proved)", async () => {
    stubJson({ error: true, message: "boom" });
    await expect(domainPort().setDns("x0.com", "k", "purchased")).rejects.toThrow(/domains\/list failed/);
  });

  it("a domain the vendor does not list yet is NOT_YET (async registration), never terminal", async () => {
    stubJson({ error: false, pages: 1, domains: [] });
    const result = await domainPort().setDns("fresh0.com", "k", "purchased");
    expect(result.verdict).toEqual({ kind: "not_yet" });
  });

  it("an UNRECOGNIZED vendor status token is INCONCLUSIVE, never terminal (live vocabulary unverified)", async () => {
    stubJson({
      error: false,
      pages: 1,
      domains: [{ uid: "u1", name: "weird0.com", status: "transferring_in", connection_type: "purchased", assigned_mailboxes: 0 }],
    });
    const result = await domainPort().setDns("weird0.com", "k", "purchased");
    expect(result.verdict.kind).toBe("inconclusive");
    expect(result.records).toEqual(ALL_FALSE);
  });
});

// --- guard A, mailbox side ------------------------------------------------

describe("guard A — the real mailbox port reports a TERMINAL mailbox as terminal", () => {
  function listBody(status: string) {
    return { error: false, mailboxes: [{ uid: "m1", domain_name: "co.com", username: "sender11", status }] };
  }

  for (const status of ["suspended", "cancelled", "expired", "failed", "deleted", "pending_deletion"]) {
    it(`vendor lists the mailbox with status='${status}' -> verdict TERMINAL, not 'still being created'`, async () => {
      stubJson(listBody(status));
      const verdict: MailboxReadiness = await mailboxPort().provisioningState("sender11@co.com");
      expect(verdict).toEqual({ kind: "terminal", vendorState: status });
    });
  }

  it("CONTROL — an active mailbox is READY", async () => {
    stubJson(listBody("active"));
    expect(await mailboxPort().provisioningState("sender11@co.com")).toEqual({ kind: "ready" });
  });

  it("CONTROL — a 'scheduled' mailbox is NOT_YET (the async buy window)", async () => {
    stubJson(listBody("scheduled"));
    expect(await mailboxPort().provisioningState("sender11@co.com")).toEqual({ kind: "not_yet" });
  });

  it("CONTROL — a mailbox the vendor lists nothing for is ABSENT", async () => {
    stubJson({ error: false, mailboxes: [] });
    expect(await mailboxPort().provisioningState("sender11@co.com")).toEqual({ kind: "absent" });
  });

  // NEW class member found mid-build: /mailboxes/list answers 200 with
  // `{error:true}` and InboxKitClient only checks res.ok, so the errored body
  // used to read as "the vendor holds nothing" — the ONE state that authorizes
  // the automatic re-buy. A failed lookup proves nothing.
  it("an ERRORED /mailboxes/list body is INCONCLUSIVE, never 'absent' (absent authorizes a re-buy)", async () => {
    stubJson({ error: true, message: "workspace unavailable" });
    const verdict = await mailboxPort().provisioningState("sender11@co.com");
    expect(verdict.kind).toBe("inconclusive");
  });
});

// --- the end-to-end consequence ------------------------------------------

interface PortLog {
  buys: string[];
  setDns: number;
}

/** A DomainPort whose setDns answers a fixed verdict — the shape ATTACK C-1 proved the real port produces. */
function verdictPort(verdict: VendorReadiness): { p: DomainPort; log: PortLog } {
  const log: PortLog = { buys: [], setDns: 0 };
  const p: DomainPort = {
    async searchLookalikes(_b, primaryDomain, count): Promise<LookalikeCandidate[]> {
      const slug = primaryDomain.split(".")[0];
      return Array.from({ length: count }, (_v, i) => ({ domain: `${slug}${i}.com`, available: true }));
    },
    async listOwnedDomains(): Promise<OwnedDomain[]> {
      return [];
    },
    async buy(domain: string): Promise<PurchasedDomain> {
      log.buys.push(domain);
      return { domain, purchasedAt: Date.now(), registrar: "test", connectionType: "purchased" };
    },
    async setDns(_d: string, _k: string, _ct: DomainConnectionType): Promise<DomainDnsResult> {
      log.setDns++;
      return { verdict, records: verdict.kind === "ready" ? ALL_TRUE : ALL_FALSE };
    },
    async release(): Promise<ReleaseResult> {
      return { released: true, releasedAt: Date.now() };
    },
  };
  return { p, log };
}

function setupInput(brand: string, primaryDomain: string) {
  return {
    brand,
    primaryDomain,
    domains: 1,
    inboxesEach: 2,
    persona: "Sender",
    physicalAddress: "1 Test St",
    senderIdentity: `S <s@${primaryDomain}>`,
    quoteOnly: false as const,
  };
}

async function runSetup(tenantId: string, port: DomainPort, input: ReturnType<typeof setupInput>, key: string): Promise<unknown> {
  return withTenantContext(tenantId, (base) =>
    runSetupInfrastructure(
      { ...base, adapters: { ...base.adapters, domain: port } },
      input,
      new SandboxOpsMailer(),
      key,
    ).catch((e: unknown) => e),
  );
}

type DomainRow = {
  status: string;
  dns_status: string;
  dns_gave_up_at: number | null;
  dns_check_count: number;
  dns_first_checked_at: number | null;
  [column: string]: SqlStorageValue;
};

function readDomainRows(tenantId: string): Promise<DomainRow[]> {
  return runInDurableObject(tenantStub(tenantId), (_i, s) =>
    s.storage.sql
      .exec<DomainRow>(`SELECT status, dns_status, dns_gave_up_at, dns_check_count, dns_first_checked_at FROM domains`)
      .toArray(),
  );
}

/** The tenant's ONE provisioned domain row — asserts the count so no test reads a phantom. */
async function readOneDomainRow(tenantId: string): Promise<DomainRow> {
  const rows = await readDomainRows(tenantId);
  expect(rows, "expected exactly one domain row").toHaveLength(1);
  return rows[0] as DomainRow;
}

function readMailboxCount(tenantId: string): Promise<number> {
  return runInDurableObject(
    tenantStub(tenantId),
    (_i, s) => s.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) as n FROM mailboxes WHERE released_at IS NULL`).one().n,
  );
}

describe("rider — scheduled_for_deletion drives the REAL port's verdict into the engine's bound", () => {
  it("a REAL port poll of scheduled_for_deletion is non-retryable on the FIRST call (not bounded-benign)", async () => {
    const { tenantId } = await mintTenant("Sched Deletion Co", "managed");
    await activatePaidPlan(tenantId, "managed");
    stubJson({
      error: false,
      pages: 1,
      domains: [{ uid: "u1", name: "scheddel0.com", status: "scheduled_for_deletion", connection_type: "purchased", assigned_mailboxes: 0 }],
    });

    // setDnsWithRetry's own contract is to drive DNS for an ALREADY-PERSISTED
    // row (it never buys) — persisting directly is the surgical way to reach
    // it without also exercising the unrelated buy()/registrant-completeness
    // path this file's other end-to-end tests use a synthetic port to skip.
    await runInDurableObject(tenantStub(tenantId), (_i, s) => {
      s.storage.sql.exec(
        `INSERT INTO domains (id, tenant_id, domain, status, purchased_at, dns_status, connection_type, source)
         VALUES ('dom_sched', ?, 'scheddel0.com', 'active', ?, 'pending', 'purchased', 'provisioned')`,
        tenantId,
        Date.now(),
      );
    });

    const err = await withTenantContext(tenantId, (ctx) =>
      setDnsWithRetry({ ...ctx, adapters: { ...ctx.adapters, domain: domainPort() } }, "scheddel0.com", "sched-key-1", "dom_sched").catch(
        (e: unknown) => e,
      ),
    );

    expect(err).toBeInstanceOf(Error);
    expect((err as { retryable?: boolean }).retryable).toBe(false);
    const row = await readOneDomainRow(tenantId);
    expect(row.dns_gave_up_at).not.toBeNull(); // gave up immediately, not left "still propagating"
  });
});

describe("the confirmed defect — a TERMINAL registration is never reported as success-pending", () => {
  it("setup_infrastructure REJECTS non-retryably instead of returning 202 provisioning:pending", async () => {
    const { tenantId } = await mintTenant("Dead Reg Co", "managed");
    await activatePaidPlan(tenantId, "managed");
    const { p, log } = verdictPort({ kind: "terminal", vendorState: "expired" });

    const outcome = await runSetup(tenantId, p, setupInput("deadreg", "deadreg.com"), "terminal-1");

    expect(outcome).toBeInstanceOf(Error);
    expect(outcome).not.toMatchObject({ provisioning: "pending" });
    // NON-retryable: telling the agent to keep retrying a dead registration is
    // the 24-hour loop this platform has already shipped once.
    expect((outcome as { retryable?: boolean }).retryable).toBe(false);
    // Actionable and vendor-blind (never names the provider).
    expect((outcome as Error).message).toMatch(/no longer usable|cannot be used|contact support/i);

    expect(await readMailboxCount(tenantId)).toBe(0);
    expect(log.buys).toHaveLength(1);
  });

  it("the give-up is DURABLE — dns_gave_up_at is stamped, and repeat calls never become success-pending", async () => {
    const { tenantId } = await mintTenant("Dead Reg Co2", "managed");
    await activatePaidPlan(tenantId, "managed");
    const { p, log } = verdictPort({ kind: "terminal", vendorState: "suspended" });

    const outcomes: unknown[] = [];
    for (let i = 0; i < 3; i++) {
      outcomes.push(await runSetup(tenantId, p, setupInput("deadregb", "deadregb.com"), `terminal-b-${i}`));
    }
    for (const [i, o] of outcomes.entries()) {
      expect(o, `call ${i} did not reject`).toBeInstanceOf(Error);
      expect(o, `call ${i} reported success-pending`).not.toMatchObject({ provisioning: "pending" });
    }

    const row = await readOneDomainRow(tenantId);
    expect(row.dns_status).toBe("pending");
    expect(row.dns_gave_up_at).not.toBeNull();
    // Exactly ONE domain purchase across all three calls — a terminal verdict
    // must never open a re-buy path.
    expect(log.buys).toHaveLength(1);
  }, 60_000);
});

describe("guard B — the durable pending state is BOUNDED", () => {
  it("DNS_PENDING_MAX_MS is the single named 6-hour bound", () => {
    expect(DNS_PENDING_MAX_MS).toBe(SIX_HOURS_MS);
  });

  it("CONTROL — a not-yet INSIDE the bound still returns 202 success-pending (the C3 contract holds)", async () => {
    const { tenantId } = await mintTenant("Slow Reg Co", "managed");
    await activatePaidPlan(tenantId, "managed");
    const { p } = verdictPort({ kind: "not_yet" });

    const outcome = await runSetup(tenantId, p, setupInput("slowreg", "slowreg.com"), "bound-1");
    expect(outcome).not.toBeInstanceOf(Error);
    expect(outcome).toMatchObject({ provisioning: "pending" });

    // The bound's anchor is stamped on the very first not-ready observation.
    const row = await readOneDomainRow(tenantId);
    expect(row.dns_first_checked_at).not.toBeNull();
    expect(row.dns_check_count).toBeGreaterThanOrEqual(1);
    expect(row.dns_gave_up_at).toBeNull();
  }, 30_000);

  it("PAST the bound the same benign not-yet becomes a NON-retryable, visible failure", async () => {
    const { tenantId } = await mintTenant("Stalled Reg Co", "managed");
    await activatePaidPlan(tenantId, "managed");
    const { p } = verdictPort({ kind: "not_yet" });

    const first = await runSetup(tenantId, p, setupInput("stallreg", "stallreg.com"), "bound-2a");
    expect(first).toMatchObject({ provisioning: "pending" });

    // Age the anchor past the bound (the tenant runs on the REAL clock after
    // activation, so the anchor is moved rather than the clock).
    await runInDurableObject(tenantStub(tenantId), (_i, s) =>
      s.storage.sql.exec(`UPDATE domains SET dns_first_checked_at = dns_first_checked_at - ?`, SIX_HOURS_MS + 60_000),
    );

    const second = await runSetup(tenantId, p, setupInput("stallreg", "stallreg.com"), "bound-2b");
    expect(second).toBeInstanceOf(Error);
    expect(second).not.toMatchObject({ provisioning: "pending" });
    expect((second as { retryable?: boolean }).retryable).toBe(false);

    expect((await readOneDomainRow(tenantId)).dns_gave_up_at).not.toBeNull();
    expect(await readMailboxCount(tenantId)).toBe(0);
  }, 60_000);

  it("a domain that RECOVERS after the give-up completes and clears the marker", async () => {
    const { tenantId } = await mintTenant("Healed Reg Co", "managed");
    await activatePaidPlan(tenantId, "managed");
    const { p } = verdictPort({ kind: "not_yet" });

    await runSetup(tenantId, p, setupInput("healreg", "healreg.com"), "heal-1");
    await runInDurableObject(tenantStub(tenantId), (_i, s) =>
      s.storage.sql.exec(`UPDATE domains SET dns_first_checked_at = dns_first_checked_at - ?`, SIX_HOURS_MS + 60_000),
    );
    await runSetup(tenantId, p, setupInput("healreg", "healreg.com"), "heal-2");
    expect((await readOneDomainRow(tenantId)).dns_gave_up_at).not.toBeNull();

    const ready = verdictPort({ kind: "ready" });
    const outcome = await runSetup(tenantId, ready.p, setupInput("healreg", "healreg.com"), "heal-3");
    expect(outcome).not.toBeInstanceOf(Error);

    const row = await readOneDomainRow(tenantId);
    expect(row.dns_status).toBe("ready");
    expect(row.dns_gave_up_at).toBeNull();
    expect(await readMailboxCount(tenantId)).toBe(2);
  }, 90_000);
});

// --- mailbox-side terminal ------------------------------------------------

/** A MailboxPort whose provisioningState answers a fixed verdict; the buy always "succeeds". */
function verdictMailboxPort(verdict: MailboxReadiness): { p: MailboxPort; buys: string[] } {
  const buys: string[] = [];
  const p: MailboxPort = {
    async provision(domain: string, localPart: string): Promise<ProvisionedMailbox> {
      buys.push(`${localPart}@${domain}`);
      return { email: `${localPart}@${domain}`, provider: "google", provisionedAt: Date.now() };
    },
    async provisioningState(): Promise<MailboxReadiness> {
      return verdict;
    },
    async getHealth(email: string): Promise<MailboxHealth> {
      return { email, reputationScore: 90, bounceRate: 0, complaintRate: 0, placementRate: 1 };
    },
    async startWarmup(): Promise<{ started: boolean; startedAt: number }> {
      return { started: true, startedAt: Date.now() };
    },
    async cancelWarmup(): Promise<{ cancelled: boolean; cancelledAt: number }> {
      return { cancelled: true, cancelledAt: Date.now() };
    },
    async release(): Promise<ReleaseResult> {
      return { released: true, releasedAt: Date.now() };
    },
  };
  return { p, buys };
}

describe("guard A — a TERMINAL mailbox is not 'still being created'", () => {
  it("setup REJECTS non-retryably, writes no billable row, and never re-buys", async () => {
    const { tenantId } = await mintTenant("Dead Mbx Co", "managed");
    await activatePaidPlan(tenantId, "managed");
    const domain = verdictPort({ kind: "ready" });
    const mailbox = verdictMailboxPort({ kind: "terminal", vendorState: "suspended" });

    const outcome = await withTenantContext(tenantId, (base) =>
      runSetupInfrastructure(
        { ...base, adapters: { ...base.adapters, domain: domain.p, mailbox: mailbox.p } },
        setupInput("deadmbx", "deadmbx.com"),
        new SandboxOpsMailer(),
        "mbx-terminal-1",
      ).catch((e: unknown) => e),
    );

    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as { retryable?: boolean }).retryable).toBe(false);
    expect((outcome as Error).message).not.toMatch(/still being created/i);
    expect(await readMailboxCount(tenantId)).toBe(0);
    // The buy is dispatched once; a terminal mailbox authorizes no second one.
    expect(mailbox.buys).toHaveLength(1);
  }, 30_000);
});

// --- guard C — the escalation edge ---------------------------------------

describe("guard C — an aging pending domain becomes a founder signal", () => {
  it("opsSummary names it and the watchtower files an unhealthy domain-DNS check", async () => {
    await seedBenignSdnList();
    const { tenantId } = await mintTenant("Aging Co", "managed");
    await activatePaidPlan(tenantId, "managed");

    const now = Date.now();
    await runInDurableObject(tenantStub(tenantId), (_i, s) => {
      s.storage.sql.exec(
        `INSERT INTO domains (id, tenant_id, domain, status, purchased_at, dns_status, connection_type, source, dns_check_count, dns_first_checked_at)
         VALUES ('dom_aging', ?, 'agingco0.com', 'active', ?, 'pending', 'purchased', 'provisioned', 4, ?)`,
        tenantId,
        now,
        now - (SIX_HOURS_MS + 60_000),
      );
    });

    const summary = await tenantStub(tenantId).opsSummary(now - ONE_DAY_MS);
    expect(summary.sendPipeline.agingPendingDomains.map((d) => d.domain)).toEqual(["agingco0.com"]);
    expect(summary.sendPipeline.agingPendingDomains[0]?.pendingForMs ?? 0).toBeGreaterThanOrEqual(SIX_HOURS_MS);

    const checks = sendPipelineChecks(tenantId, summary, new Set<string>());
    const dnsCheck = checks.find((c) => c.name.startsWith("domain_dns_aging:"));
    expect(dnsCheck, `no domain_dns_aging check in ${JSON.stringify(checks.map((c) => c.name))}`).toBeDefined();
    expect(dnsCheck?.healthy).toBe(false);
    expect(dnsCheck?.name).toBe("domain_dns_aging:agingco0.com");
  });

  it("a domain GIVEN UP on immediately is surfaced too, even though it is far too young for the age test", async () => {
    // The sharpest failure — a terminal vendor verdict on the FIRST poll — is
    // given up on within seconds. Keying the founder signal only on the anchor's
    // age would leave exactly that case with no alert at all.
    await seedBenignSdnList();
    const { tenantId } = await mintTenant("Fresh Dead Co", "managed");
    await activatePaidPlan(tenantId, "managed");

    const now = Date.now();
    await runInDurableObject(tenantStub(tenantId), (_i, s) => {
      s.storage.sql.exec(
        `INSERT INTO domains (id, tenant_id, domain, status, purchased_at, dns_status, connection_type, source, dns_check_count, dns_first_checked_at, dns_gave_up_at)
         VALUES ('dom_fresh', ?, 'freshdead0.com', 'active', ?, 'pending', 'purchased', 'provisioned', 1, ?, ?)`,
        tenantId,
        now,
        now - 1_000,
        now - 1_000,
      );
    });

    const summary = await tenantStub(tenantId).opsSummary(now - ONE_DAY_MS);
    expect(summary.sendPipeline.agingPendingDomains.map((d) => d.domain)).toEqual(["freshdead0.com"]);
    expect(summary.sendPipeline.agingPendingDomains[0]?.gaveUp).toBe(true);

    const checks = sendPipelineChecks(tenantId, summary, new Set<string>());
    const dnsCheck = checks.find((c) => c.name === "domain_dns_aging:freshdead0.com");
    expect(dnsCheck?.healthy).toBe(false);
    expect(dnsCheck?.detail).toMatch(/GIVEN UP/);
  });

  // Gate delta, Finding 2 (docs/adversarial/vendor-verdict-gate-2026-08-14.md):
  // both existing disjuncts require a column only THIS wave's code ever writes
  // (dns_first_checked_at / dns_gave_up_at), so a domain stalled BEFORE this
  // deploy — both columns NULL — matched neither and stayed invisible forever.
  // Option 1 (adopted): a third disjunct keyed on the NULL anchor + an aged
  // purchased_at, WITHOUT touching the bound or backfilling any column (a
  // stuck-but-recoverable legacy row must keep its fresh 6h grace on its next
  // retry, not insta-trip).
  it("FINDING 2 fix — a PRE-DEPLOY stalled row (purchased_at old, both new columns NULL) surfaces", async () => {
    await seedBenignSdnList();
    const { tenantId } = await mintTenant("Predeploy Stalled Co", "managed");
    await activatePaidPlan(tenantId, "managed");

    const now = Date.now();
    await runInDurableObject(tenantStub(tenantId), (_i, s) => {
      s.storage.sql.exec(
        `INSERT INTO domains (id, tenant_id, domain, status, purchased_at, dns_status, connection_type, source)
         VALUES ('dom_predeploy', ?, 'predeploy0.com', 'active', ?, 'pending', 'purchased', 'provisioned')`,
        tenantId,
        now - 3 * ONE_DAY_MS,
      );
    });

    const summary = await tenantStub(tenantId).opsSummary(now - ONE_DAY_MS);
    expect(summary.sendPipeline.agingPendingDomains.map((d) => d.domain)).toEqual(["predeploy0.com"]);

    const checks = sendPipelineChecks(tenantId, summary, new Set<string>());
    const dnsCheck = checks.find((c) => c.name === "domain_dns_aging:predeploy0.com");
    expect(dnsCheck, `no domain_dns_aging check in ${JSON.stringify(checks.map((c) => c.name))}`).toBeDefined();
    expect(dnsCheck?.healthy).toBe(false);
  });

  it("CONTROL — a healthy YOUNG row (recent purchased_at, NULL anchor) does not surface", async () => {
    await seedBenignSdnList();
    const { tenantId } = await mintTenant("Healthy Young Co", "managed");
    await activatePaidPlan(tenantId, "managed");

    const now = Date.now();
    await runInDurableObject(tenantStub(tenantId), (_i, s) => {
      s.storage.sql.exec(
        `INSERT INTO domains (id, tenant_id, domain, status, purchased_at, dns_status, connection_type, source)
         VALUES ('dom_young', ?, 'young0.com', 'active', ?, 'pending', 'purchased', 'provisioned')`,
        tenantId,
        now - 60_000,
      );
    });

    const summary = await tenantStub(tenantId).opsSummary(now - ONE_DAY_MS);
    expect(summary.sendPipeline.agingPendingDomains).toEqual([]);
  });

  it("a FUTURE-skewed purchased_at does not surface — the clock-skew direction fails safe on an is-it-old test", async () => {
    await seedBenignSdnList();
    const { tenantId } = await mintTenant("Future Skew Co", "managed");
    await activatePaidPlan(tenantId, "managed");

    const now = Date.now();
    await runInDurableObject(tenantStub(tenantId), (_i, s) => {
      s.storage.sql.exec(
        `INSERT INTO domains (id, tenant_id, domain, status, purchased_at, dns_status, connection_type, source)
         VALUES ('dom_future', ?, 'future0.com', 'active', ?, 'pending', 'purchased', 'provisioned')`,
        tenantId,
        now + ONE_DAY_MS,
      );
    });

    const summary = await tenantStub(tenantId).opsSummary(now - ONE_DAY_MS);
    expect(summary.sendPipeline.agingPendingDomains).toEqual([]);
  });
});

// --- reconcile scope ------------------------------------------------------

describe("the reconcile stops re-driving a domain we gave up on", () => {
  it("a dns_gave_up_at domain is out of scope (scanned 0, reconciled 0)", async () => {
    const { tenantId } = await mintTenant("Reconcile Dead Co", "managed");
    await activatePaidPlan(tenantId, "managed");
    const { p } = verdictPort({ kind: "not_yet" });

    await runSetup(tenantId, p, setupInput("recdead", "recdead.com"), "rec-1");
    await runInDurableObject(tenantStub(tenantId), (_i, s) =>
      s.storage.sql.exec(`UPDATE domains SET dns_first_checked_at = dns_first_checked_at - ?`, SIX_HOURS_MS + 60_000),
    );
    await runSetup(tenantId, p, setupInput("recdead", "recdead.com"), "rec-2");
    expect((await readOneDomainRow(tenantId)).dns_gave_up_at).not.toBeNull();

    const summary = await withTenantContext(tenantId, (base) =>
      runProvisioningReconcile({ ...base, adapters: { ...base.adapters, domain: p } }),
    );
    expect(summary.scanned).toBe(0);
    expect(summary.reconciled).toBe(0);
  }, 90_000);
});

// --- the burn-replacement retry loop -------------------------------------

function injectComplaints(sql: SqlStorage, tenantId: string, mailboxId: string, sends: number, complaints: number): void {
  for (let i = 0; i < sends; i++) {
    const msgId = `msg_vv_${i}`;
    const threadId = `t_vv_${i}`;
    sql.exec(
      `INSERT INTO scheduled_sends (id, tenant_id, campaign_id, lead_id, mailbox_id, step, variant, send_at, status, thread_id, message_id, sent_at)
       VALUES (?, ?, 'camp_vv', ?, ?, 1, 'a', 0, 'sent', ?, ?, 0)`,
      `ss_vv_${i}`,
      tenantId,
      `lead_vv_${i}`,
      mailboxId,
      threadId,
      msgId,
    );
    if (i >= sends - complaints) {
      sql.exec(
        `INSERT INTO events (id, tenant_id, campaign_id, lead_id, type, step, message_id, thread_id, ts, metadata_json)
         VALUES (?, ?, 'camp_vv', ?, 'complaint', 0, ?, ?, 0, '{}')`,
        `evt_vv_c_${i}`,
        tenantId,
        `lead_vv_${i}`,
        msgId,
        threadId,
      );
    }
  }
}

/**
 * Drives ONE burn-replacement sweep whose replacement domain answers `verdict`,
 * and returns the resulting action counts plus what the replacement port bought.
 *
 * Shaped exactly like test/ga-gates-ng5-2-isolation.test.ts (a `signup` demo
 * tenant + `advanceClock` past the ramp), because `advanceClock` is a
 * sandbox-only control — an `activatePaidPlan` tenant is migrated to the REAL
 * clock and the RPC refuses.
 */
async function runBurnSweep(
  brand: string,
  primaryDomain: string,
  replacement: VendorReadiness,
  seedPriorTerminals = 0,
): Promise<{ counts: Record<string, number>; buys: string[] }> {
  const { tenantId, token } = await signup(brand, `founder@${primaryDomain}`);
  const setup = await api("/setup-infrastructure", {
    method: "POST",
    token,
    body: JSON.stringify({
      brand,
      primaryDomain,
      domains: 1,
      inboxesEach: 1,
      persona: "Ops",
      physicalAddress: "1 Test St",
      senderIdentity: `Ops <o@${primaryDomain}>`,
    }),
  });
  expect(setup.status, `setup failed: ${JSON.stringify(setup.body)}`).toBe(202);
  await tenantStub(tenantId).advanceClock((WARMUP_RAMP_DAYS + 1) * ONE_DAY_MS);

  const port = verdictPort(replacement);
  const counts = await withTenantContext(tenantId, async (base) => {
    const mailbox = base.sql.exec<{ id: string }>(`SELECT id FROM mailboxes LIMIT 1`).one();
    // 20 sends / 5 complaints = 0.25 domain complaint rate, far over
    // burnComplaintRate, with sends >= minSampleSends.
    injectComplaints(base.sql, tenantId, mailbox.id, 20, 5);
    for (let i = 0; i < seedPriorTerminals; i++) {
      base.sql.exec(
        `INSERT INTO deliverability_actions (id, tenant_id, action, target, detail_json, ts)
         VALUES (?, ?, 'REPLACE_DOMAIN_TERMINAL', ?, '{}', ?)`,
        `dact_seed_${i}`,
        tenantId,
        `prior${i}.com`,
        base.clock.now(),
      );
    }
    await runDeliverabilitySweep(
      { ...base, adapters: { ...base.adapters, domain: port.p } },
      DEFAULT_THRESHOLDS,
      new SandboxOpsMailer(),
    );
    return base.sql
      .exec<{ action: string; n: number }>(
        `SELECT action, COUNT(*) as n FROM deliverability_actions WHERE tenant_id = ? GROUP BY action`,
        tenantId,
      )
      .toArray();
  });
  return { counts: Object.fromEntries(counts.map((r) => [r.action, r.n])), buys: port.log.buys };
}

describe("a TERMINAL burn-replacement counts toward the per-window replacement cap", () => {
  it("a terminal replacement is recorded under its OWN action, not a generic 'provider issue'", async () => {
    const { counts, buys } = await runBurnSweep("Burn Term Co", "burnterm.com", { kind: "terminal", vendorState: "expired" });

    // Pre-fix this was a REPLACE_DOMAIN_FAILED, which countReplacementsInWindow
    // ignores — so the next sweep re-entered with a higher domainIndex (a
    // different intent key, hence a FRESH buy) and did it all again, forever,
    // with the runaway cap never advancing.
    expect(counts.REPLACE_DOMAIN_TERMINAL).toBe(1);
    expect(counts.REPLACE_DOMAIN_FAILED ?? 0).toBe(0);
    expect(counts.REPLACE_DOMAIN ?? 0).toBe(0); // no replacement completed
    expect(buys).toHaveLength(1); // a domain WAS bought — which is why it must count
  }, 90_000);

  it("CONTROL — a transient replacement failure still logs the generic action (the cap must not swallow those)", async () => {
    const { counts } = await runBurnSweep("Burn Trans Co", "burntrans.com", { kind: "not_yet" });
    expect(counts.REPLACE_DOMAIN_FAILED).toBe(1);
    expect(counts.REPLACE_DOMAIN_TERMINAL ?? 0).toBe(0);
  }, 90_000);

  it("once the window holds MAX terminal attempts the replacement is WITHHELD — no further domain is bought", async () => {
    // The behavioral point of the counting change: three consumed attempts in
    // the window is the cap, and a terminal attempt is a consumed attempt.
    const { counts, buys } = await runBurnSweep("Burn Cap Co", "burncap.com", { kind: "terminal", vendorState: "expired" }, 3);
    expect(counts.REPLACE_DOMAIN_CAPPED).toBe(1);
    expect(buys).toEqual([]); // the spin is over — nothing else is purchased
  }, 90_000);
});

// --- guard D3 — the port contract ----------------------------------------

describe("guard D — EVERY port implementation can express a terminal vendor state", () => {
  it("RealInboxKitDomainPort answers kind:'terminal' for a terminal fixture", async () => {
    stubJson({
      error: false,
      pages: 1,
      domains: [{ uid: "u1", name: "contract0.com", status: "expired", connection_type: "purchased", assigned_mailboxes: 0 }],
    });
    const { verdict } = await domainPort().setDns("contract0.com", "k", "purchased");
    expect(verdict.kind).toBe("terminal");
  });

  it("SandboxDomainPort answers kind:'terminal' through its fault-injection seam", async () => {
    const port = new SandboxDomainPort(new RealClock());
    // Default behavior is unchanged (healthy-by-default sandbox).
    expect((await port.setDns("ok0.com", "k", "purchased")).verdict.kind).toBe("ready");
    port.terminal.add("dead0.com");
    const { verdict, records } = await port.setDns("dead0.com", "k", "purchased");
    expect(verdict.kind).toBe("terminal");
    expect(records).toEqual(ALL_FALSE);
  });

  it("RealMailboxPort answers kind:'terminal' for a terminal fixture", async () => {
    stubJson({ error: false, mailboxes: [{ uid: "m1", domain_name: "contract0.com", username: "s11", status: "suspended" }] });
    expect((await mailboxPort().provisioningState("s11@contract0.com")).kind).toBe("terminal");
  });

  it("SandboxMailboxPort answers kind:'terminal' through its fault-injection seam", async () => {
    const port = new SandboxMailboxPort(new RealClock());
    expect((await port.provisioningState("ok@ok0.com")).kind).toBe("ready");
    port.terminal.add("dead@dead0.com");
    expect(await port.provisioningState("dead@dead0.com")).toEqual({ kind: "terminal", vendorState: "suspended" });
  });

  it("RegistrarUnarmedDomainPort is the documented exemption — it fails LOUD on every method", async () => {
    await expect(new RegistrarUnarmedDomainPort().setDns("x0.com", "k", "purchased")).rejects.toThrow(/registrar is not armed/);
  });

  it("a test-fake DomainPort typechecks only by returning a verdict (the compile-level gate)", async () => {
    const { p } = verdictPort({ kind: "terminal", vendorState: "expired" });
    const { verdict } = await p.setDns("fake0.com", "k", "purchased");
    expect(verdict).toEqual({ kind: "terminal", vendorState: "expired" });
  });
});

// Keeps `env` imported-and-used in every configuration of this file (the DO
// bindings it exercises come from the same test env every other suite uses).
describe("test env sanity", () => {
  it("has the TENANT binding these tests drive", () => {
    expect(env.TENANT).toBeTruthy();
  });
});
