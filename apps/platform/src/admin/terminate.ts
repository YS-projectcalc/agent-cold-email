// D5 abuse offboarding — the shared "suspend + reclaim infra + lock the
// control-plane token + log an enforcement_actions audit row" sequence.
// Extracted from routes/admin-ops.ts's POST /admin/tenants/:id/terminate
// handler (CLAUDE.md rule c — no duplicated logic) so G1b's screening-reject
// path (routes/admin-screening.ts, design line 59: "reject can chain into the
// existing terminate path") reuses the EXACT same mechanics instead of a
// second, drifting implementation.
import { setTenantIndexStatus } from "../db.js";
import type { Env } from "../env.js";
import { newId } from "../schema.js";
import { insertEnforcementActionIfNew } from "./db.js";

export interface TerminateForAbuseResult {
  terminated: true;
  enforcementLogged: boolean;
  suspended: boolean;
  alreadyTornDown: boolean;
  teardown: { domainsReleased: number; mailboxesReleased: number; campaignsStopped: number };
}

export async function terminateTenantForAbuse(
  env: Env,
  tenantId: string,
  reason: string,
  evidence: Record<string, unknown>,
  nowMs: number,
): Promise<TerminateForAbuseResult> {
  const stub = env.TENANT.get(env.TENANT.idFromName(tenantId));
  const result = await stub.terminate();

  // Lock the control-plane token so the terminated tenant cannot re-provision
  // or re-launch and undo the reclaim (mirrors routes/admin-ops.ts's terminate
  // route exactly).
  await setTenantIndexStatus(env, tenantId, "suspended");

  const logged = await insertEnforcementActionIfNew(env, {
    id: newId("enf"),
    tenantId,
    action: "TERMINATE",
    reason,
    evidence,
    ts: nowMs,
  });

  return { terminated: true, enforcementLogged: logged, ...result };
}
