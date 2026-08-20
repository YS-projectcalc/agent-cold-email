import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  domainDnsResult,
  VendorError,
  type DomainConnectionType,
  type DomainDnsResult,
  type DomainPort,
  type LookalikeCandidate,
  type MailboxPort,
  type OwnedDomain,
  type PurchasedDomain,
  type ReleaseResult,
} from "@coldstart/shared";
import { runSetupInfrastructure } from "../src/engine/provisioning.js";
import { SandboxOpsMailer } from "../src/ops-mail/sandbox-ops-mailer.js";
import { activatePaidPlan, mintTenant, tenantStub, withTenantContext } from "./helpers.js";

// T1 — THE HEAD-OF-LINE-BLOCKING ANCHOR (class sweep 2026-08-17, IN-1).
//
// `setup_infrastructure`'s per-ordinal loop had no per-item isolation, and the
// item list is re-derived identically on every call (domainIntentKey is
// tenant+ordinal). So one ordinal whose domain is permanently dead did not just
// fail itself — it permanently denied service to every ordinal behind it, on
// every retry, forever, while the tenant paid the platform fee and the
// minimum-5 mailbox floor for zero working mailboxes.
//
// This is the probe the audit recorded: on the pre-fix code the second call
// re-enters ordinal 0, re-dies there, and the observed shape is
// setDns=[D0, D0] with mailbox.provision=[] — D1 is never bought at all.

/** Per-domain DNS behaviour, so exactly ONE ordinal can be the dead one. */
function domainPortWithDeadDomain(deadDomain: string): {
  port: DomainPort;
  log: { buys: string[]; setDns: string[] };
} {
  const log = { buys: [] as string[], setDns: [] as string[] };
  const port: DomainPort = {
    async searchLookalikes(_brand, primaryDomain, count): Promise<LookalikeCandidate[]> {
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
    async setDns(domain: string, _key: string, _connectionType: DomainConnectionType): Promise<DomainDnsResult> {
      log.setDns.push(domain);
      if (domain === deadDomain) {
        // PERMANENT, so no in-call retry masks the shape and no later attempt
        // can ever clear it — the "persistently failing head item" the class
        // is about.
        throw new VendorError("inboxkit domains/nameservers -> HTTP 404: Domain not found", false);
      }
      return domainDnsResult({ kind: "ready" });
    },
    async release(): Promise<ReleaseResult> {
      return { released: true, releasedAt: Date.now() };
    },
  };
  return { port, log };
}

/**
 * Wraps the tenant's real (sandbox) mailbox port so the buys are observable.
 *
 * A Proxy, deliberately, NOT `{ ...inner, provision }`: the sandbox port is a
 * class instance, so a spread copies its own fields and silently drops every
 * prototype method — `provisioningState` then reads `undefined` and the mailbox
 * saga fails for a reason that has nothing to do with the code under test.
 */
function recordingMailboxPort(inner: MailboxPort): { port: MailboxPort; provisioned: string[] } {
  const provisioned: string[] = [];
  const port = new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop !== "provision") return Reflect.get(target, prop, receiver);
      return async (domain: string, localPart: string, key: string) => {
        provisioned.push(`${localPart}@${domain}`);
        return target.provision(domain, localPart, key);
      };
    },
  });
  return { port, provisioned };
}

const INPUT = {
  brand: "holco",
  primaryDomain: "holco.com",
  domains: 2,
  inboxesEach: 1,
  persona: "Sender",
  physicalAddress: "1 Test St",
  senderIdentity: "S <s@holco.com>",
  quoteOnly: false as const,
};

function readMailboxEmails(tenantId: string): Promise<string[]> {
  return runInDurableObject(tenantStub(tenantId), (_i, s) =>
    s.storage.sql
      .exec<{ email: string }>(`SELECT email FROM mailboxes WHERE released_at IS NULL ORDER BY email`)
      .toArray()
      .map((r) => r.email),
  );
}

function readDomains(tenantId: string): Promise<{ domain: string; dns_status: string }[]> {
  return runInDurableObject(tenantStub(tenantId), (_i, s) =>
    s.storage.sql
      .exec<{ domain: string; dns_status: string }>(`SELECT domain, dns_status FROM domains ORDER BY domain`)
      .toArray(),
  );
}

/** Wraps the mailbox port so ONE deterministic address permanently refuses to buy. */
function mailboxPortWithDeadAddress(inner: MailboxPort, deadLocalPart: string): { port: MailboxPort; provisioned: string[] } {
  const provisioned: string[] = [];
  const port = new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop !== "provision") return Reflect.get(target, prop, receiver);
      return async (domain: string, localPart: string, key: string) => {
        if (localPart === deadLocalPart) {
          throw new VendorError("inboxkit mailboxes/buy -> HTTP 422: local part rejected", false);
        }
        provisioned.push(`${localPart}@${domain}`);
        return target.provision(domain, localPart, key);
      };
    },
  });
  return { port, provisioned };
}

function readActions(tenantId: string): Promise<{ action: string; target: string }[]> {
  return runInDurableObject(tenantStub(tenantId), (_i, s) =>
    s.storage.sql.exec<{ action: string; target: string }>(`SELECT action, target FROM deliverability_actions`).toArray(),
  );
}

describe("T2/IN-5 — one dead mailbox address must not starve the addresses behind it", () => {
  it("provisions slots 2 and 3 even though slot 1's address is permanently rejected", async () => {
    const { tenantId } = await mintTenant("Slotco", "managed");
    await activatePaidPlan(tenantId, "managed");
    const { port: domain } = domainPortWithDeadDomain("no-such-domain.example");

    let provisioned: string[] = [];
    const result = await withTenantContext(tenantId, (base) => {
      // sender11@ is ordinal 0's FIRST slot — the head item.
      const mailbox = mailboxPortWithDeadAddress(base.adapters.mailbox, "sender11");
      provisioned = mailbox.provisioned;
      return runSetupInfrastructure(
        { ...base, adapters: { ...base.adapters, domain, mailbox: mailbox.port } },
        { ...INPUT, brand: "slotco", primaryDomain: "slotco.com", senderIdentity: "S <s@slotco.com>", domains: 1, inboxesEach: 3 },
        new SandboxOpsMailer(),
        "slot-1",
      ).catch((e: unknown) => e);
    });

    // Pre-fix this was []: slot 1's permanent rejection ended the loop, so the
    // two healthy addresses behind it were never bought — on this call or any
    // retry, since the addresses are deterministic and fail identically.
    expect(provisioned).toEqual(["sender12@slotco0.com", "sender13@slotco0.com"]);
    expect(await readMailboxEmails(tenantId)).toEqual(["sender12@slotco0.com", "sender13@slotco0.com"]);

    // The dead slot is still REPORTED — a short domain must never read as a
    // completed one — and it is recorded ops-visibly rather than silently.
    expect(result).toBeInstanceOf(VendorError);
    expect((result as VendorError).retryable).toBe(false);
    expect(await readActions(tenantId)).toContainEqual({ action: "MAILBOX_SLOT_FAILED", target: "sender11@slotco0.com" });

    // AND IT REACHES AN OPERATOR (docs/adversarial/
    // wave-1-2-integration-gate-2026-08-18.md §6). Only ONE failure is rethrown
    // to the caller, so every OTHER isolated slot in a batch was previously
    // visible in nothing but the customer's own activity feed — each one a paid
    // vendor unit with no working mailbox behind it. REDS on the old code: no
    // watchtower row was ever written for this.
    const slotCheck = await env.DB.prepare(
      `SELECT status FROM watchtower_state WHERE check_name = 'mailbox_slot_failed:sender11@slotco0.com'`,
    ).first<{ status: string }>();
    expect(slotCheck?.status).toBe("unhealthy");
  }, 30_000);
});

describe("T1 — one dead ordinal must not starve the ordinals behind it", () => {
  it("provisions D1 even though D0's DNS is permanently dead, across a retry", async () => {
    const { tenantId } = await mintTenant("Holco", "managed");
    await activatePaidPlan(tenantId, "managed");
    // Ordinal 0 consumes the first fresh candidate, ordinal 1 the second.
    const { port, log } = domainPortWithDeadDomain("holco0.com");

    const provisionedAddresses: string[] = [];
    const run = (key: string): Promise<unknown> =>
      withTenantContext(tenantId, (base) => {
        const mailbox = recordingMailboxPort(base.adapters.mailbox);
        return runSetupInfrastructure(
          { ...base, adapters: { ...base.adapters, domain: port, mailbox: mailbox.port } },
          INPUT,
          new SandboxOpsMailer(),
          key,
        )
          .catch((e: unknown) => e)
          .finally(() => provisionedAddresses.push(...mailbox.provisioned));
      });

    await run("hol-1");
    await run("hol-2");

    // THE ASSERTION THE PRE-FIX CODE FAILS. Pre-fix this was
    // ["holco0.com", "holco0.com"]: the second call re-entered ordinal 0 and
    // died there, so holco1.com was never attempted at all — one dead domain
    // permanently denying service to a healthy one.
    //
    // Post-fix, call 1 attempts BOTH ordinals; call 2 re-attempts the dead
    // ordinal 0 (a retry SHOULD re-try it — it is a fresh attempt, not
    // starvation) and resumes ordinal 1 without re-driving DNS, because
    // holco1.com is already 'ready'. Three setDns calls, in that order.
    expect(log.setDns).toEqual(["holco0.com", "holco1.com", "holco0.com"]);
    // And the retry buys NOTHING a second time — the per-ordinal intent still
    // converges, which is what stops isolation from turning a retry into spend.
    expect(log.buys).toEqual(["holco0.com", "holco1.com"]);

    // D1 is genuinely usable: bought, DNS ready, and carrying its mailbox.
    const domains = await readDomains(tenantId);
    expect(domains).toEqual([
      { domain: "holco0.com", dns_status: "pending" },
      { domain: "holco1.com", dns_status: "ready" },
    ]);
    // persona slug "sender", ordinal 1, mailbox index 0 -> sender21@holco1.com
    expect(provisionedAddresses).toEqual(["sender21@holco1.com"]);
    expect(await readMailboxEmails(tenantId)).toEqual(["sender21@holco1.com"]);
  }, 30_000);

  it("still reports the dead ordinal as a failure — partial progress is never dressed as success", async () => {
    const { tenantId } = await mintTenant("Holco Two", "managed");
    await activatePaidPlan(tenantId, "managed");
    const { port } = domainPortWithDeadDomain("holcotwo0.com");

    const result = await withTenantContext(tenantId, (base) =>
      runSetupInfrastructure(
        { ...base, adapters: { ...base.adapters, domain: port } },
        { ...INPUT, brand: "holcotwo", primaryDomain: "holcotwo.com", senderIdentity: "S <s@holcotwo.com>" },
        new SandboxOpsMailer(),
        "hol2-1",
      ).catch((e: unknown) => e),
    );

    // Isolating the loop must NOT turn a permanently-dead domain into a clean
    // 200: the agent has to learn that ordinal 0 needs a hand. The grade is
    // preserved too — a permanent DNS failure stays non-retryable, so the agent
    // escalates instead of spinning (the retryable-laundering lesson).
    expect(result).toBeInstanceOf(VendorError);
    expect((result as VendorError).retryable).toBe(false);
    // ...and the healthy ordinal's work still landed.
    expect(await readMailboxEmails(tenantId)).toEqual(["sender21@holcotwo1.com"]);

    // AND THE DEAD ORDINAL REACHES AN OPERATOR. A half-completed ordinal is a
    // PAID domain with no working mail on it; before this it existed only as a
    // customer-visible activity row (wave-1-2 integration gate §6).
    const ordinalCheck = await env.DB.prepare(
      `SELECT status FROM watchtower_state WHERE check_name = 'domain_ordinal_failed:holcotwo0.com'`,
    ).first<{ status: string }>();
    expect(ordinalCheck?.status).toBe("unhealthy");
  }, 30_000);
});
