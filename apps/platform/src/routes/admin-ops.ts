import { Hono } from "hono";
import { TerminateInput } from "@coldstart/shared";
import { getTenantIndexById } from "../admin/db.js";
import { buildOpsDigest, runDunningSweep } from "../admin/ops-sweep.js";
import { terminateTenantForAbuse } from "../admin/terminate.js";
import { CHECK_RETENTION_MS, readAllCheckRows } from "../admin/watchtower.js";
import { expectedCheckRoster } from "../admin/watchtower-roster.js";
import { readSweepFreshness } from "../admin/watchtower-infra.js";
import { CRON_SWEEP_CHECK, D1_CHECK } from "../admin/watchtower-alerts.js";
import { RealClock } from "../clock.js";
import { countWaitlistEmails, listWaitlistEmails } from "../db.js";
import type { Env } from "../env.js";
import { parseJsonBody } from "../validate.js";

// Item 3e (docs/adversarial/class-sweep-vendor-truth-2026-08-18.md, D7) — the
// checks GET /admin/ops/checks structurally cannot report (they live in
// WatchtowerDO storage, never watchtower_state — see the route's own doc
// comment below). Exposed on the wire so `unhealthyCount: 0` can never be
// read as "the whole platform is healthy" during exactly the outage this
// table is blind to.
const DO_STORE_ONLY_CHECKS = [D1_CHECK, CRON_SWEEP_CHECK];

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
  // Founder ORDER 2026-08-14 (ROADMAP.md ## Open) — the operator's own Claude
  // watch polls per-check state instead of parsing OPS_ALERT_EMAIL alerts.
  // READ-ONLY (`readAllCheckRows` is a pure SELECT on `watchtower_state`, the
  // same table `reconcileAlerts` writes) — this route never calls
  // reconcileAlerts/decideAlert, so it cannot touch alert emission, dedup
  // state or check registration. Unhealthy checks first; `?unhealthy=1`
  // returns only those.
  //
  // NOT the whole watchtower picture: `d1` and `cron_sweep` (the dead-man)
  // deliberately live in WatchtowerDO storage instead of this table
  // (`../watchtower-do.ts:39-42`, 2026-08-06 alerting audit B1/B2 — a check
  // ON D1 cannot itself be stored IN D1) and NEVER appear here. A consumer
  // MUST pair this endpoint with `GET /status` (`./status.ts`), which
  // surfaces both as a 503 `degraded`. Per-row `updatedAt` staleness is this
  // endpoint's own dead-cron tell: a dead cron stops writing entirely, so
  // this route keeps serving a frozen, healthy-looking snapshot rather than
  // ever going empty or erroring.
  //
  // ROWS ARE RETIRED NOW, not accumulated (scale audit S5): a check that has
  // been healthy for `CHECK_RETENTION_MS` is DELETEd by the sweep, so this
  // table no longer grows with the platform's lifetime count of entities that
  // ever alerted. That closes the unbounded-growth ledger item for this
  // endpoint and is why it still needs no cap — but it also means a row you saw
  // last month may be gone, so `retentionMs` rides on the wire.
  //
  // THE ROSTER IS THE DENOMINATOR (docs/adversarial/
  // class-sweep-watch-completeness-2026-08-17.md). Two of the always-on checks
  // are skip-dark — `engine` when ENGINE_BASE_URL is unset, the two InboxKit
  // ones when the vendor is unarmed — and a check that is SKIPPED writes no row
  // at all. Absence then reads as health on every downstream surface, so an env
  // var lost in a deploy silently deletes a check from the monitored set.
  // `expected` says what should be here and `missing` names what is not.
  //
  // `sweepAgeSeconds` is the DEAD-CRON TELL, published rather than inferred.
  // Consumers used to derive it from per-row `updatedAt` freshness, which was
  // only ever true because SOME row happened to be re-written every tick; the
  // sweep now skips a write for a check whose state and detail are unchanged
  // (S5), so that inference is gone. This number comes from
  // `watchtower_cursor`, which every completed sweep stamps unconditionally.
  .get("/admin/ops/checks", async (c) => {
    const onlyUnhealthy = c.req.query("unhealthy") === "1";
    const [rows, freshness] = await Promise.all([readAllCheckRows(c.env), readSweepFreshness(c.env, new RealClock().now())]);
    const unhealthyCount = rows.filter((r) => !r.healthy).length;
    const checks = (onlyUnhealthy ? rows.filter((r) => !r.healthy) : rows)
      // Stable sort (V8/ES2019+): unhealthy first, healthy after, each group
      // keeping the D1 read's own order.
      .sort((a, b) => Number(a.healthy) - Number(b.healthy));
    const present = new Set(rows.map((r) => r.name));
    const expected = expectedCheckRoster(c.env);
    return c.json({
      checks,
      unhealthyCount,
      expected,
      missing: expected.filter((name) => !present.has(name)),
      excludesDoStoreChecks: DO_STORE_ONLY_CHECKS,
      sweepAgeSeconds: freshness.ageSeconds,
      sweepStale: freshness.stale,
      retentionMs: CHECK_RETENTION_MS,
    });
  })
  // C6 — the owner's durable waitlist export (adversarial panel-03 finding #9:
  // the funnel had no owner-retrieval path). Ordered newest-first.
  //
  // `count` USED TO BE `entries.length` — a page relabelled as a total. The
  // page is capped at 1000 (db.ts's listWaitlistEmails), so past 1000 leads it
  // reported `count: 1000` as the platform's waitlist size with no truncation
  // signal, while the real total sat one function away in `countWaitlistEmails`
  // (the digest already used it). Now `count` is the total, `entries` is the
  // page, and `truncated` says whether they differ.
  .get("/admin/ops/waitlist", async (c) => {
    const [entries, count] = await Promise.all([listWaitlistEmails(c.env), countWaitlistEmails(c.env)]);
    return c.json({ count, returned: entries.length, truncated: entries.length < count, entries });
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

    const result = await terminateTenantForAbuse(c.env, tenantId, parsed.data.reason, parsed.data.evidence, new RealClock().now());

    return c.json({ tenantId, ...result });
  });
