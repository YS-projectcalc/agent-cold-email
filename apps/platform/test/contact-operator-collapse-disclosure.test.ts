import { describe, expect, it } from "vitest";
import { api, signup } from "./helpers.js";

// IN-1 + IN-2, docs/adversarial/class-sweep-dedup-semantics-2026-08-17.md.
// CONFIRMED LIVE by the audit (F7, probe 2: the same `sup_bdeaf511-…` came back
// twice).
//
// `admitContactOperatorCall` dedups on `(body, urgency)` over a 60-minute
// window, and `contactOperator` returned `{ticketId, note}` with the IDENTICAL
// REPLY_NOTE for a filed ticket and a collapsed one. No client — MCP or REST —
// could tell them apart. So an agent's second, genuinely new "Any update?" 50
// minutes later came back looking exactly like a freshly filed ticket, and the
// agent had no way to learn its message reached nobody.
//
// THE KEY ITSELF STAYS COARSE, deliberately. It is rate control: the guard
// admits 5 calls/hour and every admission can cost an ops email, so collapsing
// an identical resend is the point. (It is already escalation-aware — the key
// includes `urgency`, so the same text at a HIGHER urgency files a new ticket;
// that was gate finding #6.) What was wrong is the pairing the class is defined
// by: a coarse key AND an undisclosed collapse. This closes the disclosure half,
// which is the half `Collapsed<T>` exists for and the half the sweep's own G1
// guard prescribes.

interface ContactOperatorBody {
  ticketId: string;
  note: string;
  deduplicated?: boolean;
}

function contact(token: string, body: string, urgency?: "normal" | "needs_human") {
  return api<ContactOperatorBody>("/messages/contact-operator", {
    method: "POST",
    token,
    body: JSON.stringify(urgency ? { body, urgency } : { body }),
  });
}

const ASK = "Any update on the domain setup?";

describe("IN-2 — a collapsed contact_operator call must not look like a filed ticket", () => {
  it("discloses the collapse on an identical resend inside the window", async () => {
    const { token } = await signup("Contact Dedup Co", "founder@contactdedup.test");

    const first = await contact(token, ASK);
    expect(first.status).toBe(201);
    expect(first.body.deduplicated).toBe(false);

    const second = await contact(token, ASK);
    expect(second.status).toBe(201);
    // Same ticket — the collapse itself is unchanged...
    expect(second.body.ticketId).toBe(first.body.ticketId);
    // ...but it now SAYS so, which is the whole finding.
    expect(second.body.deduplicated).toBe(true);
  });

  it("does not mark a genuinely new message as deduplicated", async () => {
    const { token } = await signup("Contact Fresh Co", "founder@contactfresh.test");

    const first = await contact(token, "First question about billing.");
    const second = await contact(token, "Second, different question about DNS.");

    expect(first.body.deduplicated).toBe(false);
    expect(second.body.deduplicated).toBe(false);
    expect(second.body.ticketId).not.toBe(first.body.ticketId);
  });

  // The escalation path (gate finding #6) is untouched: same text, higher
  // urgency is a NEW ticket, not a collapse.
  it("treats a raised-urgency resend as a new ticket, not a dedup", async () => {
    const { token } = await signup("Contact Escalate Co", "founder@contactescalate.test");

    const normal = await contact(token, ASK, "normal");
    const escalated = await contact(token, ASK, "needs_human");

    expect(escalated.body.ticketId).not.toBe(normal.body.ticketId);
    expect(escalated.body.deduplicated).toBe(false);
  });
});
