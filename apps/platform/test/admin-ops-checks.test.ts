import type { RecoveryBasis } from "@coldstart/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { reconcileAlerts } from "../src/admin/watchtower.js";
import { CRON_SWEEP_CHECK, D1_CHECK, type CheckResult } from "../src/admin/watchtower-alerts.js";
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
  count: number;
  total: number;
  truncated: boolean;
  unhealthyCount: number;
  expected: string[];
  missing: string[];
  excludesDoStoreChecks: string[];
}

const T0 = 1_800_000_000_000;

function unhealthy(name: string, detail = "down"): CheckResult {
  return { name, healthy: false, detail };
}
function healthy(name: string, detail = "ok", basis: RecoveryBasis = "reobserved"): CheckResult {
  return { name, healthy: true, detail, basis };
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
    // A second consecutive observation is what CONFIRMS the check and stamps
    // last_alert_ts (founder ruling 2026-08-16); the row itself was already
    // unhealthy from the first one, which is what this endpoint serves.
    await reconcileAlerts(
      env,
      mailer,
      [unhealthy("domain_dns_aging:example.com", "Domain example.com has had un-ready mail DNS for 50h.")],
      T0 + 3_000,
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
    expect(domainCheck.lastAlertTs).toBe(T0 + 3_000);

    // `engine` was observed unhealthy ONCE and is still inside the debounce:
    // the operator's watch sees it immediately (that is the point of polling
    // this endpoint rather than the inbox) with no alert stamped yet.
    const engineCheck = res.body.checks.find((c) => c.name === "engine")!;
    expect(engineCheck.healthy).toBe(false);
    expect(engineCheck.lastAlertTs).toBeNull();

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

  // Item 3e (docs/adversarial/class-sweep-vendor-truth-2026-08-18.md, D7) —
  // `d1`/`cron_sweep` live in WatchtowerDO storage, never this table, so a D1
  // outage (the ONE condition this endpoint's own name suggests it would
  // catch) can leave `unhealthyCount: 0` while the platform is actively down.
  // The response must say so explicitly, not just in a code comment nobody
  // consuming the JSON ever reads.
  // S8 (docs/adversarial/scale-readiness-audit-2026-08-17.md) — the last
  // unbounded cross-tenant operator read. `readAllCheckRows` had no LIMIT, no
  // cursor and no truncation signal, over a table whose S5 retirement bounds it
  // only by TIME: a platform can hold far more than a page of checks inside one
  // retention window, and an incident is exactly when it does.
  describe("S8 — bounded, with the totals it was bounded from", () => {
    /** `n` unhealthy rows, seeded straight to D1 (the state machine's own
     * debounce would need two passes each, and this is about the READ). */
    async function seedUnhealthy(n: number, prefix: string): Promise<void> {
      const statements = [];
      // 33 rows x 3 bound params = 99, under D1's 100-per-statement ceiling
      // (the same ceiling admin/db.ts's markSupportTicketsEmailed chunks for).
      for (let i = 0; i < n; i += 33) {
        const chunk = Array.from({ length: Math.min(33, n - i) }, (_, j) => i + j);
        statements.push(
          env.DB.prepare(
            `INSERT INTO watchtower_state (check_name, status, since_ts, last_alert_ts, last_detail, updated_at, unhealthy_obs, alert_count)
             VALUES ${chunk.map(() => "(?, 'unhealthy', ?, NULL, 'down', ?, 1, 0)").join(", ")}`,
          ).bind(...chunk.flatMap((k) => [`${prefix}${k}@example.com`, T0 + k, T0 + k])),
        );
      }
      await env.DB.batch(statements);
    }

    it("caps the page at the shared admin default and says how many it left out", async () => {
      await seedUnhealthy(205, "mailbox_orphan:o");

      const res = await adminApi<ChecksResponse>("/admin/ops/checks");

      // REDS on the old code: it returned all 205 with no `total`, no `count`
      // and no `truncated`.
      expect(res.body.checks).toHaveLength(200);
      expect(res.body.count).toBe(200);
      expect(res.body.total).toBe(205);
      expect(res.body.truncated).toBe(true);
      // The COUNT is never truncated, only the rows.
      expect(res.body.unhealthyCount).toBe(205);
    }, 30_000);

    it("honours ?limit=, clamped — a caller cannot ask for the unbounded read back", async () => {
      await seedUnhealthy(205, "mailbox_orphan:c");

      const small = await adminApi<ChecksResponse>("/admin/ops/checks?limit=5");
      expect(small.body.checks).toHaveLength(5);
      expect(small.body.total).toBe(205);
      expect(small.body.truncated).toBe(true);

      // Above MAX_ADMIN_LIST_LIMIT the clamp holds; with only 205 rows the page
      // is the whole table, which is what `truncated: false` means.
      const huge = await adminApi<ChecksResponse>("/admin/ops/checks?limit=999999");
      expect(huge.body.checks).toHaveLength(205);
      expect(huge.body.truncated).toBe(false);

      // A present-but-empty `?limit=` is ABSENT, not zero (validate.ts's
      // parseIntQueryParam) — it must fall back to the default, not to 1.
      const empty = await adminApi<ChecksResponse>("/admin/ops/checks?limit=");
      expect(empty.body.checks).toHaveLength(200);
    }, 30_000);

    // THE TRAP THIS FIX HAD TO AVOID: a bounded read whose page order is not
    // unhealthy-first buries every broken check behind a page of healthy ones,
    // and the endpoint an operator polls to ask "what is broken" answers with
    // healthy rows. Executed against the fix: removing the
    // `(status = 'healthy') ASC` ordering term reds the unfiltered half of this
    // test. (The `?unhealthy=1` half is carried by the SQL WHERE, which is
    // belt to that brace rather than the guard itself — see readCheckRows.)
    it("a broken check is on page ONE, filtered or not, even behind a full page of newer healthy rows", async () => {
      const mailer = new SandboxOpsMailer();
      // 205 healthy rows, all with a LATER since_ts than the unhealthy one, so
      // any ordering that is not unhealthy-first buries it past the clamp too.
      const statements = [];
      for (let i = 0; i < 205; i += 33) {
        const chunk = Array.from({ length: Math.min(33, 205 - i) }, (_, j) => i + j);
        statements.push(
          env.DB.prepare(
            `INSERT INTO watchtower_state (check_name, status, since_ts, last_alert_ts, last_detail, updated_at, unhealthy_obs, alert_count)
             VALUES ${chunk.map(() => "(?, 'healthy', ?, NULL, 'ok', ?, 0, 0)").join(", ")}`,
          ).bind(...chunk.flatMap((k) => [`cred_push_aging:h${k}@example.com`, T0 + 1_000_000 + k, T0 + k])),
        );
      }
      await env.DB.batch(statements);
      await reconcileAlerts(env, mailer, [unhealthy("engine", "engine /health unreachable")], T0);

      const filtered = await adminApi<ChecksResponse>("/admin/ops/checks?unhealthy=1");
      expect(filtered.body.checks.map((c) => c.name)).toEqual(["engine"]);
      expect(filtered.body.total).toBe(1);
      expect(filtered.body.truncated).toBe(false);
      expect(filtered.body.unhealthyCount).toBe(1);

      // ...and the same row is on the FIRST page of the unfiltered read, which
      // is what "unhealthy first" has to mean once the read is paged.
      const all = await adminApi<ChecksResponse>("/admin/ops/checks");
      expect(all.body.checks[0]!.name).toBe("engine");
      expect(all.body.total).toBe(206);
      expect(all.body.truncated).toBe(true);
    }, 30_000);

    // The roster is the denominator this endpoint publishes; deriving it from a
    // PAGE would turn the guard against a silently-deleted check into a
    // generator of false ones.
    it("computes `missing` against the TABLE, so a check past the page cap is not reported absent", async () => {
      await seedUnhealthy(205, "mailbox_orphan:r");
      // A rostered check, seeded with the OLDEST since_ts so the unhealthy-first
      // + newest-first ordering pushes it well past a 5-row page.
      await env.DB.prepare(
        `INSERT INTO watchtower_state (check_name, status, since_ts, last_alert_ts, last_detail, updated_at, unhealthy_obs, alert_count)
         VALUES ('cron_legs', 'unhealthy', ?, NULL, 'down', ?, 1, 0)`,
      )
        .bind(T0 - 999_999, T0)
        .run();

      const res = await adminApi<ChecksResponse>("/admin/ops/checks?limit=5");

      expect(res.body.checks.map((c) => c.name)).not.toContain("cron_legs");
      expect(res.body.expected).toContain("cron_legs");
      // REDS on a page-derived roster: `cron_legs` exists and would be named
      // missing purely because it fell past the LIMIT.
      expect(res.body.missing).not.toContain("cron_legs");
      // The genuinely absent ones are still named.
      expect(res.body.missing).toContain("do_storage");
    }, 30_000);

    it("an empty store is truncated: false, not a short page", async () => {
      const res = await adminApi<ChecksResponse>("/admin/ops/checks");
      expect(res.body).toMatchObject({ count: 0, total: 0, truncated: false, unhealthyCount: 0 });
    });

    // The two bounds are independent and BOTH ride on this response: the S5
    // time bound (`retentionMs` — a row you saw last month may be gone) and the
    // S8 page bound (`total`/`truncated` — the rows you are holding may not be
    // all of them). A consumer that sees only one of them can still be wrong
    // about why a check it remembers is absent.
    it("publishes the retention bound and the page bound together", async () => {
      await seedUnhealthy(205, "mailbox_orphan:b");
      const res = await adminApi<ChecksResponse & { retentionMs: number; sweepStale: boolean; sweepAgeSeconds: number | null }>(
        "/admin/ops/checks",
      );
      expect(res.body.retentionMs).toBeGreaterThan(0);
      expect(res.body.truncated).toBe(true);
      expect(res.body.total).toBe(205);
      expect(typeof res.body.sweepStale).toBe("boolean");
    }, 30_000);
  });

  it("discloses which checks this table structurally CANNOT report, so 0 can never read as all-clear", async () => {
    // Every row healthy — the exact shape a D1 outage would ALSO produce here
    // (this table cannot record the outage itself).
    const mailer = new SandboxOpsMailer();
    await reconcileAlerts(env, mailer, [healthy("engine")], T0);

    const res = await adminApi<ChecksResponse>("/admin/ops/checks");
    expect(res.status).toBe(200);
    expect(res.body.unhealthyCount).toBe(0);
    expect(res.body.excludesDoStoreChecks).toEqual(expect.arrayContaining([D1_CHECK, CRON_SWEEP_CHECK]));
    expect(res.body.excludesDoStoreChecks.length).toBe(2);
  });
});
