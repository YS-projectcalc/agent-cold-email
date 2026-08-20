import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { DelegatingClock, RealClock, requireVirtualClock, VirtualClock } from "../src/clock.js";
import { migrateTenantClockToReal } from "../src/engine/clock-migration.js";
import { ONE_DAY_MS } from "../src/engine/warmup.js";
import type { TenantContext } from "../src/tenant-context.js";
import type { TenantDO } from "../src/tenant-do.js";
import { mintTenant, seedBenignSdnList, signup, tenantStub } from "./helpers.js";

// WAVE 2 DECISION 2 — the one-shot virtual->real clock migration
// (archive/2026-08-05-provisioning-fixwave-plan/wave2-design-2026-08-05.md,
// adversary-gated through two rounds in
// docs/adversarial/wave2-design-review-2026-08-05.md).
//
// Every tenant signs up as 'demo' and therefore on a VirtualClock whose offset
// jumps ~32 virtual days per demo run. The checkout upgrade never touched the
// clock, so a paying tenant's frozen "now" is typically far in the real FUTURE.
// These tests drive the REAL entry points: the DO constructor (via
// evictDurableObject, so the constructor genuinely re-runs) and the Stripe
// checkout webhook — never a hand-built harness around the migration function.

import { REQUEST_IDEMPOTENCY_PENDING_CLAIM_TTL_MS as PENDING_CLAIM_TTL_MS } from "../src/engine/idempotency.js"; // the real stale-claim window, not a copy of it

interface ProfileRow {
  plan: string;
  clock_mode: string;
  clock_base: number;
  clock_offset: number;
  clock_migration_delta_ms: number | null;
  clock_migrated_at: number | null;
  [column: string]: SqlStorageValue;
}

interface MailboxRow {
  id: string;
  provider: string;
  source: string;
  slot_counted: number;
  released_at: number | null;
  deliv_status: string;
  warmup_started_at: number;
  [column: string]: SqlStorageValue;
}

interface SendRow {
  id: string;
  status: string;
  send_at: number;
  sending_since: number | null;
  [column: string]: SqlStorageValue;
}

/** Everything the migration is supposed to (or supposed not to) touch, in one read. */
interface Snapshot {
  profile: ProfileRow;
  mailboxes: MailboxRow[];
  sends: SendRow[];
  campaigns: { id: string; status: string; is_demo: number }[];
  idempotency: { key: string; status: string; created_at: number }[];
  domains: { id: string; status: string; first_send_eligible_at: number | null; dns_first_checked_at: number | null }[];
}

function readSnapshot(tenantId: string): Promise<Snapshot> {
  return runInDurableObject(tenantStub(tenantId), (_i, state) => {
    const sql = state.storage.sql;
    return {
      profile: sql
        .exec<ProfileRow>(
          `SELECT plan, clock_mode, clock_base, clock_offset, clock_migration_delta_ms, clock_migrated_at
           FROM tenant_profile WHERE id = ?`,
          tenantId,
        )
        .one(),
      mailboxes: sql
        .exec<MailboxRow>(
          `SELECT id, provider, source, slot_counted, released_at, deliv_status, warmup_started_at
           FROM mailboxes ORDER BY id`,
        )
        .toArray(),
      sends: sql.exec<SendRow>(`SELECT id, status, send_at, sending_since FROM scheduled_sends ORDER BY id`).toArray(),
      campaigns: sql
        .exec<{ id: string; status: string; is_demo: number; [c: string]: SqlStorageValue }>(
          `SELECT id, status, is_demo FROM campaigns ORDER BY id`,
        )
        .toArray(),
      idempotency: sql
        .exec<{ key: string; status: string; created_at: number; [c: string]: SqlStorageValue }>(
          `SELECT key, status, created_at FROM request_idempotency ORDER BY key`,
        )
        .toArray(),
      domains: sql
        .exec<{
          id: string;
          status: string;
          first_send_eligible_at: number | null;
          dns_first_checked_at: number | null;
          [c: string]: SqlStorageValue;
        }>(`SELECT id, status, first_send_eligible_at, dns_first_checked_at FROM domains ORDER BY id`)
        .toArray(),
    };
  });
}

function byId<T extends { id: string }>(rows: T[], id: string): T {
  const row = rows.find((r) => r.id === id);
  if (!row) throw new Error(`no row ${id} in ${JSON.stringify(rows)}`);
  return row;
}

/**
 * Builds a tenant in EXACTLY the shape production produced before this wave: it
 * signed up as 'demo', ran demo runs (so its virtual clock is offset by a large
 * jump), then upgraded to the paid plan WITHOUT anything touching the clock —
 * i.e. `plan='managed'` while `clock_mode` is still 'virtual'.
 *
 * `offsetMs` is the virtual offset: positive puts the frozen clock in the real
 * FUTURE (the headline case, delta negative), and a negative `baseShiftMs` puts
 * it in the real PAST (delta positive). Both signs must work.
 */
async function seedUnmigratedPaidTenant(
  slug: string,
  opts: { offsetMs?: number; baseShiftMs?: number } = {},
): Promise<{ tenantId: string; frozenNow: number }> {
  const { tenantId } = await signup(slug, `founder@${slug}.com`);
  const offsetMs = opts.offsetMs ?? 0;
  const baseShiftMs = opts.baseShiftMs ?? 0;

  return runInDurableObject(tenantStub(tenantId), (_i, state) => {
    const sql = state.storage.sql;
    sql.exec(
      `UPDATE tenant_profile SET plan = 'managed', billing_state = 'active',
         clock_base = clock_base + ?, clock_offset = ? WHERE id = ?`,
      baseShiftMs,
      offsetMs,
      tenantId,
    );
    const profile = sql
      .exec<{ clock_base: number; clock_offset: number; [c: string]: SqlStorageValue }>(
        `SELECT clock_base, clock_offset FROM tenant_profile WHERE id = ?`,
        tenantId,
      )
      .one();
    const frozenNow = profile.clock_base + profile.clock_offset;

    // --- domains: one provisioned (no BYO gates), one BYO with both gates set,
    // one PURELY sandbox-origin (NEW-4 — no real mailbox is ever attached, so
    // nothing protects it from retirement).
    sql.exec(
      `INSERT INTO domains (id, tenant_id, domain, purchased_at, source) VALUES ('dom_prov', ?, '${slug}.com', ?, 'provisioned')`,
      tenantId,
      frozenNow,
    );
    sql.exec(
      `INSERT INTO domains (id, tenant_id, domain, purchased_at, source, first_send_eligible_at, dns_first_checked_at)
       VALUES ('dom_byo', ?, 'byo-${slug}.com', ?, 'byo', ?, ?)`,
      tenantId,
      frozenNow,
      frozenNow + 3 * ONE_DAY_MS,
      frozenNow - ONE_DAY_MS,
    );
    sql.exec(
      `INSERT INTO domains (id, tenant_id, domain, purchased_at, source) VALUES ('dom_sandbox_only', ?, 'sandboxonly-${slug}.com', ?, 'provisioned')`,
      tenantId,
      frozenNow,
    );
    // Gate finding 1 (wave2-integration-gate-2026-08-06) — the Mordy-shaped
    // domain: adopted via the shipped path (connection_type recorded), ZERO
    // mailboxes ever attached. This is not a corner case, it is the paying
    // customer's ACTUAL current row shape. Must never be retired.
    sql.exec(
      `INSERT INTO domains (id, tenant_id, domain, purchased_at, source, connection_type)
       VALUES ('dom_mordy', ?, 'mordy-${slug}.com', ?, 'provisioned', 'purchased')`,
      tenantId,
      frozenNow,
    );
    // Gate finding 1 sibling shape — mid-saga: the domain row committed, but
    // mailbox-provisioning.ts's insertProvisionedMailbox has not run yet (it
    // only inserts AFTER the vendor confirms each mailbox). Same zero-mailbox
    // predicate as dom_mordy, distinct row so both named scenarios have their
    // own assertion.
    sql.exec(
      `INSERT INTO domains (id, tenant_id, domain, purchased_at, source) VALUES ('dom_midsaga', ?, 'midsaga-${slug}.com', ?, 'provisioned')`,
      tenantId,
      frozenNow,
    );

    // --- mailboxes: one demo-era sandbox row, one real (slot_counted=1), one
    // BYO (all three on dom_prov, so a domain carrying a live real mailbox is
    // exercised too), plus a second sandbox row on dom_sandbox_only (NEW-4 —
    // the domain with NOTHING but sandbox mailboxes on it), plus an ambiguous
    // pre-slot-counted-column real row (gate finding 1 sibling).
    const insertMailbox = (
      id: string,
      source: string,
      slotCounted: number,
      warmupStartedAt: number,
      domainId = "dom_prov",
      provider = "",
    ) =>
      sql.exec(
        `INSERT INTO mailboxes (id, tenant_id, domain_id, domain, email, daily_cap, warmup_started_at, created_at, source, slot_counted, provider)
         VALUES (?, ?, ?, '${slug}.com', ?, 5, ?, ?, ?, ?, ?)`,
        id,
        tenantId,
        domainId,
        `${id}@${slug}.com`,
        warmupStartedAt,
        warmupStartedAt,
        source,
        slotCounted,
        provider,
      );
    // Sandbox-origin, POSITIVELY stamped at insert (mailbox-provisioning.ts's
    // insertProvisionedMailbox writes `provider` straight from the port's own
    // answer today — 'sandbox' from SandboxMailboxPort). The migration's
    // backfill no longer GUESSES 'sandbox' for an ambiguous row (gate finding
    // 1 sibling, fixed below), so these fixtures model the row shape the
    // current insert path actually produces.
    insertMailbox("mb_sandbox", "provisioned", 0, frozenNow - 30 * ONE_DAY_MS, "dom_prov", "sandbox");
    insertMailbox("mb_sandbox_only", "provisioned", 0, frozenNow - 25 * ONE_DAY_MS, "dom_sandbox_only", "sandbox");
    // Real InboxKit mailbox: the vendor stamps REAL wall time, not ctx.clock.
    insertMailbox("mb_real", "provisioned", 1, Date.now() - 10 * ONE_DAY_MS);
    // BYO: a genuine ramp part-way through, on real time.
    insertMailbox("mb_byo", "byo_connected", 0, Date.now() - 5 * ONE_DAY_MS);
    // Gate finding 1 sibling (PRESLOT-MAILBOX) — a REAL mailbox row that
    // predates BOTH the `provider` column AND (hypothetically) the
    // `slot_counted` column: provider='' (never stamped) AND slot_counted=0
    // (not because it's sandbox, but because it's simply older than that
    // column too). Indistinguishable from a genuine unclassified row by any
    // column available — the backfill must leave it alone, not guess.
    insertMailbox("mb_preslot_real", "provisioned", 0, Date.now() - 12 * ONE_DAY_MS, "dom_prov");

    // --- campaigns: one real, one demo-seed
    const insertCampaign = (id: string, isDemo: number) =>
      sql.exec(
        `INSERT INTO campaigns (id, tenant_id, name, sequence_json, send_window_json, is_demo, created_at)
         VALUES (?, ?, ?, '[]', '{}', ?, ?)`,
        id,
        tenantId,
        id,
        isDemo,
        frozenNow,
      );
    insertCampaign("cmp_real", 0);
    insertCampaign("cmp_demo", 1);

    // --- scheduled sends
    const insertSend = (id: string, campaignId: string, status: string, sendAt: number, sendingSince: number | null) =>
      sql.exec(
        `INSERT INTO scheduled_sends (id, tenant_id, campaign_id, lead_id, step, send_at, status, thread_id, sending_since)
         VALUES (?, ?, ?, 'lead', 1, ?, ?, 'thr', ?)`,
        id,
        tenantId,
        campaignId,
        sendAt,
        status,
        sendingSince,
      );
    // Two pending rows 6h apart — their RELATIVE offset must survive the rebase.
    insertSend("ss_pending_a", "cmp_real", "pending", frozenNow + 3600_000, null);
    insertSend("ss_pending_b", "cmp_real", "pending", frozenNow + 3600_000 + 6 * 3600_000, null);
    // A row stuck in 'sending' — BOTH its send_at and its claim marker must shift
    // (adversary finding 4: the TTL reclaim restores status only).
    insertSend("ss_sending", "cmp_real", "sending", frozenNow + 1800_000, frozenNow - 60_000);
    // Terminal history: audit rows, never shifted.
    insertSend("ss_sent", "cmp_real", "sent", frozenNow - 5 * ONE_DAY_MS, null);
    // Demo seed row: terminalized, not shifted.
    insertSend("ss_demo", "cmp_demo", "pending", frozenNow + 7200_000, null);

    // --- idempotency: a 'pending' claim stamped comfortably PAST the stale-claim
    // TTL in virtual time. Under a future-frozen clock `realNow - created_at` is
    // negative, so it reads as BELOW the TTL and the key is wedged forever;
    // after the migration rebases it, it must read as reclaimable.
    //
    // The age is DERIVED from the constant, not written as a number: it was
    // "20 minutes" against a 10-minute TTL, and N7's raise to 30 minutes made
    // that seed land INSIDE the window — the assertion below then failed for a
    // reason that had nothing to do with clock rebasing.
    sql.exec(
      `INSERT INTO request_idempotency (key, status, created_at) VALUES ('setup:wedged', 'pending', ?)`,
      frozenNow - PENDING_CLAIM_TTL_MS * 2,
    );
    // A recorded outcome carries its response — the table's CHECK makes a 'done'
    // row with no body unrepresentable (schema.ts, cached-terminal member 10).
    sql.exec(
      `INSERT INTO request_idempotency (key, status, response_json, created_at) VALUES ('setup:done', 'done', '{"jobId":"job_x"}', ?)`,
      frozenNow - ONE_DAY_MS,
    );

    return { tenantId, frozenNow };
  });
}

/** Forces a genuine DO re-construction — the production path the migration self-applies on. */
async function reconstruct(tenantId: string): Promise<void> {
  await evictDurableObject(tenantStub(tenantId));
  // Any RPC re-instantiates the DO, running the constructor (and therefore the
  // migration) for real.
  await runInDurableObject(tenantStub(tenantId), () => undefined);
}

describe("clock selection (wave-2 DECISION 2)", () => {
  it("a tenant minted directly on the paid plan starts on the REAL clock, stamped 'real' at insert", async () => {
    const { tenantId } = await mintTenant("Paid Direct", "managed");
    const snap = await readSnapshot(tenantId);
    expect(snap.profile.clock_mode).toBe("real");

    const clockNow = await runInDurableObject(tenantStub(tenantId), (instance) =>
      (instance as unknown as { requireContext(): TenantContext }).requireContext().clock.now(),
    );
    expect(Math.abs(clockNow - Date.now())).toBeLessThan(60_000);
  });

  it("a demo tenant is byte-identical: virtual clock, advanceClock still works", async () => {
    const { tenantId } = await signup("Demo Unchanged", "founder@demounchanged.com");
    expect((await readSnapshot(tenantId)).profile.clock_mode).toBe("virtual");

    const before = await runInDurableObject(tenantStub(tenantId), (instance) =>
      (instance as unknown as { requireContext(): TenantContext }).requireContext().clock.now(),
    );
    const newOffset = await tenantStub(tenantId).advanceClock(5 * ONE_DAY_MS);
    expect(newOffset).toBe(5 * ONE_DAY_MS);

    const after = await runInDurableObject(tenantStub(tenantId), (instance) =>
      (instance as unknown as { requireContext(): TenantContext }).requireContext().clock.now(),
    );
    expect(after - before).toBe(5 * ONE_DAY_MS);
    // Still frozen relative to real time — the virtual clock does not tick.
    expect(after).toBeGreaterThan(Date.now() + 4 * ONE_DAY_MS);
  });

  it("advanceClock is refused on a paid tenant", async () => {
    const { tenantId } = await mintTenant("No Advance", "managed");
    // Called on the instance rather than across the RPC bridge: the guard is
    // synchronous, and this keeps the deliberate throw from surfacing as an
    // unhandled remote rejection in the runner.
    await runInDurableObject(tenantStub(tenantId), (instance) => {
      expect(() => (instance as unknown as TenantDO).advanceClock(ONE_DAY_MS)).toThrow(/sandbox-only/i);
    });
  });

  it("requireVirtualClock is a structural guard, and resolves THROUGH the delegate", () => {
    const virtual = new VirtualClock(1000, 0);
    expect(requireVirtualClock(virtual)).toBe(virtual);
    expect(requireVirtualClock(new DelegatingClock(() => virtual))).toBe(virtual);
    expect(() => requireVirtualClock(new RealClock())).toThrow(/real clock/i);
    expect(() => requireVirtualClock(new DelegatingClock(() => new RealClock()))).toThrow(/real clock/i);
  });
});

describe("clock migration — the DO constructor self-applies it, both delta signs", () => {
  for (const variant of [
    { name: "frozen clock in the real FUTURE (delta negative)", offsetMs: 400 * ONE_DAY_MS, baseShiftMs: 0 },
    { name: "frozen clock in the real PAST (delta positive)", offsetMs: 0, baseShiftMs: -200 * ONE_DAY_MS },
  ]) {
    it(`rebases every clock-stamped row: ${variant.name}`, async () => {
      const slug = `mig${variant.offsetMs}${Math.abs(variant.baseShiftMs)}`;
      const { tenantId, frozenNow } = await seedUnmigratedPaidTenant(slug, variant);
      const before = await readSnapshot(tenantId);
      expect(before.profile.clock_mode).toBe("virtual");

      await reconstruct(tenantId);

      const after = await readSnapshot(tenantId);
      // U1 PROBE RESULT: reaching 'real' at all proves `transactionSync` COMMITS
      // from DO-constructor context (adversary round-2 UNVERIFIABLE). A runtime
      // that refused it would have thrown into the constructor's catch, leaving
      // 'virtual'.
      expect(after.profile.clock_mode).toBe("real");
      const delta = after.profile.clock_migration_delta_ms;
      expect(delta).not.toBeNull();
      // delta = realNow - frozenNow, and it carries the sign the variant implies.
      expect(Math.sign(delta as number)).toBe(Math.sign(Date.now() - frozenNow));
      expect(Math.abs((after.profile.clock_migrated_at as number) - Date.now())).toBeLessThan(60_000);

      // --- SHIFT: pending sends rebased, RELATIVE offsets preserved
      const pendingA = byId(after.sends, "ss_pending_a");
      const pendingB = byId(after.sends, "ss_pending_b");
      expect(pendingA.send_at).toBe(byId(before.sends, "ss_pending_a").send_at + (delta as number));
      expect(pendingB.send_at - pendingA.send_at).toBe(6 * 3600_000);
      // ...and they now sit in a real-time-comparable window.
      expect(Math.abs(pendingA.send_at - (Date.now() + 3600_000))).toBeLessThan(60_000);

      // --- SHIFT: the stuck 'sending' row's send_at AND its claim marker
      const sending = byId(after.sends, "ss_sending");
      expect(sending.status).toBe("sending");
      expect(sending.send_at).toBe(byId(before.sends, "ss_sending").send_at + (delta as number));
      expect(sending.sending_since).toBe((byId(before.sends, "ss_sending").sending_since as number) + (delta as number));
      // The reclaim restores status only, so this row must be due-comparable NOW.
      expect(sending.send_at).toBeLessThan(Date.now() + 3600_000);

      // --- terminal history untouched
      expect(byId(after.sends, "ss_sent").send_at).toBe(byId(before.sends, "ss_sent").send_at);

      // --- TERMINALIZE the demo seed
      expect(byId(after.sends, "ss_demo").status).toBe("skipped");
      expect(byId(after.sends, "ss_demo").send_at).toBe(byId(before.sends, "ss_demo").send_at); // skipped, not shifted
      expect(after.campaigns.find((c) => c.id === "cmp_demo")?.status).toBe("paused");
      expect(after.campaigns.find((c) => c.id === "cmp_real")?.status).toBe("active");

      // --- the wedged idempotency claim becomes reclaimable
      const wedgedBefore = before.idempotency.find((r) => r.key === "setup:wedged")!;
      const wedged = after.idempotency.find((r) => r.key === "setup:wedged")!;
      expect(wedged.created_at).toBe(wedgedBefore.created_at + (delta as number));
      expect(Date.now() - wedged.created_at).toBeGreaterThan(PENDING_CLAIM_TTL_MS);
      // 'done' rows shift too, so the 30-day eviction keeps working.
      const doneBefore = before.idempotency.find((r) => r.key === "setup:done")!;
      expect(after.idempotency.find((r) => r.key === "setup:done")!.created_at).toBe(doneBefore.created_at + (delta as number));

      // --- BYO domain gates shift; the provisioned domain has none to shift
      const byoDomain = byId(after.domains, "dom_byo");
      expect(byoDomain.first_send_eligible_at).toBe((byId(before.domains, "dom_byo").first_send_eligible_at as number) + (delta as number));
      expect(byoDomain.dns_first_checked_at).toBe((byId(before.domains, "dom_byo").dns_first_checked_at as number) + (delta as number));
      expect(byId(after.domains, "dom_prov").first_send_eligible_at).toBeNull();

      // --- CLASSIFY + RETIRE
      const sandbox = byId(after.mailboxes, "mb_sandbox");
      expect(sandbox.provider).toBe("sandbox");
      expect(sandbox.released_at).not.toBeNull();
      // BOTH markers: 'paused' is what stops the manual-reply path (which picks
      // its mailbox from thread history with no eligibility filter) sending
      // through a retired demo-era mailbox.
      expect(sandbox.deliv_status).toBe("paused");

      const real = byId(after.mailboxes, "mb_real");
      expect(real.provider).toBe("google");
      expect(real.released_at).toBeNull();
      expect(real.deliv_status).toBe("healthy");

      const byo = byId(after.mailboxes, "mb_byo");
      expect(byo.provider).toBe("byo");
      expect(byo.released_at).toBeNull();

      // --- gate finding 1 sibling (PRESLOT-MAILBOX): an ambiguous row (real,
      // pre-column, indistinguishable from a genuine unclassified row) must
      // stay '' — never guessed as 'sandbox', never released, never paused.
      const preslot = byId(after.mailboxes, "mb_preslot_real");
      expect(preslot.provider).toBe("");
      expect(preslot.released_at).toBeNull();
      expect(preslot.deliv_status).toBe("healthy");

      // --- warmup_started_at is NEVER shifted and NEVER reset, for any class
      for (const id of ["mb_sandbox", "mb_real", "mb_byo", "mb_preslot_real"]) {
        expect(byId(after.mailboxes, id).warmup_started_at).toBe(byId(before.mailboxes, id).warmup_started_at);
      }

      // --- NEW-4: sandbox-origin `domains` rows are retired alongside their
      // mailboxes. dom_sandbox_only carries NOTHING but a (now-retired,
      // positively-classified) sandbox mailbox -> retired. dom_prov still
      // carries mb_real, a live non-sandbox mailbox -> left 'active'. dom_byo
      // (source='byo') is never a retirement candidate at all, regardless of
      // what's attached to it.
      expect(byId(after.domains, "dom_sandbox_only").status).toBe("retired");
      expect(byId(after.domains, "dom_prov").status).toBe("active");
      expect(byId(after.domains, "dom_byo").status).toBe("active");

      // --- gate finding 1 (BLOCKING) — a zero-mailbox `provisioned` domain
      // has NO positive evidence of sandbox origin (nothing attached at all)
      // and must never be retired: the Mordy-shaped adopted-but-empty domain,
      // and the mid-saga (domain committed, mailbox not yet inserted) shape.
      expect(byId(after.domains, "dom_mordy").status).toBe("active");
      expect(byId(after.domains, "dom_midsaga").status).toBe("active");
    });
  }

  it("is idempotent: a second construction is a no-op (the marker forecloses re-entry)", async () => {
    const { tenantId } = await seedUnmigratedPaidTenant("idem", { offsetMs: 400 * ONE_DAY_MS });
    await reconstruct(tenantId);
    const afterFirst = await readSnapshot(tenantId);
    expect(afterFirst.profile.clock_mode).toBe("real");

    await reconstruct(tenantId);
    const afterSecond = await readSnapshot(tenantId);

    expect(afterSecond.profile.clock_migration_delta_ms).toBe(afterFirst.profile.clock_migration_delta_ms);
    expect(afterSecond.profile.clock_migrated_at).toBe(afterFirst.profile.clock_migrated_at);
    for (const send of afterFirst.sends) {
      expect(byId(afterSecond.sends, send.id).send_at).toBe(send.send_at);
    }
    for (const row of afterFirst.idempotency) {
      expect(afterSecond.idempotency.find((r) => r.key === row.key)!.created_at).toBe(row.created_at);
    }
    expect(byId(afterSecond.mailboxes, "mb_sandbox").released_at).toBe(byId(afterFirst.mailboxes, "mb_sandbox").released_at);
    // NEW-4: the domain retirement is idempotent too — already-'retired' stays
    // 'retired' (its WHERE clause only ever touches status='active' rows).
    expect(byId(afterFirst.domains, "dom_sandbox_only").status).toBe("retired");
    expect(byId(afterSecond.domains, "dom_sandbox_only").status).toBe("retired");
  });

  it("a demo tenant's DO construction runs NO migration (byte-identical)", async () => {
    const { tenantId } = await signup("Demo No Migration", "founder@demonomig.com");
    await tenantStub(tenantId).advanceClock(30 * ONE_DAY_MS);
    const before = await readSnapshot(tenantId);

    await reconstruct(tenantId);

    const after = await readSnapshot(tenantId);
    expect(after.profile.clock_mode).toBe("virtual");
    expect(after.profile.clock_migration_delta_ms).toBeNull();
    expect(after.profile.clock_offset).toBe(before.profile.clock_offset);
  });
});

describe("clock migration — atomicity (adversary finding 5)", () => {
  /**
   * Fault injection WITHOUT touching the migration's own code: a partial unique
   * index over `deliv_status='paused'` is legal to create while zero rows are
   * paused, and then the retirement — which pauses TWO sandbox mailboxes —
   * violates it. The throw therefore lands AFTER the provider backfill has
   * already written, which is exactly the partial-application shape the
   * transaction has to undo.
   */
  async function armRetirementFault(tenantId: string): Promise<void> {
    await runInDurableObject(tenantStub(tenantId), (_i, state) => {
      const sql = state.storage.sql;
      sql.exec(
        `INSERT INTO mailboxes (id, tenant_id, domain_id, domain, email, daily_cap, warmup_started_at, created_at, source, slot_counted)
         VALUES ('mb_sandbox2', ?, 'dom_prov', 'x.com', 'mb_sandbox2@x.com', 5, 1, 1, 'provisioned', 0)`,
        tenantId,
      );
      sql.exec(`CREATE UNIQUE INDEX idx_fault_paused ON mailboxes(deliv_status) WHERE deliv_status = 'paused'`);
    });
  }

  async function disarmRetirementFault(tenantId: string): Promise<void> {
    await runInDurableObject(tenantStub(tenantId), (_i, state) => {
      state.storage.sql.exec(`DROP INDEX idx_fault_paused`);
    });
  }

  it("a throw mid-migration rolls back EVERYTHING including the marker, then a clean re-run applies exactly once", async () => {
    const { tenantId } = await seedUnmigratedPaidTenant("rollback", { offsetMs: 400 * ONE_DAY_MS });
    await armRetirementFault(tenantId);
    const before = await readSnapshot(tenantId);

    // Constructor context: the migration throws, the constructor catches it, the
    // DO still boots. (U1 PROBE: this also proves transactionSync ROLLS BACK
    // from a DO constructor, not just that it commits.)
    await reconstruct(tenantId);

    const rolledBack = await readSnapshot(tenantId);
    expect(rolledBack.profile.clock_mode).toBe("virtual"); // marker rolled back with the work
    expect(rolledBack.profile.clock_migration_delta_ms).toBeNull();
    // Nothing partially applied: no shift, no classification, no retirement.
    for (const send of before.sends) {
      expect(byId(rolledBack.sends, send.id).send_at).toBe(send.send_at);
      expect(byId(rolledBack.sends, send.id).status).toBe(send.status);
    }
    for (const mailbox of rolledBack.mailboxes) {
      // mb_sandbox/mb_sandbox_only are seeded with provider='sandbox' DIRECTLY
      // (today's real insert-time stamp, gate finding 1 sibling fix) — this
      // transaction never wrote that column for them (the backfill only ever
      // targets provider=''), so a rollback correctly leaves it exactly as
      // seeded. Every other row started '' and stays '' either way.
      const expectedProvider = mailbox.id === "mb_sandbox" || mailbox.id === "mb_sandbox_only" ? "sandbox" : "";
      expect(mailbox.provider).toBe(expectedProvider);
      expect(mailbox.released_at).toBeNull();
      expect(mailbox.deliv_status).toBe("healthy");
    }
    expect(rolledBack.idempotency.find((r) => r.key === "setup:wedged")!.created_at).toBe(
      before.idempotency.find((r) => r.key === "setup:wedged")!.created_at,
    );
    // NEW-4: domain retirement rolled back too — the throw lands during the
    // mailbox retirement, BEFORE the domain-retirement step ever runs.
    expect(byId(rolledBack.domains, "dom_sandbox_only").status).toBe("active");

    // The retry re-enters a genuinely virgin state, so the delta applies ONCE.
    await disarmRetirementFault(tenantId);
    await reconstruct(tenantId);

    const after = await readSnapshot(tenantId);
    expect(after.profile.clock_mode).toBe("real");
    const delta = after.profile.clock_migration_delta_ms as number;
    expect(byId(after.sends, "ss_pending_a").send_at).toBe(byId(before.sends, "ss_pending_a").send_at + delta);
    // The clean re-run applies the domain retirement exactly once too.
    expect(byId(after.domains, "dom_sandbox_only").status).toBe("retired");
    // Single application, not double: the rebased row lands ~1h out, not ~800 days.
    expect(Math.abs(byId(after.sends, "ss_pending_a").send_at - (Date.now() + 3600_000))).toBeLessThan(60_000);
    expect(byId(after.mailboxes, "mb_sandbox").released_at).not.toBeNull();
  });

  it("rolls back the same way when called outside a constructor (fault injected at an arbitrary statement)", async () => {
    const { tenantId, frozenNow } = await seedUnmigratedPaidTenant("faultproxy", { offsetMs: 400 * ONE_DAY_MS });
    const before = await readSnapshot(tenantId);

    await runInDurableObject(tenantStub(tenantId), (_i, state) => {
      // Fail the 6th sql.exec — past the backfill, the retirement AND the
      // send_at shift, so several statements have genuinely written by then.
      let calls = 0;
      const realStorage = state.storage;
      const faultySql = new Proxy(realStorage.sql, {
        get(target, prop) {
          if (prop === "exec") {
            return (...args: unknown[]) => {
              if (++calls === 6) throw new Error("injected mid-migration failure");
              return (target.exec as (...a: unknown[]) => unknown)(...args);
            };
          }
          const value = Reflect.get(target, prop, target);
          return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
        },
      }) as SqlStorage;
      const faultyStorage = new Proxy(realStorage, {
        get(target, prop) {
          if (prop === "sql") return faultySql;
          const value = Reflect.get(target, prop, target);
          return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
        },
      }) as DurableObjectStorage;

      expect(() => migrateTenantClockToReal(faultyStorage, tenantId, frozenNow, Date.now())).toThrow(/injected/);
    });

    const after = await readSnapshot(tenantId);
    expect(after.profile.clock_mode).toBe("virtual");
    for (const send of before.sends) expect(byId(after.sends, send.id).send_at).toBe(send.send_at);
    for (const mailbox of after.mailboxes) {
      // Same seeded-vs-written distinction as the constructor-context rollback
      // test above: mb_sandbox/mb_sandbox_only carry provider='sandbox' from
      // seed, untouched by this (rolled-back) transaction.
      const expectedProvider = mailbox.id === "mb_sandbox" || mailbox.id === "mb_sandbox_only" ? "sandbox" : "";
      expect(mailbox.provider).toBe(expectedProvider);
    }
    expect(after.idempotency.find((r) => r.key === "setup:wedged")!.created_at).toBe(
      before.idempotency.find((r) => r.key === "setup:wedged")!.created_at,
    );
  });
});

describe("the flip is visible to an ALREADY-IN-FLIGHT saga (adversary finding 6)", () => {
  it("a TenantContext captured before checkout reads REAL time on its very next clock.now()", async () => {
    await seedBenignSdnList();
    const { tenantId } = await signup("Inflight Saga", "founder@inflightsaga.com");
    // Demo runs pushed the virtual clock ~400 days into the real future.
    await tenantStub(tenantId).advanceClock(400 * ONE_DAY_MS);

    await runInDurableObject(tenantStub(tenantId), async (instance) => {
      const withPrivates = instance as unknown as {
        requireContext(): TenantContext;
        handleStripeWebhook(event: unknown): Promise<{ plan?: string }>;
      };
      // The saga captures its context BEFORE the flip, exactly as a multi-minute
      // setup_infrastructure would.
      const ctx = withPrivates.requireContext();
      const beforeFlip = ctx.clock.now();
      expect(beforeFlip).toBeGreaterThan(Date.now() + 300 * ONE_DAY_MS);

      // The DO input gate opens across this await — the normal ordering for a
      // checkout webhook arriving mid-setup.
      const result = await withPrivates.handleStripeWebhook({
        id: `evt_${crypto.randomUUID()}`,
        type: "checkout.session.completed",
        data: {
          object: {
            customer: "cus_inflight",
            subscription: "sub_inflight",
            client_reference_id: tenantId,
            metadata: { tenantId, plan: "managed" },
          },
        },
      });
      expect(result.plan).toBe("managed");

      // The SAME ctx object — no re-capture — now reads real time.
      const afterFlip = ctx.clock.now();
      expect(Math.abs(afterFlip - Date.now())).toBeLessThan(60_000);
      expect(afterFlip).toBeLessThan(beforeFlip - 300 * ONE_DAY_MS);
    });

    const snap = await readSnapshot(tenantId);
    expect(snap.profile.clock_mode).toBe("real");
    expect(snap.profile.clock_migration_delta_ms).not.toBeNull();
  });

  it("the cached sandbox adapter bundle follows the flip too (no cache invalidation needed)", async () => {
    await seedBenignSdnList();
    const { tenantId } = await signup("Cached Bundle", "founder@cachedbundle.com");
    await tenantStub(tenantId).advanceClock(400 * ONE_DAY_MS);

    await runInDurableObject(tenantStub(tenantId), async (instance) => {
      const withPrivates = instance as unknown as {
        requireContext(): TenantContext;
        handleStripeWebhook(event: unknown): Promise<{ plan?: string }>;
        sandboxAdapters: { email: { poll(email: string, cursor: number): Promise<unknown> } } | null;
      };
      // Building a context populates the cached sandbox bundle, which closes over
      // the clock it was handed.
      const ctx = withPrivates.requireContext();
      expect(withPrivates.sandboxAdapters).not.toBeNull();
      const cachedBundleBefore = withPrivates.sandboxAdapters;

      await withPrivates.handleStripeWebhook({
        id: `evt_${crypto.randomUUID()}`,
        type: "checkout.session.completed",
        data: {
          object: {
            customer: "cus_cached",
            subscription: "sub_cached",
            client_reference_id: tenantId,
            metadata: { tenantId, plan: "managed" },
          },
        },
      });

      // Same bundle instance (its in-memory port state must survive), yet the
      // clock it reads through is now real.
      expect(withPrivates.sandboxAdapters).toBe(cachedBundleBefore);
      expect(Math.abs(ctx.clock.now() - Date.now())).toBeLessThan(60_000);
    });
  });
});

// U1 (adversary round-1 UNVERIFIABLE): the ramp math's non-finite failure mode
// was PROVEN, but whether a non-finite value can actually reach the column was
// not. This probe answers it, and freezes the answer as a regression guard: the
// DO SQLite driver binds NaN as NULL, which the NOT NULL constraint rejects. So
// the column can never hold a non-finite anchor — N2 is hardening, not a live
// defect. The hardening still ships (see the port clamp in real-mailbox-port
// and the ramp floor in warmup-cancel's ramp-math test): a raw SQL constraint
// error mid-provisioning-saga is a worse failure shape than a graded VendorError.
describe("U1 probe — non-finite warmup_started_at", () => {
  it("the DO SQLite driver REJECTS a NaN bind into warmup_started_at (INTEGER NOT NULL)", async () => {
    const { tenantId } = await signup("Nan Probe", "founder@nanprobe.com");
    const outcome = await runInDurableObject(tenantStub(tenantId), (_i, state) => {
      const sql = state.storage.sql;
      sql.exec(
        `INSERT INTO domains (id, tenant_id, domain, purchased_at) VALUES ('dom_nan', ?, 'nan.com', 1)`,
        tenantId,
      );
      try {
        sql.exec(
          `INSERT INTO mailboxes (id, tenant_id, domain_id, domain, email, daily_cap, warmup_started_at, created_at)
           VALUES ('mb_nan', ?, 'dom_nan', 'nan.com', 'nan@nan.com', 5, ?, 1)`,
          tenantId,
          Number.NaN,
        );
      } catch (err) {
        return { accepted: false, error: String(err) };
      }
      const stored = sql
        .exec<{ warmup_started_at: number; [c: string]: SqlStorageValue }>(
          `SELECT warmup_started_at FROM mailboxes WHERE id = 'mb_nan'`,
        )
        .one();
      return { accepted: true, stored: stored.warmup_started_at };
    });

    // The answer, frozen: refused at the constraint, never stored. If a future
    // runtime starts ACCEPTING the bind, this fails and the class reopens —
    // a stored non-finite anchor would need a backfill sweep, not just the
    // port-level clamp.
    expect(outcome.accepted).toBe(false);
    expect(outcome.error).toMatch(/NOT NULL constraint failed: mailboxes\.warmup_started_at/);
    const rows = await runInDurableObject(tenantStub(tenantId), (_i, state) =>
      state.storage.sql.exec<{ n: number; [c: string]: SqlStorageValue }>(`SELECT COUNT(*) as n FROM mailboxes`).one(),
    );
    expect(rows.n).toBe(0);
  });
});
