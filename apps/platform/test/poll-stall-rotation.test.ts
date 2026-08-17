// T3 — the STALL variant of the head-of-line-blocking class
// (docs/adversarial/class-sweep-hol-blocking-2026-08-17.md, IN-9). No try/catch
// test can express it: the per-mailbox catch in runPollInbox has always been
// correct for THROWS, and the loop was still fully in-class because every
// mailbox drew on ONE shared SEND_PIPELINE_TENANT_BUDGET_MS (135s) while a
// single engine poll may consume ENGINE_REQUEST_TIMEOUT_MS (120s), over a
// mailbox list with no ORDER BY.
//
// So one mailbox whose IMAP host black-holes connections burned nearly the whole
// tenant budget: mailboxes 2..N were never polled AND runScheduledTick never ran
// — the tenant sent nothing, every 5-minute cycle, permanently.

import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { EmailPort, PollResult } from "@coldstart/shared";
import { runPollInbox } from "../src/engine/reply-processor.js";
import { runTick } from "../src/engine/tick.js";
import { CRON_PERIOD_MS } from "../src/admin/ops-sweep.js";
import { signup, tenantStub, withTenantContext } from "./helpers.js";

const WEDGED = "a-wedged@stall.test";
const HEALTHY_1 = "b-healthy@stall.test";
const HEALTHY_2 = "c-healthy@stall.test";

/** One mailbox's poll NEVER resolves; the others answer instantly. */
function stallingEmailPort(inner: EmailPort, wedged: string): { port: EmailPort; polled: string[] } {
  const polled: string[] = [];
  const port = new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop !== "poll") return Reflect.get(target, prop, receiver);
      return (mailboxEmail: string, sinceCursor: number): Promise<PollResult> => {
        polled.push(mailboxEmail);
        if (mailboxEmail === wedged) return new Promise<PollResult>(() => {}); // never settles
        return Promise.resolve({ events: [], cursor: sinceCursor });
      };
    },
  });
  return { port, polled };
}

function seedMailboxes(tenantId: string): Promise<void> {
  return runInDurableObject(tenantStub(tenantId), (_i, state) => {
    state.storage.sql.exec(
      `INSERT INTO domains (id, tenant_id, domain, status, purchased_at, connection_type) VALUES ('dom_s', ?, 'stall.test', 'active', 0, 'purchased')`,
      tenantId,
    );
    for (const email of [WEDGED, HEALTHY_1, HEALTHY_2]) {
      state.storage.sql.exec(
        `INSERT INTO mailboxes (id, tenant_id, domain_id, domain, email, daily_cap, warmup_started_at, created_at, provider, poll_cursor)
         VALUES (?, ?, 'dom_s', 'stall.test', ?, 50, 0, 0, 'google', 0)`,
        `mbx_${email.split("@")[0]}`,
        tenantId,
        email,
      );
    }
  });
}

describe("T3/IN-9 — one wedged mailbox must not consume the whole tenant budget every cycle", () => {
  it("polls every mailbox across three cycles and still returns in time for the tick", async () => {
    const { tenantId } = await signup("Stall Co", "founder@stall.test");
    await seedMailboxes(tenantId);

    // Shrunk budgets via the injectable seam — the fairness property is about
    // wall-clock starvation, so it cannot be asserted at the real 30s/60s. The
    // ratio is what matters and is preserved: the wedged mailbox consumes its
    // whole per-mailbox budget, which then exhausts the phase budget, exactly as
    // 30s of a 60s phase would.
    const BUDGETS = { mailboxBudgetMs: 50, phaseBudgetMs: 40 };
    const firstPolledPerCycle: string[] = [];
    const everPolled = new Set<string>();

    for (let cycle = 0; cycle < 3; cycle++) {
      const cyclePolled = await withTenantContext(tenantId, async (base) => {
        const { port, polled } = stallingEmailPort(base.adapters.email, WEDGED);
        // Pre-fix this call NEVER RESOLVES for a cycle whose rotation reaches
        // the wedged mailbox: the poll had no per-mailbox budget, so the whole
        // tenant sat on one hung IMAP connection until the cron leg abandoned
        // the poll+tick pair, and the tick never ran.
        await runPollInbox({ ...base, adapters: { ...base.adapters, email: port } }, BUDGETS);
        return polled;
      });
      expect(cyclePolled.length).toBeGreaterThan(0);
      firstPolledPerCycle.push(cyclePolled[0]!);
      for (const email of cyclePolled) everPolled.add(email);
      // A whole cron period, so the cycle-derived rotation offset steps.
      await tenantStub(tenantId).advanceClock(CRON_PERIOD_MS);
    }

    // FAIRNESS: every mailbox was reached at least once across the three cycles.
    expect([...everPolled].sort()).toEqual([WEDGED, HEALTHY_1, HEALTHY_2].sort());
    // ...and it is ROTATION that achieves it, not luck: the head of the queue is
    // a different mailbox each cycle. Without the offset, the same mailbox would
    // lead every cycle and the two behind a wedged one would starve forever.
    expect(new Set(firstPolledPerCycle).size).toBe(3);

    // The healthy mailboxes genuinely COMPLETED (cursor stamped), so this is
    // real progress, not merely "the call returned".
    const synced = await runInDurableObject(tenantStub(tenantId), (_i, state) =>
      state.storage.sql
        .exec<{ email: string; last_polled_at: number | null }>(`SELECT email, last_polled_at FROM mailboxes ORDER BY email`)
        .toArray(),
    );
    expect(synced.find((m) => m.email === HEALTHY_1)!.last_polled_at).not.toBeNull();
    expect(synced.find((m) => m.email === HEALTHY_2)!.last_polled_at).not.toBeNull();
    // The wedged one never completed, so its cursor is deliberately un-advanced:
    // its events are redelivered next cycle and deduped, the same no-loss
    // position as a lost poll response.
    expect(synced.find((m) => m.email === WEDGED)!.last_polled_at).toBeNull();

    // AND THE TICK RUNS. This is the harm the sweep named: with the poll eating
    // the shared budget, runScheduledTick was never reached, so the tenant sent
    // nothing at all while one mailbox was wedged.
    await withTenantContext(tenantId, async (base) => {
      const { port } = stallingEmailPort(base.adapters.email, WEDGED);
      await expect(runTick({ ...base, adapters: { ...base.adapters, email: port } })).resolves.toBeDefined();
    });
  }, 30_000);
});
