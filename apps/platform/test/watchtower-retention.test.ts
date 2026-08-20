import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import {
  CHECK_RETENTION_MS,
  evaluateHealthChecks,
  readReportedCheckNames,
  reconcileAlerts,
  retireHealthyCheckRows,
} from "../src/admin/watchtower.js";
import { expectedCheckRoster } from "../src/admin/watchtower-roster.js";
import { adminApi, mintTenant } from "./helpers.js";
import { SandboxOpsMailer } from "../src/ops-mail/sandbox-ops-mailer.js";
import type { CheckResult } from "../src/admin/watchtower-alerts.js";

// SCALE AUDIT S5 — "every entity ever alerted re-emits a health result and a D1
// write on every tick forever, and survives customer churn."
//
// MEASURED by the audit: one real mailbox + one real provisioned domain, their
// two `watchtower_state` rows seeded as if each had alerted once, then five
// consecutive sweeps:
//
//   AMPLIFICATION {"seededEntityResultsPerTick":[2,2,2,2,2],"watchtowerWritesOver5Ticks":20}
//
// and after releasing both (i.e. the customer churned):
//
//   AFTER_RELEASE {"stillEmitted":["domain_dns_aging:amp-example.com","cred_push_aging:sales@amp-example.com"]}
//
// Two independent halves, and BOTH are needed. The per-tick D1 write is what
// makes a lifetime-cumulative table cost real money on every tick; the survival
// across release is what makes the table lifetime-cumulative in the first
// place, since `apps/platform/src` contains no `DELETE FROM watchtower_state`
// at all (the audit proved that by execution, not by grep).

const T0 = 1_800_000_000_000;

async function rowOf(name: string) {
  return env.DB.prepare(`SELECT status, since_ts, updated_at, last_detail FROM watchtower_state WHERE check_name = ?`)
    .bind(name)
    .first<{ status: string; since_ts: number; updated_at: number; last_detail: string }>();
}

const healthy = (name: string, detail: string): CheckResult => ({ name, healthy: true, basis: "reobserved", detail });

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM watchtower_state").run();
});

describe("S5a — a tick that changes nothing writes nothing", () => {
  it("does not re-write a steady healthy row, tick after tick", async () => {
    const mailer = new SandboxOpsMailer();
    const result = healthy("domain_dns_aging:steady.test", "Domain steady.test (tenant ten_x) is status=released, dns=pending.");

    await reconcileAlerts(env, mailer, [result], T0);
    const first = await rowOf(result.name);
    expect(first?.updated_at).toBe(T0);

    // Four more ticks with the IDENTICAL observation — the shape the audit
    // measured at 4 D1 writes per entity per 5 ticks.
    for (let i = 1; i <= 4; i++) await reconcileAlerts(env, mailer, [result], T0 + i * 300_000);

    const after = await rowOf(result.name);
    expect(after?.updated_at).toBe(T0);
  });

  it("still writes the moment ANYTHING about the observation changes", async () => {
    const mailer = new SandboxOpsMailer();
    const name = "domain_dns_aging:changing.test";
    await reconcileAlerts(env, mailer, [healthy(name, "dns=pending")], T0);
    await reconcileAlerts(env, mailer, [healthy(name, "dns=ready")], T0 + 300_000);

    const after = await rowOf(name);
    expect(after?.updated_at).toBe(T0 + 300_000);
    expect(after?.last_detail).toBe("dns=ready");
  });

  it("still writes a state TRANSITION on an unchanged detail string", async () => {
    const mailer = new SandboxOpsMailer();
    const name = "do_storage";
    const detail = "DO storage probe ok";
    await reconcileAlerts(env, mailer, [healthy(name, detail)], T0);
    // Same name, same detail, opposite health: the row must move.
    await reconcileAlerts(env, mailer, [{ name, healthy: false, detail }], T0 + 300_000);

    const after = await rowOf(name);
    expect(after?.status).toBe("unhealthy");
    expect(after?.updated_at).toBe(T0 + 300_000);
  });
});

describe("S5b — a check that has been healthy long enough is retired", () => {
  async function seedRow(name: string, status: "healthy" | "unhealthy", sinceTs: number) {
    await env.DB.prepare(
      `INSERT INTO watchtower_state (check_name, status, since_ts, last_alert_ts, last_detail, updated_at, unhealthy_obs, alert_count)
       VALUES (?, ?, ?, NULL, 'seeded', ?, 0, 0)`,
    )
      .bind(name, status, sinceTs, sinceTs)
      .run();
  }

  it("deletes long-healthy rows and leaves everything else alone", async () => {
    const old = T0 - CHECK_RETENTION_MS - 1;
    await seedRow("cred_push_aging:churned@example.com", "healthy", old);
    await seedRow("domain_dns_aging:churned.example.com", "healthy", old);
    // The two that must survive: a LIVE incident of the same age, and a
    // recently-cleared check an operator may still be reading.
    await seedRow("mailbox_orphan:live@example.com", "unhealthy", old);
    await seedRow("do_storage", "healthy", T0 - 60_000);

    const { retired } = await retireHealthyCheckRows(env, T0);

    expect(retired).toBe(2);
    expect(await rowOf("cred_push_aging:churned@example.com")).toBeNull();
    expect(await rowOf("mailbox_orphan:live@example.com")).not.toBeNull();
    expect(await rowOf("do_storage")).not.toBeNull();
  });

  it("removes the retired name from `reported` — which is what stops the immortal re-emission", async () => {
    // `reported` is the set the per-entity clear loops iterate. A churned
    // customer's domain stays in `provisionedDomains` (no status filter, by
    // design — that is what lets a stale alert clear at all), so as long as its
    // name is in `reported` the sweep emits a result for it on EVERY tick, for
    // the life of the platform.
    const name = "domain_dns_aging:churned.example.com";
    await seedRow(name, "healthy", T0 - CHECK_RETENTION_MS - 1);
    expect(await readReportedCheckNames(env)).toContain(name);

    await retireHealthyCheckRows(env, T0);

    expect(await readReportedCheckNames(env)).not.toContain(name);
  });

  it("a retired check alerts normally when the condition comes back", async () => {
    // Retirement must be alert-NEUTRAL: `decideAlert` treats a missing row and a
    // healthy row identically (a fresh episode), so the debounce still applies
    // and the founder still hears about it on the second observation.
    const mailer = new SandboxOpsMailer();
    const name = "cred_push_aging:back@example.com";
    await seedRow(name, "healthy", T0 - CHECK_RETENTION_MS - 1);
    await retireHealthyCheckRows(env, T0);

    await reconcileAlerts(env, mailer, [{ name, healthy: false, detail: "waiting again" }], T0);
    expect(mailer.sent).toEqual([]);
    await reconcileAlerts(env, mailer, [{ name, healthy: false, detail: "waiting again" }], T0 + 300_000);
    expect(mailer.sent.map((m) => m.subject)).toEqual(["[coldrig] Mailbox credentials back@example.com: UNHEALTHY"]);
  });
});

// N3 (docs/adversarial/wave-b1-scale-monitoring-gate-2026-08-20.md) — S5's
// retirement and S8's roster denominator composed into a lie, PROVED by the
// gate with two probes:
//
//   present BEFORE retire=6  retired=6  present AFTER=0
//   MISSING after one retireHealthyCheckRows: ["do_storage","failure_signals",
//     "cron_legs","sweep_coverage","sweep_signals","alert_delivery"]
//
// Two independent causes, and both needed fixing. Retirement DELETED rows whose
// absence the roster reports as a defect; and above one slice `scanComplete` is
// permanently false, so a healthy platform emitted no `failure_signals`
// observation at all and nothing ever created the row in the first place.
describe("N3 — retirement and the roster denominator cannot manufacture a false `missing`", () => {
  async function seedHealthyLongAgo(name: string) {
    await env.DB.prepare(
      `INSERT INTO watchtower_state (check_name, status, since_ts, last_alert_ts, last_detail, updated_at, unhealthy_obs, alert_count)
       VALUES (?, 'healthy', ?, NULL, 'ok', ?, 0, 0)`,
    )
      .bind(name, T0 - CHECK_RETENTION_MS - 1, T0)
      .run();
  }

  it("never retires a roster member, and still retires the per-entity families S5 exists for", async () => {
    for (const name of expectedCheckRoster(env)) await seedHealthyLongAgo(name);
    await seedHealthyLongAgo("domain_dns_aging:churned.example.com");
    await seedHealthyLongAgo("cred_push_aging:churned@example.com");

    const { retired } = await retireHealthyCheckRows(env, T0);

    // REDS on the old code: retired === roster.length + 2, and every roster
    // member's row was gone.
    expect(retired).toBe(2);
    for (const name of expectedCheckRoster(env)) expect(await rowOf(name)).not.toBeNull();
    expect(await rowOf("domain_dns_aging:churned.example.com")).toBeNull();
  });

  it("GET /admin/ops/checks reports nothing missing after a retirement pass", async () => {
    for (const name of expectedCheckRoster(env)) await seedHealthyLongAgo(name);
    await retireHealthyCheckRows(env, T0);

    const { body } = await adminApi<{ missing: string[] }>("/admin/ops/checks");
    // REDS on the old code with the gate's exact list.
    expect(body.missing).toEqual([]);
  });

  it("a roster member that leaves the roster becomes retirable again", async () => {
    // The self-correcting half: `engine` is only expected while ENGINE_BASE_URL
    // is set, so a genuinely departed check does not get protected forever.
    await seedHealthyLongAgo("engine");
    const darkEnv = { ...env, ENGINE_BASE_URL: undefined } as unknown as typeof env;
    expect(expectedCheckRoster(darkEnv)).not.toContain("engine");

    await retireHealthyCheckRows(darkEnv, T0);
    expect(await rowOf("engine")).toBeNull();
  });
});

describe("N3 — a PARTIAL scan still gives failure_signals a row, without ever claiming a recovery", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM tenants_index").run();
  });

  it("writes the row on a partial scan of a clean platform, scoped honestly", async () => {
    const a = await mintTenant("Partial Scan A", "managed");
    await mintTenant("Partial Scan B", "managed");

    // One of two tenants — `scanComplete` false, window clean.
    await reconcileAlerts(env, new SandboxOpsMailer(), await evaluateHealthChecks(env, T0, { tenantIds: [a.tenantId] }), T0);

    const row = await rowOf("failure_signals");
    // REDS on the old code: the hold suppressed the observation entirely, so no
    // producer ever created this row above one slice.
    expect(row?.status).toBe("healthy");
    expect(row?.last_detail).toContain("1 of 2 tenant(s) scanned this cycle");
  });

  it("still HOLDS a partial clean window while an episode is open — no false RECOVERED", async () => {
    const a = await mintTenant("Hold Scan A", "managed");
    await mintTenant("Hold Scan B", "managed");
    const mailer = new SandboxOpsMailer();

    // Announce an episode the normal way (two consecutive unhealthy observations).
    for (const at of [T0, T0 + 300_000]) {
      await reconcileAlerts(env, mailer, [{ name: "failure_signals", healthy: false, detail: "3 terminal-failed send(s)" }], at);
    }
    expect(mailer.sent.map((m) => m.subject)).toEqual(["[coldrig] Failure signals: UNHEALTHY"]);

    // A partial scan now sees a clean window — which proves nothing about the
    // tenants it did not read.
    await reconcileAlerts(
      env,
      mailer,
      await evaluateHealthChecks(env, T0 + 600_000, { tenantIds: [a.tenantId] }),
      T0 + 600_000,
    );

    expect(mailer.sent.map((m) => m.subject)).toEqual(["[coldrig] Failure signals: UNHEALTHY"]);
    expect((await rowOf("failure_signals"))?.status).toBe("unhealthy");
  });
});
