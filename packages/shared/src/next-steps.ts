/**
 * `nextSteps` — the self-guiding half of a response (design §7.2).
 *
 * THE PROBLEM IT EXISTS FOR: a terminal `setup_infrastructure` response said
 * `{jobId, billing}` and nothing else, so a customer whose call provisioned one
 * domain of the two they were paying for learned nothing about the second — an
 * operator had to write the message. Every surface that can say what remains
 * now says it, in a form an unattended agent can execute rather than parse.
 *
 * ONE DERIVATION, THREE CONSUMERS (`deriveNextSteps` in
 * apps/platform/src/engine/next-steps.ts): responses embed it, the stuck-customer
 * check counts it, and the nudge renders from it. There is no second copy to
 * drift — which is the whole answer to "how does it stay TRUE by construction".
 *
 * The types live here, in shared, so the dashboard imports them rather than
 * hand-mirroring a tenth DTO copy.
 */

/**
 * Closed union. The runtime array is the source of truth and the type is
 * derived from it, so a new reason cannot be added without the doc-coverage
 * guard seeing it.
 */
export const NEXT_STEP_REASONS = [
  /** Paying, and NOTHING is provisioned. Unambiguous — the only unambiguously-owed seat state. */
  "paid_seats_unprovisioned",
  /** At the 5-seat floor with 1..4 provisioned: the remaining mailboxes cost $0. NEVER owed. */
  "seat_headroom_free",
  /** A live domain's mail DNS has not come up yet. */
  "domain_dns_incomplete",
  /** An ordinal was REQUESTED and never completed — an intent with no live domain, past grace. */
  "ordinal_incomplete",
  /** The platform stopped and only an operator can restart it. */
  "setup_operator_blocked",
  /** A spend-ceiling / plan-slot hold. Distinct from operator-blocked: nothing failed. */
  "setup_capacity_held",
  /** Our Stripe quantity push did not land. OURS to fix, never the customer's. */
  "billed_quantity_drift",
  /** Lifecycle freeze — re-checkout is the way out. */
  "account_frozen",
  /** An unacked message the account will not progress past. */
  "message_action_required",
  /** A provisioned mailbox's credentials have not reached the send engine yet. */
  "mailbox_credentials_pending",
  /** Infrastructure is up and no campaign exists. */
  "ready_to_launch",
] as const;
export type NextStepReason = (typeof NEXT_STEP_REASONS)[number];

/** The MCP tools a step can name. Every member must be a real tool in `mcp/tools.ts` (guard G3). */
export type NextStepTool =
  | "setup_infrastructure"
  | "launch_campaign"
  | "contact_operator"
  | "ack_message"
  | "configure_byo_domain";

/**
 * How the caller acts.
 *
 * A DISCRIMINATED UNION, and `via` is always present, so "no action is
 * possible" is a STATED value rather than an empty object a shape-guessing
 * consumer has to interpret. It also makes a non-tool action expressible:
 * there is no `checkout` MCP tool (verified against `mcp/tools.ts`), and a
 * frozen account's only way out is an HTTP POST.
 */
export type NextStepAction =
  | {
      via: "mcp_tool";
      tool: NextStepTool;
      /** Literal arguments, complete EXCEPT the names listed in `paramsToSupply`. */
      params: Record<string, unknown>;
      /**
       * Fields the PLATFORM cannot know and the caller must add. Empty = send
       * `params` verbatim.
       *
       * A SIBLING ARRAY, never a magic sentinel inside `params` (gate L1): a
       * placeholder string gets JSON-serialised and sent by an unattended
       * agent, then fails zod — the same class of failure this contract exists
       * to close.
       *
       * Computed PER FIELD by emptiness, never from a "this tenant has never
       * provisioned" population test (§7.17.6). Asking an agent to re-supply a
       * brand the platform already holds is the mirror image of the defect
       * this wave fixes: the platform knowing something and not saying it,
       * inverted into the platform knowing something and pretending not to.
       */
      paramsToSupply: string[];
      /** The key to REUSE, or null = mint a fresh one. Never a key we invented. */
      idempotencyKey: string | null;
    }
  | { via: "http"; method: "POST"; path: string; note: string }
  /** Nothing the caller can do; the note says who acts and what unblocks it. */
  | { via: "none"; note: string };

/**
 * The billing consequence of a step, from `buildMailboxBilling` — the SAME
 * projection the response's own `billing` field carries, so a step's claim
 * about the bill is the bill.
 *
 * Lives in shared (rather than beside its builder in the platform engine)
 * because `NextStep.effect` is part of the published contract and a shared type
 * cannot reference a platform-internal one.
 */
export interface MailboxBilling {
  /**
   * The mailbox count this projection is for — REALITY, not the ask (SPEC §18
   * "the proposed new count"). On an actual add/remove it is the live provisioned
   * count AFTER the operation (so a capacity_pending partial reflects only what
   * landed); on a quoteOnly preview it is the projected count (current + delta).
   */
  provisionedAfter: number;
  /** Projected monthly price for that count on the curve, folding any stored
   *  checkout discount, integer cents. Floors at the 5-mailbox / $99 minimum. */
  projectedMonthlyCents: number;
  /** Human-readable pricing formula (SPEC §18) so no add is a silent bill surprise. */
  formula: string;
}

export interface NextStep {
  reason: NextStepReason;
  /**
   * owed      = the account will not progress until this happens.
   * available = nothing is blocked; this is the next thing worth doing.
   *
   * ONLY `owed` steps feed the stuck-customer check and the nudge. That makes
   * `kind` load-bearing for two independent suppressions, which is why
   * `seat_headroom_free` being permanently `available` is guarded rather than
   * merely intended (§7.18.5).
   */
  kind: "owed" | "available";
  /** One customer-safe sentence. Vendor-blind: composed prose, never `err.message`. */
  why: string;
  action: NextStepAction;
  /** Who must act before this can succeed. null = the agent can act right now. */
  waitingOn: "operator" | "customer_billing" | null;
  /** Do not repeat this call before `notBeforeMs` from now — the retry CADENCE as a machine field. 0 = now. */
  notBeforeMs: number;
  /** null when the step changes no billable count. */
  effect: MailboxBilling | null;
  /** How long this condition has existed, when an HONEST anchor exists; null when none does. */
  sinceMs: number | null;
}

export interface NextSteps {
  /**
   * EXPLICIT discriminator. An empty `steps` array must never be the only
   * signal — a shape-only classifier cannot tell "nothing is owed" from "not
   * computed", and `none_owed` is routinely emitted WITH a non-empty `steps`
   * (an `available` step is not owed).
   */
  status: "owed" | "none_owed";
  steps: NextStep[];
  computedAt: number;
}
