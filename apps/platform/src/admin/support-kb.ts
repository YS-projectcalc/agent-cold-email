// D1 (brief) — AI support triage: classify an inbound message, then for the
// FAQ-answerable categories draft an answer from a small built-in knowledge
// base grounded in the REAL product (SPEC.md §6 tools, §18 pricing, the
// no-signup demo, §7/§10 guardrails, honest limitations). Pure functions —
// no I/O, no clock — so classification/drafting is unit-testable in
// isolation, same shape as engine/deliverability.ts's `evaluate`.

export type SupportCategory = "billing" | "deliverability" | "how-to" | "abuse-report" | "other";

// Order matters: abuse-report is checked FIRST — a message that mentions
// abuse/phishing alongside e.g. billing words must still escalate, never
// auto-answer. billing/deliverability/how-to are checked in a fixed order
// after that; "other" is the fallback when nothing matches.
const ABUSE_REPORT_RE = /\b(abuse|phishing|scam|fraud|unauthorized|impersonat\w*|spam complaint|report(ing)? (this|you|abuse))\b/i;
const BILLING_RE = /\b(bill(ing)?|invoice|charge(d)?|payment|refund|subscription|price|pricing|card (declined|failed)|receipt|past.?due|cancel my)\b/i;
const DELIVERABILITY_RE = /\b(bounc\w*|spam folder|not delivered|deliverability|domain burn\w*|reputation|blacklist|blocklist|warmup|inbox placement)\b/i;
const HOWTO_RE = /\b(how do i|how to|getting started|get started|set ?up|setup|configure|documentation|docs|mcp|api key|token|connect (my )?agent)\b/i;

export function classifySupportMessage(subject: string, body: string): SupportCategory {
  const text = `${subject}\n${body}`;
  if (ABUSE_REPORT_RE.test(text)) return "abuse-report";
  if (BILLING_RE.test(text)) return "billing";
  if (DELIVERABILITY_RE.test(text)) return "deliverability";
  if (HOWTO_RE.test(text)) return "how-to";
  return "other";
}

// SPEC.md §18 canonical pricing curve (kept as prose here, not re-imported from
// @coldstart/shared, so a support draft never accidentally quotes a stale
// computed number mid-refactor — this KB is deliberately a static, reviewable
// snapshot of the pricing page copy). The quantity-billing migration (design
// §11) rewrote this from the retired 3-tier ladder ($99/$299/$799 + a wrong
// $13/mailbox) to the single continuous per-mailbox curve.
function draftBillingAnswer(): string {
  return (
    "Pricing is one continuous per-mailbox plan (no tiers, domains bundled, no separate send meter): " +
    "$49/mo platform + $10/mo per provisioned mailbox, minimum 5 mailboxes ($99/mo). So 5 mailboxes is $99, " +
    "10 is $149, 20 is $249, 60 is $649; 61+ mailboxes is a custom quote. The bill follows the mailboxes you " +
    "actually have — provisioning more raises it, removing mailboxes lowers it (no mid-cycle credit; the lower " +
    "price takes effect at your next renewal). Free/Demo is $0, sandbox-only (no real sends). Billing runs on " +
    "Stripe (currently test mode); check `account()` (or GET /account) for your current plan, mailbox count, and billing status."
  );
}

function draftHowToAnswer(): string {
  return (
    "This platform is driven by your coding agent, not a dashboard: point it at the hosted MCP endpoint with your bearer token " +
    "(or the CLI twin) and it gets ~12 tools — setup_infrastructure, infrastructure_status, launch_campaign, campaign_results, " +
    "metrics, inbox, thread, reply, mark, pause, pause_all, account. `npx agent-cold-email demo` runs the full pipeline " +
    "against the live sandbox with no signup if you want to see it work first."
  );
}

function draftDeliverabilityAnswer(): string {
  return (
    "Deliverability is run by an automated AI control loop, not a manual specialist team: it watches bounce/complaint rate and " +
    "warmup health per mailbox, auto-throttles or pauses a degrading one, and auto-retires + replaces a burning domain — " +
    "domain burn of 8-18%/month is normal and handled automatically, not a failure. Honest limit: this automates the RESPONSE " +
    "within Gmail/Microsoft's rules; it can't change how they judge a domain, and there is no guaranteed inbox placement."
  );
}

/** Null = not FAQ-answerable — the message escalates instead of auto-drafting. */
export function draftAnswerFor(category: SupportCategory): string | null {
  switch (category) {
    case "billing":
      return draftBillingAnswer();
    case "how-to":
      return draftHowToAnswer();
    case "deliverability":
      return draftDeliverabilityAnswer();
    case "abuse-report":
    case "other":
      return null;
  }
}

export interface SupportTriageResult {
  category: SupportCategory;
  draft: string | null;
  /** 'open' = FAQ-drafted, awaiting the owner's send (real send is an activation step). 'escalated' = flagged for the owner, no draft. */
  status: "open" | "escalated";
}

export function triageSupportMessage(subject: string, body: string): SupportTriageResult {
  const category = classifySupportMessage(subject, body);
  const draft = draftAnswerFor(category);
  return { category, draft, status: draft ? "open" : "escalated" };
}
