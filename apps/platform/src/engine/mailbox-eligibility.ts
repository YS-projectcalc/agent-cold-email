// Wave-2 §1a — WHICH MAILBOXES MAY BE SENT FROM. The ONE definition, shared by
// the tick's capacity picker (engine/tick.ts) and the send-starved watchtower
// alert (engine/ops-summary.ts).
//
// WHY ONE COPY (adversary round-2, R4). Two hand-maintained copies of an
// eligibility rule drift, and the drift mode here is the worst one available:
// the alert computes "this tenant has eligible mailboxes" while the picker
// finds none, producing a silent zero-send with the alarm asleep — precisely
// the state the alert exists to make visible. So the predicate is built here
// once and both call sites bind the same two parameters, in the same order.
//
// WHY THE PAID CLAUSES ARE PLAN-GATED. A demo/free tenant runs the SANDBOX
// bundle: its mailboxes are all provider='sandbox' and would every one of them
// be excluded, breaking the demo. Demo/free therefore get the historical
// predicate byte-identically; the four provenance clauses apply only to a paid
// tenant, which is the only kind that can reach a real engine.

import { isPaidPlan, type TenantPlan } from "@coldstart/shared";
import type { TenantContext } from "../tenant-context.js";

/**
 * The historical eligibility rule, unchanged: not paused by the deliverability
 * control loop, and past its domain's DMARC observation window (SPEC.md §20.2 —
 * `first_send_eligible_at` is NULL for every provisioned/non-gated domain).
 * Binds (tenantId, nowMs).
 */
const BASE_ELIGIBILITY_SQL = `
  FROM mailboxes m JOIN domains d ON d.id = m.domain_id
  WHERE m.tenant_id = ? AND m.deliv_status != 'paused'
    AND (d.first_send_eligible_at IS NULL OR d.first_send_eligible_at <= ?)`;

/**
 * The wave-2 provenance clauses, PAID TENANTS ONLY. Each closes a distinct way
 * a mailbox can be picked that the engine cannot actually send from:
 *
 *  - `released_at IS NULL` — explicit rather than incidental via 'paused'.
 *  - `provider NOT IN ('sandbox','')` — a demo-era sandbox row exists at no
 *    vendor at all, and (never having sent) is permanently the least-loaded
 *    candidate the picker sees, so it would win EVERY assignment. `''` is the
 *    not-yet-classified state a rolled-back clock migration leaves behind; it is
 *    excluded on purpose (see schema.ts's provider comment — do not "fix" it).
 *  - `source != 'byo_connected'` — TEMPORARY. This build wires no engine
 *    credentials for BYO mailboxes (engine/byo-mailbox-composition.ts says so
 *    outright); lift this clause when the BYO->engine push lane ships.
 *  - no 'pending' credential push — a mailbox we KNOW is not yet credentialed.
 *    The polarity is NOT-pending rather than requires-'pushed' deliberately: a
 *    mailbox with no row at all is the operator static-config emergency path
 *    (the engine resolves credentials from its config OR the pushed store), which
 *    the Worker cannot observe and must not block. One slow-minting mailbox
 *    costs exactly that mailbox's capacity; the other N-1 keep sending.
 *
 * `p.tenant_id = m.tenant_id` is redundant inside a per-tenant DO and is there
 * anyway (CLAUDE.md rule h; adversary round-2 R3) — the house applies tenant
 * scoping even where a DO makes it structurally impossible to cross.
 */
const PAID_PROVENANCE_SQL = `
    AND m.released_at IS NULL
    AND m.provider NOT IN ('sandbox', '')
    AND m.source != 'byo_connected'
    AND NOT EXISTS (
      SELECT 1 FROM mailbox_cred_pushes p
       WHERE p.email = m.email AND p.tenant_id = m.tenant_id AND p.status = 'pending'
    )`;

/**
 * Builds the send-eligibility query for this tenant's plan. `selectList` is a
 * code literal at every call site (never tenant input — CLAUDE.md rule h is
 * about the bound parameters, which are always exactly `tenantId, nowMs`).
 */
export function sendEligibleMailboxSql(plan: TenantPlan, selectList: string): string {
  return `SELECT ${selectList}${BASE_ELIGIBILITY_SQL}${isPaidPlan(plan) ? PAID_PROVENANCE_SQL : ""}`;
}

/**
 * How many mailboxes this tenant could send from right now — the send-starved
 * watchtower alert's half of the shared predicate (§1c). Runs the SAME query
 * shape the picker runs, so "the alert says you have capacity" and "the picker
 * found capacity" cannot disagree.
 */
export function countSendEligibleMailboxes(ctx: TenantContext, nowMs: number): number {
  return ctx.sql
    .exec<{ n: number }>(sendEligibleMailboxSql(ctx.plan, `COUNT(*) as n`), ctx.tenantId, nowMs)
    .one().n;
}
