// The EXPECTED CHECK ROSTER — which always-on checks a healthy sweep should
// have written a `watchtower_state` row for.
//
// WHY (docs/adversarial/class-sweep-watch-completeness-2026-08-17.md, platform
// IN member 7, and the watch-spec guard in §4): the `engine` check is omitted
// from the results array ENTIRELY when `ENGINE_BASE_URL` is unset. The
// skip-dark behaviour is deliberate and correct — a dark engine is not a
// failure and must never flap — but nothing anywhere asserted the expected
// roster, so an env var lost in a deploy DELETES a check from the monitored
// set: no row is written, `GET /admin/ops/checks` never lists it, and its
// absence reads as health on every downstream surface.
//
// That is the class in one line: *the read's own result is the only evidence of
// its completeness, so absence is indistinguishable from health.* The remedy is
// the same one every member gets — publish the denominator. Here the
// denominator is the roster.
//
// SEPARATE FILE, not a const in watchtower.ts, because it is read by the ROUTE
// and derived from `env` — putting it beside the probes would make the route
// import the whole D1 state machine to ask one question.

import type { Env } from "../env.js";
import {
  ALERT_DELIVERY_CHECK,
  CRON_LEGS_CHECK,
  FAILURE_SIGNALS_CHECK,
  SWEEP_COVERAGE_CHECK,
  SWEEP_SIGNALS_CHECK,
} from "./watchtower-alerts.js";
import { vendorChecksArmed } from "./watchtower-vendor.js";

/**
 * The check names a completed sweep is expected to have recorded, given this
 * environment's configuration.
 *
 * DELIBERATELY NOT `d1` / `cron_sweep`: those two live in WatchtowerDO storage
 * and never appear in `watchtower_state` at all (a check ON D1 cannot be stored
 * IN D1). The route reports them separately as `excludesDoStoreChecks`.
 *
 * Also not the per-ENTITY checks (`mailbox_orphan:`, `domain_dns_aging:`, ...):
 * those are raised only while an entity is unhealthy or clearing, so their
 * absence is the healthy state, not a gap.
 */
export function expectedCheckRoster(env: Env): string[] {
  const roster = ["do_storage", FAILURE_SIGNALS_CHECK, CRON_LEGS_CHECK, SWEEP_COVERAGE_CHECK, SWEEP_SIGNALS_CHECK, ALERT_DELIVERY_CHECK];
  // Both conditional checks are listed EXACTLY when their dependency is
  // configured, which is what makes "missing" mean something: an unset
  // ENGINE_BASE_URL removes the expectation as well as the check, and a set one
  // keeps both.
  if (env.ENGINE_BASE_URL) roster.push("engine");
  if (vendorChecksArmed(env)) roster.push("vendor_wallet", "warmup_duplicates");
  return roster;
}
