import { describe, expect, it } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import { VendorError } from "@coldstart/shared";
import type { PollResult } from "@coldstart/shared";
import { runPollInbox } from "../src/engine/reply-processor.js";
import { activatePaidPlan, api, mintTenant, seedBenignSdnList, tenantStub, withTenantContext } from "./helpers.js";

// WAVE 2 N6 — POLL ISOLATION, and the released-mailbox filter under it.
//
// Two defects, one root cause: `runPollInbox` looped EVERY mailbox row a tenant
// had ever held (no `released_at` filter) with no per-mailbox guard, so
//   (a) every torn-down mailbox cost a doomed engine round trip on every poll,
//       forever — and with the cron now driving poll every 5 minutes, each one
//       can burn a full request timeout against a slow engine; and
//   (b) the FIRST mailbox to throw aborted the whole tenant's poll, so one bad
//       address silently stopped every other mailbox's replies from ever being
//       processed.

const DAY_MS = 24 * 60 * 60 * 1000;

interface SeedMailbox {
  email: string;
  releasedAt?: number;
}

async function seedMailboxes(tenantId: string, mailboxes: SeedMailbox[]): Promise<void> {
  await runInDurableObject(tenantStub(tenantId), async (_i, state) => {
    const sql = state.storage.sql;
    const now = Date.now();
    const domainId = sql.exec<{ id: string }>(`SELECT id FROM domains WHERE tenant_id = ? LIMIT 1`, tenantId).one().id;
    const domain = sql.exec<{ domain: string }>(`SELECT domain FROM domains WHERE id = ?`, domainId).one().domain;
    sql.exec(`DELETE FROM mailboxes WHERE tenant_id = ?`, tenantId);
    for (const mb of mailboxes) {
      sql.exec(
        `INSERT INTO mailboxes
           (id, tenant_id, domain_id, domain, email, daily_cap, sent_today, sent_today_epoch_day, status,
            warmup_started_at, created_at, poll_cursor, provider, released_at)
         VALUES (?, ?, ?, ?, ?, 5, 0, ?, 'warming', ?, ?, 100, 'google', ?)`,
        `mbx_${mb.email}`,
        tenantId,
        domainId,
        domain,
        mb.email,
        Math.floor(now / DAY_MS),
        now,
        now,
        mb.releasedAt ?? null,
      );
    }
  });
}

async function cursorsOf(tenantId: string): Promise<Record<string, number>> {
  const rows = await runInDurableObject(tenantStub(tenantId), async (_i, state) =>
    state.storage.sql
      .exec<{ email: string; poll_cursor: number }>(`SELECT email, poll_cursor FROM mailboxes WHERE tenant_id = ?`, tenantId)
      .toArray(),
  );
  return Object.fromEntries(rows.map((r) => [r.email, r.poll_cursor]));
}

async function tenantWithMailboxes(brand: string, domain: string, mailboxes: SeedMailbox[]): Promise<string> {
  await seedBenignSdnList();
  const { tenantId, token } = await mintTenant(brand, "managed");
  await activatePaidPlan(tenantId, "managed");
  await api("/setup-infrastructure", {
    method: "POST",
    token,
    body: JSON.stringify({
      brand,
      primaryDomain: domain,
      domains: 1,
      inboxesEach: 1,
      persona: "Sender",
      physicalAddress: "1 Poll St",
      senderIdentity: `Sender <s@${domain}>`,
    }),
  });
  await seedMailboxes(tenantId, mailboxes);
  return tenantId;
}

describe("N6 — one mailbox's failure never costs the tenant its whole poll", () => {
  it("mailbox A throws => B is still polled, and A's cursor is left un-advanced", async () => {
    const tenantId = await tenantWithMailboxes("Poll Iso Co", "poll-iso-co.test", [
      { email: "a@poll-iso-co.test" },
      { email: "b@poll-iso-co.test" },
    ]);

    const polled: string[] = [];
    await withTenantContext(tenantId, async (ctx) => {
      ctx.adapters.email.poll = async (email: string): Promise<PollResult> => {
        polled.push(email);
        // A is uncredentialed at the engine — the real 422 shape.
        if (email === "a@poll-iso-co.test") throw new VendorError("unknown mailbox", true);
        return { events: [], cursor: 500 };
      };
      return runPollInbox(ctx);
    });

    // B was reached even though A came first and threw.
    expect(polled).toEqual(["a@poll-iso-co.test", "b@poll-iso-co.test"]);
    const cursors = await cursorsOf(tenantId);
    // A's cursor is EXACTLY where it was: nothing below the throw ran, so the
    // events it would have carried are redelivered next poll (deduped on
    // message_id) rather than skipped.
    expect(cursors["a@poll-iso-co.test"]).toBe(100);
    expect(cursors["b@poll-iso-co.test"]).toBe(500);
  });

  it("a throw does not stop the tenant's reply counters for the mailboxes that DID work", async () => {
    const tenantId = await tenantWithMailboxes("Poll Count Co", "poll-count-co.test", [
      { email: "bad@poll-count-co.test" },
      { email: "good@poll-count-co.test" },
    ]);
    const result = await withTenantContext(tenantId, async (ctx) => {
      ctx.adapters.email.poll = async (email: string): Promise<PollResult> => {
        if (email === "bad@poll-count-co.test") throw new VendorError("engine unreachable", true);
        return { events: [], cursor: 42 };
      };
      return runPollInbox(ctx);
    });
    // The call RETURNS rather than propagating — the tenant's poll completed.
    expect(result).toEqual({ replies: 0, bounces: 0, complaints: 0 });
  });

  it("a RELEASED mailbox is never polled at all", async () => {
    const tenantId = await tenantWithMailboxes("Poll Released Co", "poll-released-co.test", [
      { email: "live@poll-released-co.test" },
      { email: "gone@poll-released-co.test", releasedAt: Date.now() },
    ]);

    const polled: string[] = [];
    await withTenantContext(tenantId, async (ctx) => {
      ctx.adapters.email.poll = async (email: string): Promise<PollResult> => {
        polled.push(email);
        return { events: [], cursor: 7 };
      };
      return runPollInbox(ctx);
    });

    expect(polled).toEqual(["live@poll-released-co.test"]);
  });
});
