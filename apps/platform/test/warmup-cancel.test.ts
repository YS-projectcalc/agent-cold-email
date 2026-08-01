import { createExecutionContext, createScheduledController, env, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.js";
import { runWarmupCancellationSweep } from "../src/engine/warmup-cancel.js";
import { ONE_DAY_MS, WARMUP_RAMP_DAYS } from "../src/engine/warmup.js";
import { api, signup, tenantStub, withTenantContext } from "./helpers.js";

// Founder ruling 2026-08-02 (ROADMAP.md:25, option b) — InboxKit's warmup pool
// is a RECURRING per-mailbox monthly add-on auto-activated at provisioning. It
// must be cancelled by the platform once the mailbox's ramp completes (day 29),
// so COGS is ~one month per mailbox instead of forever. Cancelling must not
// touch what the mailbox can SEND: the ramp is ours (engine/warmup.ts), so a
// cancelled mailbox still sends at its full post-ramp cap.

interface MailboxRow {
  id: string;
  email: string;
  sent_today: number;
  daily_cap: number;
  warmup_cancelled_at: number | null;
  warmup_cancel_gave_up_at: number | null;
  warmup_cancel_attempts: number;
  [column: string]: SqlStorageValue;
}

async function seedProvisionedTenant(slug: string): Promise<{ tenantId: string; token: string }> {
  const domain = `${slug}.com`;
  const { tenantId, token } = await signup(slug, `founder@${domain}`);
  await api("/setup-infrastructure", {
    method: "POST",
    token,
    body: JSON.stringify({
      brand: slug,
      primaryDomain: domain,
      domains: 1,
      inboxesEach: 1,
      persona: "Sender",
      physicalAddress: "1 Test St",
      senderIdentity: `Sender <s@${domain}>`,
    }),
  });
  return { tenantId, token };
}

function readMailbox(tenantId: string): Promise<MailboxRow> {
  return runInDurableObject(tenantStub(tenantId), (_i, state) =>
    state.storage.sql
      .exec<MailboxRow>(
        `SELECT id, email, sent_today, daily_cap, warmup_cancelled_at, warmup_cancel_gave_up_at, warmup_cancel_attempts
         FROM mailboxes LIMIT 1`,
      )
      .one(),
  );
}

function updateMailboxSource(tenantId: string, mailboxId: string, source: string): Promise<void> {
  return runInDurableObject(tenantStub(tenantId), (_i, state) => {
    state.storage.sql.exec(`UPDATE mailboxes SET source = ? WHERE id = ?`, source, mailboxId);
  });
}

function readActions(tenantId: string): Promise<{ action: string; target: string; detail_json: string }[]> {
  return runInDurableObject(tenantStub(tenantId), (_i, state) =>
    state.storage.sql
      .exec<{ action: string; target: string; detail_json: string }>(
        `SELECT action, target, detail_json FROM deliverability_actions WHERE action LIKE 'WARMUP_%' ORDER BY ts ASC`,
      )
      .toArray(),
  );
}

/** Runs the sweep with the mailbox port's cancelWarmup swapped for `impl`. */
function sweepWithCancel(
  tenantId: string,
  impl: (email: string) => Promise<{ cancelled: boolean; cancelledAt: number }>,
): Promise<{ cancelled: number; failed: number; calls: string[] }> {
  return withTenantContext(tenantId, async (ctx) => {
    const calls: string[] = [];
    const patched = {
      ...ctx,
      adapters: {
        ...ctx.adapters,
        mailbox: {
          ...ctx.adapters.mailbox,
          cancelWarmup: async (email: string) => {
            calls.push(email);
            return impl(email);
          },
        },
      },
    };
    const result = await runWarmupCancellationSweep(patched);
    return { ...result, calls };
  });
}

afterEach(() => vi.restoreAllMocks());

describe("warmup auto-cancel at ramp completion (founder ruling 2026-08-02)", () => {
  it("does NOT cancel while the mailbox is still ramping", async () => {
    const { tenantId } = await seedProvisionedTenant("warmupramping");
    // Day 1 — freshly provisioned, nowhere near day 29.
    const result = await sweepWithCancel(tenantId, async () => ({ cancelled: true, cancelledAt: Date.now() }));

    expect(result.calls).toEqual([]);
    expect(result.cancelled).toBe(0);
    expect((await readMailbox(tenantId)).warmup_cancelled_at).toBeNull();
  });

  it("cancels EXACTLY ONCE at the day-29 transition, and never re-fires on later ticks", async () => {
    const { tenantId } = await seedProvisionedTenant("warmuponce");
    await tenantStub(tenantId).advanceClock((WARMUP_RAMP_DAYS + 1) * ONE_DAY_MS);

    const first = await sweepWithCancel(tenantId, async () => ({ cancelled: true, cancelledAt: Date.now() }));
    expect(first.cancelled).toBe(1);
    expect(first.calls).toHaveLength(1);

    const marked = await readMailbox(tenantId);
    expect(marked.warmup_cancelled_at).not.toBeNull();

    // Three more sweeps, including one a week later — the marker, not timing,
    // is what stops it. A naive "cancel when day > 28" with no marker would
    // bill a vendor call on every tick forever.
    const second = await sweepWithCancel(tenantId, async () => ({ cancelled: true, cancelledAt: Date.now() }));
    await tenantStub(tenantId).advanceClock(7 * ONE_DAY_MS);
    const third = await sweepWithCancel(tenantId, async () => ({ cancelled: true, cancelledAt: Date.now() }));

    expect(second.calls).toEqual([]);
    expect(third.calls).toEqual([]);
    expect((await readMailbox(tenantId)).warmup_cancelled_at).toBe(marked.warmup_cancelled_at);

    const actions = await readActions(tenantId);
    expect(actions.filter((a) => a.action === "WARMUP_CANCELLED")).toHaveLength(1);
  });

  it("a vendor failure leaves the marker unset and RETRIES on the next tick", async () => {
    const { tenantId } = await seedProvisionedTenant("warmupretry");
    await tenantStub(tenantId).advanceClock((WARMUP_RAMP_DAYS + 1) * ONE_DAY_MS);

    const failed = await sweepWithCancel(tenantId, async () => {
      throw new Error("inboxkit warmup/cancel 503");
    });
    expect(failed.failed).toBe(1);
    const afterFailure = await readMailbox(tenantId);
    expect(afterFailure.warmup_cancelled_at).toBeNull();
    expect(afterFailure.warmup_cancel_attempts).toBe(1);

    // Next tick succeeds — the retry is what closes it, not a manual fix.
    const retried = await sweepWithCancel(tenantId, async () => ({ cancelled: true, cancelledAt: Date.now() }));
    expect(retried.cancelled).toBe(1);
    expect((await readMailbox(tenantId)).warmup_cancelled_at).not.toBeNull();

    const actions = await readActions(tenantId);
    expect(actions.map((a) => a.action)).toEqual(["WARMUP_CANCEL_FAILED", "WARMUP_CANCELLED"]);
  });

  it("stops retrying at the attempt cap instead of calling the vendor every tick forever", async () => {
    const { tenantId } = await seedProvisionedTenant("warmupgiveup");
    await tenantStub(tenantId).advanceClock((WARMUP_RAMP_DAYS + 1) * ONE_DAY_MS);

    const alwaysFails = async () => {
      throw new Error("inboxkit warmup/cancel: no such subscription");
    };
    let totalCalls = 0;
    for (let i = 0; i < 8; i++) {
      totalCalls += (await sweepWithCancel(tenantId, alwaysFails)).calls.length;
    }

    // 5 attempts then it gives up — NOT 8 (one per sweep, forever).
    expect(totalCalls).toBe(5);
    const row = await readMailbox(tenantId);
    expect(row.warmup_cancel_attempts).toBe(5);
    // Adversary N-c: the give-up marks its OWN column and must NOT write
    // warmup_cancelled_at, which asserts the vendor confirmed. Reading "is this
    // pool still billing?" off that column must never answer "no" because we
    // merely stopped asking.
    expect(row.warmup_cancel_gave_up_at).not.toBeNull();
    expect(row.warmup_cancelled_at).toBeNull();
    const actions = await readActions(tenantId);
    expect(actions.at(-1)!.action).toBe("WARMUP_CANCEL_GAVE_UP");
  });

  it("a given-up mailbox is not swept again (the give-up marker also stops it)", async () => {
    const { tenantId } = await seedProvisionedTenant("warmupgaveupstop");
    await tenantStub(tenantId).advanceClock((WARMUP_RAMP_DAYS + 1) * ONE_DAY_MS);
    const boom = async () => {
      throw new Error("permanent");
    };
    for (let i = 0; i < 5; i++) await sweepWithCancel(tenantId, boom);
    expect((await readMailbox(tenantId)).warmup_cancel_gave_up_at).not.toBeNull();

    // A sweep AFTER the give-up must make no further vendor calls.
    const after = await sweepWithCancel(tenantId, boom);
    expect(after.calls).toEqual([]);
  });

  it("SKIPS a BYO-connected mailbox, which never had a pool subscription", async () => {
    // Adversary N-e: engine/byo-mailbox-composition.ts inserts BYO mailboxes
    // with a real warmup_started_at but never calls startWarmup, so the ramp
    // math alone cannot tell them apart. Without the source filter the sweep
    // burns the full attempt budget on resolveMailboxUid failures and files a
    // false give-up per BYO mailbox.
    const { tenantId } = await seedProvisionedTenant("warmupbyo");
    await tenantStub(tenantId).advanceClock((WARMUP_RAMP_DAYS + 1) * ONE_DAY_MS);
    const row = await readMailbox(tenantId);
    await updateMailboxSource(tenantId, row.id, "byo_connected");

    const swept = await sweepWithCancel(tenantId, async () => ({ cancelled: true, cancelledAt: Date.now() }));

    expect(swept.calls).toEqual([]);
    expect(swept.cancelled).toBe(0);
    const after = await readMailbox(tenantId);
    expect(after.warmup_cancelled_at).toBeNull();
    expect(after.warmup_cancel_gave_up_at).toBeNull();
    expect(await readActions(tenantId)).toEqual([]);
  });

  it("a warmup-cancelled mailbox still SENDS at its full post-ramp cap", async () => {
    const { tenantId, token } = await seedProvisionedTenant("warmupstillsends");
    await tenantStub(tenantId).advanceClock((WARMUP_RAMP_DAYS + 1) * ONE_DAY_MS);
    await sweepWithCancel(tenantId, async () => ({ cancelled: true, cancelledAt: Date.now() }));
    expect((await readMailbox(tenantId)).warmup_cancelled_at).not.toBeNull();

    await api("/campaigns", {
      method: "POST",
      token,
      body: JSON.stringify({
        name: "c",
        offer: "x",
        leads: [{ email: "lead@warmupstillsends-leads.com", firstName: "L", company: "Co" }],
        sequence: [{ step: 1, subject: "Hi", body: "Hi", delayDays: 0 }],
      }),
    });
    const ticked = await tenantStub(tenantId).tick();

    expect(ticked.sent).toBe(1);
    const row = await readMailbox(tenantId);
    expect(row.daily_cap).toBe(40); // fully warmed — cancelling the pool changed nothing
    expect(row.sent_today).toBe(1);
  });

  // A1 (BLOCKING, adversary warmup-wave review 2026-08-02). The sweep used to
  // run ONLY inside runTick, and nothing in production calls tick() — no cron
  // entry, no route, no MCP tool, no DO alarm. So the shipped code could never
  // have cancelled anything while the site claimed in the present tense that it
  // does. These two tests are the ones that would have caught that: they assert
  // the sweep is reachable from the REAL production driver, not from a test
  // calling tick() directly.
  it("A1 — the TenantDO exposes warmupCancelSweep as its own cron-callable RPC", async () => {
    const { tenantId } = await seedProvisionedTenant("warmupdorpc");
    await tenantStub(tenantId).advanceClock((WARMUP_RAMP_DAYS + 1) * ONE_DAY_MS);

    const result = await tenantStub(tenantId).warmupCancelSweep();

    expect(result).toEqual({ cancelled: 1, failed: 0 });
    expect((await readMailbox(tenantId)).warmup_cancelled_at).not.toBeNull();
  });

  it("A1 — the CRON entry point reaches the sweep (this is the only production driver)", async () => {
    const { tenantId } = await seedProvisionedTenant("warmupcron");
    await tenantStub(tenantId).advanceClock((WARMUP_RAMP_DAYS + 1) * ONE_DAY_MS);
    expect((await readMailbox(tenantId)).warmup_cancelled_at).toBeNull();

    // Drive the REAL scheduled() export, exactly as the wrangler.toml cron
    // trigger does — no direct call to the sweep, no tick().
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 200 }));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController(), env, ctx);
    await waitOnExecutionContext(ctx);
    logSpy.mockRestore();
    vi.restoreAllMocks();

    expect((await readMailbox(tenantId)).warmup_cancelled_at).not.toBeNull();
    expect((await readActions(tenantId)).map((a) => a.action)).toEqual(["WARMUP_CANCELLED"]);
  });

  it("the tick drives the sweep end to end, with the sandbox port's no-op cancel", async () => {
    const { tenantId } = await seedProvisionedTenant("warmupviatick");
    await tenantStub(tenantId).advanceClock((WARMUP_RAMP_DAYS + 1) * ONE_DAY_MS);
    expect((await readMailbox(tenantId)).warmup_cancelled_at).toBeNull();

    await tenantStub(tenantId).tick();

    // No adapter patching here — this is the real wiring through runTick and
    // the real SandboxMailboxPort.cancelWarmup.
    expect((await readMailbox(tenantId)).warmup_cancelled_at).not.toBeNull();
    expect((await readActions(tenantId)).map((a) => a.action)).toEqual(["WARMUP_CANCELLED"]);
  });

  it("never cancels ANOTHER tenant's mailbox (per-tenant isolation, CLAUDE.md rule h)", async () => {
    const a = await seedProvisionedTenant("warmupisoa");
    const b = await seedProvisionedTenant("warmupisob");
    await tenantStub(a.tenantId).advanceClock((WARMUP_RAMP_DAYS + 1) * ONE_DAY_MS);
    await tenantStub(b.tenantId).advanceClock((WARMUP_RAMP_DAYS + 1) * ONE_DAY_MS);

    const bEmail = (await readMailbox(b.tenantId)).email;
    const swept = await sweepWithCancel(a.tenantId, async () => ({ cancelled: true, cancelledAt: Date.now() }));

    expect(swept.cancelled).toBe(1);
    expect(swept.calls).not.toContain(bEmail);
    // B is untouched by A's sweep — its own tick is what would cancel it.
    expect((await readMailbox(b.tenantId)).warmup_cancelled_at).toBeNull();
  });

  it("skips a released (torn-down) mailbox — teardown already cancelled it vendor-side", async () => {
    const { tenantId } = await seedProvisionedTenant("warmupreleased");
    await tenantStub(tenantId).advanceClock((WARMUP_RAMP_DAYS + 1) * ONE_DAY_MS);
    const row = await readMailbox(tenantId);
    await runInDurableObject(tenantStub(tenantId), (_i, state) => {
      state.storage.sql.exec(`UPDATE mailboxes SET released_at = 1 WHERE id = ?`, row.id);
    });

    const swept = await sweepWithCancel(tenantId, async () => ({ cancelled: true, cancelledAt: Date.now() }));

    expect(swept.calls).toEqual([]);
    expect(swept.cancelled).toBe(0);
  });
});
