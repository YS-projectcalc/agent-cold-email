import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { domainIntentKey, replacementDomainIntentKey } from "../src/engine/provision-intents.js";
import { activatePaidPlan, api, mintTenant, seedBenignSdnList, tenantStub } from "./helpers.js";
import { IK_API_KEY, IK_WORKSPACE_ID } from "./fixtures/inboxkit.js";
import { fakeInboxKit, purchasedVendorDomain, REGISTRANT } from "./fixtures/inboxkit-workspace.js";

// ══ THE C4-CLASS FIXTURE ═════════════════════════════════════════════════════
//
// C4 (ROADMAP.md, the 2026-08-13 P0): *acceptance fixtures could not express
// state produced by a PREVIOUSLY DEPLOYED BUILD.* Every fixture in this suite
// seeds `domain_intents` through the CURRENT `domainIntentKey` — including the
// 2026-08-05 gate's own orphan-adopt acceptance, which is why that gate could
// verify adopt-in-place, be believed to cover the retry path in general, and
// still leave the live customer minting a domain per retry four days later. A
// derivation change is INVISIBLE to a suite that only ever writes the current
// derivation: both sides move together and every test stays green.
//
// SO THIS FILE SEEDS THE OLD SHAPE LITERALLY. `LEGACY_KEY` below is not
// derived from anything — it is the exact string pinned in
// docs/adversarial/incident-hotfix-gate-2026-08-05.md:287, copied character for
// character from the transcript of the call that actually ran against Mordy's
// tenant. If a future derivation change orphans rows again, THIS is the shape
// of test that catches it: seed what the last build wrote, drive the real
// entry point, assert no second purchase.
//
// The systemic guard against re-introducing C4 is therefore this file's CLASS,
// not its contents: any change to a persisted key derivation needs a fixture
// that writes the PREVIOUS derivation by literal. test/persisted-key-
// derivations.test.ts is its build-time companion — it fails the moment a
// derivation moves, and points here.
// ═════════════════════════════════════════════════════════════════════════════

/** The 2026-08-05 call's key, verbatim: `${setupKey}#${ordinal}` under the pre-85f48af derivation. */
const LEGACY_KEY = "apd-setup-a-2mbx#0";
/** The domain that call registered ($12.50) — live at the vendor, committed under LEGACY_KEY. */
const ORPHAN = "goauthorpitchdesk.com";
/** What the 2026-08-12 retry minted instead of resuming ORPHAN ($15) — committed at the NEW key. */
const LOOKALIKE = "theauthorpitchdesk.com";

function setupBody(domains: number): string {
  return JSON.stringify({
    brand: "Author Pitch Desk",
    primaryDomain: "authorpitchdesk.com",
    domains,
    inboxesEach: 1,
    persona: "Sender",
    physicalAddress: "1 Main St",
    senderIdentity: "Author Pitch Desk <hello@authorpitchdesk.com>",
    registerDomains: true,
    registrant: REGISTRANT,
  });
}

/** The idempotency key his agent has been resending — the one whose old derivation orphaned the intent. */
const RETRY_KEY = "apd-setup-a-2mbx";
/** A DIFFERENT request: raising the ask is a new intent, not a retry of the old one. */
const RAISED_KEY = "apd-setup-b-2dom";

/**
 * His agent's call. The key governs RESPONSE REPLAY only and has no say in what
 * gets bought (src/tenant-do.ts's setupInfrastructure) — which is exactly why a
 * genuinely new request has to carry a new one: reusing a completed key returns
 * the recorded response verbatim without running anything.
 */
function post(token: string, domains = 1, idempotencyKey = RETRY_KEY) {
  return api<Record<string, unknown>>("/setup-infrastructure", {
    method: "POST",
    token,
    headers: { "idempotency-key": idempotencyKey },
    body: setupBody(domains),
  });
}

function readIntents(tenantId: string): Promise<{ key: string; candidate_domain: string; status: string }[]> {
  return runInDurableObject(tenantStub(tenantId), (_i, s) =>
    s.storage.sql
      .exec<{ key: string; candidate_domain: string; status: string }>(
        `SELECT key, candidate_domain, status FROM domain_intents ORDER BY key`,
      )
      .toArray(),
  );
}

function readMailboxes(tenantId: string): Promise<{ email: string }[]> {
  return runInDurableObject(tenantStub(tenantId), (_i, s) =>
    s.storage.sql.exec<{ email: string }>(`SELECT email FROM mailboxes WHERE released_at IS NULL ORDER BY email`).toArray(),
  );
}

/** Writes a live `domains` row + its intent, exactly as the build that ran would have. */
async function seed(
  tenantId: string,
  rows: { id: string; domain: string; intentKey: string }[],
): Promise<void> {
  await runInDurableObject(tenantStub(tenantId), (_i, s) => {
    for (const row of rows) {
      // `connection_type` NULL and `dns_status` 'pending' — his rows predate the
      // discriminator column and never cleared DNS, which is the whole reason
      // his retries kept re-entering provisioning.
      s.storage.sql.exec(
        `INSERT INTO domains (id, tenant_id, domain, status, purchased_at, dns_status) VALUES (?, ?, ?, 'active', 1, 'pending')`,
        row.id,
        tenantId,
        row.domain,
      );
      s.storage.sql.exec(
        `INSERT INTO domain_intents (key, tenant_id, candidate_domain, status, created_at, updated_at)
         VALUES (?, ?, ?, 'committed', 1, 1)`,
        row.intentKey,
        tenantId,
        row.domain,
      );
    }
  });
  // The production trigger, modelled honestly: the reconciliation runs in the DO
  // CONSTRUCTOR, so it applies when a deploy restarts the tenant's DO — never to
  // an isolate already in memory. Seeding without this evict would test a DO
  // that booted before the state existed, which is not a state any deploy
  // produces. Same mechanism test/clock-migration.test.ts uses for the same
  // reason.
  await evictDurableObject(tenantStub(tenantId));
}

/** Mordy's tenant as of 2026-08-13: the 08-12 mint at the CURRENT key, the 08-05 orphan at the old one. */
async function hisLiveState(): Promise<{ token: string; tenantId: string }> {
  const { token, tenantId } = await mintTenant("Author Pitch Desk", "managed");
  await activatePaidPlan(tenantId, "managed");
  await seed(tenantId, [
    { id: "dom_orphan", domain: ORPHAN, intentKey: LEGACY_KEY },
    { id: "dom_mint", domain: LOOKALIKE, intentKey: domainIntentKey(tenantId, 0) },
  ]);
  return { token, tenantId };
}

describe("legacy domain-intent keys are rebound, not re-bought", () => {
  const saved = {
    REGISTRAR_PROVIDER: env.REGISTRAR_PROVIDER,
    INBOXKIT_API_KEY: env.INBOXKIT_API_KEY,
    INBOXKIT_WORKSPACE_ID: env.INBOXKIT_WORKSPACE_ID,
  };

  beforeEach(async () => {
    await seedBenignSdnList();
    await env.DB.prepare("DELETE FROM vendor_spend_entries").run();
    await env.DB.prepare("DELETE FROM vendor_spend_ledger").run();
    await env.DB.prepare("DELETE FROM vendor_slot_state").run();
    Object.assign(env, { REGISTRAR_PROVIDER: "inboxkit", INBOXKIT_API_KEY: IK_API_KEY, INBOXKIT_WORKSPACE_ID: IK_WORKSPACE_ID });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Object.assign(env, saved);
  });

  it("THE MINT, REPRODUCED: an orphaned old-key intent resumes its paid domain instead of buying a lookalike", async () => {
    // Mordy's state on 2026-08-12 at 19:29Z — one paid domain, one committed
    // intent, under the key the previous build derived. RED on the un-fixed
    // code: `planProvisioning` finds nothing at `tenant:<id>#0`, so the ordinal
    // reads unsatisfied, a fresh lookalike is generated, `findAdoptableDomain`
    // cannot rescue ORPHAN (it excludes anything with a live `domains` row) —
    // and /domains/register fires. That is the $15 charge, in a test.
    const { token, tenantId } = await mintTenant("Author Pitch Desk", "managed");
    await activatePaidPlan(tenantId, "managed");
    await seed(tenantId, [{ id: "dom_orphan", domain: ORPHAN, intentKey: LEGACY_KEY }]);

    const vendor = fakeInboxKit({ domains: [purchasedVendorDomain(ORPHAN)] });

    const first = await post(token);

    // THE MONEY ASSERTION.
    expect(vendor.countOf("/domains/register")).toBe(0);
    expect(vendor.registered()).toEqual([ORPHAN]);
    expect(JSON.stringify(await readIntents(tenantId))).not.toContain(LOOKALIKE);

    // The orphan came home: the row moved to the ordinal the current code reads,
    // keeping its status and the resource it names.
    expect(await readIntents(tenantId)).toEqual([
      { key: domainIntentKey(tenantId, 0), candidate_domain: ORPHAN, status: "committed" },
    ]);

    // And it got past DNS onto the mailbox leg — the step his tenant never
    // reached. The vendor has accepted the buy but not yet created it, so this
    // attempt still ends retryable, with nothing billable written.
    expect(vendor.countOf("/mailboxes/buy")).toBe(1);
    expect(first.status).toBe(502);
    expect(first.body.retryable).toBe(true);
    expect(await readMailboxes(tenantId)).toEqual([]);

    // The retry his agent would send next finishes it — still zero purchases.
    vendor.activateMailboxes();
    const second = await post(token);

    expect(second.status).toBe(202);
    expect(vendor.countOf("/domains/register")).toBe(0);
    expect(vendor.countOf("/mailboxes/buy")).toBe(1);
    expect(await readMailboxes(tenantId)).toEqual([{ email: `sender11@${ORPHAN}` }]);
  });

  it("HIS LIVE STATE: the ordinal-0 collision rebinds the orphan to the next ordinal instead of overwriting", async () => {
    // Where his tenant actually sits tonight: the 08-12 retry committed the
    // minted lookalike at the CURRENT key, so ordinal 0 is taken and the orphan
    // has nowhere to go home to. Overwriting would trade one paid domain for
    // another — recovering $12.50 by discarding $15.
    const { token, tenantId } = await hisLiveState();
    const vendor = fakeInboxKit({ domains: [purchasedVendorDomain(ORPHAN), purchasedVendorDomain(LOOKALIKE)] });

    expect(await readIntents(tenantId)).toEqual([
      // The committed intent at ordinal 0 is UNTOUCHED...
      { key: domainIntentKey(tenantId, 0), candidate_domain: LOOKALIKE, status: "committed" },
      // ...and the orphan took the next free ordinal, keeping its resource.
      { key: domainIntentKey(tenantId, 1), candidate_domain: ORPHAN, status: "committed" },
    ]);

    // His agent's held retry, unchanged and still asking for ONE domain, is now
    // safe to send: it resumes ordinal 0 and buys nothing. (It still ends
    // retryable — the vendor has accepted the mailbox order without creating it
    // yet, which is the structural first-buy wait, not this defect.)
    expect((await post(token, 1)).status).toBe(502);
    expect(vendor.countOf("/domains/register")).toBe(0);
    expect(vendor.registered().sort()).toEqual([ORPHAN, LOOKALIKE].sort());
  });

  it("BOTH DOMAINS USABLE: raising the ask to 2 resumes the rebound orphan rather than buying a third", async () => {
    // The outcome the un-fixed code cannot produce: with the orphan still under
    // its old key, ordinal 1 holds no intent at all, so this call generates a
    // fresh lookalike and registers a THIRD domain.
    const { token, tenantId } = await hisLiveState();
    const vendor = fakeInboxKit({
      domains: [purchasedVendorDomain(ORPHAN), purchasedVendorDomain(LOOKALIKE)],
      mailboxesReadyOnBuy: true,
    });

    expect((await post(token, 2, RAISED_KEY)).status).toBe(202);

    expect(vendor.countOf("/domains/register")).toBe(0);
    expect(vendor.registered().sort()).toEqual([ORPHAN, LOOKALIKE].sort());
    // A mailbox on each — the stranded domain is genuinely in service, not just
    // recorded.
    expect(await readMailboxes(tenantId)).toEqual([
      { email: `sender11@${LOOKALIKE}` },
      { email: `sender21@${ORPHAN}` },
    ]);
  });

  it("a burn-replacement intent is NOT legacy: the deliverability loop's own keys are left alone", async () => {
    // engine/deliverability-actions.ts is a second, CURRENT writer of
    // `domain_intents` under `replacementDomainIntentKey`. Its keys do not match
    // `domainIntentKey` either — so a reconciliation that classified "orphan" as
    // "anything that isn't the setup derivation" would rebind a working key onto
    // an ordinal the setup path owns, orphaning the replacement and re-creating
    // this exact defect on the deliverability route.
    const { tenantId } = await mintTenant("Author Pitch Desk", "managed");
    await activatePaidPlan(tenantId, "managed");
    const replaceKey = replacementDomainIntentKey(tenantId, "burned.com", 3);
    await seed(tenantId, [{ id: "dom_replacement", domain: "goburned.com", intentKey: replaceKey }]);

    expect(await readIntents(tenantId)).toEqual([
      { key: replaceKey, candidate_domain: "goburned.com", status: "committed" },
    ]);
  });

  it("an orphan with no live domain row behind it is left alone — a rebind needs proof of a resource", async () => {
    // The rebind's whole licence is that the tenant demonstrably owns the thing.
    // An old-key intent naming a domain with no live `domains` row proves
    // nothing: it may name a buy that never landed, and binding it to an ordinal
    // would make `planProvisioning` skip a domain the tenant does not have.
    const { tenantId } = await mintTenant("Author Pitch Desk", "managed");
    await activatePaidPlan(tenantId, "managed");
    await runInDurableObject(tenantStub(tenantId), (_i, s) => {
      s.storage.sql.exec(
        `INSERT INTO domain_intents (key, tenant_id, candidate_domain, status, created_at, updated_at)
         VALUES (?, ?, ?, 'committed', 1, 1)`,
        LEGACY_KEY,
        tenantId,
        ORPHAN,
      );
    });
    await evictDurableObject(tenantStub(tenantId));

    expect(await readIntents(tenantId)).toEqual([
      { key: LEGACY_KEY, candidate_domain: ORPHAN, status: "committed" },
    ]);
  });
});
