import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { listPendingScreeningReviews } from "../src/admin/db.js";
import { LIST_UNAVAILABLE_VERSION } from "../src/ofac/screening.js";
import { adminApi } from "./helpers.js";

// S8 (docs/adversarial/scale-readiness-audit-2026-08-17.md) — CROSS-TENANT
// operator reads had no LIMIT, no cursor and no truncation, over tables that
// are LIFETIME-CUMULATIVE (support tickets are never deleted; screening reviews
// keep one row per tenant ever held). The audit's own note is that per-TENANT
// reads consistently do carry bounds — the gap is cross-tenant only.
//
// The bound has to arrive with a TRUE TOTAL beside it, or it just moves the
// failure: a truncated list that reports its own truncated length as the count
// tells the operator the queue is empty when it is 200-deep.

const DEFAULT_LIMIT = 200;

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM support_tickets").run();
  await env.DB.prepare("DELETE FROM screening_reviews").run();
});

async function seedTickets(n: number, status = "open"): Promise<void> {
  const now = Date.now();
  const statements = [];
  for (let i = 0; i < n; i++) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO support_tickets (id, from_email, subject, body, tenant_id, category, draft, status, created_at, source)
         VALUES (?, ?, ?, ?, NULL, 'other', NULL, ?, ?, 'email')`,
      ).bind(`tkt_bulk_${i}`, `a${i}@x.com`, `subject ${i}`, `body ${i}`, status, now + i),
    );
  }
  await env.DB.batch(statements);
}

async function seedReview(tenantId: string, listVersion: string, createdAt: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO screening_reviews (tenant_id, matched_terms, screened_fields, list_version, status, created_at)
     VALUES (?, '[]', '{}', ?, 'pending', ?)`,
  )
    .bind(tenantId, listVersion, createdAt)
    .run();
}

describe("S8 — GET /admin/support/digest is bounded and reports the true total", () => {
  it("caps the ticket list at the default while `counts` still names every open ticket", async () => {
    await seedTickets(DEFAULT_LIMIT + 5);

    const res = await adminApi<{ counts: { open: number; escalated: number }; tickets: unknown[] }>(
      "/admin/support/digest",
    );

    expect(res.status).toBe(200);
    expect(res.body.tickets).toHaveLength(DEFAULT_LIMIT);
    // The truncation is VISIBLE in the same response — this is what stops a
    // bounded digest from reading as "205 tickets? no, 200, that's all of them".
    expect(res.body.counts.open).toBe(DEFAULT_LIMIT + 5);
  });

  it("honors an explicit ?limit= and treats a present-but-EMPTY one as absent (the D9 shape)", async () => {
    await seedTickets(20);

    expect((await adminApi<{ tickets: unknown[] }>("/admin/support/digest?limit=5")).body.tickets).toHaveLength(5);
    // `?limit=` is `""`; Number("") is 0, which a naive clamp floors to 1 row.
    expect((await adminApi<{ tickets: unknown[] }>("/admin/support/digest?limit=")).body.tickets).toHaveLength(20);
    expect((await adminApi<{ tickets: unknown[] }>("/admin/support/digest?limit=abc")).body.tickets).toHaveLength(20);
  });
});

describe("S8 — GET /admin/screening/reviews is bounded and reports the true total", () => {
  it("caps the review list at the default and reports how many are actually pending", async () => {
    const now = Date.now();
    const statements = [];
    for (let i = 0; i < DEFAULT_LIMIT + 3; i++) {
      statements.push(
        env.DB.prepare(
          `INSERT INTO screening_reviews (tenant_id, matched_terms, screened_fields, list_version, status, created_at)
           VALUES (?, '[]', '{}', 'v1', 'pending', ?)`,
        ).bind(`ten_bulk_${i}`, now + i),
      );
    }
    await env.DB.batch(statements);

    const res = await adminApi<{ count: number; total: number; reviews: unknown[] }>("/admin/screening/reviews");

    expect(res.status).toBe(200);
    expect(res.body.reviews).toHaveLength(DEFAULT_LIMIT);
    expect(res.body.count).toBe(DEFAULT_LIMIT); // what this page holds
    expect(res.body.total).toBe(DEFAULT_LIMIT + 3); // what the queue actually holds
  });
});

// THE ANTI-TRUNCATION GUARD, and the reason the bound could not simply be
// pushed into the shared query. `listPendingScreeningReviews` has a SECOND
// consumer that is not an operator page: ofac/screening-recovery.ts's 5-minute
// cron re-screens every tenant held on the `list-unavailable` sentinel. It used
// to load the WHOLE pending queue and filter in JS — so a limit added for the
// operator's benefit would have silently stopped a SANCTIONS recovery sweep from
// ever reaching a tenant sitting past the cap, with no error anywhere.
//
// This test passes on the pre-fix code too (it filtered in JS, which also finds
// the row). It is here to fail on the WRONG fix, which is the one this class
// invites.
describe("S8 — the sentinel-recovery sweep's reach is not bounded by the operator page size", () => {
  it("finds a sentinel review sitting far past the operator default", async () => {
    const now = Date.now();
    const statements = [];
    // A queue deeper than the operator page, all of it real-version hits...
    for (let i = 0; i < DEFAULT_LIMIT + 5; i++) {
      statements.push(
        env.DB.prepare(
          `INSERT INTO screening_reviews (tenant_id, matched_terms, screened_fields, list_version, status, created_at)
           VALUES (?, '[]', '{}', 'v1', 'pending', ?)`,
        ).bind(`ten_hit_${i}`, now + i),
      );
    }
    await env.DB.batch(statements);
    // ...and ONE tenant stuck on the sentinel, newest, so an ascending operator
    // page would never show it.
    await seedReview("ten_stuck_on_sentinel", LIST_UNAVAILABLE_VERSION, now + 10_000);

    const sentinelOnly = await listPendingScreeningReviews(env, { listVersion: LIST_UNAVAILABLE_VERSION });

    expect(sentinelOnly.map((r) => r.tenantId)).toEqual(["ten_stuck_on_sentinel"]);
  });

  it("the sentinel filter is applied in SQL, so a real-version hit never rides along", async () => {
    const now = Date.now();
    await seedReview("ten_real_hit", "v1", now);
    await seedReview("ten_sentinel", LIST_UNAVAILABLE_VERSION, now + 1);

    const sentinelOnly = await listPendingScreeningReviews(env, { listVersion: LIST_UNAVAILABLE_VERSION });
    expect(sentinelOnly.map((r) => r.tenantId)).toEqual(["ten_sentinel"]);

    const all = await listPendingScreeningReviews(env);
    expect(all.map((r) => r.tenantId).sort()).toEqual(["ten_real_hit", "ten_sentinel"]);
  });
});
