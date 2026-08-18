// U1 of the head-of-line class sweep (docs/adversarial/class-sweep-hol-blocking-
// 2026-08-17.md) — SETTLED AS REAL, and worse than the sweep predicted.
//
// The sweep expected an unset TOKEN_HASH_PEPPER to be harmless (`TextEncoder`
// coercing `undefined` to the string "undefined") and only the EMPTY string to
// throw. Probed in workerd, BOTH throw: `new TextEncoder().encode(undefined)`
// yields a ZERO-length array exactly like `encode("")`, and WebCrypto rejects
// zero-length raw HMAC key material with
//   DataError: Imported HMAC key length (0) must be a non-zero value ...
//
// The throw used to happen inside the due-row loop, AFTER the atomic claim — so
// it aborted every remaining due row with no per-row grading, no 'failed' event
// and no alert, and left the claimed row churning attempts through the stuck-
// 'sending' reclaim. Silent total send stoppage, invisible to the watchtower's
// send_starved check (which fires only when ZERO mailboxes are eligible — here
// they all are).

import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { runTick } from "../src/engine/tick.js";
import { listSurfacedTenantMessages } from "../src/engine/tenant-messages.js";
import { deriveUnsubscribeKey } from "../src/unsubscribe-token.js";
import { ONE_DAY_MS, WARMUP_RAMP_DAYS } from "../src/engine/warmup.js";
import { api, signup, tenantStub, withTenantContext } from "./helpers.js";

const ONE_STEP = [{ step: 1, subject: "Hi", body: "Hi", delayDays: 0 }];

async function tenantWithDueSends(brand: string, primaryDomain: string) {
  const { tenantId, token } = await signup(brand, `founder@${primaryDomain}`);
  await api("/setup-infrastructure", {
    method: "POST",
    token,
    body: JSON.stringify({
      brand,
      primaryDomain,
      domains: 1,
      inboxesEach: 1,
      persona: "Sender",
      physicalAddress: "1 Test St",
      senderIdentity: `Sender <s@${primaryDomain}>`,
    }),
  });
  await tenantStub(tenantId).advanceClock((WARMUP_RAMP_DAYS + 1) * ONE_DAY_MS);
  await api("/campaigns", {
    method: "POST",
    token,
    body: JSON.stringify({
      name: "Pepper",
      offer: "x",
      leads: Array.from({ length: 3 }, (_v, i) => ({ email: `p${i}@leads-test.com`, firstName: `P${i}`, company: "Co" })),
      sequence: ONE_STEP,
      stopOnReply: true,
    }),
  });
  return { tenantId, token };
}

function sendRowStates(tenantId: string): Promise<{ status: string; attempts: number }[]> {
  return runInDurableObject(tenantStub(tenantId), (_i, state) =>
    state.storage.sql
      .exec<{ status: string; attempts: number }>(`SELECT status, attempts FROM scheduled_sends ORDER BY id`)
      .toArray(),
  );
}

describe("U1 — an unusable TOKEN_HASH_PEPPER is a LOUD refusal, never a silent abort", () => {
  it("the derivation itself rejects an empty pepper by name, not with a raw key-length error", async () => {
    await expect(deriveUnsubscribeKey("")).rejects.toThrow(/TOKEN_HASH_PEPPER/);
    // The unset case reaches the same guard — `encode(undefined)` is zero-length
    // too, which is the half the sweep expected to be benign.
    await expect(deriveUnsubscribeKey(undefined as unknown as string)).rejects.toThrow(/TOKEN_HASH_PEPPER/);
  });

  it("refuses to send, claims NOTHING, burns no attempts, and tells the agent why", async () => {
    const { tenantId } = await tenantWithDueSends("Pepper Co", "pepperco.com");

    const result = await withTenantContext(tenantId, (base) =>
      runTick({ ...base, env: { ...base.env, TOKEN_HASH_PEPPER: "" } }),
    );

    // Pre-fix: runTick REJECTS with a WebCrypto DataError. The first due row is
    // left stuck 'sending' with no 'failed' event, and the other two are never
    // looked at — on this tick and every tick after it.
    expect(result).toEqual({ sent: 0, skipped: 0, deferred: 3 });

    const rows = await sendRowStates(tenantId);
    expect(rows).toHaveLength(3);
    // Nothing claimed, so nothing to reclaim and no attempt burned toward
    // MAX_SEND_ATTEMPTS: the queue survives the outage intact.
    expect(rows.every((r) => r.status === "pending")).toBe(true);
    expect(rows.every((r) => r.attempts === 0)).toBe(true);

    // ...and it is LOUD. Deduped, so a 5-minute cron cannot storm the channel.
    const messages = await withTenantContext(tenantId, (ctx) => listSurfacedTenantMessages(ctx));
    const blocked = messages.filter((m) => m.kind === "send_blocked");
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toMatchObject({ severity: "action_required" });
    // Customer-safe: it names the effect and who owns the fix, never the secret.
    expect(blocked[0]!.body).not.toMatch(/TOKEN_HASH_PEPPER/);
    expect(blocked[0]!.body).toMatch(/contact support/i);

    // A second tick does not multiply the message (the dedup key holds).
    await withTenantContext(tenantId, (base) => runTick({ ...base, env: { ...base.env, TOKEN_HASH_PEPPER: "" } }));
    const after = await withTenantContext(tenantId, (ctx) => listSurfacedTenantMessages(ctx));
    expect(after.filter((m) => m.kind === "send_blocked")).toHaveLength(1);
  }, 30_000);

  it("CONTROL — with a real pepper the same tenant sends normally", async () => {
    const { tenantId } = await tenantWithDueSends("Pepper Ok Co", "pepperokco.com");
    const result = await withTenantContext(tenantId, (base) => runTick(base));
    expect(result.sent).toBe(3);
    const messages = await withTenantContext(tenantId, (ctx) => listSurfacedTenantMessages(ctx));
    expect(messages.some((m) => m.kind === "send_blocked")).toBe(false);
  }, 30_000);
});
