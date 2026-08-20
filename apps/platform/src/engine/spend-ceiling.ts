// G0/G2/G4 (ga-gates-design-2026-07-22.md §0/§G2/§G4) — the ONE money-out
// choke-point every real vendor spend passes through, plus the cross-tenant
// D1 accounting it maintains and the stale-reserve reaper that keeps it
// crash-safe.
//
// withSpendCeiling(ctx, kind, fn):
//   - SANDBOX tenants (demo/free/unactivated — factory.ts hands them a sandbox
//     bundle) cost $0: no reservation, no ledger touch, just run fn(). This is
//     the structural guarantee a non-real tenant can never consume the ceiling.
//   - REAL tenants: ATOMICALLY reserve the kind's estimated cost against the
//     per-calendar-month D1 ceiling BEFORE the vendor call (single conditional
//     UPDATE — no TOCTOU, G2's two-concurrent-reserve guard), plus (for a plan-
//     slot mailbox) an atomic reserve against the account slot counter (G4),
//     commit on success, release on failure. A rejected reserve throws
//     CapacityPendingError — a GRACEFUL back-pressure signal the provisioning
//     entry points catch to leave the tenant capacity_pending (never a 500),
//     plus a one-shot founder alert.
//
// The single choke-point is the G2/G4 analogue of the I3/I4 lane's
// isRealSpendArmed env-coverage guard: spend-ceiling-coverage.test.ts asserts
// no money-out call site bypasses this wrapper.

import { CapacityPendingError, operatorNotifiedClause, type Notified } from "@coldstart/shared";
import { RealClock } from "../clock.js";
import type { Env } from "../env.js";
import { RESERVE_REAP_BATCH } from "../admin/sweep-budget.js";
import { sweepDeadlineOf, sweepTenants, type SweepScope } from "../admin/tenant-slice.js";
import { createOpsMailer, type OpsMailer } from "../ops-mail/ops-mailer.js";
import { newId } from "../schema.js";
import type { TenantContext } from "../tenant-context.js";
import { escapeHtml } from "../html-escape.js";

// The money-out call kinds the choke-point distinguishes (design §G4: slot
// accounting must count ONLY plan-slot mailboxes). 'mailbox' consumes one
// InboxKit plan slot; 'warmup' is the warmup add-on already priced into
// COST_MAILBOX_CENTS (reserves 0 — see spendCostCents); 'prewarm' is the future
// Instant-Start SKU (InboxKit's own inventory, NOT one of our plan slots, so no
// slot consumed); 'domain' is a registrar purchase (no slot).
export type SpendKind = "mailbox" | "warmup" | "prewarm" | "domain";

// Founder-tunable defaults (design §"Founder-tunable knobs"). Overestimate-
// biased because the exact InboxKit credit->$ rate is UNVERIFIED until a real
// top-up (prewarm research §2); a conservative overestimate can only over-
// restrict, never over-spend.
// THE BLAST-RADIUS BOUND, AS A FORMULA (founder ruling 2026-08-18: the flat
// $150 "is the deliberate pilot blast-radius bound — its Train-6 remedy = scale
// it with paying-tenant count"). A flat pilot figure is a PLATFORM-WIDE cap, so
// at 690¢/mailbox it stopped every tenant's provisioning at ~21 mailboxes for
// the whole month (scale-readiness-audit-2026-08-17.md S2) — a growth ceiling
// disguised as a safety bound.
//
//   ceiling = PLATFORM_BASE + PER_PAYING_TENANT x paying tenants
//
// PLATFORM_BASE covers what is owed no matter how many customers exist (the
// InboxKit base subscription, ~$39, plus headroom). PER_PAYING_TENANT covers ONE
// customer's whole first-month provisioning, which is where a customer's vendor
// spend is concentrated: this ledger counts provision-time reserves, so an
// existing customer adds ~nothing in later months (N-PC-1, ga-gates-design-
// review-2026-07-23.md). Derived from this file's own cost table at a generous
// ordinary shape — 3 domains + 9 mailboxes = 3x1500 + 9x690 = 10,710¢ — then
// rounded UP to 12,000¢, keeping the original overestimate bias.
//
// A customer who provisions far past that ordinary shape (the Scale tier admits
// 18 domains / 60 mailboxes ≈ 68,400¢) still trips the gate. That is the bound
// DOING ITS JOB: it fails gracefully into capacity_pending with a founder alert,
// never into vendor spend, and the founder raises the knob deliberately.
//
// THE COUNT IS OPERATOR-DECLARED (`PAYING_TENANT_COUNT`), not queried. There is
// no maintained cross-tenant count of currently-paying tenants to read:
// `tenants_index.plan` is written once at signup and never updated (db.ts — the
// INSERT is its only writer), and `stripe_customer_index` is append-only and
// many-customers-to-one-tenant, so counting it would RATCHET UP with churn and
// silently widen the blast radius over time. An explicit knob can only widen when
// a human widens it, which is the correct direction for a money guard.
const PLATFORM_BASE_CENTS = 6000; // $60 — InboxKit base sub (~$39) + headroom, independent of customer count
const PER_PAYING_TENANT_CENTS = 12000; // $120 — one customer's first-month provisioning, overestimate-biased
const DEFAULT_PAYING_TENANTS = 1; // the pilot today; the founder raises this as customers land
const DEFAULT_COST_MAILBOX_CENTS = 690; // slot amortized ($39/10) + $3/mo warmup add-on
const DEFAULT_COST_DOMAIN_CENTS = 1500; // .com registration ceiling
const DEFAULT_COST_PREWARM_MAILBOX_CENTS = 900; // prewarm top tier (Instant-Start SKU)
const DEFAULT_INBOXKIT_PLAN_SLOTS = 10; // the purchased InboxKit Professional plan

// A 'reserved' entry older than this is presumed orphaned by a crash between
// reserve and commit/release (design NB-2) and is reclaimed by the scheduled()
// reaper. Sized well above the longest legitimate provision run so a live
// in-flight reservation is never reaped, yet far under a day so a genuinely
// leaked reservation frees promptly.
//
// RAISED WITH THE CLAIM TTL IT IS SIZED AGAINST (N7's knock-on, wave-b1 gate).
// This used to say "single-digit minutes per the idempotency 'pending' TTL" and
// sit at 15 min. That TTL has been re-derived to 30 min now that the S3 retry
// adds up to 20s of serialized backoff per vendor call
// (engine/idempotency.ts), so 15 min would have put the reaper INSIDE the
// longest legitimate run — making the H7 path below ("entry was resolved out
// from under a successful commit") an ordinary event on slow-but-healthy
// sagas instead of the incident it is written as. Nothing would over-spend
// (`committed_cents` is still incremented and the entry record restored), but
// `reserved_cents` double-decrements into its MAX(0,...) clamp and an
// error-level reconciliation log fires on a working provision — which is how
// an operator learns to ignore that line.
//
// 45 min = 1.5x the re-derived 30-min bound, still ~32x under a day.
// `spend-ceiling.test.ts` pins the ordering so the two cannot drift again: the
// reaper must always outlive the claim.
export const RESERVE_REAP_TTL_MS = 45 * 60 * 1000;

function parsePositiveInt(raw: string | null | undefined, fallback: number): number {
  if (raw == null) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * The per-calendar-month spend ceiling (founder Q1 ruling: per-calendar-month,
 * base sub included). `SPEND_CEILING_CENTS` remains the ABSOLUTE override — an
 * operator who names a number gets exactly it — and in its absence the bound is
 * derived from the declared paying-tenant count (see the formula above), so
 * growth raises the ceiling instead of hitting it.
 */
export function spendCeilingCents(env: Env): number {
  const payingTenants = parsePositiveInt(env.PAYING_TENANT_COUNT, DEFAULT_PAYING_TENANTS);
  return parsePositiveInt(env.SPEND_CEILING_CENTS, PLATFORM_BASE_CENTS + PER_PAYING_TENANT_CENTS * payingTenants);
}

/** The InboxKit plan's slot capacity (G4). Founder raises it after a plan upgrade — no automatic vendor plan purchase. */
export function inboxKitPlanSlots(env: Env): number {
  return parsePositiveInt(env.INBOXKIT_PLAN_SLOTS, DEFAULT_INBOXKIT_PLAN_SLOTS);
}

/** The estimated money-out cost the choke-point reserves for one call of `kind` (founder-tunable per-kind). */
export function spendCostCents(env: Env, kind: SpendKind): number {
  switch (kind) {
    case "mailbox":
      return parsePositiveInt(env.COST_MAILBOX_CENTS, DEFAULT_COST_MAILBOX_CENTS);
    case "domain":
      return parsePositiveInt(env.COST_DOMAIN_CENTS, DEFAULT_COST_DOMAIN_CENTS);
    case "prewarm":
      return parsePositiveInt(env.COST_PREWARM_MAILBOX_CENTS, DEFAULT_COST_PREWARM_MAILBOX_CENTS);
    case "warmup":
      // The warmup add-on's cost is BUNDLED into COST_MAILBOX_CENTS at the
      // provision site (design cost-table rationale: "slot amortized + warmup
      // add-on"), so wrapping startWarmup reserves 0 — it routes through the
      // choke-point for inventory-completeness (no money-out vendor call escapes
      // the enumerated sites) without double-reserving.
      //
      // LIFECYCLE (founder ruling 2026-08-02, ROADMAP.md:25 option b): the
      // add-on is a RECURRING monthly per-mailbox charge, but the platform now
      // cancels it once the mailbox's ramp completes (engine/warmup-cancel.ts),
      // so it bills for roughly the one ramp month rather than the life of the
      // mailbox. COST_MAILBOX_CENTS stays as-is and stays overestimate-biased by
      // design — it charges the full ramp-month add-on against month one, which
      // over-reserves slightly in later months rather than under-reserving. The
      // cancel itself is NOT money-out (it STOPS spend), so it is deliberately
      // absent from the money-out inventory, exactly like `release`. A future
      // standalone warmup SKU flips this to a real founder-tunable cost here.
      return 0;
  }
}

/**
 * period_key = 'YYYY-MM' (per-calendar-month, founder Q1).
 *
 * H7 (INCIDENT 2026-08-05) — the previous comment here claimed paid tenants run
 * on a real-time clock so this was "real wall-clock". That was FALSE: the
 * VirtualClock is per-tenant and carries whatever offset/multiplier that DO has
 * accumulated (a tenant that was demo before upgrading keeps its skew), which
 * time-warped the incident's ledger rows into the wrong period entirely. The
 * ledger is CROSS-TENANT D1 state, so every one of its timestamps now comes
 * from `ledgerNow()` below, never from `ctx.clock`.
 */
export function periodKey(nowMs: number): string {
  const d = new Date(nowMs);
  const month = `${d.getUTCMonth() + 1}`.padStart(2, "0");
  return `${d.getUTCFullYear()}-${month}`;
}

/**
 * Wall-clock for every ledger write — a DELIBERATE, documented exception to the
 * injected-clock rule (ARCHITECTURE.md #4). That rule exists so per-tenant
 * simulation is deterministic; the vendor spend ledger is the opposite kind of
 * state: ONE cross-tenant row per calendar month, reconciled against real
 * invoices. Stamping it from a tenant's virtual clock lets any single tenant's
 * time skew corrupt shared accounting. Mirrors how `scheduled.ts` uses
 * `RealClock` for the same reason.
 */
function ledgerNow(): number {
  return new RealClock().now();
}

function setCapacityPendingMarker(ctx: TenantContext): boolean {
  // Per-tenant marker (DO SQLite) G3's activationState reads. Conditional so
  // the 'ok'->'capacity_pending' TRANSITION is detectable — the alert fires only
  // on the transition, not once per rejected mailbox (no alert storm).
  const res = ctx.sql.exec(
    `UPDATE tenant_profile SET provisioning_state = 'capacity_pending' WHERE id = ? AND provisioning_state != 'capacity_pending'`,
    ctx.tenantId,
  );
  return res.rowsWritten > 0;
}

function clearCapacityPendingMarker(ctx: TenantContext): void {
  ctx.sql.exec(
    `UPDATE tenant_profile SET provisioning_state = 'ok' WHERE id = ? AND provisioning_state != 'ok'`,
    ctx.tenantId,
  );
}

async function currentSlotsUsed(db: D1Database): Promise<number> {
  const row = await db.prepare(`SELECT slots_used FROM vendor_slot_state WHERE id = 1`).first<{ slots_used: number }>();
  return row?.slots_used ?? 0;
}

/**
 * Returns WHETHER THE FOUNDER WAS ACTUALLY TOLD (docs/adversarial/
 * class-sweep-signal-inversion-2026-08-17.md guard A1). It used to return
 * void, and the 409 body one frame up asserted "The operator has been
 * notified" regardless — while this function early-returns on an unset
 * OPS_ALERT_EMAIL and swallows every send failure. A customer told a human is
 * on it stops escalating; that is the whole cost of the claim being decorative.
 */
/**
 * The ceiling currently STORED for this period — what `withSpendCeiling`'s
 * atomic reserve actually gates on, which is not necessarily what the env says
 * right now.
 *
 * A RAISE IS DURABLE FOR THE CALENDAR MONTH (N1). `ceiling_cents` has exactly
 * two writers, both in `withSpendCeiling`: the `INSERT OR IGNORE` seed and the
 * raise-only reconcile (`WHERE period_key = ? AND ceiling_cents < ?`). Nothing
 * anywhere lowers it — there is no lowering statement and no admin route — so a
 * mistyped `PAYING_TENANT_COUNT` that lands on ONE provisioning call raises the
 * live month's bound until the 1st, and putting the knob back does not walk it
 * back. Raise-only is correct for its purpose (a lowered bound could sit under
 * reserved+committed and block every remaining provision on a number nobody
 * saw), but the irreversibility is the part that was undocumented.
 *
 * THE MANUAL LOWERING PATH, since there is no supported one:
 *
 *   wrangler d1 execute coldstart-platform-db --remote \
 *     --command "UPDATE vendor_spend_ledger SET ceiling_cents = <cents> WHERE period_key = '<YYYY-MM>'"
 *
 * Check `reserved_cents + committed_cents` first — setting the ceiling below
 * that total blocks all further provisioning for the month without refunding
 * anything already spent. An admin route for this is on the ROADMAP.
 */
async function readInForceCeilingCents(ctx: TenantContext, now: Date): Promise<number | null> {
  try {
    const row = await ctx.env.DB.prepare(`SELECT ceiling_cents FROM vendor_spend_ledger WHERE period_key = ?`)
      .bind(periodKey(now.getTime()))
      .first<{ ceiling_cents: number }>();
    return row?.ceiling_cents ?? null;
  } catch (err) {
    // The alert must still go out; an unreadable row just means we report the
    // configured number alone rather than both.
    console.error("capacity-pending alert: could not read the in-force ceiling", err);
    return null;
  }
}

async function alertCapacityPending(
  ctx: TenantContext,
  reason: "spend_ceiling" | "slot_capacity",
  detail: {
    kind: SpendKind;
    estCents: number;
    ceilingCents: number;
    /** The ceiling the GATE actually used — `vendor_spend_ledger.ceiling_cents`
     * for this period, which is raise-only and so can be HIGHER than the
     * configured number above (N1). Null when the row could not be read. */
    inForceCeilingCents: number | null;
    planSlots: number;
    slotsUsed: number;
  },
  mailer: OpsMailer,
): Promise<Notified> {
  if (!ctx.env.OPS_ALERT_EMAIL) return { delivered: false, why: "dark_channel" };
  // N2 — the growth knob is PAYING_TENANT_COUNT, not SPEND_CEILING_CENTS.
  // This line used to instruct the latter, which is the ABSOLUTE OVERRIDE
  // (`spendCeilingCents`): an operator following the old instruction would
  // freeze the ceiling at a literal and the per-paying-tenant scaling would
  // never apply again — re-creating the growth-ceiling-disguised-as-a-safety-
  // bound that this formula exists to remove. Read at exactly the moment
  // provisioning is blocked, i.e. when it is most likely to be obeyed.
  const action =
    reason === "slot_capacity"
      ? `slot capacity reached (${detail.slotsUsed}/${detail.planSlots}) — upgrade the InboxKit plan and raise INBOXKIT_PLAN_SLOTS`
      : `spend ceiling reached — raise PAYING_TENANT_COUNT to match the customers you now have (the ceiling scales with it). ` +
        `SPEND_CEILING_CENTS is an absolute override: setting it FREEZES the ceiling at that literal and the per-tenant scaling stops applying`;
  // BOTH numbers, because they can differ and the operator needs the one the
  // gate used. `ceiling_cents` is raise-only within a period, so a number
  // configured earlier this month is still in force even after the config came
  // back down.
  const ceilingLine =
    detail.inForceCeilingCents !== null && detail.inForceCeilingCents !== detail.ceilingCents
      ? `Ceiling IN FORCE this period: ${detail.inForceCeilingCents}¢/mo (configured right now: ${detail.ceilingCents}¢/mo — the in-force number is higher because a raise is durable for the calendar month).`
      : `Ceiling: ${detail.ceilingCents}¢/mo.`;
  const text =
    `Tenant ${ctx.tenantId} hit a provisioning capacity gate on a '${detail.kind}' spend (est ${detail.estCents}¢).\n\n` +
    `${ceilingLine}\n\n${action}.\n\nThe tenant is held in 'capacity_pending' (no charge, no provisioning) and a later provision retries once you raise the limit.`;
  try {
    await mailer.send({
      to: ctx.env.OPS_ALERT_EMAIL,
      subject: `[coldrig] provisioning capacity gate — ${reason} (tenant ${ctx.tenantId})`,
      text,
      html: `<p>${escapeHtml(text).replace(/\n/g, "<br>")}</p>`,
    });
    return { delivered: true, why: "sent" };
  } catch (mailErr) {
    console.error(`capacity-pending alert: send to ${ctx.env.OPS_ALERT_EMAIL} failed (dark or transient)`, mailErr);
    return { delivered: false, why: "send_failed" };
  }
}

async function rejectCapacity(
  ctx: TenantContext,
  reason: "spend_ceiling" | "slot_capacity",
  detail: { kind: SpendKind; estCents: number; ceilingCents: number; planSlots: number; slotsUsed: number },
  mailer: OpsMailer,
): Promise<never> {
  const transitioned = setCapacityPendingMarker(ctx);
  // N1 — read the ceiling THE GATE ACTUALLY USED, not just the configured one.
  // Only on the rejection path, so it costs a D1 read exactly when provisioning
  // is already blocked and an operator is about to be told a number.
  const inForceCeilingCents = transitioned ? await readInForceCeilingCents(ctx, new Date()) : null;
  // Only the FIRST rejection of an episode alerts; a later one is deliberately
  // withheld because an earlier alert stands — which is a reason the customer
  // sentence must be able to say, and could not while it was a constant.
  const notified: Notified = transitioned
    ? await alertCapacityPending(ctx, reason, { ...detail, inForceCeilingCents }, mailer)
    : { delivered: false, why: "suppressed_cooldown" };
  // CUSTOMER-FACING (error-response.ts returns this message verbatim in the 409
  // body), so it names neither the provider nor our internal capacity numbers.
  // It used to read "InboxKit plan-slot capacity reached (3/10)" — the vendor's
  // identity plus our own inventory position, shipped to a tenant. The operator
  // detail lives in the ops alert above, which is exactly the split the founder
  // rule asks for (docs/adversarial/sweep-vendor-leak-2026-08-05.md).
  //
  // The notification clause is CHOSEN BY WHAT HAPPENED (packages/shared's
  // operatorNotifiedClause), never asserted.
  const limit = reason === "slot_capacity" ? "its provisioning capacity" : "its monthly provisioning limit";
  throw new CapacityPendingError(
    reason,
    `provisioning is temporarily held: this account has reached ${limit}. Nothing was charged. ` +
      `${operatorNotifiedClause(notified)} A retry will succeed once the limit is raised.`,
  );
}

/**
 * The money-out choke-point (design §0). Reserves `kind`'s cost against the D1
 * ceiling BEFORE `fn`, commits on success, releases on failure. No-op for
 * sandbox tenants. Throws CapacityPendingError when the reserve is rejected.
 *
 * COMPOSE INSIDE the I3/I4 idempotency wrapper (design §G2 collision note):
 *   withRequestIdempotency(ctx, key, () => withSpendCeiling(ctx, kind, () => vendorCall()))
 * so a replayed provision that returns the RECORDED result (no re-buy) never
 * re-enters here and never double-reserves — only a true first execution
 * reaches this function. On a thrown CapacityPendingError the idempotency claim
 * is cleared (failures aren't cached), so a retry after the founder raises the
 * ceiling re-runs cleanly.
 *
 * `mailer` is injectable (default the real/dark-per-env OpsMailer) — same
 * pattern as runDeliverabilitySweep/alertRegistrarUnarmed, so a guard test can
 * assert the alert with a SandboxOpsMailer without any production call site
 * threading it.
 *
 * NOTE (design deviation, flagged): the G4 slot counter lives in its OWN
 * account-wide single row (vendor_slot_state), NOT in the per-calendar-month
 * ledger row the design put it in — plan-slot OCCUPANCY persists across months,
 * so a per-month counter would reset to 0 each month and let a tenant
 * re-provision the full plan again (silent over-provisioning). See the
 * migration comment. Each counter's two-concurrent-reserve guard still holds
 * via its own atomic single-row conditional UPDATE.
 */
export async function withSpendCeiling<T>(
  ctx: TenantContext,
  kind: SpendKind,
  fn: () => T | Promise<T>,
  mailer: OpsMailer = createOpsMailer(ctx.env),
): Promise<T> {
  // Sandbox tenants (demo/free/unactivated, or the real-vendor creds unarmed)
  // cost $0 and never touch the account ledger. This IS the reason a demo/free
  // tenant can never consume the ceiling (factory.ts hands them kind='sandbox').
  if (ctx.adapters.kind === "sandbox") return fn();

  const db = ctx.env.DB;
  const now = ledgerNow();
  const pk = periodKey(now);
  const estCents = spendCostCents(ctx.env, kind);
  const isSlot = kind === "mailbox";
  const ceilingCents = spendCeilingCents(ctx.env);
  const planSlots = inboxKitPlanSlots(ctx.env);

  // Seed the period $ row + the account slot row (idempotent) so the conditional
  // reserves below have rows to gate on — a reserve UPDATE fails-closed (blocks
  // ALL spend) if its row is absent (adversary minor: "G2 must specify
  // period_key row seeding"). INSERT OR IGNORE, so a concurrent seed / a
  // pre-existing row is untouched (a test can pre-seed a low ceiling / a near-cap
  // slots_used).
  await db
    .prepare(
      `INSERT OR IGNORE INTO vendor_spend_ledger (period_key, reserved_cents, committed_cents, ceiling_cents, updated_at)
       VALUES (?, 0, 0, ?, ?)`,
    )
    .bind(pk, ceilingCents, now)
    .run();
  // ...and CARRY A RAISE INTO THE MONTH ALREADY IN PROGRESS. The reserve below
  // gates on the ROW's ceiling_cents, which `INSERT OR IGNORE` only ever writes
  // at the month's FIRST spend — so raising the configured ceiling did nothing
  // until the 1st, and `alertCapacityPending`'s own instruction ("raise
  // SPEND_CEILING_CENTS ... a retry will succeed once the limit is raised") was
  // false for up to a month. That is the exact window in which it is read: the
  // alert only fires because provisioning is already blocked.
  //
  // RAISE-ONLY, deliberately. Lowering a live month's stored ceiling could put it
  // UNDER reserved+committed, which would not claw anything back (the spend is
  // already made) but would block every remaining provision on numbers the
  // operator never saw — so a reduction takes effect at the next period, where it
  // bounds a month that has spent nothing yet.
  await db
    .prepare(`UPDATE vendor_spend_ledger SET ceiling_cents = ?, updated_at = ? WHERE period_key = ? AND ceiling_cents < ?`)
    .bind(ceilingCents, now, pk, ceilingCents)
    .run();
  await db.prepare(`INSERT OR IGNORE INTO vendor_slot_state (id, slots_used, updated_at) VALUES (1, 0, ?)`).bind(now).run();

  // Phase 1 — ATOMIC $ reserve (all kinds). The check AND the increment are one
  // statement, so two concurrent provisions that jointly exceed the ceiling
  // can't both slip past (single-writer D1/SQLite serializes) — G2's guard.
  const dollarRes = await db
    .prepare(
      `UPDATE vendor_spend_ledger
          SET reserved_cents = reserved_cents + ?, updated_at = ?
        WHERE period_key = ?
          AND reserved_cents + committed_cents + ? <= ceiling_cents`,
    )
    .bind(estCents, now, pk, estCents)
    .run();
  if ((dollarRes.meta.changes ?? 0) === 0) {
    return rejectCapacity(ctx, "spend_ceiling", { kind, estCents, ceilingCents, planSlots, slotsUsed: 0 }, mailer);
  }

  // Phase 2 — ATOMIC slot reserve (plan-slot mailbox only) — G4's guard. If the
  // plan slot capacity is exhausted, ROLL BACK the phase-1 $ reserve so a
  // slot-capacity rejection never strands a reservation.
  if (isSlot) {
    const slotRes = await db
      .prepare(`UPDATE vendor_slot_state SET slots_used = slots_used + 1, updated_at = ? WHERE id = 1 AND slots_used + 1 <= ?`)
      .bind(now, planSlots)
      .run();
    if ((slotRes.meta.changes ?? 0) === 0) {
      await db
        .prepare(`UPDATE vendor_spend_ledger SET reserved_cents = MAX(0, reserved_cents - ?), updated_at = ? WHERE period_key = ?`)
        .bind(estCents, now, pk)
        .run();
      const slotsUsed = await currentSlotsUsed(db);
      return rejectCapacity(ctx, "slot_capacity", { kind, estCents, ceilingCents, planSlots, slotsUsed }, mailer);
    }
  }

  // Both reserves succeeded — anchor an audit + reaper entry. A crash between
  // here and commit leaves this 'reserved' for the scheduled() reaper (NB-2).
  const entryId = newId("vsp");
  await db
    .prepare(
      `INSERT INTO vendor_spend_entries (id, period_key, tenant_id, kind, est_cents, actual_cents, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, 'reserved', ?, ?)`,
    )
    .bind(entryId, pk, ctx.tenantId, kind, estCents, now, now)
    .run();

  try {
    const result = await fn();
    // Commit: move est from reserved to committed (slots_used stays — the slot is
    // really used now). Entry -> committed. A real spend went through, so clear
    // any stale capacity_pending marker.
    const committedAt = ledgerNow();
    await db
      .prepare(
        `UPDATE vendor_spend_ledger
            SET reserved_cents = MAX(0, reserved_cents - ?), committed_cents = committed_cents + ?, updated_at = ?
          WHERE period_key = ?`,
      )
      .bind(estCents, estCents, committedAt, pk)
      .run();
    // H7 (INCIDENT 2026-08-05) — guard the transition on the entry still being
    // 'reserved'. The stale-reservation reaper can fire between our reserve and
    // this commit; it flips the row to 'released' AND subtracts the reservation
    // from the ledger. The unguarded UPDATE then flipped that same row to
    // 'committed' while the ledger had already been decremented once — the
    // double-subtract that shows up live as 2026-07 reserved_cents=0 (clamped
    // by MAX(0,...)) against committed_cents=1500.
    const committed = await db
      .prepare(`UPDATE vendor_spend_entries SET status = 'committed', actual_cents = ?, updated_at = ? WHERE id = ? AND status = 'reserved'`)
      .bind(estCents, committedAt, entryId)
      .run();
    if (!committed.meta.changes) {
      // The reaper (or anything else) already resolved this row, so its
      // reservation is no longer counted. Money DID move — the vendor call
      // above succeeded — so restore an accurate committed record rather than
      // leaving spend that happened unrecorded. INSERT OR REPLACE, not a second
      // UPDATE: the row may have been deleted outright.
      await db
        .prepare(
          `INSERT OR REPLACE INTO vendor_spend_entries (id, tenant_id, kind, est_cents, actual_cents, status, period_key, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'committed', ?, ?, ?)`,
        )
        .bind(entryId, ctx.tenantId, kind, estCents, estCents, pk, committedAt, committedAt)
        .run();
      // The ledger's committed_cents was already incremented above, but its
      // reserved_cents was decremented TWICE (once by the reaper, once by us).
      // MAX(0,...) clamps rather than going negative, so no correction is
      // possible from here — record it for reconciliation instead of pretending.
      console.error(
        "vendor spend: entry was resolved out from under a successful commit; committed record restored",
        JSON.stringify({ entryId, tenantId: ctx.tenantId, kind, estCents, periodKey: pk }),
      );
    }
    clearCapacityPendingMarker(ctx);
    return result;
  } catch (err) {
    // Vendor call failed — RELEASE the reservation (subtract est + any slot).
    // Entry -> released. Never leaks a reservation on a failed vendor call.
    const releasedAt = ledgerNow();
    await db
      .prepare(`UPDATE vendor_spend_ledger SET reserved_cents = MAX(0, reserved_cents - ?), updated_at = ? WHERE period_key = ?`)
      .bind(estCents, releasedAt, pk)
      .run();
    if (isSlot) {
      await db
        .prepare(`UPDATE vendor_slot_state SET slots_used = MAX(0, slots_used - 1), updated_at = ? WHERE id = 1`)
        .bind(releasedAt)
        .run();
    }
    await db
      .prepare(`UPDATE vendor_spend_entries SET status = 'released', updated_at = ? WHERE id = ?`)
      .bind(releasedAt, entryId)
      .run();
    throw err;
  }
}

/**
 * Stale-reserve reaper (design NB-2 disposition) — run from scheduled(). A
 * TenantDO that dies between reserve (D1 write) and commit/release, or an
 * idempotency replay that returns a recorded result without re-entering
 * withSpendCeiling, would strand `reserved_cents` forever — silently shrinking
 * the effective ceiling and generating false capacity_pending alerts. This
 * releases every reservation older than RESERVE_REAP_TTL_MS back into the
 * ledger (and the account slot counter, for a 'mailbox' reserve). Fail-CLOSED
 * direction (a leaked reservation over-restricts, never over-spends), so this is
 * a correctness-of-accounting reconcile, not a spend-safety gate.
 *
 * Flip-then-subtract, gated on the flip: only the reaper that actually claims
 * the entry ('reserved'->'released') touches the counters, so a legit late
 * commit that flipped the SAME entry to 'committed' first makes the reaper's
 * flip a no-op and the counters are left alone (no double-subtract).
 */
export async function reapStaleReservations(
  env: Env,
  nowMs: number,
  scope: SweepScope = {},
): Promise<{ reaped: number; releasedCents: number; errors: number; deferred: number }> {
  const cutoff = nowMs - RESERVE_REAP_TTL_MS;
  // BOUNDED, and through the same primitive every other fan-out leg uses
  // (NEW-1, round 2 of docs/adversarial/wave-b1-scale-monitoring-gate-2026-08-20.md).
  // This read had no LIMIT and its loop had no deadline, at 2-3 subrequests a
  // row, running AHEAD of the cursor commit, the send pipeline, the signal
  // report and the heartbeat. Executed by the gate: 300 orphans => ~901
  // subrequests in one leg, against a budgeted tick of 592. It is B1's class,
  // one leg over, and it was pre-existing — which is precisely why the guard
  // that should have caught it (`sweep-budget.test.ts`) had to stop being a
  // tautology in the same commit.
  const stale = await env.DB.prepare(
    `SELECT id, period_key, kind, est_cents FROM vendor_spend_entries
      WHERE status = 'reserved' AND created_at < ?
      ORDER BY created_at ASC
      LIMIT ?`,
  )
    .bind(cutoff, RESERVE_REAP_BATCH)
    .all<{ id: string; period_key: string; kind: string; est_cents: number }>();

  const byId = new Map(stale.results.map((row) => [row.id, row]));
  let reaped = 0;
  let releasedCents = 0;

  // OLDEST FIRST + a self-draining population: a reaped entry leaves
  // `status = 'reserved'`, so the next tick's batch is the next 25. Nothing can
  // sit at the head forever the way a rotation can.
  //
  // The tick's DEADLINE but NOT its rotation accumulator — this leg iterates
  // ledger entries, not the tenant slice, so how many it visited says nothing
  // about how far the tenant rotation got (admin/tenant-slice.ts).
  const swept = await sweepTenants(
    [...byId.keys()],
    sweepDeadlineOf(scope.fanout),
    async (entryId) => {
      const row = byId.get(entryId) as { id: string; period_key: string; kind: string; est_cents: number };
      const flip = await env.DB.prepare(
        `UPDATE vendor_spend_entries SET status = 'released', updated_at = ? WHERE id = ? AND status = 'reserved'`,
      )
        .bind(nowMs, row.id)
        .run();
      if ((flip.meta.changes ?? 0) === 0) return; // committed/released concurrently — leave the counters untouched
      await env.DB.prepare(
        `UPDATE vendor_spend_ledger SET reserved_cents = MAX(0, reserved_cents - ?), updated_at = ? WHERE period_key = ?`,
      )
        .bind(row.est_cents, nowMs, row.period_key)
        .run();
      if (row.kind === "mailbox") {
        await env.DB.prepare(`UPDATE vendor_slot_state SET slots_used = MAX(0, slots_used - 1), updated_at = ? WHERE id = 1`)
          .bind(nowMs)
          .run();
      }
      reaped++;
      releasedCents += row.est_cents;
    },
    // One row's transient D1 failure must never abort reaping the rest of
    // the batch — the row stays 'reserved' and is retried next tick (audit
    // class-sweep sibling fix, 2026-08-06, mirrors runDunningSweep's
    // per-tenant try/catch).
    (entryId, err) => console.error(`reapStaleReservations: failed to reap entry ${entryId}`, err),
  );

  return { reaped, releasedCents, errors: swept.errors, deferred: swept.deferred };
}

/**
 * Decrements the account slot counter (D1) by `count` when real plan-slot
 * mailboxes are released (G4, teardown path — engine/lifecycle.ts). `count` is
 * the number of released mailboxes that were slot-counted at provision
 * (mailboxes.slot_counted=1) — NOT gated on the current adapter kind, because a
 * tenant being torn down is frozen and thus reads sandbox, yet its real mailboxes
 * still hold slots. A no-op when count<=0 (the default build never slot-counts
 * anything, so this never touches D1 there).
 */
export async function releaseMailboxSlots(ctx: TenantContext, count: number, nowMs: number): Promise<void> {
  if (count <= 0) return;
  await ctx.env.DB.prepare(`UPDATE vendor_slot_state SET slots_used = MAX(0, slots_used - ?), updated_at = ? WHERE id = 1`)
    .bind(count, nowMs)
    .run();
}
