import { describe, expect, it } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import { VendorError } from "@coldstart/shared";
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

/** Live mailbox addresses, newest first — the order removeMailboxes selects in. */
function liveMailboxEmails(tenantId: string): Promise<string[]> {
  return runInDurableObject(tenantStub(tenantId), (_i, state) =>
    state.storage.sql
      .exec<{ email: string }>(
        `SELECT email FROM mailboxes WHERE tenant_id = ? AND released_at IS NULL ORDER BY created_at DESC`,
        tenantId,
      )
      .toArray()
      .map((r) => r.email),
  );
}

/**
 * Makes the sandbox mailbox port refuse `stuck` addresses. The Set is read LIVE
 * on every call, so a test can heal the vendor mid-run (`stuck.clear()`) and
 * watch the next retry finish what it owed — the idiom from
 * test/remove-mailboxes-idempotency.test.ts.
 */
async function failReleaseFor(tenantId: string, stuck: Set<string>, attempts: string[]): Promise<void> {
  await runInDurableObject(tenantStub(tenantId), (instance) => {
    const bundle = (instance as unknown as { sandboxAdapters: { mailbox: { release: unknown } } | null }).sandboxAdapters;
    if (!bundle) throw new Error("no cached sandbox bundle to break — seed the tenant first");
    const original = bundle.mailbox.release as (email: string, key: string) => Promise<unknown>;
    bundle.mailbox.release = async (email: string, key: string) => {
      attempts.push(email);
      if (stuck.has(email)) throw new VendorError("mailbox not found at the provider", false, { step: "mailbox release" });
      return original.call(bundle.mailbox, email, key);
    };
  });
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

// B1, docs/adversarial/wave-a-trains-3-4-gate-2026-08-20.md.
//
// THE MEMBER THIS FILE WAS MISSING. The three cases above never exercise a
// same-key retry with `failedCount > 0`, so the guard was green by omission
// while `deduplicated` was wired to `intent.replayed` ALONE — and `replayed`
// means only "a recorded intent already existed for this key", never "this call
// did no work".
//
// That makes the tool's OWN instructed retry lie. `mcp/tools.ts` tells agents:
// "A call that came back with failedCount above zero did NOT finish, so its key
// is not frozen: resend the identical request with the same key until
// failedCount is 0." Wave 1+2 deliberately made `failedCount > 0` non-terminal
// so that retry re-RUNS rather than replaying. So the designed, documented retry
// always lands on `replayed: true` — and the healing call, which makes a real
// vendor release and irreversibly destroys a mailbox, reported
// `deduplicated: true`, i.e. "not new work done just now". Under-reporting
// destruction on the one path whose mistakes cannot be undone.
//
// The answer was already computed and thrown away one line up: releaseMailboxes
// returns {releasedCount, failedCount} and the call site destructured nothing.
describe("B1 — a retry that actually released something is never reported as a replay", () => {
  it("marks the HEALING call fresh and only the true no-op replay as deduplicated", async () => {
    const { tenantId, token } = await signup("Straggler Co", "founder@stragglerco.com");
    await api("/setup-infrastructure", {
      method: "POST",
      token,
      body: setupBody("Straggler Co", "stragglerco.com", 2, 2),
    });
    expect(await liveMailboxes(tenantId)).toBe(4);

    const live = await liveMailboxEmails(tenantId);
    const stuck = new Set([live[2]!]); // inside the 3 this call selects (newest first)
    const attempts: string[] = [];
    await failReleaseFor(tenantId, stuck, attempts);

    // CALL 1 — the vendor refuses one address. A genuine partial.
    const first = await removeN(token, 3, "downgrade-straggler");
    expect(first.body.releasedCount).toBe(2);
    expect(first.body.failedCount).toBe(1);
    expect(first.body.deduplicated).toBe(false);

    // CALL 2 — the vendor heals and the instructed retry FINISHES the downgrade.
    // It makes a real release call and destroys the straggler for good.
    stuck.clear();
    const attemptsBefore = attempts.length;
    const second = await removeN(token, 3, "downgrade-straggler");
    expect(second.body.releasedCount).toBe(3);
    expect(second.body.failedCount).toBe(0);
    expect(attempts.length).toBeGreaterThan(attemptsBefore); // real vendor work
    expect(await liveMailboxes(tenantId)).toBe(1);
    // THE FINDING: work happened, so this is NOT a replay.
    expect(second.body.deduplicated).toBe(false);

    // CALL 3 — now genuinely a no-op re-run: every member is already released.
    //
    // The ageout is REQUIRED to reach it, and that is worth stating. Call 2
    // finished with `failedCount: 0`, so it is terminal and its response is
    // recorded — a third same-key call inside the 30-day window REPLAYS that
    // stored response and never re-enters `removeMailboxes` at all. The flag
    // sees the INTENT layer only; the idempotency layer collapses ABOVE it,
    // invisibly, handing back the recording's own `deduplicated: false`
    // (per provenance.ts the field is defined on the RESPONSE, so a replayed
    // response carrying the original flag is a known gap — benign here because
    // the counts are absolute and accurate; the generic fix is stamping
    // `deduplicated: true` at the single replay site in engine/idempotency.ts,
    // routed to the Wave B alert-state increment). Only once the claim ages
    // out does `fn` re-run and find there is nothing left to do.
    await ageOutRequestClaims(tenantId);
    const attemptsBeforeThird = attempts.length;
    const third = await removeN(token, 3, "downgrade-straggler");
    expect(third.body.releasedCount).toBe(3);
    expect(third.body.failedCount).toBe(0);
    expect(attempts.length).toBe(attemptsBeforeThird); // zero vendor calls
    expect(await liveMailboxes(tenantId)).toBe(1);
    expect(third.body.deduplicated).toBe(true);
  });
});
