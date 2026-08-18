import { VendorError } from "@coldstart/shared";

/**
 * InboxKit error-envelope mapping. TWO distinct shapes were observed live
 * (verified 2026-07-20 against `https://api.inboxkit.com/v1/api`):
 *
 *  - Gateway/auth-layer errors (bad/malformed JWT, unknown route) — a bare
 *    `{code, message}`, e.g. `401 {"code":401,"message":"jwt malformed"}` or
 *    `404 {"code":404,"message":"Not found"}`. These never reach the app's own
 *    business logic (no `error` field at all).
 *  - App-level business errors on a known, authenticated route —
 *    `{error: true, message}`, e.g.
 *    `409 {"error":true,"message":"Mailbox john.doe@example.com already exists"}`
 *    (per docs.inboxkit.com's per-endpoint response examples). NOTE these can
 *    arrive with HTTP **200** — the app half of the envelope is independent of
 *    the status, which is why `inboxKitAppError` below exists at all.
 *
 * THE GRADE IS THREE-VALUED (class A, docs/adversarial/
 * class-sweep-vendor-truth-2026-08-18.md). `retryable` alone forced every
 * operator-clearable refusal — an empty credit wallet, a rotated JWT, a
 * delinquent workspace — into "permanent", which `error-response.ts` rendered
 * to the customer's agent as "check your inputs". `gradeInboxKitFailure`
 * answers both questions: can THIS caller clear it by retrying, and can an
 * OPERATOR clear it so that the same retry then completes.
 *
 * ⚠ SCOPE: THROWING BRANCHES ONLY (completeness pass finding 5). Two adapter
 * branches read the same 200-`{error:true}` envelope and deliberately do NOT
 * throw — `warmupSubscriptionState` and `findExactMailbox` return
 * `"inconclusive"`, because 'absent' is the one verdict that authorizes a
 * second paid purchase and a failed lookup must never become one (the
 * vendor-verdict class, closed 2026-08-14). Routing those through a throwing
 * grader would reopen it. They stay as they are, on purpose.
 */

/** The three-valued grade for one InboxKit refusal. */
export interface InboxKitGrade {
  /** Transient — the same call, later, can succeed on its own. */
  retryable: boolean;
  /**
   * Not retryable BY THE CALLER, but not the caller's fault either: an operator
   * tops up / re-credentials / un-suspends, and then the caller's SAME retry
   * completes. Never true together with `retryable` — a transient failure needs
   * nobody.
   */
  operatorActionable: boolean;
}

/**
 * Grades one InboxKit refusal from its HTTP status and body.
 *
 * `status` is 200 for the app-level `{error:true}` envelope, which is a
 * refusal the HTTP layer never sees. That path can only be graded from the
 * body, so it starts from "permanent" and is only ever UPGRADED to
 * operator-actionable — see the funding note below.
 */
export function gradeInboxKitFailure(status: number, body: unknown): InboxKitGrade {
  const retryable = status >= 500 || status === 429;
  if (retryable) return { retryable: true, operatorActionable: false };
  return { retryable: false, operatorActionable: isOperatorActionable(status, body) };
}

function isOperatorActionable(status: number, body: unknown): boolean {
  // 401 — an expired/rotated InboxKit JWT (the API key IS a raw JWT,
  // inboxkit-client.ts). 402 — the canonical funding refusal. 403 — a
  // suspended/delinquent workspace. All three are ACCOUNT-wide, so the blast
  // radius of grading them "check your inputs" is every tenant at once: one
  // stale credential wrote a terminal `setup_failed` row for the whole fleet.
  if (status === 401 || status === 402 || status === 403) return true;

  // A gateway-shaped 404 (`{code, message}`, no `error` field — the shape this
  // file's own live capture documents) means the ROUTE does not exist, not that
  // a resource is missing: an app-level "not found" arrives in the `{error:true}`
  // envelope instead. A route we call and the vendor does not serve is an
  // engineering/operator condition — the state `showMailboxCredentials` is in
  // today, whose endpoint path is an unverified documented guess. Telling a
  // customer to check their inputs for it is simply false.
  if (status === 404 && isGatewayEnvelope(body)) return true;

  return hasFundingSignal(body);
}

/** The bare `{code, message}` gateway envelope — no `error` field at all. */
function isGatewayEnvelope(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const record = body as Record<string, unknown>;
  return !("error" in record) && typeof record.code === "number";
}

/**
 * Funding refusals that arrive with neither a 402 nor a machine-readable field.
 *
 * ⚠ THIS IS A MESSAGE-TEXT MATCH, the pattern this adapter has deleted twice
 * (`/already exists/i`) — so the difference matters. Those matches were
 * LOAD-BEARING for a money decision: a wording change silently authorized (or
 * skipped) a purchase. This one authorizes NOTHING. It can only upgrade an
 * already-permanent refusal's customer message from "check your inputs" to
 * "an operator must clear this"; when it fails to match, the behaviour is
 * exactly what it was before this function existed. Fail-open by construction.
 *
 * Live-captured wording: `402 {"error":true,"message":"Insufficient wallet
 * balance to purchase mailboxes"}`. The wire shape of the `/warmup/add` funds
 * refusal that caused the incident is still UNVERIFIED (canon Part 6 #1), which
 * is the whole reason the status path and the body path both exist.
 */
function hasFundingSignal(body: unknown): boolean {
  const message = extractMessage(body);
  if (!message) return false;
  return FUNDING_PATTERNS.some((pattern) => pattern.test(message));
}

const FUNDING_PATTERNS = [
  /insufficient\s+(wallet\s+)?(balance|funds?|credits?)/i,
  /not\s+enough\s+(balance|funds?|credits?)/i,
  /payment\s+required/i,
  /top\s*-?\s*up/i,
];

/**
 * A non-2xx InboxKit response as a graded `VendorError`. `context` is the op
 * label (`"POST /mailboxes/buy"`) — operator-facing only; the customer surface
 * reads the abstract `step` derived from it (vendor-failure.ts), never this.
 */
export function mapInboxKitError(status: number, body: unknown, context: string): VendorError {
  const grade = gradeInboxKitFailure(status, body);
  const message = extractMessage(body) ?? `HTTP ${status} with no parseable error body`;
  return new VendorError(`inboxkit ${context} -> HTTP ${status}: ${message}`, grade.retryable, {
    operatorActionable: grade.operatorActionable,
  });
}

/**
 * A 200-`{error:true}` app-level refusal as a graded `VendorError` — the half of
 * the envelope `mapInboxKitError` never sees, because the HTTP layer called it a
 * success.
 *
 * `message` is the CALLER's own composed sentence (it knows which address or
 * domain the call was about); `body` is passed for GRADING ONLY. `opts
 * .operatorActionable` forces the grade up for a site that knows the answer
 * structurally rather than from the body — today that is the domain-register
 * checkout-URL branch, where a Stripe session in place of a wallet debit IS the
 * insufficient-balance signal, with no message to match on.
 *
 * There is deliberately no way to force `retryable` here: the two adapter
 * branches that throw RETRYABLE off a 200 envelope (`cancelWarmup`'s
 * still-active subscription, `/domains/list`'s page failure) construct their own
 * error, so a mechanical "route every branch through the grader" pass can never
 * flatten their grade — see the scope warning at the top of this file.
 */
export function inboxKitAppError(message: string, body: unknown, opts: { operatorActionable?: boolean } = {}): VendorError {
  const grade = gradeInboxKitFailure(200, body);
  return new VendorError(message, false, {
    operatorActionable: opts.operatorActionable ?? grade.operatorActionable,
  });
}

function extractMessage(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const record = body as Record<string, unknown>;
  return typeof record.message === "string" ? record.message : undefined;
}
