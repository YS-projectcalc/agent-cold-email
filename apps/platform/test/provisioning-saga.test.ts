import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { VendorError, type DnsRecordSet, type DomainPort, type LookalikeCandidate, type OwnedDomain, type PurchasedDomain, type ReleaseResult } from "@coldstart/shared";
import { provisionDomainWithMailboxes } from "../src/engine/provisioning.js";
import { mintTenant, withTenantContext } from "./helpers.js";

// INCIDENT 2026-08-05 — setup_infrastructure registered goauthorpitchdesk.com
// ($12.50), then our immediate setDns raced InboxKit's ~32s ASYNC registration,
// threw, and the `INSERT INTO domains` that ran AFTER setDns never happened.
// The domain was ours and invisible to us; every retry regenerated the same
// name and hit "already owned by your team".
//
// These tests pin the three properties that make that unreachable: the domain
// is recorded the instant it is bought (H2), a retry ADOPTS what we already own
// instead of re-buying (H3), and the durable intent record is what carries the
// resolved name across the retry (H1).

interface PortCalls {
  buy: string[];
  setDns: string[];
  listOwned: number;
}

/** A DomainPort whose setDns fails N times before succeeding — the live race. */
function racingDomainPort(opts: { setDnsFailures: number; owned?: OwnedDomain[] }): { port: DomainPort; calls: PortCalls } {
  const calls: PortCalls = { buy: [], setDns: [], listOwned: 0 };
  let remaining = opts.setDnsFailures;
  const port: DomainPort = {
    async searchLookalikes(): Promise<LookalikeCandidate[]> {
      return [{ domain: "tryacme.com", available: true }];
    },
    async listOwnedDomains(): Promise<OwnedDomain[]> {
      calls.listOwned++;
      return opts.owned ?? [];
    },
    async buy(domain: string): Promise<PurchasedDomain> {
      calls.buy.push(domain);
      return { domain, purchasedAt: Date.now(), registrar: "test-registrar" };
    },
    async setDns(domain: string): Promise<DnsRecordSet> {
      calls.setDns.push(domain);
      if (remaining-- > 0) {
        // The exact shape of the incident: the vendor has accepted the order but
        // has not finished registering, so the nameservers call is rejected.
        throw new VendorError("inboxkit domains/nameservers failed: domain not found", true);
      }
      return { mx: true, spf: true, dkim: true, dmarc: true, rdns: true };
    },
    async release(): Promise<ReleaseResult> {
      return { released: true, releasedAt: Date.now() };
    },
  };
  return { port, calls };
}

function readDomains(tenantId: string): Promise<{ domain: string; status: string; dns_status: string }[]> {
  return runInDurableObject(env.TENANT.get(env.TENANT.idFromName(tenantId)), (_i, state) =>
    state.storage.sql
      .exec<{ domain: string; status: string; dns_status: string }>(`SELECT domain, status, dns_status FROM domains`)
      .toArray(),
  );
}

function readIntents(tenantId: string): Promise<{ key: string; candidate_domain: string; status: string }[]> {
  return runInDurableObject(env.TENANT.get(env.TENANT.idFromName(tenantId)), (_i, state) =>
    state.storage.sql
      .exec<{ key: string; candidate_domain: string; status: string }>(`SELECT key, candidate_domain, status FROM domain_intents`)
      .toArray(),
  );
}

const INTENT_KEY = "saga-test#0";

describe("provisioning saga — a bought domain is never stranded (INCIDENT 2026-08-05)", () => {
  it("H2 — a setDns failure leaves the domain RECORDED (dns pending), not lost", async () => {
    const { tenantId } = await mintTenant("Saga Persist Co", "managed");
    const { port, calls } = racingDomainPort({ setDnsFailures: 99 });

    const err = await withTenantContext(tenantId, (base) =>
      provisionDomainWithMailboxes(
        { ...base, adapters: { ...base.adapters, domain: port } },
        { domain: "tryacme.com", domainIndex: 0, personaSlug: "sales", inboxesEach: 1, intentKey: INTENT_KEY },
      ).catch((e: unknown) => e),
    );

    // The failure is surfaced as RETRYABLE, never swallowed and never a 500.
    expect(err).toBeInstanceOf(VendorError);
    expect((err as VendorError).retryable).toBe(true);

    // THE POINT: we paid for it, so it is on the books. Pre-fix this was [].
    const domains = await readDomains(tenantId);
    expect(domains).toHaveLength(1);
    expect(domains[0]!.domain).toBe("tryacme.com");
    expect(domains[0]!.dns_status).toBe("pending");
    expect(calls.buy).toEqual(["tryacme.com"]);
  });

  it("H1 — the intent is 'committed' after the buy, so a retry can find what we own", async () => {
    const { tenantId } = await mintTenant("Saga Intent Co", "managed");
    const { port } = racingDomainPort({ setDnsFailures: 99 });

    await withTenantContext(tenantId, (base) =>
      provisionDomainWithMailboxes(
        { ...base, adapters: { ...base.adapters, domain: port } },
        { domain: "tryacme.com", domainIndex: 0, personaSlug: "sales", inboxesEach: 1, intentKey: INTENT_KEY },
      ).catch(() => undefined),
    );

    const intents = await readIntents(tenantId);
    expect(intents).toHaveLength(1);
    expect(intents[0]!.candidate_domain).toBe("tryacme.com");
    expect(intents[0]!.status).toBe("committed"); // the buy DID land
  });

  it("H1 — a buy that THROWS leaves a 'dangling' intent naming the domain we may own", async () => {
    const { tenantId } = await mintTenant("Saga Dangling Co", "managed");
    const { port } = racingDomainPort({ setDnsFailures: 0 });
    port.buy = async () => {
      throw new VendorError("inboxkit domains/register failed: upstream timeout", true);
    };

    await withTenantContext(tenantId, (base) =>
      provisionDomainWithMailboxes(
        { ...base, adapters: { ...base.adapters, domain: port } },
        { domain: "tryacme.com", domainIndex: 0, personaSlug: "sales", inboxesEach: 1, intentKey: INTENT_KEY },
      ).catch(() => undefined),
    );

    const intents = await readIntents(tenantId);
    // NEVER deleted — a deleted intent is indistinguishable from one that never
    // ran, which is exactly how the live incident lost track of $12.50.
    expect(intents).toHaveLength(1);
    expect(intents[0]!.status).toBe("dangling");
    expect(intents[0]!.candidate_domain).toBe("tryacme.com");
  });

  it("H3 — the RETRY adopts an already-owned domain instead of buying it again", async () => {
    const { tenantId } = await mintTenant("Saga Adopt Co", "managed");

    // Attempt 1: the buy lands, setDns loses the race, DNS stays pending.
    const first = racingDomainPort({ setDnsFailures: 99 });
    await withTenantContext(tenantId, (base) =>
      provisionDomainWithMailboxes(
        { ...base, adapters: { ...base.adapters, domain: first.port } },
        { domain: "tryacme.com", domainIndex: 0, personaSlug: "sales", inboxesEach: 1, intentKey: INTENT_KEY },
      ).catch(() => undefined),
    );
    expect(first.calls.buy).toEqual(["tryacme.com"]);

    // Simulate the real strand: the domains row is gone (pre-fix behavior, or a
    // crash before it committed), but the vendor still owns the domain. This is
    // Mordy's exact state.
    await runInDurableObject(env.TENANT.get(env.TENANT.idFromName(tenantId)), (_i, state) => {
      state.storage.sql.exec(`DELETE FROM domains`);
    });

    // Attempt 2: same intent key, same candidate — and the vendor reports it owned.
    const second = racingDomainPort({
      setDnsFailures: 0,
      owned: [{ domain: "tryacme.com", status: "active", assignedMailboxes: 0 }],
    });
    await withTenantContext(tenantId, (base) =>
      provisionDomainWithMailboxes(
        { ...base, adapters: { ...base.adapters, domain: second.port } },
        { domain: "tryacme.com", domainIndex: 0, personaSlug: "sales", inboxesEach: 1, intentKey: INTENT_KEY },
      ),
    );

    // THE UNBLOCK: zero additional spend, and the domain is recovered.
    expect(second.calls.buy).toEqual([]);
    expect(second.calls.listOwned).toBe(1);
    const domains = await readDomains(tenantId);
    expect(domains).toHaveLength(1);
    expect(domains[0]!.domain).toBe("tryacme.com");
    expect(domains[0]!.dns_status).toBe("ready");
  });

  it("H3 — does NOT adopt a domain that already has mailboxes attached", async () => {
    const { tenantId } = await mintTenant("Saga NoSteal Co", "managed");
    const { port, calls } = racingDomainPort({
      setDnsFailures: 0,
      // Owned, but in use elsewhere — adopting it would re-home someone's mail.
      owned: [{ domain: "tryacme.com", status: "active", assignedMailboxes: 2 }],
    });

    await withTenantContext(tenantId, (base) =>
      provisionDomainWithMailboxes(
        { ...base, adapters: { ...base.adapters, domain: port } },
        { domain: "tryacme.com", domainIndex: 0, personaSlug: "sales", inboxesEach: 1, intentKey: INTENT_KEY },
      ),
    );

    expect(calls.buy).toEqual(["tryacme.com"]); // fell through to the ordinary buy
  });

  it("H4 — a REPLAYED provision re-warms nothing and inserts no duplicate row", async () => {
    const { tenantId } = await mintTenant("Saga Replay Co", "managed");
    const { port } = racingDomainPort({ setDnsFailures: 0 });
    let warmupCalls = 0;
    let buyCalls = 0;

    const run = () =>
      withTenantContext(tenantId, (base) => {
        const ctx = {
          ...base,
          adapters: {
            ...base.adapters,
            domain: port,
            mailbox: {
              ...base.adapters.mailbox,
              async provision(domain: string, localPart: string) {
                buyCalls++;
                return { email: `${localPart}@${domain}`, provider: "google" as const, provisionedAt: Date.now() };
              },
              async startWarmup() {
                warmupCalls++;
                return { started: true, startedAt: Date.now() };
              },
            },
          },
        };
        return provisionDomainWithMailboxes(ctx, {
          domain: "tryacme.com",
          domainIndex: 0,
          personaSlug: "sales",
          inboxesEach: 1,
          intentKey: INTENT_KEY,
        });
      });

    await run();
    await run(); // the replay — same deterministic per-mailbox key

    // Pre-fix, only the BUY was inside the recorded unit: the replay re-fired
    // startWarmup (a second $3/mo subscription) and re-INSERTed the row, which
    // syncMailboxQuantity then billed the customer for.
    expect(buyCalls).toBe(1);
    expect(warmupCalls).toBe(1);
    const liveMailboxes = await runInDurableObject(env.TENANT.get(env.TENANT.idFromName(tenantId)), (_i, state) =>
      state.storage.sql
        .exec<{ n: number }>(`SELECT COUNT(*) as n FROM mailboxes WHERE released_at IS NULL`)
        .one().n,
    );
    expect(liveMailboxes).toBe(1);
  });

  it("H2 — setDns succeeding on the RETRY flips dns_status to ready", async () => {
    const { tenantId } = await mintTenant("Saga Dns Recover Co", "managed");
    // Fails once, succeeds on the in-call retry.
    const { port, calls } = racingDomainPort({ setDnsFailures: 1 });

    await withTenantContext(tenantId, (base) =>
      provisionDomainWithMailboxes(
        { ...base, adapters: { ...base.adapters, domain: port } },
        { domain: "tryacme.com", domainIndex: 0, personaSlug: "sales", inboxesEach: 1, intentKey: INTENT_KEY },
      ),
    );

    expect(calls.setDns).toHaveLength(2);
    expect((await readDomains(tenantId))[0]!.dns_status).toBe("ready");
  });
});
