// Closure gate for docs/adversarial/agent-channel-product-audit-2026-08-17.md
// — F1 (a recorded 202 SUCCESS-PENDING outcome replaying forever), F3 (the
// terminal give-up reaching the agent through no durable channel) and Q4 (the
// 6h bound restarting its clock on the NULL-anchor population).
//
// Every assertion below is written as the CORRECT behaviour, so the file fails
// on the pre-fix tree and passes on the fix. It drives the EXACT production
// entry-point composition tenant-do.ts uses:
//   withRequestIdempotency(ctx, `setup_infrastructure:${key}`, () => runSetupInfrastructure(...), { isIncomplete })
// so a fix that only works when the engine function is called directly cannot
// pass it.
//
// The seeded state reproduces the live shape the audit measured on
// 2026-08-17: two committed ordinals, zero mailboxes, ordinal 0's DNS never
// came up (504h) with a NULL `dns_first_checked_at` (the column predates the
// row), ordinal 1's DNS ready.

import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
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
} from "@coldstart/shared";
import { VendorError } from "@coldstart/shared";
import { withRequestIdempotency } from "../src/engine/idempotency.js";
import { isSetupProvisioningIncomplete, runSetupInfrastructure } from "../src/engine/provisioning.js";
import { SandboxOpsMailer } from "../src/ops-mail/sandbox-ops-mailer.js";
import { activatePaidPlan, mintTenant, tenantStub, withTenantContext } from "./helpers.js";

const ALL_FALSE = { mx: false, spf: false, dkim: false, dmarc: false, rdns: false };
const ALL_TRUE = { mx: true, spf: true, dkim: true, dmarc: true, rdns: true };
const KEY = "apd-setup-a-2mbx";

const D0 = "goauthorpitchdesk.com"; // ordinal 0 — DNS never came up (504h)
const D1 = "theauthorpitchdesk.com"; // ordinal 1 — DNS ready, mailbox stuck

interface Log {
  buys: string[];
  setDns: string[];
  mailboxBuys: string[];
  listOwned: number;
}

function newLog(): Log {
  return { buys: [], setDns: [], mailboxBuys: [], listOwned: 0 };
}

function ports(log: Log, opts: { d0Verdict: "not_yet" | "ready" }): { domain: DomainPort; mailbox: MailboxPort } {
  const domain: DomainPort = {
    async searchLookalikes(_b, primaryDomain, count): Promise<LookalikeCandidate[]> {
      const slug = primaryDomain.split(".")[0];
      return Array.from({ length: count }, (_v, i) => ({ domain: `fresh${slug}${i}.com`, available: true }));
    },
    async listOwnedDomains(): Promise<OwnedDomain[]> {
      log.listOwned++;
      return [];
    },
    async buy(d: string): Promise<PurchasedDomain> {
      log.buys.push(d);
      return { domain: d, purchasedAt: Date.now(), registrar: "test", connectionType: "purchased" };
    },
    async setDns(d: string, _k: string, _ct: DomainConnectionType): Promise<DomainDnsResult> {
      log.setDns.push(d);
      // D0: the vendor keeps answering "not listed yet" — indistinguishable from
      // a registration made 2s ago. This is what a 504h stall looks like.
      if (d === D0) {
        return opts.d0Verdict === "ready"
          ? { verdict: { kind: "ready" }, records: ALL_TRUE }
          : { verdict: { kind: "not_yet" }, records: ALL_FALSE };
      }
      return { verdict: { kind: "ready" }, records: ALL_TRUE };
    },
    async release(): Promise<ReleaseResult> {
      return { released: true, releasedAt: Date.now() };
    },
  };

  const mailbox: MailboxPort = {
    async provision(d: string, localPart: string): Promise<ProvisionedMailbox> {
      log.mailboxBuys.push(`${localPart}@${d}`);
      return { email: `${localPart}@${d}`, provider: "google", provisionedAt: Date.now() };
    },
    async provisioningState(): Promise<MailboxReadiness> {
      return { kind: "not_yet" };
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
  return { domain, mailbox };
}

const setupInput = {
  brand: "Author Pitch Desk",
  primaryDomain: "authorpitchdesk.com",
  domains: 2,
  inboxesEach: 1,
  persona: "Mordy Tee",
  physicalAddress: "1 Test St",
  senderIdentity: "Mordy <m@authorpitchdesk.com>",
  quoteOnly: false as const,
};

/** The 202 body the SUCCESS-PENDING branch records under the caller's key. */
const RECORDED_PENDING_RESPONSE = {
  jobId: "job_first_call",
  billing: { provisionedAfter: 0, projectedMonthlyCents: 9900, formula: "seeded" },
  provisioning: "pending",
  pendingDomain: D0,
};

/** Reproduce the live durable state: 2 committed ordinals, 0 mailboxes. */
async function seedLiveState(
  tenantId: string,
  opts: { d0AnchorAgeMs: number | null; d0PurchasedAgeMs: number; recordedPendingAgeMs: number | null },
): Promise<void> {
  await runInDurableObject(tenantStub(tenantId), (_i, s) => {
    const sql = s.storage.sql;
    // An activated tenant runs on the REAL clock (wave-2 DECISION 2), so
    // Date.now() IS ctx.clock.now() for these rows.
    const now = Date.now();
    const mk = (id: string, dom: string, dnsStatus: string, anchor: number | null, purchasedAgo: number): void => {
      sql.exec(
        `INSERT INTO domains (id, tenant_id, domain, status, purchased_at, dns_status, connection_type, source,
           dns_check_count, dns_first_checked_at, dns_gave_up_at)
         VALUES (?, ?, ?, 'active', ?, ?, 'purchased', 'provisioned', ?, ?, NULL)`,
        id,
        tenantId,
        dom,
        now - purchasedAgo,
        dnsStatus,
        anchor === null ? 0 : 3,
        anchor,
      );
    };
    mk("dom_audit0", D0, "pending", opts.d0AnchorAgeMs === null ? null : now - opts.d0AnchorAgeMs, opts.d0PurchasedAgeMs);
    mk("dom_audit1", D1, "ready", now - 119 * 3_600_000, 119 * 3_600_000);

    for (const [ordinal, dom] of [[0, D0], [1, D1]] as [number, string][]) {
      sql.exec(
        `INSERT INTO domain_intents (key, tenant_id, candidate_domain, status, persona_slug, inboxes_each, created_at, updated_at)
         VALUES (?, ?, ?, 'committed', 'mordytee', 1, ?, ?)`,
        `tenant:${tenantId}#${ordinal}`,
        tenantId,
        dom,
        now - 504 * 3_600_000,
        now - 504 * 3_600_000,
      );
    }

    if (opts.recordedPendingAgeMs !== null) {
      // What the SUCCESS-PENDING branch (provisioning.ts) records for the key.
      sql.exec(
        `INSERT INTO request_idempotency (key, status, response_json, created_at) VALUES (?, 'done', ?, ?)`,
        `setup_infrastructure:${KEY}`,
        JSON.stringify(RECORDED_PENDING_RESPONSE),
        now - opts.recordedPendingAgeMs,
      );
    }
  });
}

interface DomRow {
  domain: string;
  dns_status: string;
  dns_gave_up_at: number | null;
  dns_first_checked_at: number | null;
  dns_check_count: number;
  [c: string]: SqlStorageValue;
}

function readDomains(tenantId: string): Promise<DomRow[]> {
  return runInDurableObject(tenantStub(tenantId), (_i, s) =>
    s.storage.sql
      .exec<DomRow>(
        `SELECT domain, dns_status, dns_gave_up_at, dns_first_checked_at, dns_check_count FROM domains WHERE tenant_id = ? ORDER BY domain`,
        tenantId,
      )
      .toArray(),
  );
}

interface MsgRow {
  kind: string;
  severity: string;
  body: string;
  action_hint: string | null;
  [c: string]: SqlStorageValue;
}

function readMessages(tenantId: string): Promise<MsgRow[]> {
  return runInDurableObject(tenantStub(tenantId), (_i, s) =>
    s.storage.sql
      .exec<MsgRow>(`SELECT kind, severity, body, action_hint FROM tenant_messages WHERE tenant_id = ?`, tenantId)
      .toArray(),
  );
}

async function driveRetry(tenantId: string, log: Log, d0Verdict: "not_yet" | "ready"): Promise<unknown> {
  const p = ports(log, { d0Verdict });
  return withTenantContext(tenantId, (base) => {
    const ctx = { ...base, adapters: { ...base.adapters, domain: p.domain, mailbox: p.mailbox } };
    // EXACT production composition — tenant-do.ts's setupInfrastructure.
    return withRequestIdempotency(
      ctx,
      `setup_infrastructure:${KEY}`,
      () => runSetupInfrastructure(ctx, setupInput, new SandboxOpsMailer(), KEY),
      { isIncomplete: isSetupProvisioningIncomplete },
    ).catch((e: unknown) => e);
  });
}

describe("F1 — a recorded 202 SUCCESS-PENDING outcome must not replay forever", () => {
  it("ARM A: a same-key retry long after the recorded 202 RE-RUNS the saga", async () => {
    const { tenantId } = await mintTenant("APD ArmA", "managed");
    await activatePaidPlan(tenantId, "managed");
    await seedLiveState(tenantId, {
      d0AnchorAgeMs: null,
      d0PurchasedAgeMs: 504 * 3_600_000,
      recordedPendingAgeMs: 504 * 3_600_000,
    });

    const log = newLog();
    await driveRetry(tenantId, log, "not_yet");

    // THE CLAIM UNDER TEST: does the retry make any progress toward mailboxes?
    expect(log.setDns.length + log.mailboxBuys.length).toBeGreaterThan(0);
  }, 60_000);

  it("a same-key retry WITHIN the short replay window still replays the recorded 202 (double-submit protection)", async () => {
    const { tenantId } = await mintTenant("APD Replay", "managed");
    await activatePaidPlan(tenantId, "managed");
    await seedLiveState(tenantId, {
      d0AnchorAgeMs: null,
      d0PurchasedAgeMs: 504 * 3_600_000,
      recordedPendingAgeMs: 1_000, // recorded a second ago — a dropped-response retry
    });

    const log = newLog();
    const outcome = await driveRetry(tenantId, log, "not_yet");

    expect(outcome).toEqual(RECORDED_PENDING_RESPONSE);
    expect(log.setDns).toEqual([]);
    expect(log.mailboxBuys).toEqual([]);
    expect(log.buys).toEqual([]);
  }, 60_000);

  // The reason the wrapper exists: two racing same-key calls must not both run
  // the saga. Reclaiming an EXPIRED incomplete record must not weaken that —
  // same shape as idempotency.test.ts's stale-claim race (Promise.allSettled
  // against the real DO instance, so the DO's own input gate is what
  // serializes, not a faked step).
  it("a concurrent duplicate of an expired-incomplete key still gets exactly-one-saga semantics", async () => {
    const { tenantId } = await mintTenant("APD Race", "managed");
    await activatePaidPlan(tenantId, "managed");
    await runInDurableObject(tenantStub(tenantId), (_i, s) => {
      s.storage.sql.exec(
        `INSERT INTO request_idempotency (key, status, response_json, created_at) VALUES (?, 'done', ?, 0)`,
        "setup_infrastructure:race-key",
        JSON.stringify({ ...RECORDED_PENDING_RESPONSE, pendingDomain: "raced.com" }),
      );
    });

    const oneDomain = { ...setupInput, brand: "Race Co", primaryDomain: "raceco.com", domains: 1 };
    const [a, b] = await runInDurableObject(tenantStub(tenantId), (instance) =>
      Promise.allSettled([
        instance.setupInfrastructure(oneDomain, "race-key"),
        instance.setupInfrastructure(oneDomain, "race-key"),
      ]),
    );

    const rejected = [a, b].filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect([a, b].filter((r) => r.status === "fulfilled").length).toBe(1);
    expect(rejected.length).toBe(1);
    expect(rejected[0]!.reason).toMatchObject({ message: expect.stringMatching(/in progress/i) });
    // Exactly ONE saga ran: one domain, not two.
    expect((await readDomains(tenantId)).length).toBe(1);
  }, 60_000);
});

describe("Q4 — the 6h bound must cover the NULL-anchor (pre-deploy) population", () => {
  it("ARM B: an un-ready domain purchased 504h ago with a NULL anchor gives up on the FIRST observation", async () => {
    const { tenantId } = await mintTenant("APD ArmB", "managed");
    await activatePaidPlan(tenantId, "managed");
    await seedLiveState(tenantId, { d0AnchorAgeMs: null, d0PurchasedAgeMs: 504 * 3_600_000, recordedPendingAgeMs: null });

    const log = newLog();
    const outcome = await driveRetry(tenantId, log, "not_yet");
    const domains = await readDomains(tenantId);

    // Correct behaviour after a 504h stall: give up, non-retryably.
    expect(domains.find((d) => d.domain === D0)?.dns_gave_up_at).not.toBeNull();
    expect(outcome).toBeInstanceOf(VendorError);
    expect((outcome as VendorError).retryable).toBe(false);
  }, 60_000);

  it("ARM B2: the SECOND retry gives the agent the SAME terminal answer, and never re-dates the give-up", async () => {
    const { tenantId } = await mintTenant("APD ArmB2", "managed");
    await activatePaidPlan(tenantId, "managed");
    await seedLiveState(tenantId, { d0AnchorAgeMs: null, d0PurchasedAgeMs: 504 * 3_600_000, recordedPendingAgeMs: null });

    await driveRetry(tenantId, newLog(), "not_yet");
    const gaveUpAfterFirst = (await readDomains(tenantId)).find((d) => d.domain === D0)?.dns_gave_up_at;

    const outcome2 = await driveRetry(tenantId, newLog(), "not_yet");
    const gaveUpAfterSecond = (await readDomains(tenantId)).find((d) => d.domain === D0)?.dns_gave_up_at;

    expect(outcome2).toBeInstanceOf(VendorError);
    expect((outcome2 as VendorError).retryable).toBe(false);
    // The marker records WHEN we first gave up, not when we last re-confirmed it.
    expect(gaveUpAfterSecond).toBe(gaveUpAfterFirst);
  }, 60_000);
});

describe("F3 — the terminal give-up must reach the agent durably", () => {
  it("ARM C: an anchor already 504h old throws non-retryably AND leaves an action_required message naming contact_operator", async () => {
    const { tenantId } = await mintTenant("APD ArmC", "managed");
    await activatePaidPlan(tenantId, "managed");
    await seedLiveState(tenantId, {
      d0AnchorAgeMs: 504 * 3_600_000,
      d0PurchasedAgeMs: 504 * 3_600_000,
      recordedPendingAgeMs: null,
    });

    const outcome = await driveRetry(tenantId, newLog(), "not_yet");
    expect(outcome).toBeInstanceOf(VendorError);
    expect((outcome as VendorError).retryable).toBe(false);

    const messages = await readMessages(tenantId);
    const failed = messages.find((m) => m.kind === "setup_failed");
    expect(failed, `no setup_failed message; got ${JSON.stringify(messages)}`).toBeDefined();
    expect(failed!.severity).toBe("action_required");
    expect(failed!.body).toContain("contact_operator");
    expect(JSON.parse(failed!.action_hint!)).toMatchObject({ tool: "contact_operator" });
    // GUARDRAIL B — the body is composed prose, never the vendor error string.
    expect(failed!.body).not.toContain("registrar");
  }, 60_000);
});

describe("F1b — a recovered ordinal 0 lets the loop reach its mailbox leg", () => {
  it("ARM D: once D0's DNS comes up the saga buys D0's mailbox", async () => {
    const { tenantId } = await mintTenant("APD ArmD", "managed");
    await activatePaidPlan(tenantId, "managed");
    await seedLiveState(tenantId, { d0AnchorAgeMs: null, d0PurchasedAgeMs: 504 * 3_600_000, recordedPendingAgeMs: null });

    const log = newLog();
    await driveRetry(tenantId, log, "ready");

    expect(log.setDns).toContain(D0);
    expect(log.mailboxBuys.some((m) => m.endsWith(`@${D0}`))).toBe(true);
    // Nothing was re-bought — the committed ordinals resolve to the live rows.
    expect(log.buys).toEqual([]);
  }, 60_000);
});
