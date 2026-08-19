// Shared error types. Kept tiny and dependency-free so both the platform
// worker and (later) the CLI/MCP surface can catch/branch on these classes.

export class ValidationError extends Error {
  constructor(message: string, public readonly issues?: unknown) {
    super(message);
    this.name = "ValidationError";
  }
}

/**
 * A vendor-side failure carrying its own transient-vs-permanent grade. Real
 * signals are graded (SMTP 4xx/5xx, an activation-gated stub, a rate-limit vs
 * a bad-credentials error); a handler must branch on that grade instead of
 * attaching one unconditional consequence (A5 spike CLASS A). `retryable`
 * true = transient (safe to re-attempt with backoff/cap); false = permanent
 * (re-attempting can never succeed — fail fast). The engine tick's per-send
 * billing path (engine/tick.ts) reads this: retryable retries under an attempt
 * cap, non-retryable fails immediately, so no infinite-retry path survives.
 */
export class VendorError extends Error {
  /**
   * The ABSTRACT, vendor-blind operation label this failure belongs to
   * (apps/platform/src/vendor-failure.ts's `customerSafeVendorFailure`), e.g.
   * "domain DNS setup". Set by throw sites that already know which step failed
   * but whose message deliberately names no vendor and no endpoint; a customer
   * surface reads it INSTEAD of the message. Never a vendor endpoint path — the
   * path IS a vendor fingerprint (docs/adversarial/sweep-vendor-leak-2026-08-05.md).
   */
  public readonly step?: string;

  /**
   * THE THIRD VALUE (class A, docs/adversarial/class-sweep-vendor-truth-2026-08-18.md).
   * `retryable` carries a two-valued answer to a three-valued question, and the
   * missing third value is the one that cost a customer a week: a refusal that
   * THIS caller cannot clear by retrying, and that nobody needs to change their
   * inputs for, because an OPERATOR clears it and then the SAME retry completes.
   *
   * The live instance: an empty vendor credit wallet refused `/warmup/add`,
   * `retryable:false` rendered to the customer's agent as "Retrying as-is will
   * not help — check your inputs", and the agent correctly disabled its retry
   * loop for a condition a $19 top-up cleared. Same shape for a rotated vendor
   * JWT (401), a delinquent workspace (402/403) and a vendor response whose
   * shape drifted out from under our schema.
   *
   * `retryable` is deliberately UNTOUCHED — openapi.yaml publishes it and ~10
   * sites branch on it, and the two questions are genuinely independent: this
   * flag says WHO can clear the refusal, not whether an immediate re-attempt
   * would work. `operatorActionable` is only ever meaningful alongside
   * `retryable: false` (a retryable failure needs nobody).
   *
   * An OWN enumerable property, like `retryable` and `step`: an error crossing
   * the DO->Worker RPC boundary arrives with its own properties but NO
   * prototype, so every consumer reads the field rather than the class.
   */
  public readonly operatorActionable: boolean;

  constructor(
    message: string,
    public readonly retryable: boolean,
    options?: { cause?: unknown; step?: string; operatorActionable?: boolean },
  ) {
    super(message, options);
    this.name = "VendorError";
    this.step = options?.step;
    this.operatorActionable = options?.operatorActionable ?? false;
  }
}

/**
 * Thrown by every `real/` VendorPort implementation. ARCHITECTURE.md #6 and
 * #8: real vendor adapters are typed stubs coded against public docs but
 * never actually called — they exist so the swap sandbox->real is a
 * provable no-op later, and so a demo/free tenant is structurally unable to
 * reach a live vendor (the adapter factory only ever hands them `sandbox`).
 * A VendorError with `retryable: false` — an unactivated adapter can never
 * become activated by retrying, so a handler must fail fast, never loop.
 */
export class NotActivatedError extends VendorError {
  constructor(vendor: string, op: string) {
    super(
      `${vendor}.${op} is not activated — real vendor adapters are coded stubs only until ACTIVATION.md is executed by the owner.`,
      false,
    );
    this.name = "NotActivatedError";
  }
}

/**
 * Thrown by the domain port's registrar seam whenever `domain.buy` (or any
 * other DomainPort method) is reached without the registrar being armed — G5
 * gate (a), ROADMAP.md:19,33,43 / adversary B1 2026-07-23. The prior factory
 * logic welded `domain.buy` to the mailbox vendor's `inboxKitConfig`, so
 * arming InboxKit for mailboxes silently also armed InboxKit-as-registrar —
 * a money-out path the founder never authorized. `registrarConfig`
 * (`REGISTRAR_PROVIDER`/`CLOUDFLARE_REGISTRAR_API_TOKEN`) is now the ONLY
 * thing that can arm real registrar spend, and even once set, the Cloudflare
 * purchase adapter itself is DEFERRED to the GA wave (its public API's
 * new-domain-purchase coverage is unverified — this codebase does not build
 * dark adapters against an unverified wire shape). So this error fires
 * either way: registrar unarmed, or armed-but-not-yet-implemented. Always
 * `retryable: false` (VendorError) — retrying can't fix either case.
 *
 * WHICH LEG FAILED IS CARRIED, because the two are not the same refusal
 * (design §7.8, gate L2). `selectRealDomainPort` holds both booleans and used
 * to throw both away, so one message served both — and for the `opt_in` leg it
 * was wrong twice: it said *account* when the truth was *this request*, and its
 * "no human has been notified" clause routed an unattended agent to escalate
 * over something its own next call fixes. That is the vendor-truth wave's class
 * A one seam over, and it cost a real customer a support round trip
 * (sup_dce385a8 / sup_9d2c9a3a, 2026-08-18). `error-response.ts` branches on it:
 * `env` keeps today's 503 `registrar_unarmed`, `opt_in` becomes a 400
 * `registrar_optin_missing` naming the field.
 *
 * `reason` is an OWN enumerable property, like `retryable` and `step`: an error
 * crossing the DO->Worker RPC boundary arrives with its own properties but NO
 * prototype, so the mapper reads the field, never the class.
 */
export type RegistrarUnarmedReason = "env" | "opt_in";

export class RegistrarUnarmedError extends VendorError {
  constructor(op: string, public readonly reason: RegistrarUnarmedReason) {
    super(
      reason === "opt_in"
        ? `domain.${op} is blocked: this request did not set registerDomains: true, so the per-tenant registrar opt-in leg is not satisfied for it — real domain purchase requires the tenant's consent on the request that spends.`
        : `domain.${op} is blocked: the registrar is not armed (set REGISTRAR_PROVIDER + CLOUDFLARE_REGISTRAR_API_TOKEN and complete the registrar arming step, ACTIVATION.md gate (a)) or its purchase adapter is not yet built — real domain purchase never happens via the mailbox vendor credential alone.`,
      false,
      // Honest per leg (non-blocking 9). An operator arming the env IS the
      // clearer of the `env` leg; the TENANT clears its own opt-in by resending
      // one field, and telling its agent to go find a human would be the same
      // misdirection this split exists to end.
      { operatorActionable: reason === "env" },
    );
    this.name = "RegistrarUnarmedError";
  }
}

/**
 * Thrown by `engine/domain-dns.ts`'s `setDnsWithRetry` when a provisioned
 * domain's mail DNS WILL NOT come up — the vendor-verdict class fix
 * (docs/adversarial/vendor-verdict-class-sweep-2026-08-14.md). Two conditions
 * produce it: the vendor reported a TERMINAL registration state
 * (expired/suspended/cancelled/…), or the benign "still propagating" state
 * outlived `DNS_PENDING_MAX_MS`.
 *
 * `retryable: false`, and that grade is the whole deliverable. Before it, both
 * conditions surfaced either as a retryable VendorError (which is how one dead
 * vendor call became a 24-hour customer retry loop) or — after C3 part b — as an
 * HTTP 202 `provisioning:"pending"` SUCCESS returned on every call forever, on a
 * paid domain that would never carry a mailbox. Telling the agent to stop is
 * what gets a human involved.
 *
 * NAME. It keeps `name = "VendorError"` rather than taking a distinct one, for
 * the same reason `DomainPropagationPendingError` does: error-response.ts and
 * vendor-failure.ts both discriminate by `name` (an error crossing the
 * DO->Worker RPC boundary arrives with its own properties but NO prototype, so
 * `instanceof` is false at the HTTP surface), and the existing
 * non-retryable-VendorError mapping is already the correct customer response.
 * It lives HERE rather than beside its thrower so the burn-replacement sweep —
 * the one consumer that must tell it apart, in-process, by `instanceof` — can
 * import it without creating a deliverability-actions <-> domain-dns cycle.
 */
export class DomainDnsTerminalError extends VendorError {
  constructor(message: string, step?: string) {
    super(message, false, { step });
    this.name = "VendorError";
  }
}

/**
 * Thrown by the vendor-spend choke-point (`engine/spend-ceiling.ts`
 * `withSpendCeiling`) when a money-out reserve is REJECTED — either the
 * per-calendar-month spend ceiling (`SPEND_CEILING_CENTS`, G2) or the InboxKit
 * plan-slot capacity (`INBOXKIT_PLAN_SLOTS`, G4) would be exceeded. It is a
 * GRACEFUL back-pressure signal, NEVER a hard failure: the provisioning entry
 * points (`runSetupInfrastructure`, the deliverability REPLACE_DOMAIN path)
 * catch it, leave the tenant in a `capacity_pending` state (surfaced by G3's
 * `activationState`), and return without a 500 — the founder alert already
 * fired and a later provision retries once the ceiling/plan is raised.
 * `retryable: false` for the CURRENT call (retrying without raising the
 * ceiling can't succeed), but the reserve was released, so a fresh attempt
 * after the founder acts starts clean. `reason` distinguishes the two causes
 * for the ops alert / any surface that wants to explain the hold.
 */
export class CapacityPendingError extends VendorError {
  constructor(
    public readonly reason: "spend_ceiling" | "slot_capacity",
    message: string,
  ) {
    super(message, false);
    this.name = "CapacityPendingError";
  }
}

/**
 * Thrown by `registrar-arming.ts`'s `assertCompleteRegistrant` — the
 * fail-loud defense-in-depth boundary at the ACTUAL domain-buy call site
 * (`provisioning.ts`'s `provisionDomainWithMailboxes`) when a tenant cleared
 * both registrar-arming legs (armed + opted in) but the registrant this
 * platform has on file for them is missing required fields. Unlike
 * `RegistrarUnarmedError` (an operator-fixable arming gap, generic customer
 * message), this is a TENANT-fixable data gap — `missingFields` names exactly
 * what's absent so the calling agent can re-submit `setup_infrastructure` with
 * a complete `registrant`. `retryable: false` (VendorError) since retrying
 * without supplying the missing fields can't succeed. The Worker's onError
 * maps this to a 4xx naming the fields (index.ts), never a generic 500 —
 * same graceful-surface pattern as `RegistrarUnarmedError`.
 */
export class IncompleteRegistrantError extends VendorError {
  constructor(message: string, public readonly missingFields: string[]) {
    super(message, false);
    this.name = "IncompleteRegistrantError";
  }
}

/** Which send guard refused — one member per check in `engine/guarded-send.ts`. */
export type SendBlockedReason = "suppressed" | "mailbox_paused" | "daily_cap_reached";

/**
 * Thrown by the shared guarded single-send primitive (`engine/guarded-send.ts`)
 * when a one-off send is refused by send governance — warm-lead Q3
 * (ROADMAP.md:76) / adversary R1/R2, `docs/adversarial/
 * warm-lead-thin-layer-design-2026-07-16.md`. A refusal is a normal, expected
 * outcome an agent must be able to branch on, never a silent drop and never an
 * opaque 500: `reason` names the guard that tripped and `retryable` says
 * whether waiting alone can clear it (a daily cap rolls over; a deliverability
 * pause and a suppression do not — both need a state change first). The
 * Worker's onError maps this to 429 when retryable and 409 otherwise, with a
 * `send_blocked` code (index.ts) — the same structured-4xx treatment
 * `IncompleteRegistrantError` gets.
 */
export class SendBlockedError extends Error {
  constructor(
    public readonly reason: SendBlockedReason,
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = "SendBlockedError";
  }
}

export class TenantIsolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TenantIsolationError";
  }
}

/**
 * Thrown when a per-tenant/per-IP rate limit or lifetime cap is exceeded.
 * The Worker's onError maps this to HTTP 429. Used by the demo-run throttle
 * (TenantDO.demoRun); the /signup per-IP limiter returns 429 directly at the
 * HTTP layer without throwing (see routes/signup.ts).
 *
 * `retryAfter` (seconds) is OPTIONAL — msgchannel Inc5's contact_operator
 * storm guard (engine/contact-operator.ts) is the first caller to pass it, so
 * a caller can tell an agent exactly when its window clears instead of just
 * "try again"; every existing throw site (demo-run) omits it and is
 * unaffected (error-response.ts only includes the field when present).
 */
export class RateLimitError extends Error {
  constructor(
    message: string,
    public readonly retryAfter?: number,
  ) {
    super(message);
    this.name = "RateLimitError";
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

/**
 * SPEC.md §19.2/§19.4/§19.5 — optimistic-concurrency conflict on a
 * `dashboard_views` write (PUT /dashboard/views/:id, MCP `configure_dashboard`):
 * the caller's `rev` didn't match the row's current `rev`. Carries the CURRENT
 * rev + layout so the caller (an agent) can rebase its edit onto the latest
 * state and retry, rather than just being told "try again" — the Worker's
 * onError maps this to HTTP 409 with a structured `{ currentRev, currentLayout }`
 * body (not just `{ error }`), and the MCP tool surfaces the same fields.
 */
export class RevConflictError extends Error {
  constructor(
    message: string,
    public readonly currentRev: number,
    public readonly currentLayout: unknown,
  ) {
    super(message);
    this.name = "RevConflictError";
  }
}

/**
 * Thrown when a launch repeats a campaign this tenant launched moments ago with
 * byte-identical content, and no idempotency key distinguished the two.
 *
 * Auto-send is armed, so a duplicate campaign is duplicate REAL cold outreach to
 * the same prospects — quota burn and deliverability damage that cannot be taken
 * back once the tick sends it. A double-click and a dropped-response retry are
 * indistinguishable from a deliberate relaunch at the API, so the launch is
 * REFUSED rather than silently deduped: `existingCampaignId` names what already
 * exists, which is what a caller needs either to stop or to go look. The Worker
 * maps it to HTTP 409.
 */
export class DuplicateCampaignError extends Error {
  constructor(
    message: string,
    public readonly existingCampaignId: string,
  ) {
    super(message);
    this.name = "DuplicateCampaignError";
  }
}

/**
 * Thrown when a mutating intent is retried with the same Idempotency-Key while
 * the FIRST call for that key is still executing — a 'pending' claim row exists
 * (engine/idempotency.ts's claim-then-execute). RETRYABLE by design: the client
 * should retry once the first call records its response (or clears the claim on
 * failure). The Worker maps it to HTTP 409 Conflict.
 */
export class RequestInProgressError extends Error {
  constructor(message = "a request with this idempotency key is already in progress — retry shortly") {
    super(message);
    this.name = "RequestInProgressError";
  }
}
