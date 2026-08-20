import { describe, expect, it } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import { api, signup, tenantStub } from "./helpers.js";

// NB-R3-1, docs/adversarial/wave-1-2-integration-gate-2026-08-18.md.
//
// `request_idempotency` rows age out after 30 days; `mailbox_release_intents`
// rows never do. So a key reused after the ageout misses the response replay,
// re-runs `fn`, finds the RECORDED intent, drives nothing (every member is
// already released) and reports `{releasedCount: 3, failedCount: 0}` — byte
// identical to a fresh, successful downgrade of three more mailboxes.
//
// Measured by the gate: 0 vendor calls, live count unchanged. Safe in the sense
// that nothing is destroyed — the recorded intent is what bounds it — but an
// agent that reused a key cannot distinguish this from a real second downgrade,
// and will believe it shrank the fleet while continuing to pay for it.
//
// The fix is the disclosure the codebase already named and left with no
// consumer: `Collapsed<T>`'s `deduplicated` flag (packages/shared/src/
// provenance.ts). This is its first REAL consumer.

function setupBody(brand: string, primaryDomain: string, domains: number, inboxesEach: number) {
  return JSON.stringify({
    brand,
    primaryDomain,
    domains,
    inboxesEach,
    persona: "Sender",
    physicalAddress: "1 Test St",
    senderIdentity: `Sender <s@${primaryDomain}>`,
  });
}

function removeN(token: string, count: number, idempotencyKey?: string) {
  return api<{ releasedCount?: number; failedCount?: number; deduplicated?: boolean }>("/remove-mailboxes", {
    method: "POST",
    token,
    body: JSON.stringify({ count, acknowledged: true }),
    headers: idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined,
  });
}

function liveMailboxes(tenantId: string): Promise<number> {
  return runInDurableObject(tenantStub(tenantId), (_i, state) =>
    state.storage.sql
      .exec<{ n: number }>(`SELECT COUNT(*) as n FROM mailboxes WHERE tenant_id = ? AND released_at IS NULL`, tenantId)
      .one().n,
  );
}

/** The 30-day ageout: the claim is gone, the recorded intent is not. */
function ageOutRequestClaims(tenantId: string): Promise<void> {
  return runInDurableObject(tenantStub(tenantId), (_i, state) => {
    state.storage.sql.exec(`DELETE FROM request_idempotency WHERE key LIKE 'remove_mailboxes:%'`);
  });
}

describe("NB-R3-1 — a downgrade that released nothing must say so", () => {
  it("discloses `deduplicated` on a key reused after the request_idempotency ageout", async () => {
    const { tenantId, token } = await signup("Ageout Co", "founder@ageout.com");
    await api("/setup-infrastructure", { method: "POST", token, body: setupBody("Ageout Co", "ageout.com", 2, 2) });
    expect(await liveMailboxes(tenantId)).toBe(4);

    const first = await removeN(token, 2, "downgrade-ageout");
    expect(first.status).toBe(200);
    expect(first.body.releasedCount).toBe(2);
    expect(first.body.deduplicated).toBe(false); // a real, fresh downgrade
    expect(await liveMailboxes(tenantId)).toBe(2);

    await ageOutRequestClaims(tenantId);

    const reused = await removeN(token, 2, "downgrade-ageout");
    expect(reused.status).toBe(200);
    // Nothing was released — the fleet is unchanged — and the response says so
    // rather than reporting a second successful downgrade of two mailboxes.
    expect(await liveMailboxes(tenantId)).toBe(2);
    expect(reused.body.deduplicated).toBe(true);
  });

  it("a genuine downgrade under a NEW key is not marked deduplicated", async () => {
    const { tenantId, token } = await signup("Fresh Key Co", "founder@freshkey.com");
    await api("/setup-infrastructure", { method: "POST", token, body: setupBody("Fresh Key Co", "freshkey.com", 2, 2) });

    const first = await removeN(token, 1, "fresh-1");
    expect(first.body.deduplicated).toBe(false);
    const second = await removeN(token, 1, "fresh-2");
    expect(second.body.deduplicated).toBe(false);
    expect(await liveMailboxes(tenantId)).toBe(2);
  });

  it("an UNKEYED downgrade resolves per call and is never marked deduplicated", async () => {
    const { tenantId, token } = await signup("Unkeyed Co", "founder@unkeyed.com");
    await api("/setup-infrastructure", { method: "POST", token, body: setupBody("Unkeyed Co", "unkeyed.com", 2, 2) });

    expect((await removeN(token, 1)).body.deduplicated).toBe(false);
    expect((await removeN(token, 1)).body.deduplicated).toBe(false);
    expect(await liveMailboxes(tenantId)).toBe(2);
  });
});
