import { describe, expect, it } from "vitest";
import { api, mintTenant, tenantStub } from "./helpers.js";

interface AccountResponse {
  usageCents: number;
}

// B1 brief: "Ensure per-mailbox/mo + per-send metering aggregates correctly
// into account().usageCents." Paid-tier only (SEE engine/provisioning.ts
// comment) — demo/free's usageCents stays send-fee-only, proven as a
// regression by the UNCHANGED e2e.test.ts assertion (usageCents === 8 for a
// demo tenant with 4 mailboxes + 4 sends, i.e. 4 * 2c, no mailbox fee).
describe("metering aggregates per-mailbox/mo + per-send fees for a paid tenant", () => {
  it("adds a mailbox provisioning fee at setup time, then a send fee on top after a tick", async () => {
    const { tenantId, token } = await mintTenant("Metering Co", "launch");

    const setup = await api("/setup-infrastructure", {
      method: "POST",
      token,
      body: JSON.stringify({
        brand: "Metering Co",
        primaryDomain: "metering.com",
        domains: 1,
        inboxesEach: 2, // 2 mailboxes x 600c/mo fee = 1200c
        persona: "Sender",
        physicalAddress: "1 Metering St",
        senderIdentity: "Sender <s@metering.com>",
      }),
    });
    expect(setup.status).toBe(202);

    const afterSetup = await api<AccountResponse>("/account", { token });
    expect(afterSetup.body.usageCents).toBe(1200); // 2 mailboxes x 600c, no sends yet

    // No clock advance needed — day-1 warmup cap is 5/day (> 0), so a fresh
    // mailbox can already send; advanceClock is sandbox(demo/free)-only
    // anyway and this tenant is a paid plan (see tenant-do.ts).
    await api("/campaigns", {
      method: "POST",
      token,
      body: JSON.stringify({
        name: "Metering campaign",
        offer: "x",
        leads: [{ email: "lead@metering-leads-test.com", firstName: "L", company: "Co" }],
        sequence: [{ step: 1, subject: "Hi", body: "Hi", delayDays: 0 }],
      }),
    });
    const tick = await tenantStub(tenantId).tick();
    expect(tick.sent).toBe(1);

    const afterSend = await api<AccountResponse>("/account", { token });
    expect(afterSend.body.usageCents).toBe(1202); // 1200c mailbox fees + 2c send fee
  });

  it("retrying an identical setup_infrastructure call does not double-charge the mailbox fee (idempotent on retry)", async () => {
    // The sandbox DomainPort's searchLookalikes is deterministic per
    // (brand, primaryDomain, count) — see vendors/sandbox/domain-port.ts —
    // and the persona/domain/mailbox-index combo drives the mailbox
    // provisioning idempotency key (engine/provisioning.ts). So an agent
    // retry with IDENTICAL params (e.g. a dropped response, retried
    // request) reproduces the same key, exercising the same
    // `source_send_id`-anchored idempotency as tick.ts's send path.
    const { token } = await mintTenant("Idempotent Metering Co", "growth");
    const setupOnce = async () =>
      api("/setup-infrastructure", {
        method: "POST",
        token,
        body: JSON.stringify({
          brand: "Idempotent Metering Co",
          primaryDomain: "idempotentmetering.com",
          domains: 1,
          inboxesEach: 1,
          persona: "Sender",
          physicalAddress: "1 St",
          senderIdentity: "Sender <s@idempotentmetering.com>",
        }),
      });

    await setupOnce();
    const afterFirst = await api<AccountResponse>("/account", { token });
    expect(afterFirst.body.usageCents).toBe(600); // 1 mailbox x 600c

    await setupOnce(); // identical retry
    const afterSecond = await api<AccountResponse>("/account", { token });
    expect(afterSecond.body.usageCents).toBe(600); // unchanged — not double-charged
  });
});
