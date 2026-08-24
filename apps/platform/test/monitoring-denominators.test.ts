import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { buildOpsDigest } from "../src/admin/ops-sweep.js";
import { expectedCheckRoster } from "../src/admin/watchtower-roster.js";
import { adminApi, mintTenant, tenantStub } from "./helpers.js";

// THE ONE GUARD FOR THE WATCH-COMPLETENESS CLASS (docs/adversarial/
// class-sweep-watch-completeness-2026-08-17.md §4): *every monitoring read
// publishes the denominator it was drawn from.*
//
// The class in one sentence: the read's own result is the only evidence of its
// completeness, so ABSENCE IS INDISTINGUISHABLE FROM HEALTH. Three of the ten
// confirmed members contain no WHERE clause and no LIMIT at all, which is why
// the remedy is a denominator rather than a lint rule — a rule that flags
// `status IN (` cannot see a hardcoded literal or a skip-dark check that simply
// never writes a row.

const T0 = 1_800_000_000_000;

describe("GET /admin/ops/waitlist — a truncated page relabelled as a count", () => {
  // `count: entries.length` where `entries` is capped at 1000 (db.ts). Past
  // 1000 leads it reported `count: 1000` AS THE TOTAL with no truncation
  // signal — while the true total already existed one function away
  // (`countWaitlistEmails`, which the digest was already using).
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM waitlist").run();
  });

  afterAll(async () => {
    await env.DB.prepare("DELETE FROM waitlist").run();
  });

  it("reports the REAL total past the page cap, and says the page was truncated", async () => {
    // Just past the 1000-row page. Batched in chunks: D1's per-statement
    // ceiling is 100 bound parameters and each row binds two.
    const total = 1001;
    const rowsPerStatement = 49;
    const statements = [];
    for (let i = 0; i < total; i += rowsPerStatement) {
      const chunk = Array.from({ length: Math.min(rowsPerStatement, total - i) }, (_, j) => i + j);
      statements.push(
        env.DB.prepare(`INSERT INTO waitlist (email, created_at) VALUES ${chunk.map(() => "(?, ?)").join(", ")}`).bind(
          ...chunk.flatMap((n) => [`lead${n}@waitlist.test`, T0 + n]),
        ),
      );
    }
    await env.DB.batch(statements);

    const { body } = await adminApi<{ count: number; returned: number; truncated: boolean; entries: unknown[] }>("/admin/ops/waitlist");

    // REDS on the old code: `count` was `entries.length`, i.e. 1000.
    expect(body.count).toBe(total);
    expect(body.returned).toBe(1000);
    expect(body.truncated).toBe(true);
    expect(body.entries).toHaveLength(1000);
  }, 60_000);

  it("says truncated: false when the page really is everything", async () => {
    await env.DB.prepare(`INSERT INTO waitlist (email, created_at) VALUES ('one@waitlist.test', ?)`).bind(T0).run();
    const { body } = await adminApi<{ count: number; returned: number; truncated: boolean }>("/admin/ops/waitlist");
    expect(body).toMatchObject({ count: 1, returned: 1, truncated: false });
  });
});

describe("GET /admin/ops/checks — the expected ROSTER, so a skipped check is not an absent one", () => {
  // The `engine` check is omitted from the results array entirely when
  // ENGINE_BASE_URL is unset, and the two vendor checks when InboxKit is
  // unarmed. The skip-dark behaviour is correct; the gap was that nothing
  // asserted the expected roster, so an env var lost in a deploy DELETED a
  // check from the monitored set and its absence read as health everywhere.
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM watchtower_state").run();
  });

  it("names the checks it expected and did not find", async () => {
    await env.DB.prepare(
      `INSERT INTO watchtower_state (check_name, status, since_ts, last_alert_ts, last_detail, updated_at, unhealthy_obs, alert_count)
       VALUES ('do_storage', 'healthy', ?, NULL, 'ok', ?, 0, 0)`,
    )
      .bind(T0, T0)
      .run();

    const { body } = await adminApi<{ expected: string[]; missing: string[]; sweepStale: boolean }>("/admin/ops/checks");

    // REDS on the old code: neither field existed at all.
    expect(body.expected).toContain("cron_legs");
    expect(body.expected).toContain("do_storage");
    expect(body.missing).toContain("cron_legs");
    expect(body.missing).not.toContain("do_storage");
  });

  it("expects the skip-dark checks EXACTLY when their dependency is configured", () => {
    const dark = expectedCheckRoster({ ...env, ENGINE_BASE_URL: undefined, INBOXKIT_API_KEY: undefined, INBOXKIT_WORKSPACE_ID: undefined } as typeof env);
    expect(dark).not.toContain("engine");
    expect(dark).not.toContain("vendor_wallet");

    const armed = expectedCheckRoster({
      ...env,
      ENGINE_BASE_URL: "https://engine.test",
      INBOXKIT_API_KEY: "k",
      INBOXKIT_WORKSPACE_ID: "w",
    } as unknown as typeof env);
    expect(armed).toContain("engine");
    expect(armed).toContain("vendor_wallet");
    expect(armed).toContain("warmup_duplicates");
  });

  // Gate NB5 (docs/adversarial/msgchannel-inc4-gate-2026-08-24.md) —
  // mirror_delivery is UNCONDITIONALLY always-on (scheduled.ts reports it
  // every tick regardless of MESSAGE_EMAIL_MIRROR_ENABLED), yet was absent
  // from this roster from day one: a lost report read as health with
  // nothing to catch it — exactly the absence-is-indistinguishable-from-
  // health class this file exists to close.
  it("mirror_delivery is expected regardless of engine/vendor configuration (always-on, not skip-dark)", () => {
    const dark = expectedCheckRoster({ ...env, ENGINE_BASE_URL: undefined, INBOXKIT_API_KEY: undefined, INBOXKIT_WORKSPACE_ID: undefined } as typeof env);
    expect(dark).toContain("mirror_delivery");

    const armed = expectedCheckRoster({
      ...env,
      ENGINE_BASE_URL: "https://engine.test",
      INBOXKIT_API_KEY: "k",
      INBOXKIT_WORKSPACE_ID: "w",
    } as unknown as typeof env);
    expect(armed).toContain("mirror_delivery");
  });

  it("publishes the sweep's own freshness rather than leaving it to be inferred from row mtimes", async () => {
    await env.DB.prepare("DELETE FROM watchtower_cursor").run();
    const stale = await adminApi<{ sweepAgeSeconds: number | null; sweepStale: boolean }>("/admin/ops/checks");
    // No sweep has ever completed against this database: STALE, not unknown.
    expect(stale.body).toMatchObject({ sweepAgeSeconds: null, sweepStale: true });

    await env.DB.prepare(`INSERT INTO watchtower_cursor (id, last_sweep_ts) VALUES (1, ?)`).bind(Date.now()).run();
    const fresh = await adminApi<{ sweepAgeSeconds: number | null; sweepStale: boolean }>("/admin/ops/checks");
    expect(fresh.body.sweepStale).toBe(false);
    expect(fresh.body.sweepAgeSeconds).toBeLessThan(60);

    await env.DB.prepare("DELETE FROM watchtower_cursor").run();
  });
});

describe("buildOpsDigest — the rollup states what it scanned and what it could not bucket", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM tenants_index").run();
  });

  it("counts a tenant whose billing_state matches no lifecycle bucket, and raises it", async () => {
    const { tenantId } = await mintTenant("Unbucketed Co", "managed");
    await runInDurableObject(tenantStub(tenantId), (_instance, state) => {
      // A value nobody accounted for. `billing_state` carries no CHECK
      // constraint (schema.ts, DEFAULT 'none'), so this is one UPDATE away in
      // production too.
      state.storage.sql.exec(`UPDATE tenant_profile SET billing_state = 'grace_period' WHERE id = ?`, tenantId);
    });

    const digest = await buildOpsDigest(env, T0, 24);

    // REDS on the old code: the field did not exist, and the tenant counted in
    // `tenants.total` while appearing in NO lifecycle number.
    expect(digest.lifecycle.unbucketed).toBe(1);
    expect(digest.watchdogAlerts.join(" ")).toContain("no bucket for");
  });

  it("says so when the pass was PARTIAL, and every count is over what it scanned", async () => {
    const a = await mintTenant("Partial A", "managed");
    await mintTenant("Partial B", "managed");

    const digest = await buildOpsDigest(env, T0, 24, { tenantIds: [a.tenantId] });

    // REDS on the old code: `tenants.total` WAS the scanned count, so a partial
    // pass was indistinguishable from a complete one.
    expect(digest.tenants).toMatchObject({ total: 2, scanned: 1 });
    expect(digest.complete).toBe(false);
    expect(digest.watchdogAlerts.join(" ")).toContain("PARTIAL PASS");
  });

  it("a complete pass says complete, and raises no partial-pass line", async () => {
    await mintTenant("Complete Co", "managed");
    const digest = await buildOpsDigest(env, T0, 24);
    expect(digest.complete).toBe(true);
    expect(digest.tenants).toMatchObject({ total: 1, scanned: 1 });
    expect(digest.watchdogAlerts.join(" ")).not.toContain("PARTIAL PASS");
  });
});
