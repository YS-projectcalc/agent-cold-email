import { Hono } from "hono";
import { TerminateInput } from "@coldstart/shared";
import { getTenantIndexById, insertEnforcementActionIfNew } from "../admin/db.js";
import { buildOpsDigest, runDunningSweep } from "../admin/ops-sweep.js";
import { RealClock } from "../clock.js";
import { listWaitlistEmails, setTenantIndexStatus } from "../db.js";
import type { Env } from "../env.js";
import { newId } from "../schema.js";
import { parseJsonBody } from "../validate.js";

const DEFAULT_DIGEST_WINDOW_HOURS = 24;

function parseWindowHours(raw: string | undefined): number {
  const n = raw ? Number(raw) : DEFAULT_DIGEST_WINDOW_HOURS;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_DIGEST_WINDOW_HOURS;
}

// D2/D6 (brief) — business-ops routines. Both handlers are thin: the actual
// cross-tenant iteration/aggregation lives in ../admin/ops-sweep.ts, shared
// with the cron `scheduled()` handler (../scheduled.ts) so cron and the
// on-demand endpoint can never drift (CLAUDE.md rule c). Acceptable at
// test-mode scale (admin/README.md); a D1 read-model fed by Queues is the
// scale path once tenant count makes a full per-request RPC fan-out slow.
export const adminOpsRoute = new Hono<{ Bindings: Env }>()
  // D2 — dunning / failed-payment sweep. Scans every tenant currently
  // 'past_due' and records at most one dunning_events row per (tenant,
  // failure-count-as-cycle) — a second sweep before the next failure is a
  // no-op (idempotent per cycle). "suspend" flips the tenant's own status
  // now (a real local mutation); the actual retry/dunning EMAILS are an
  // ACTIVATION step (no outbound email channel is wired in this build).
  .post("/admin/ops/dunning-sweep", async (c) => {
    const result = await runDunningSweep(c.env, new RealClock().now());
    return c.json(result);
  })
  // D6 — the owner's single cross-tenant business-health rollup: the daily
  // digest that replaces the owner doing ops manually (SPEC.md §0.10).
  .get("/admin/ops/digest", async (c) => {
    const windowHours = parseWindowHours(c.req.query("hours"));
    const digest = await buildOpsDigest(c.env, new RealClock().now(), windowHours);
    return c.json(digest);
  })
  // C6 — the owner's durable waitlist export (adversarial panel-03 finding #9:
  // the funnel had no owner-retrieval path). Ordered newest-first.
  .get("/admin/ops/waitlist", async (c) => {
    const entries = await listWaitlistEmails(c.env);
    return c.json({ count: entries.length, entries });
  })
  // D5 — abuse offboarding: the terminal rung of the AUP consequence ladder
  // (site/aup.html §7). Immediately suspends + reclaims the tenant's infra (the
  // SAME teardown path as voluntary /cancel), honors suppression obligations
  // (teardownTenant never deletes opt-outs), and records the reason + evidence
  // to the D1 enforcement_actions audit log — idempotent per (tenant, action),
  // so a retry after the DO teardown committed lands exactly one row. Real
  // vendor RELEASE is the sandbox port now; the live registrar/mailbox release
  // call is an activation step (ACTIVATION.md).
  .post("/admin/tenants/:id/terminate", async (c) => {
    const tenantId = c.req.param("id");
    const tenant = await getTenantIndexById(c.env, tenantId);
    if (!tenant) return c.json({ error: `tenant ${tenantId} not found` }, 404);

    const parsed = await parseJsonBody(c, TerminateInput);
    if (!parsed.ok) return parsed.response;

    const stub = c.env.TENANT.get(c.env.TENANT.idFromName(tenantId));
    const result = await stub.terminate();

    // Lock the control-plane token so the terminated tenant cannot re-provision
    // or re-launch and undo the reclaim (see setTenantIndexStatus). Idempotent.
    await setTenantIndexStatus(c.env, tenantId, "suspended");

    const logged = await insertEnforcementActionIfNew(c.env, {
      id: newId("enf"),
      tenantId,
      action: "TERMINATE",
      reason: parsed.data.reason,
      evidence: parsed.data.evidence,
      ts: new RealClock().now(),
    });

    return c.json({ tenantId, terminated: true, enforcementLogged: logged, ...result });
  });
