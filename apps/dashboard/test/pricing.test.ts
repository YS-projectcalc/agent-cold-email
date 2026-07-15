import { describe, expect, it } from "vitest";
import {
  MAX_SELF_SERVE_MAILBOXES,
  MINIMUM_BILLABLE_MAILBOXES,
  quoteProvisionedMailboxes,
} from "@coldstart/shared";

describe("provisioned-mailbox quote", () => {
  it.each([
    [5, 9_900, 2, 3_300],
    [10, 14_900, 4, 6_600],
    [20, 24_900, 7, 13_200],
    [60, 64_900, 20, 39_600],
  ])("quotes %i mailboxes deterministically", (mailboxes, monthlyCents, domains, sends) => {
    expect(quoteProvisionedMailboxes(mailboxes)).toEqual({
      mailboxes,
      monthlyCents,
      estimatedDomains: domains,
      planningSendsPerMonth: sends,
    });
  });

  it("keeps self-serve quotes inside the published 5–60 mailbox boundary", () => {
    expect(quoteProvisionedMailboxes(1).mailboxes).toBe(MINIMUM_BILLABLE_MAILBOXES);
    expect(quoteProvisionedMailboxes(100).mailboxes).toBe(MAX_SELF_SERVE_MAILBOXES);
  });
});
