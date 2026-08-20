import { describe, expect, it } from "vitest";
import { recordEventIfNew } from "../src/engine/events.js";
import replyProcessorSource from "../src/engine/reply-processor.ts?raw";
import { signup, withTenantContext } from "./helpers.js";

// IN-14, docs/adversarial/class-sweep-dedup-semantics-2026-08-17.md, closed per
// the team-lead ruling as option (b): keep the COUNT semantics, stop discarding
// the repeat's metadata.
//
// Bounce/complaint events dedup on `(tenant_id, type, message_id)` where
// `message_id` is the ORIGINAL SEND's id — the DSN carries no id of its own
// (`PolledBounce`/`PolledComplaint` in packages/shared/src/vendor-ports.ts), and
// that column MUST stay the original send's id because engine/deliverability.ts
// (:320, :387) JOINs `scheduled_sends.message_id = events.message_id` to
// attribute a bounce to its sending mailbox. Widening the key would silently
// zero that attribution.
//
// So two genuinely different DSNs for one send collapse to one row, which is
// defensible as a COUNT (one send, one outcome; a 4.4.1 "delayed" notice is not
// a delivery failure). What was NOT defensible is that `recordEventIfNew`
// returned false and threw the second DSN's payload away: a greylisting MTA
// emitting 4.4.1 "delayed" and then 4.2.2 "mailbox full" left the platform's
// only record saying "delayed" forever. The later DSN is the more final truth.
//
// TESTED AT THE EVENT-RECORDING SEAM, NOT END-TO-END — deliberately, and this is
// a real coverage limit rather than a shortcut. The sandbox EmailPort
// (vendors/sandbox/email-port.ts) mints ONE DSN per send, reusing
// `result.messageId` with a hardcoded reason, so it CANNOT produce two distinct
// DSNs for one send; IN-14 is unreachable through the sandbox by construction.
// The seam test below proves the mechanism and the source guard proves the two
// DSN call sites actually use it — without that second half the fix would be
// live code with no production driver.

const ORIGINAL_ID = "<send-abc@coldstart.test>";

function eventRows(tenantId: string) {
  return withTenantContext(tenantId, (ctx) =>
    ctx.sql
      .exec<{ ts: number; metadata_json: string; type: string }>(
        `SELECT ts, metadata_json, type FROM events WHERE tenant_id = ? AND type = 'soft_bounce'`,
        ctx.tenantId,
      )
      .toArray(),
  );
}

function recordSoftBounce(
  tenantId: string,
  reason: string,
  ts: number,
  refreshMetadataOnRepeat: boolean,
): Promise<boolean> {
  return withTenantContext(tenantId, (ctx) =>
    recordEventIfNew(ctx, {
      campaignId: "cmp_dsn",
      leadId: "led_dsn",
      type: "soft_bounce",
      step: 0,
      messageId: ORIGINAL_ID,
      threadId: "thr_dsn",
      ts,
      metadata: { reason, toEmail: "lead@example.com", severity: "soft" },
      refreshMetadataOnRepeat,
    }),
  );
}

describe("IN-14 — a second DSN for the same send refreshes the record it cannot duplicate", () => {
  it("keeps ONE row but replaces the stale reason with the later one", async () => {
    const { tenantId } = await signup("DSN Refresh Co", "founder@dsnrefresh.test");

    expect(await recordSoftBounce(tenantId, "soft bounce 4.4.1 delayed", 1000, true)).toBe(true);
    // The greylisting MTA's second, more final report.
    expect(await recordSoftBounce(tenantId, "soft bounce 4.2.2 mailbox full", 2000, true)).toBe(false);

    const rows = await eventRows(tenantId);
    // COUNT SEMANTICS UNCHANGED (the ruling): one send, one soft bounce.
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.metadata_json).reason).toBe("soft bounce 4.2.2 mailbox full");
    // `ts` is when this condition was FIRST recorded and is an ORDER BY column
    // for getThread — the same reason IN-3 made tenant_messages.created_at
    // immutable. A refresh must never move it.
    expect(rows[0]!.ts).toBe(1000);
  });

  it("returns false on the repeat, so no side effect and no webhook re-fires", async () => {
    const { tenantId } = await signup("DSN Sideeffect Co", "founder@dsnside.test");
    await recordSoftBounce(tenantId, "first", 1000, true);
    expect(await recordSoftBounce(tenantId, "second", 2000, true)).toBe(false);
  });

  it("leaves metadata alone when the caller does not opt in (every other event type)", async () => {
    const { tenantId } = await signup("DSN Optout Co", "founder@dsnoptout.test");
    await recordSoftBounce(tenantId, "first", 1000, false);
    await recordSoftBounce(tenantId, "second", 2000, false);

    const rows = await eventRows(tenantId);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.metadata_json).reason).toBe("first");
  });
});

// The other half of the fix: live code with no production driver is 100% green
// and 100% dead. Both DSN paths must actually ask for the refresh.
describe("IN-14 wiring — the bounce and complaint paths opt in", () => {
  it("every recordEventIfNew call in reply-processor for a DSN type sets refreshMetadataOnRepeat", () => {
    // Each `recordEventIfNew({...})` block in the file, with its type field.
    const blocks = replyProcessorSource.split("recordEventIfNew(ctx, {").slice(1);
    expect(blocks.length).toBeGreaterThanOrEqual(4); // reply, hard bounce, soft bounce, complaint

    const dsnBlocks = blocks.filter((b) => /type: "(bounce|soft_bounce|complaint)"/.test(b.slice(0, 400)));
    expect(dsnBlocks).toHaveLength(3);
    for (const block of dsnBlocks) {
      expect(block.slice(0, 600)).toMatch(/refreshMetadataOnRepeat:\s*true/);
    }

    // ...and the reply path must NOT, since a re-polled reply is byte-identical
    // and there is nothing later or truer to learn from it.
    const replyBlocks = blocks.filter((b) => /type: "reply"/.test(b.slice(0, 400)));
    expect(replyBlocks).toHaveLength(1);
    expect(replyBlocks[0]!.slice(0, 600)).not.toMatch(/refreshMetadataOnRepeat/);
  });
});
