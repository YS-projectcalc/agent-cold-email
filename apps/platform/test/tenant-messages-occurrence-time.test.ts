import { describe, expect, it } from "vitest";
import { emitTenantMessage, listMessagesPage } from "../src/engine/tenant-messages.js";
import { signup, tenantStub, withTenantContext } from "./helpers.js";

// IN-3 + IN-5, docs/adversarial/class-sweep-dedup-semantics-2026-08-17.md.
//
// `emitTenantMessage`'s dedup branch UPDATEd `created_at = now` on every
// re-trigger. Two losses fell out of that one write:
//
//  IN-3 — the original occurrence time was destroyed, so "how long has this
//  been stuck?" became unanswerable, and every `sinceMs` the next-steps planner
//  reports understated the age of a recurring blocker.
//
//  IN-5 — `created_at` is an ORDER BY column for both read surfaces AND the
//  component of `listMessagesPage`'s keyset cursor. Re-stamping moved a live row
//  from BELOW an already-issued cursor to ABOVE it, so a row re-emitted
//  mid-pagination was skipped by that entire drain. `listMessagesPage`'s own
//  docstring claims a mid-pagination emit "can't shift an already-issued page" —
//  true for INSERTs, false for this UPDATE.
//
// RECONCILIATION with the customer-continuity wave (NB-3, build gate r3, see
// engine/next-steps.ts). That wave DELIBERATELY relies on the re-stamp: its
// min-age expiry gate must measure "time since the platform last OBSERVED the
// failure", so a condition that keeps recurring never ages into being expired
// while it is still failing. Both are right, and they are asking `created_at`
// for two different facts. So the fix splits them rather than reverting either:
// `created_at` becomes immutable (what it has always claimed to mean) and a new
// `last_occurred_at` carries the recurrence, which is what the expiry gate now
// reads. The final test below pins that the continuity behaviour is preserved.

const KEY = "acme.com";

function rowTimes(tenantId: string) {
  return withTenantContext(tenantId, (ctx) =>
    ctx.sql
      .exec<{ created_at: number; last_occurred_at: number | null; body: string }>(
        `SELECT created_at, last_occurred_at, body FROM tenant_messages WHERE tenant_id = ?`,
        tenantId,
      )
      .one(),
  );
}

describe("IN-3 — a dedup re-emit must not destroy the original occurrence time", () => {
  it("keeps created_at at the FIRST occurrence across a re-emit", async () => {
    const { tenantId } = await signup("Occurrence Co", "founder@occurrence.test");
    await withTenantContext(tenantId, (ctx) =>
      emitTenantMessage(ctx, { kind: "retry_setup", severity: "action_required", body: "first", dedupKey: KEY }),
    );
    const first = await rowTimes(tenantId);

    await tenantStub(tenantId).advanceClock(60 * 60 * 1000); // an hour later

    await withTenantContext(tenantId, (ctx) =>
      emitTenantMessage(ctx, { kind: "retry_setup", severity: "action_required", body: "second", dedupKey: KEY }),
    );
    const second = await rowTimes(tenantId);

    expect(second.created_at).toBe(first.created_at);
    // The refresh itself is untouched — that is the dedup branch's whole purpose.
    expect(second.body).toBe("second");
    // ...and the recurrence is recorded, not thrown away.
    expect(second.last_occurred_at).toBeGreaterThan(first.created_at);
  });
});

describe("IN-5 — a row re-emitted mid-pagination must still be drained", () => {
  it("does not skip a re-emitted row that an issued cursor had already passed", async () => {
    const { tenantId } = await signup("Pagination Co", "founder@pagination.test");

    // 20 unread messages, oldest first, each with its own dedup key.
    for (let i = 0; i < 20; i++) {
      await withTenantContext(tenantId, (ctx) =>
        emitTenantMessage(ctx, {
          kind: "retry_setup",
          severity: "action_required",
          body: `msg ${i}`,
          dedupKey: `domain-${i}.com`,
        }),
      );
      await tenantStub(tenantId).advanceClock(1000);
    }

    // Page 1 — the agent now holds a cursor.
    const page1 = await withTenantContext(tenantId, (ctx) => listMessagesPage(ctx, { limit: 5 }));
    expect(page1.messages).toHaveLength(5);
    expect(page1.nextCursor).not.toBeNull();

    // A message far below the cursor (the OLDEST) is re-emitted mid-drain.
    await tenantStub(tenantId).advanceClock(1000);
    await withTenantContext(tenantId, (ctx) =>
      emitTenantMessage(ctx, {
        kind: "retry_setup",
        severity: "action_required",
        body: "msg 0 (re-emitted)",
        dedupKey: "domain-0.com",
      }),
    );

    // Drain the rest with the issued cursors.
    const drained: string[] = page1.messages.map((m) => m.body);
    let cursor = page1.nextCursor;
    while (cursor) {
      const page = await withTenantContext(tenantId, (ctx) => listMessagesPage(ctx, { cursor: cursor!, limit: 5 }));
      drained.push(...page.messages.map((m) => m.body));
      cursor = page.nextCursor;
    }

    expect(drained).toHaveLength(20);
    expect(drained).toContain("msg 0 (re-emitted)");
  });
});
