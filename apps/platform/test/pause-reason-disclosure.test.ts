import { describe, expect, it } from "vitest";
import { applyActions, logAction } from "../src/engine/deliverability-actions.js";
import { signup, withTenantContext } from "./helpers.js";

// IN-16, docs/adversarial/class-sweep-dedup-semantics-2026-08-17.md.
//
// `applyPause`'s conditional `UPDATE ... AND deliv_status != 'paused'` doubles
// as a dedup: a SECOND pause for a DIFFERENT reason (already paused for a bounce
// rate, now also for a complaint spike) wrote nothing and called no `logAction`,
// so the activity feed and infrastructure_status showed only the FIRST cause.
// The mailbox is correctly paused either way — no send goes out — but the
// operator asking "why is this mailbox paused?" gets an answer that is stale and
// silently incomplete, and the second, often more serious cause leaves no trace
// anywhere.
//
// The idempotency the guard exists for is preserved and asserted below: a repeat
// pause for the SAME reason still writes nothing and logs nothing (the panel #2
// lesson). Only a genuinely NEW cause is recorded.

const MAILBOX_ID = "mbx_pause_in16";

async function seedPausableMailbox(tenantId: string): Promise<void> {
  await withTenantContext(tenantId, (ctx) => {
    ctx.sql.exec(
      `INSERT INTO mailboxes (id, tenant_id, domain_id, domain, email, daily_cap, warmup_started_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      MAILBOX_ID,
      tenantId,
      "dom_in16",
      "in16.test",
      "user@in16.test",
      30,
      1_800_000_000_000,
      1_800_000_000_000,
    );
  });
}

function pause(tenantId: string, reason: string): Promise<void> {
  return withTenantContext(tenantId, async (ctx) => {
    await applyActions(ctx, [
      { type: "PAUSE", mailboxId: MAILBOX_ID, email: "user@in16.test", reason },
    ]);
  });
}

function pauseActions(tenantId: string) {
  return withTenantContext(tenantId, (ctx) =>
    ctx.sql
      .exec<{ detail_json: string }>(
        `SELECT detail_json FROM deliverability_actions WHERE tenant_id = ? AND action = 'PAUSE' ORDER BY rowid`,
        ctx.tenantId,
      )
      .toArray()
      .map((r) => JSON.parse(r.detail_json).reason as string),
  );
}

function pausedStatus(tenantId: string) {
  return withTenantContext(tenantId, (ctx) =>
    ctx.sql
      .exec<{ deliv_status: string }>(`SELECT deliv_status FROM mailboxes WHERE id = ?`, MAILBOX_ID)
      .one().deliv_status,
  );
}

describe("IN-16 — a second pause for a DIFFERENT reason must not vanish", () => {
  it("records the new cause on an already-paused mailbox", async () => {
    const { tenantId } = await signup("Pause Reason Co", "founder@pausereason.test");
    await seedPausableMailbox(tenantId);

    await pause(tenantId, "hard_bounce_rate");
    await pause(tenantId, "complaint_spike");

    expect(await pausedStatus(tenantId)).toBe("paused");
    expect(await pauseActions(tenantId)).toEqual(["hard_bounce_rate", "complaint_spike"]);
  });

  it("stays idempotent for a repeat of the SAME reason (the panel #2 lesson)", async () => {
    const { tenantId } = await signup("Pause Idem Co", "founder@pauseidem.test");
    await seedPausableMailbox(tenantId);

    await pause(tenantId, "hard_bounce_rate");
    await pause(tenantId, "hard_bounce_rate");
    await pause(tenantId, "hard_bounce_rate");

    expect(await pauseActions(tenantId)).toEqual(["hard_bounce_rate"]);
  });

  it("logAction remains the only writer of the feed (no double row on the first pause)", async () => {
    const { tenantId } = await signup("Pause First Co", "founder@pausefirst.test");
    await seedPausableMailbox(tenantId);

    await pause(tenantId, "hard_bounce_rate");

    expect(await pauseActions(tenantId)).toHaveLength(1);
    expect(typeof logAction).toBe("function");
  });
});
