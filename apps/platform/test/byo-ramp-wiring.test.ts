import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ONE_DAY_MS } from "../src/engine/warmup.js";
import { api, signup, tenantStub } from "./helpers.js";

// Integration test for SPEC.md §20.2/§20.5's ramp-tier wiring
// (mailbox-state.ts's rampTierByMailboxId + computeMailboxWarmupState), driven
// through the REAL DO — proves the domain-level is_primary/reputation_branch
// columns actually reach a mailbox's live dailyCap, and that an ORDINARY
// provisioned domain's mailbox is completely unaffected (flag-dark guarantee).

interface MailboxHealth {
  email: string;
  domain: string;
  dailyCap: number;
}
interface InfraStatus {
  mailboxHealth: MailboxHealth[];
}

describe("ramp-tier wiring — primary-domain daily-cap clamp", () => {
  it("clamps a primary domain's mailbox to <=20/mbx/day at a ramp day where standard would exceed it, while its sibling provisioned domain is unaffected", async () => {
    const { tenantId, token } = await signup("Ramp Wiring Co", "founder@rampwiring.com");
    await api("/setup-infrastructure", {
      method: "POST",
      token,
      body: JSON.stringify({
        brand: "Ramp Wiring Co",
        primaryDomain: "rampwiring.com",
        domains: 2,
        inboxesEach: 1,
        persona: "Ops",
        physicalAddress: "1 Test St",
        senderIdentity: "Ops <o@rampwiring.com>",
      }),
    });

    // Mark exactly ONE of the two provisioned domains as primary — direct SQL
    // (there is no facade intent yet that flips an EXISTING provisioned
    // domain to primary; this test isolates the mailbox-state.ts wiring from
    // the intake pipeline that will normally set this).
    let primaryDomainName = "";
    await runInDurableObject(tenantStub(tenantId), async (_instance, state) => {
      const rows = state.storage.sql.exec<{ id: string; domain: string }>(`SELECT id, domain FROM domains`).toArray();
      const first = rows[0]!;
      primaryDomainName = first.domain;
      state.storage.sql.exec(`UPDATE domains SET is_primary = 1 WHERE id = ?`, first.id);
    });

    // Day 22 -- standard schedule = 35/day (day 22-28 band); the primary
    // clamp must cap this mailbox at 20 while the sibling stays at 35.
    await tenantStub(tenantId).advanceClock(21 * ONE_DAY_MS);

    const status = await api<InfraStatus>("/infrastructure-status", { token });
    expect(status.status).toBe(200);
    const primaryMailbox = status.body.mailboxHealth.find((m) => m.domain === primaryDomainName)!;
    const otherMailbox = status.body.mailboxHealth.find((m) => m.domain !== primaryDomainName)!;

    expect(primaryMailbox.dailyCap).toBe(20);
    expect(otherMailbox.dailyCap).toBe(35);
  });
});
