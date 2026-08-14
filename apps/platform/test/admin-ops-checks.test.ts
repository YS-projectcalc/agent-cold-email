import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { reconcileAlerts } from "../src/admin/watchtower.js";
import type { CheckResult } from "../src/admin/watchtower-alerts.js";
import { SandboxOpsMailer } from "../src/ops-mail/sandbox-ops-mailer.js";
import { adminApi, api } from "./helpers.js";

// Founder ORDER 2026-08-14 (ROADMAP.md ## Open "GET /admin/ops/checks") — the
// operator's own Claude watch polls per-check watchtower state instead of
// parsing OPS_ALERT_EMAIL alert emails. This drives the SAME state machine
// entry point (`reconcileAlerts`) the cron sweep uses (watchtower.test.ts's
// own pattern) to seed rows in `watchtower_state`, then reads them back
// through the new route.

interface CheckRow {
  name: string;
  healthy: boolean;
  detail: string;
  sinceTs: number;
  lastAlertTs: number | null;
  updatedAt: number;
}
interface ChecksResponse {
  checks: CheckRow[];
  unhealthyCount: number;
}

const T0 = 1_800_000_000_000;

function unhealthy(name: string, detail = "down"): CheckResult {
  return { name, healthy: false, detail };
}
function healthy(name: string, detail = "ok"): CheckResult {
  return { name, healthy: true, detail };
}

// watchtower_state persists in D1 and is not rolled back between tests in
// this pool (watchtower.test.ts's own beforeEach) — clear it so each test
// drives its own known-empty baseline.
beforeEach(async () => {
  await env.DB.prepare("DELETE FROM watchtower_state").run();
});

describe("GET /admin/ops/checks — admin read surface for watchtower per-check state", () => {
  it("401s with no admin auth", async () => {
    const res = await api("/admin/ops/checks");
    expect(res.status).toBe(401);
  });

  it("returns unhealthy checks first, correct counts, and details/timestamps from the store", async () => {
    const mailer = new SandboxOpsMailer();
    await reconcileAlerts(env, mailer, [healthy("d1", "D1 SELECT 1 ok")], T0);
    await reconcileAlerts(env, mailer, [unhealthy("engine", "engine /health unreachable")], T0 + 1_000);
    await reconcileAlerts(
      env,
      mailer,
      [unhealthy("domain_dns_aging:example.com", "Domain example.com has had un-ready mail DNS for 50h.")],
      T0 + 2_000,
    );

    const res = await adminApi<ChecksResponse>("/admin/ops/checks");
    expect(res.status).toBe(200);
    expect(res.body.unhealthyCount).toBe(2);
    expect(res.body.checks).toHaveLength(3);

    // Unhealthy checks first.
    expect(res.body.checks[0]!.healthy).toBe(false);
    expect(res.body.checks[1]!.healthy).toBe(false);
    expect(res.body.checks[2]!.healthy).toBe(true);
    expect(new Set(res.body.checks.slice(0, 2).map((c) => c.name))).toEqual(
      new Set(["engine", "domain_dns_aging:example.com"]),
    );

    const domainCheck = res.body.checks.find((c) => c.name === "domain_dns_aging:example.com")!;
    expect(domainCheck.detail).toBe("Domain example.com has had un-ready mail DNS for 50h.");
    expect(domainCheck.sinceTs).toBe(T0 + 2_000);
    expect(domainCheck.lastAlertTs).toBe(T0 + 2_000);

    const d1Check = res.body.checks.find((c) => c.name === "d1")!;
    expect(d1Check.healthy).toBe(true);
    expect(d1Check.detail).toBe("D1 SELECT 1 ok");
    expect(d1Check.lastAlertTs).toBeNull();
  });

  it("?unhealthy=1 returns only unhealthy checks, and unhealthyCount still reflects the full store", async () => {
    const mailer = new SandboxOpsMailer();
    await reconcileAlerts(env, mailer, [healthy("d1")], T0);
    await reconcileAlerts(env, mailer, [unhealthy("engine")], T0);
    await reconcileAlerts(env, mailer, [unhealthy("do_storage")], T0);

    const res = await adminApi<ChecksResponse>("/admin/ops/checks?unhealthy=1");
    expect(res.status).toBe(200);
    expect(res.body.unhealthyCount).toBe(2);
    expect(res.body.checks).toHaveLength(2);
    expect(res.body.checks.every((c) => c.healthy === false)).toBe(true);
    expect(new Set(res.body.checks.map((c) => c.name))).toEqual(new Set(["engine", "do_storage"]));
  });

  it("a check that clears (recovers) no longer appears when filtering ?unhealthy=1, and unhealthyCount drops", async () => {
    const mailer = new SandboxOpsMailer();
    await reconcileAlerts(env, mailer, [unhealthy("mailbox_provisioning:a@example.com")], T0);

    const before = await adminApi<ChecksResponse>("/admin/ops/checks?unhealthy=1");
    expect(before.body.unhealthyCount).toBe(1);
    expect(before.body.checks.map((c) => c.name)).toEqual(["mailbox_provisioning:a@example.com"]);

    // The mailbox resolves -> the same state machine reports it healthy again.
    await reconcileAlerts(
      env,
      mailer,
      [healthy("mailbox_provisioning:a@example.com", "mailbox now provisioned")],
      T0 + 60_000,
    );

    const after = await adminApi<ChecksResponse>("/admin/ops/checks?unhealthy=1");
    expect(after.body.unhealthyCount).toBe(0);
    expect(after.body.checks).toHaveLength(0);

    const full = await adminApi<ChecksResponse>("/admin/ops/checks");
    const cleared = full.body.checks.find((c) => c.name === "mailbox_provisioning:a@example.com")!;
    expect(cleared.healthy).toBe(true);
    expect(cleared.detail).toBe("mailbox now provisioned");
  });

  it("performs NO writes — watchtower_state is byte-identical before and after a GET", async () => {
    const mailer = new SandboxOpsMailer();
    await reconcileAlerts(env, mailer, [unhealthy("d1"), healthy("engine")], T0);

    const before = await env.DB.prepare(
      `SELECT check_name, status, since_ts, last_alert_ts, last_detail, updated_at FROM watchtower_state ORDER BY check_name`,
    ).all();

    const res = await adminApi<ChecksResponse>("/admin/ops/checks");
    expect(res.status).toBe(200);
    const filteredRes = await adminApi<ChecksResponse>("/admin/ops/checks?unhealthy=1");
    expect(filteredRes.status).toBe(200);

    const after = await env.DB.prepare(
      `SELECT check_name, status, since_ts, last_alert_ts, last_detail, updated_at FROM watchtower_state ORDER BY check_name`,
    ).all();

    expect(after.results).toEqual(before.results);
  });
});
