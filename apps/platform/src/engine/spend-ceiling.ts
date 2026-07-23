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

import { CapacityPendingError } from "@coldstart/shared";
import type { Env } from "../env.js";
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
const DEFAULT_SPEND_CEILING_CENTS = 15000; // $150/mo — ~2x the pilot's expected spend
const DEFAULT_COST_MAILBOX_CENTS = 690; // slot amortized ($39/10) + $3/mo warmup add-on
const DEFAULT_COST_DOMAIN_CENTS = 1500; // .com registration ceiling
const DEFAULT_COST_PREWARM_MAILBOX_CENTS = 900; // prewarm top tier (Instant-Start SKU)
const DEFAULT_INBOXKIT_PLAN_SLOTS = 10; // the purchased InboxKit Professional plan

// A 'reserved' entry older than this is presumed orphaned by a crash between
// reserve and commit/release (design NB-2) and is reclaimed by the scheduled()
// reaper. Sized well above the longest legitimate provision run (single-digit
// minutes per the idempotency 'pending' TTL, engine/idempotency.ts) so a live
// in-flight reservation is never reaped, yet far under a day so a genuinely
// leaked reservation frees promptly.
const RESERVE_REAP_TTL_MS = 15 * 60 * 1000;

function parsePositiveInt(raw: string | null | undefined, fallback: number): number {
  if (raw == null) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** The per-calendar-month spend ceiling (founder Q1 ruling: per-calendar-month, base sub included, default $150). */
export function spendCeilingCents(env: Env): number {
  return parsePositiveInt(env.SPEND_CEILING_CENTS, DEFAULT_SPEND_CEILING_CENTS);
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
      // the enumerated sites) without double-reserving. A future standalone
      // warmup SKU flips this to a real founder-tunable cost here.
      return 0;
  }
}

/** period_key = 'YYYY-MM' (per-calendar-month, founder Q1). Only real/paid tenants
 *  reach the ledger (sandbox no-op below), and paid tenants run on a real-time
 *  clock (multiplier 1 — advanceClock is demo/free-only), so this is real wall-clock. */
export function periodKey(nowMs: number): string {
  const d = new Date(nowMs);
  const month = `${d.getUTCMonth() + 1}`.padStart(2, "0");
  return `${d.getUTCFullYear()}-${month}`;
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

async function alertCapacityPending(
  ctx: TenantContext,
  reason: "spend_ceiling" | "slot_capacity",
  detail: { kind: SpendKind; estCents: number; ceilingCents: number; planSlots: number; slotsUsed: number },
  mailer: OpsMailer,
): Promise<void> {
  if (!ctx.env.OPS_ALERT_EMAIL) return;
  const action =
    reason === "slot_capacity"
      ? `slot capacity reached (${detail.slotsUsed}/${detail.planSlots}) — upgrade the InboxKit plan and raise INBOXKIT_PLAN_SLOTS`
      : `spend ceiling reached (ceiling ${detail.ceilingCents}¢/mo) — raise SPEND_CEILING_CENTS or upgrade InboxKit`;
  const text =
    `Tenant ${ctx.tenantId} hit a provisioning capacity gate on a '${detail.kind}' spend (est ${detail.estCents}¢).\n\n` +
    `${action}.\n\nThe tenant is held in 'capacity_pending' (no charge, no provisioning) and a later provision retries once you raise the limit.`;
  try {
    await mailer.send({
      to: ctx.env.OPS_ALERT_EMAIL,
      subject: `[coldrig] provisioning capacity gate — ${reason} (tenant ${ctx.tenantId})`,
      text,
      html: `<p>${escapeHtml(text).replace(/\n/g, "<br>")}</p>`,
    });
  } catch (mailErr) {
    console.error(`capacity-pending alert: send to ${ctx.env.OPS_ALERT_EMAIL} failed (dark or transient)`, mailErr);
  }
}

async function rejectCapacity(
  ctx: TenantContext,
  reason: "spend_ceiling" | "slot_capacity",
  detail: { kind: SpendKind; estCents: number; ceilingCents: number; planSlots: number; slotsUsed: number },
  mailer: OpsMailer,
): Promise<never> {
  const transitioned = setCapacityPendingMarker(ctx);
  if (transitioned) await alertCapacityPending(ctx, reason, detail, mailer);
  throw new CapacityPendingError(
    reason,
    reason === "slot_capacity"
      ? `provisioning held: InboxKit plan-slot capacity reached (${detail.slotsUsed}/${detail.planSlots})`
      : `provisioning held: monthly vendor-spend ceiling reached (${detail.ceilingCents}¢)`,
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
  const now = ctx.clock.now();
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
    const committedAt = ctx.clock.now();
    await db
      .prepare(
        `UPDATE vendor_spend_ledger
            SET reserved_cents = MAX(0, reserved_cents - ?), committed_cents = committed_cents + ?, updated_at = ?
          WHERE period_key = ?`,
      )
      .bind(estCents, estCents, committedAt, pk)
      .run();
    await db
      .prepare(`UPDATE vendor_spend_entries SET status = 'committed', actual_cents = ?, updated_at = ? WHERE id = ?`)
      .bind(estCents, committedAt, entryId)
      .run();
    clearCapacityPendingMarker(ctx);
    return result;
  } catch (err) {
    // Vendor call failed — RELEASE the reservation (subtract est + any slot).
    // Entry -> released. Never leaks a reservation on a failed vendor call.
    const releasedAt = ctx.clock.now();
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
export async function reapStaleReservations(env: Env, nowMs: number): Promise<{ reaped: number; releasedCents: number }> {
  const cutoff = nowMs - RESERVE_REAP_TTL_MS;
  const stale = await env.DB.prepare(
    `SELECT id, period_key, kind, est_cents FROM vendor_spend_entries WHERE status = 'reserved' AND created_at < ?`,
  )
    .bind(cutoff)
    .all<{ id: string; period_key: string; kind: string; est_cents: number }>();

  let reaped = 0;
  let releasedCents = 0;
  for (const row of stale.results) {
    const flip = await env.DB.prepare(
      `UPDATE vendor_spend_entries SET status = 'released', updated_at = ? WHERE id = ? AND status = 'reserved'`,
    )
      .bind(nowMs, row.id)
      .run();
    if ((flip.meta.changes ?? 0) === 0) continue; // committed/released concurrently — leave the counters untouched
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
  }
  return { reaped, releasedCents };
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
