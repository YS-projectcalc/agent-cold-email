/**
 * The one-shot continuity nudge (design §7.12, founder ruling Q1: exactly
 * ONE in-product message per stall episode, fired one day after onset — no
 * email, no daily cadence, no give-up-after-3).
 *
 * EPISODE IDENTITY comes from the machine that already exists —
 * `AlertState.sinceTs` (`admin/watchtower-policy.ts`), the onset of the
 * check's current unhealthy status — rather than a parallel log. The caller
 * (`admin/watchtower.ts`'s `reconcileAlerts`) passes that `sinceTs` across
 * the one cross-DO RPC this wave adds.
 *
 * THE GUARD: `continuity_nudge_episode_ts` records WHICH episode this tenant
 * was last nudged for. `sinceTs > continuity_nudge_episode_ts` is monotone —
 * a new episode always has a strictly later onset — so the comparison alone
 * gives exactly-one-per-episode with no counter, and re-running this RPC any
 * number of times for the SAME episode is a genuine no-op after the first.
 *
 * THE CRY-WOLF RULE: never nudge when every owed step waits on the operator
 * or customer billing — those are OUR/billing blockers, not the agent's, and
 * nudging the agent to act on something it cannot act on is exactly the
 * noise this mechanism must not become.
 */
import type { TenantContext } from "../tenant-context.js";
import { deriveNextSteps } from "./next-steps.js";
import { emitTenantMessage } from "./tenant-messages.js";

/** The one message kind this mechanism writes — SELF_WRITTEN_MESSAGE_KINDS
 *  in next-steps.ts already excludes it from `owedCount`/`owedReasons`
 *  (I6, §7.17.2), which is what keeps this RPC from re-arming the very
 *  check that fires it. */
export const CONTINUITY_NUDGE_KIND = "continuity_nudge";

function composeContinuityNudgeBody(owedWhys: string[]): string {
  // Professional tone (founder directive): no first names, no casual
  // register. Derived from the SAME `why` prose the response and the
  // operator digest would show — never a second, hand-written summary.
  const detail = owedWhys.length === 1 ? owedWhys[0] : owedWhys.map((w, i) => `${i + 1}. ${w}`).join(" ");
  return (
    `This account has not progressed in over a day. ${detail} ` +
    `Review infrastructure_status for the current next step and act on it, or contact_operator if it names an operator blocker.`
  );
}

/**
 * Idempotent per episode (see file header). Called from the watchtower's
 * cross-DO RPC; `episodeSinceTs` is the unhealthy check's own
 * `AlertState.sinceTs` at the time of the call.
 */
export function maybeEmitContinuityNudge(ctx: TenantContext, episodeSinceTs: number): void {
  const row = ctx.sql
    .exec<{ continuity_nudge_episode_ts: number | null }>(
      `SELECT continuity_nudge_episode_ts FROM tenant_profile WHERE id = ?`,
      ctx.tenantId,
    )
    .one();
  if (row.continuity_nudge_episode_ts !== null && row.continuity_nudge_episode_ts >= episodeSinceTs) return;

  const owed = deriveNextSteps(ctx).steps.filter((s) => s.kind === "owed");
  if (owed.length === 0) return; // nothing owed — should not happen if the caller only calls while unhealthy, but safe either way
  if (owed.every((s) => s.waitingOn === "operator" || s.waitingOn === "customer_billing")) return; // cry-wolf rule — re-evaluated every call, so a later mixed-blame tick within the SAME episode can still qualify

  emitTenantMessage(ctx, {
    kind: CONTINUITY_NUDGE_KIND,
    severity: "action_required",
    body: composeContinuityNudgeBody(owed.map((s) => s.why)),
  });
  ctx.sql.exec(`UPDATE tenant_profile SET continuity_nudge_episode_ts = ? WHERE id = ?`, episodeSinceTs, ctx.tenantId);
}
