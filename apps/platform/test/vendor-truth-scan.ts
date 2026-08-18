// SCANNERS + ALLOWLISTS for the two vendor-truth tripwires
// (docs/adversarial/class-sweep-vendor-truth-2026-08-18.md). The assertions and
// the proof that these scanners are not no-ops live in
// vendor-truth-coverage.test.ts — same split as loop-isolation-scan.ts /
// loop-isolation-coverage.test.ts.
//
// TWO CLASSES, both of which shipped as green suites:
//
//  A — a permanent VendorError built by hand, so the three-valued grade never
//      ran. Every one of these reaches a customer's agent as "check your
//      inputs, retrying will not help", which for an operator-clearable refusal
//      is false twice over.
//  E — a BILLED, non-idempotent vendor call with no vendor-state pre-check
//      and/or no durable claim written BEFORE it. A marker written after the
//      call cannot close the window it sits inside.

/**
 * Strips `//` and block comments, preserving offsets by replacing each comment
 * character with a space.
 *
 * MANDATORY, not tidiness. This file's own first run flagged
 * `byo-mailbox-composition.ts` for a `domain.buy(` that lives in a DOC COMMENT
 * reading "there is no domain.buy()/setDns() call" — a scanner that reads prose
 * as code reports a defect in the one file whose comment explains it does not
 * have it. Offsets are preserved so every index the callers compute still points
 * at the real source.
 *
 * String and template literals are skipped so a comment marker inside a URL or a
 * message ("https://…", "a // b") does not blank the rest of the line.
 */
export function stripComments(source: string): string {
  const out = source.split("");
  let i = 0;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== "\n") out[k] = " ";
  };
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i++;
      while (i < source.length && !(source[i] === quote && source[i - 1] !== "\\")) i++;
      i++;
      continue;
    }
    if (ch === "/" && next === "/") {
      const end = source.indexOf("\n", i);
      blank(i, end === -1 ? source.length : end);
      i = end === -1 ? source.length : end;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    i++;
  }
  return out.join("");
}

/** Every scanned source with its comments blanked out. */
function withoutComments(sources: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(sources).map(([file, source]) => [file, stripComments(source)]));
}

/** One `new VendorError(...)` construction found in the source. */
export interface VendorErrorSite {
  file: string;
  /**
   * The construction with its whitespace collapsed onto one line, truncated.
   *
   * NOT the first source line: the throws that most need a written reason are
   * the MULTI-LINE ones, whose first line is the bare `new VendorError(` — so
   * allowlisting by first line would let a single entry excuse every multi-line
   * permanent throw in a file, including one added later. Collapsing makes each
   * entry name exactly one site.
   */
  snippet: string;
}

/** One billed-effect call site found in the source. */
export interface BilledEffectSite {
  file: string;
  pattern: string;
  /** The enclosing function's declared name, or "(top level)". */
  enclosing: string;
}

/**
 * Constructors that produce a GRADED error — the three-valued grader itself,
 * plus the two adapter entry points that delegate to it. A permanent error from
 * one of these has been graded by definition.
 */
const GRADER_CONSTRUCTORS = ["mapInboxKitError(", "inboxKitAppError("];

/**
 * Permanent (`retryable: false`) VendorError constructions that are NOT
 * grader-built and do NOT set `operatorActionable` — each needs a written
 * reason for why "permanent, and nobody can clear it" is the honest grade.
 *
 * A new entry here is a claim about a REFUSAL, so write why an operator cannot
 * clear it. "It looked permanent" is not a reason; the wallet refusal looked
 * permanent too.
 */
export const ALLOWED_PERMANENT: { file: string; snippet: string; reason: string }[] = [
  // --- A DIFFERENT VENDOR: the cold-engine Worker, not InboxKit. The canon
  // names email-port.ts's RETRYABLE_ENGINE_STATUSES the COMPLIANT template
  // (class A OUT, load-bearing) — it grades by status against an explicit list.
  {
    file: "apps/platform/src/vendors/real/email-port.ts",
    snippet: 'new VendorError("engine /v1/send returned a malformed SendEmailResult", false)',
    reason:
      "our own engine's response contract, not a vendor refusal: a malformed result is a bug on one side of a seam we own, and no top-up, credential or account action makes the identical call succeed",
  },
  {
    file: "apps/platform/src/vendors/real/email-port.ts",
    snippet: 'new VendorError("engine /v1/poll returned a malformed PollResult", false)',
    reason: "same as the /v1/send malformed-result throw above — our own engine's contract, not a refusal any operator can clear",
  },
  {
    file: "apps/platform/src/vendors/real/email-port.ts",
    snippet: "new VendorError(`ENGINE_BASE_URL must be https (or localhost): ${this.config.baseUrl}`, false)",
    reason: "config validation that runs BEFORE any call is made; there is no vendor answer here to grade, and the value is ours",
  },
  {
    file: "apps/platform/src/engine/engine-mailbox-client.ts",
    snippet: 'new VendorError("engine POST /v1/mailboxes returned a malformed UpsertResult", false)',
    reason: "our own engine's response contract — same reasoning as the email-port malformed-result entries above",
  },
  {
    file: "apps/platform/src/engine/engine-mailbox-client.ts",
    snippet: "new VendorError(`ENGINE_BASE_URL must be https (or localhost): ${this.config.baseUrl}`, false)",
    reason: "config validation before any call is made — same reasoning as the email-port entry above",
  },

  // --- INBOXKIT, but not a refusal the vendor issued ---
  {
    file: "apps/platform/src/vendors/real/inboxkit-domain-port.ts",
    snippet: 'new VendorError("inboxkit domains/list has more pages than this adapter will walk", false)',
    reason:
      "OUR page ceiling, not the vendor's answer: a retry re-walks the same ceiling and fails identically, so raising it is a code change. The alternative — under-reporting the walk — is the vendor-verdict defect this throw exists to avoid",
  },
  {
    file: "apps/platform/src/vendors/real/inboxkit-domain-port.ts",
    snippet: "new VendorError(`inboxkit domain registration for ${domain} requires registrant contact details, not configured`, false)",
    reason:
      "thrown BEFORE any vendor call: a registrant of record is a legal fact this platform has not been given, and the arming-gap surfaces already exist as RegistrarUnarmedError / IncompleteRegistrantError with their own customer messages",
  },
  {
    file: "apps/platform/src/vendors/real/mailbox-port.ts",
    snippet:
      "new VendorError( `inboxkit warmup/add returned an unparseable start time for ${email}: ${JSON.stringify(startedAt)}`, false, )",
    reason:
      "a REFUSAL BY US, after the subscription is already created and billed: we will not guess the ramp's only anchor, and a retryable grade here would enrol and charge for a fresh subscription on every attempt. Nobody can clear it by acting on the account",
  },
  {
    file: "apps/platform/src/vendors/real/mailbox-port.ts",
    snippet: "new VendorError(`inboxkit has no mailbox matching ${email}`, false)",
    reason:
      "a DEFINITIVE absence from resolveMailboxUid, distinguished from an inconclusive lookup one line below (which is retryable). Nothing an operator does makes a mailbox that is not there resolvable; release() no longer reaches this path at all",
  },
  {
    file: "apps/platform/src/vendors/real/mailbox-port.ts",
    snippet:
      "new VendorError( `inboxkit keyword search for ${email} returned a NON-EXACT match (${resolvedEmail}) — refusing to act on the wrong mailbox`",
    reason:
      "a REFUSAL BY US and the strictest one in the adapter: acting on a fuzzy near-match would cancel a DIFFERENT paid mailbox. It must never soften into anything a caller or operator can wave through",
  },

  // --- STILL OPEN: canon-named class A members this lane's scope ruling did not
  // include. Recorded, not silently graded — an allowlist entry that says "open"
  // is a flag to the orchestrator, never a safety claim.
  {
    file: "apps/platform/src/vendors/real/oauth-mint.ts",
    snippet:
      "new VendorError(`no manually-minted gmail_api grant supplied for ${mailbox.email} — mint its refresh token and supply it at arming`, false)",
    reason:
      "STILL OPEN (canon class A, oauth-mint.ts:55): its arm IS operator-clearable — an operator mints the grant — but the endpoint shape is UNVERIFIED (canon Part 6 #5) and the wave's scope ruling did not include oauth-mint. Flagged for the next pass rather than graded on a guess",
  },
  {
    file: "apps/platform/src/vendors/real/oauth-mint.ts",
    snippet:
      'new VendorError(`inboxkit consent for ${mailbox.email} returned no refresh token (UNVERIFIED response shape): ${consent.message ?? "no messa',
    reason: "STILL OPEN — the sibling of the oauth-mint entry above (canon class A, oauth-mint.ts:107), same UNVERIFIED-shape reason",
  },
  {
    file: "apps/platform/src/vendors/real/inboxkit-domain-port.ts",
    snippet: 'new VendorError(`inboxkit domains/remove failed for ${domain}: ${body.message ?? "no message"}`, false)',
    reason:
      "STILL OPEN: the domain-side sibling of the release() idempotency fix. It is a spend-STOPPING call, so a false permanent strands a paid resource rather than over-spending, and closing it belongs with domain teardown rather than this lane",
  },
];

/**
 * Finds every `new VendorError(...)` whose grade argument is the literal
 * `false` — i.e. a hand-built PERMANENT refusal.
 *
 * Paren-balanced rather than line-based on purpose: the constructions that
 * matter most here span several lines, and a line-based scan would miss exactly
 * those.
 */
export function findHandBuiltPermanentSites(sources: Record<string, string>): VendorErrorSite[] {
  const sites: VendorErrorSite[] = [];
  for (const [file, source] of Object.entries(withoutComments(sources))) {
    for (const call of vendorErrorCalls(source)) {
      if (!isPermanentGrade(call.text)) continue;
      if (call.text.includes("operatorActionable")) continue; // graded deliberately at the site
      if (GRADER_CONSTRUCTORS.some((g) => call.text.includes(g))) continue;
      sites.push({ file, snippet: collapse(call.text) });
    }
  }
  return sites;
}

export function isAllowedPermanent(site: VendorErrorSite): boolean {
  return ALLOWED_PERMANENT.some((a) => a.file === site.file && a.snippet === site.snippet);
}

/** Every `new VendorError(` call in a source, with its full paren-balanced text. */
function vendorErrorCalls(source: string): { text: string }[] {
  const calls: { text: string }[] = [];
  const marker = "new VendorError(";
  let from = 0;
  for (;;) {
    const start = source.indexOf(marker, from);
    if (start === -1) return calls;
    const open = start + marker.length - 1;
    let depth = 0;
    let end = open;
    for (; end < source.length; end++) {
      if (source[end] === "(") depth++;
      else if (source[end] === ")") {
        depth--;
        if (depth === 0) break;
      }
    }
    calls.push({ text: source.slice(start, end + 1) });
    from = end + 1;
  }
}

/**
 * True when the SECOND argument is the literal `false`. The message argument is
 * skipped by depth-aware, template-literal-aware scanning: `${...}` inside a
 * backtick message routinely contains commas and parens, and splitting on them
 * naively would grade the wrong argument.
 */
function isPermanentGrade(callText: string): boolean {
  const args = topLevelArgs(callText.slice(callText.indexOf("(") + 1, callText.lastIndexOf(")")));
  return args[1]?.trim() === "false";
}

function topLevelArgs(inner: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = "";
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!;
    const prev = inner[i - 1];
    if (quote) {
      current += ch;
      if (ch === quote && prev !== "\\") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    if (ch === ")" || ch === "}" || ch === "]") depth--;
    if (ch === "," && depth === 0) {
      args.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  args.push(current);
  return args;
}

/** One line, single-spaced, bounded — an allowlist key a human can still read. */
function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 140);
}

// ---------------------------------------------------------------------------
// TRIPWIRE (b) — billed effect, pre-check + durable claim BEFORE the call
// ---------------------------------------------------------------------------

/**
 * The BILLED, non-idempotent vendor calls. Deliberately the same three the
 * spend-ceiling guard enumerates (test/spend-ceiling-coverage.test.ts) — that
 * one asks "is it inside the money CHOKE-POINT", this one asks "is it allowed to
 * happen at all yet". A new money-out call must satisfy both.
 */
export const BILLED_EFFECTS = ["mailbox.provision(", "mailbox.startWarmup(", "domain.buy("];

/** Asking the VENDOR what it already holds — the only thing that can close a crash window. */
const PRE_CHECK_MARKERS = [
  "provisioningState(",
  "confirmVendorOwnership(",
  "warmupSubscriptionState(",
  "listOwnedDomains(",
  "findAdoptableDomain(",
  "readBuyDispatch(",
];

/** A durable record that survives a throw and proves money MAY have moved. */
const CLAIM_MARKERS = [
  "claimBuyDispatch(",
  "recordMailboxIntent(",
  "recordDomainIntent(",
  "markMailboxIntent(",
  "markDomainIntent(",
  "readMailboxIntent(",
  "withRequestIdempotency(",
];

/**
 * Billed-effect sites whose pre-check and/or claim lives in a DIFFERENT
 * function from the call — legitimate, and each entry names where.
 *
 * This exists because the in-function check below is deliberately literal, and
 * the codebase's best-designed site fails it: `dispatchBuy` is a three-line
 * function that does nothing BUT claim-then-call, with the vendor pre-check in
 * its caller. Loosening the scanner to accept that shape would accept every
 * unguarded call too, so the split is recorded here instead.
 */
export const ALLOWED_SPLIT_GUARD: { file: string; enclosing: string; preCheckIn: string; claimIn: string; reason: string }[] = [
  {
    file: "apps/platform/src/engine/mailbox-provisioning.ts",
    enclosing: "dispatchBuy",
    preCheckIn: "acquireMailbox (readBuyDispatch + confirmVendorOwnership)",
    claimIn: "dispatchBuy itself (claimBuyDispatch, before the call)",
    reason:
      "the canon's own compliant template (class E, E3 HELD): the money DECISION is in acquireMailbox, which asks the vendor whenever any dispatch is on record, and the claim is the first statement of this function — written before the call precisely so a kill inside it still proves money may have moved",
  },
];

/**
 * Finds billed-effect call sites whose ENCLOSING function does not contain both
 * a vendor-state pre-check and a durable claim ahead of the call.
 *
 * "Enclosing function" is the nearest preceding `function <name>` declaration —
 * crude, and sufficient: this codebase declares every saga leg that way, and the
 * one shape it gets wrong is recorded in ALLOWED_SPLIT_GUARD above rather than
 * papered over by a cleverer heuristic that would also excuse a real gap.
 */
export function findUnguardedBilledEffects(sources: Record<string, string>): BilledEffectSite[] {
  const sites: BilledEffectSite[] = [];
  for (const [file, source] of Object.entries(withoutComments(sources))) {
    for (const pattern of BILLED_EFFECTS) {
      let from = 0;
      for (;;) {
        const index = source.indexOf(pattern, from);
        if (index === -1) break;
        from = index + pattern.length;
        const { name, body } = enclosingFunction(source, index);
        const guarded = PRE_CHECK_MARKERS.some((m) => body.includes(m)) && CLAIM_MARKERS.some((m) => body.includes(m));
        if (!guarded) sites.push({ file, pattern, enclosing: name });
      }
    }
  }
  return sites;
}

export function isAllowedSplitGuard(site: BilledEffectSite): boolean {
  return ALLOWED_SPLIT_GUARD.some((a) => a.file === site.file && a.enclosing === site.enclosing);
}

/** The nearest preceding function declaration, and the source from it up to the call. */
function enclosingFunction(source: string, callIndex: number): { name: string; body: string } {
  const decl = /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)/g;
  let name = "(top level)";
  let start = 0;
  for (let m = decl.exec(source); m && m.index < callIndex; m = decl.exec(source)) {
    name = m[1]!;
    start = m.index;
  }
  return { name, body: source.slice(start, callIndex) };
}
