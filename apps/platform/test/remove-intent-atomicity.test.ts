import { describe, expect, it } from "vitest";
import type { TenantContext } from "../src/tenant-context.js";
import { recordRemoveIntent } from "../src/engine/remove-intents.js";
import { mintTenant, withTenantContext } from "./helpers.js";

// R4-1, docs/adversarial/wave-1-2-integration-gate-2026-08-18.md.
//
// `recordRemoveIntent` chunks its multi-row INSERT at 20 rows and justified it
// with "there is no point between chunks for a crash to land on, so every chunk
// lands or none do". The gate MEASURED that last clause false: DO SqlStorage
// writes SURVIVE an exception raised later in the same turn and caught — which
// is exactly what `withRequestIdempotency` does with any throw out of `fn`.
//
// The consequence is the dangerous part. If chunk 1 landed and chunk 2 did not,
// `readRemoveIntent`'s early return adopts the SHORT set as the whole downgrade
// on the retry: the customer's downgrade completes short, reports
// `failedCount: 0`, and freezes as terminal — an under-release reported as
// success, on the one path in this codebase whose mistakes are irreversible (a
// released mailbox loses the warmup reputation its four-week ramp bought).
//
// The gate rated it non-blocking because no INPUT can make chunk 2 throw while
// chunk 1 succeeds — every full chunk binds identically 100 params, OR IGNORE
// suppresses the only constraint, and every column is fed a non-null value
// derived once outside the loop. So the fault is injected here rather than
// driven by input: the test wraps the real `ctx.sql` and lets the intent INSERT
// write only its first row, which is what a partial chunk write looks like to
// the read-back. Everything else — the table, the resolution query, the
// read-back — is real.

/** A ctx whose intent INSERT lands only its FIRST row (a partial chunk write). */
function ctxWithPartialIntentWrite(ctx: TenantContext): TenantContext {
  const realExec = ctx.sql.exec.bind(ctx.sql);
  const sql = new Proxy(ctx.sql, {
    get(target, prop, receiver) {
      if (prop !== "exec") return Reflect.get(target, prop, receiver);
      return (query: string, ...bindings: unknown[]) => {
        if (!/INSERT OR IGNORE INTO mailbox_release_intents/.test(query)) {
          return realExec(query, ...(bindings as never[]));
        }
        // Keep the statement well-formed, but bind one row's worth of params.
        const oneRow = query.replace(/VALUES .*/s, "VALUES (?, ?, ?, ?, ?)");
        return realExec(oneRow, ...(bindings.slice(0, 5) as never[]));
      };
    },
  });
  return { ...ctx, sql } as TenantContext;
}

async function seedLiveMailboxes(tenantId: string, n: number): Promise<void> {
  await withTenantContext(tenantId, (ctx) => {
    for (let i = 0; i < n; i++) {
      ctx.sql.exec(
        `INSERT INTO mailboxes (id, tenant_id, domain_id, domain, email, daily_cap, warmup_started_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        `mbx_atomicity_${i}`,
        tenantId,
        "dom_atomicity",
        "atomicity.test",
        `user${i}@atomicity.test`,
        30,
        1_800_000_000_000,
        1_800_000_000_000 + i,
      );
    }
  });
}

describe("R4-1 — a partially-written release intent must never be adopted as the whole downgrade", () => {
  it("throws instead of returning a SHORT target set", async () => {
    const { tenantId } = await mintTenant("Atomicity Co", "managed");
    await seedLiveMailboxes(tenantId, 3);

    await expect(
      withTenantContext(tenantId, (ctx) => recordRemoveIntent(ctxWithPartialIntentWrite(ctx), "key-partial", 3)),
    ).rejects.toThrow(/intent/i);
  });

  it("leaves NO rows behind, so the retry re-resolves rather than adopting the short set", async () => {
    const { tenantId } = await mintTenant("Atomicity Retry Co", "managed");
    await seedLiveMailboxes(tenantId, 3);

    await withTenantContext(tenantId, (ctx) =>
      recordRemoveIntent(ctxWithPartialIntentWrite(ctx), "key-retry", 3),
    ).catch(() => undefined);

    const rows = await withTenantContext(tenantId, (ctx) =>
      ctx.sql
        .exec<{ n: number }>(
          `SELECT COUNT(*) as n FROM mailbox_release_intents WHERE key = ? AND tenant_id = ?`,
          "key-retry",
          tenantId,
        )
        .one().n,
    );
    expect(rows).toBe(0);

    // The retry now resolves the FULL set on healthy storage, as it must — and
    // as a genuine first execution, NOT as a replay of the discarded partial.
    const retried = await withTenantContext(tenantId, (ctx) => recordRemoveIntent(ctx, "key-retry", 3));
    expect(retried.members).toHaveLength(3);
    expect(retried.replayed).toBe(false);
  });

  // The guard must not fire on the ordinary path.
  it("records the whole set normally when every row lands", async () => {
    const { tenantId } = await mintTenant("Atomicity Happy Co", "managed");
    await seedLiveMailboxes(tenantId, 3);

    const first = await withTenantContext(tenantId, (ctx) => recordRemoveIntent(ctx, "key-happy", 3));
    expect(first.members).toHaveLength(3);
    expect(first.replayed).toBe(false);

    // And a same-key replay still returns the recorded set without re-resolving,
    // now SAYING that is what it did (NB-R3-1).
    const replay = await withTenantContext(tenantId, (ctx) => recordRemoveIntent(ctx, "key-happy", 3));
    expect(replay.members.map((m) => m.mailboxId).sort()).toEqual(first.members.map((m) => m.mailboxId).sort());
    expect(replay.replayed).toBe(true);
  });
});
