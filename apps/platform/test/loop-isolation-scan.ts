// The HEAD-OF-LINE-BLOCKING guard (class sweep 2026-08-17,
// docs/adversarial/class-sweep-hol-blocking-2026-08-17.md).
//
// THE CLASS, in one sentence: a sequential loop over a durably-selected,
// stably-ordered item list, where one item consumes the whole call (by
// throwing past the loop, or by eating a shared budget), and the next
// invocation re-selects the same list in the same order — so the head item's
// persistent failure is a permanent, silent denial of service to every item
// behind it, with no skip, reorder, quarantine or replace path.
//
// The nine IN-fixes (isolated-loop.ts's forEachIsolated/withItemBudget)
// closed the confirmed members by consolidating the idiom the repo had
// already invented twice correctly (warmup-cancel.ts, provision-intents.ts).
// Fixing those instances does not close the CLASS: the next loop over a
// tenant/mailbox/domain/message/action collection can reintroduce it in a new
// file, or in this one, without anyone noticing until a customer is billed
// for zero working mailboxes again. A doc comment is not a guard, so
// test/loop-isolation-coverage.test.ts is a TRIPWIRE built on the scanner
// below — it parses the SOURCE of every file under the three swept trees,
// finds every brace-matched `for`/`for await`/`while` loop body that contains
// an `await` or a durable write (the two effect shapes a starved item can be
// denied), and asserts each one is either:
//   (a) routed through `forEachIsolated` (the loop body itself calls it —
//       the compliant sites mostly aren't even a raw loop anymore, they're a
//       function call, so this branch exists for a loop that dispatches a
//       BATCH through the primitive rather than being replaced by it),
//   (b) isolated inline (the loop's own body contains its own try/catch —
//       the pattern the repo already used correctly at 25 sites: per-tenant
//       cron legs, per-mailbox polls, retry/backoff loops), or
//   (c) present in the ALLOWED_UNISOLATED_LOOPS list below with a written
//       reason — mirroring ALLOWED_SEND_CALL_SITES in
//       send-governance-coverage.test.ts.
//
// TRIPWIRE, NOT A SANDBOX: this is a lexical/brace-matched scan, not a parser.
// It catches the shape a developer plausibly WRITES (a raw sequential loop
// with an unguarded await or write in its body), not every conceivable dodge
// (a loop body that calls out to a helper which itself loops unguarded is
// invisible to this scan — call-chain composition has to be read, as the
// sweep doc's own §2 "Semantic" table found for IN-3). Its job is to make the
// honest mistake — adding a new per-item loop without reaching for the
// primitive the repo already has — loud, not to be a capability boundary.
// The detectors are proven against synthetic sources in the test file so the
// tripwire itself cannot silently rot into a no-op.
//
// OUT OF SCOPE BY DESIGN: `.forEach(async ...)` / `Promise.all` / `.map(async
// ...)` fan-out constructs are a different code shape (concurrent, not
// sequential) that `forEachIsolated` does not address and the class doc
// tracks separately — `infrastructure-status.ts:110`'s guarded `Promise.all`
// is exactly that, already OUT per the doc as "a prior fix of this exact
// class" under a different mechanism. This tripwire follows the brief's
// literal scope: sequential `for`/`for await`/`while`.

export interface LoopSite {
  file: string;
  /** The loop's own header text (`for (const sub of subs)`), normalized to one line — the allowlist key. */
  header: string;
}

const LOOP_KEYWORD = /\b(for await|for|while)\s*\(/g;
const DURABLE_WRITE = /\bsql\.exec\(|\.prepare\(|\blogAction\(|\bemitTenantMessage\(/;

/** Index of the `(` at `openIndex`'s matching close paren, or -1 if unbalanced. */
function matchingParen(source: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < source.length; i++) {
    if (source[i] === "(") depth++;
    else if (source[i] === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** The brace-matched `{ ... }` block starting at/after `fromIndex`, or null for a non-block-bodied loop (`for (...) x();`). */
function braceBody(source: string, fromIndex: number): [number, number] | null {
  let i = fromIndex;
  while (i < source.length && /\s/.test(source[i] as string)) i++;
  if (source[i] !== "{") return null;
  let depth = 0;
  for (let j = i; j < source.length; j++) {
    if (source[j] === "{") depth++;
    else if (source[j] === "}") {
      depth--;
      if (depth === 0) return [i, j];
    }
  }
  return null;
}

/**
 * Every brace-matched `for`/`for await`/`while` loop, in the given sources,
 * whose body contains an `await` or a durable write, that is NEITHER routed
 * through `forEachIsolated` NOR isolated by its own inline `try`/`catch`.
 * This is the raw candidate list — allowlist filtering happens at the call site.
 */
export function findUnisolatedLoopSites(sources: Record<string, string>): LoopSite[] {
  const offenders: LoopSite[] = [];
  for (const [file, source] of Object.entries(sources)) {
    LOOP_KEYWORD.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = LOOP_KEYWORD.exec(source)) !== null) {
      const parenOpen = m.index + m[0].length - 1;
      const parenClose = matchingParen(source, parenOpen);
      if (parenClose === -1) continue;
      const body = braceBody(source, parenClose + 1);
      if (!body) continue; // single-statement loop body — none of the swept sites are shaped this way
      const [bodyStart, bodyEnd] = body;
      const bodyText = source.slice(bodyStart, bodyEnd + 1);
      const needsIsolation = /\bawait\b/.test(bodyText) || DURABLE_WRITE.test(bodyText);
      if (!needsIsolation) continue;
      const routedThroughPrimitive = bodyText.includes("forEachIsolated(");
      const hasOwnTryCatch = /\btry\s*\{/.test(bodyText) && /\bcatch\b/.test(bodyText);
      if (routedThroughPrimitive || hasOwnTryCatch) continue;
      const header = source.slice(m.index, parenClose + 1).replace(/\s+/g, " ").trim();
      offenders.push({ file, header });
    }
  }
  return offenders;
}

/**
 * Loops the scan above would flag, but that are NOT this class — each one
 * read against `docs/adversarial/class-sweep-hol-blocking-2026-08-17.md` §3's
 * inventory, not inferred from the grep. Three entries are marked STILL OPEN:
 * they are IN/UNCERTAIN members the doc names that the nine IN-commits on
 * this branch did NOT close (verified against `git log` — no IN-6/U2/U4
 * commit exists). Listing them here keeps the tripwire green on today's code
 * without pretending they are safe; closing them is the sweep inventory's
 * call, not this test's, per the brief's scope discipline.
 */
export const ALLOWED_UNISOLATED_LOOPS: { file: string; header: string; reason: string }[] = [
  // --- Single-item retry/backoff — no second item to starve (doc §3 OUT group 3) ---
  {
    file: "apps/engine/src/index.ts",
    header: "while (engine.inFlightCount() > 0 && Date.now() < deadline)",
    reason: "drain wait for one process, not a per-item loop over a collection — nothing behind it to starve",
  },
  {
    file: "apps/platform/src/engine/webhook-security.ts",
    header: "while (out.length < max)",
    reason: "single-buffer retry/backoff loop filling one output — no second item in-flight to starve",
  },
  {
    file: "apps/platform/src/validate.ts",
    header: "while (true)",
    reason: "single-item retry/backoff loop (bounded elsewhere) — no second item to starve",
  },
  {
    file: "apps/platform/src/vendors/real/inboxkit-domain-port.ts",
    header: "for (let page = 1; page <= MAX_DOMAIN_PAGES; page++)",
    reason: "bounded paged walk of ONE query, permanent-graded overflow — not independent items that can be skipped/reordered",
  },
  {
    file: "packages/cli/src/client.ts",
    header: "for (let attempt = 0; attempt < maxAttempts && !isDone(result); attempt++)",
    reason: "pollUntil is a single exponential-backoff poll of ONE call, not a loop over a collection — no second item to starve",
  },
  // --- Chunked execution of ONE logical operation — the "items" are not independently completable (doc §3 OUT group 4) ---
  {
    file: "apps/platform/src/admin/db.ts",
    header: "for (let i = 0; i < ids.length; i += MARK_EMAILED_CHUNK_SIZE)",
    reason: "batches one bulk UPDATE into D1-sized chunks — a chunk failing aborts the one logical operation, which is the correct semantic, not starvation",
  },
  {
    file: "apps/platform/src/engine/contact-operator-guard.ts",
    header: "for (let i = 0; i < ids.length; i += RELEASE_EMAIL_CLAIM_CHUNK_SIZE)",
    reason: "same chunked-bulk-op shape as admin/db.ts — one logical release, not independently completable items",
  },
  {
    file: "apps/platform/src/engine/demo.ts",
    header: "for (let i = 0; i < demoThreadIds.length; i += THREAD_LABEL_CHUNK_SIZE)",
    reason: "same chunked-bulk-op shape — one logical labeling pass over demo data",
  },
  {
    file: "apps/platform/src/ofac/sdn-list.ts",
    header: "for (let i = 0; i < params.entries.length; i += INSERT_BATCH_SIZE)",
    reason: "builds one batch of prepared statements for a single atomic swap-in — chunking, not independent per-entry items",
  },
  // --- Synchronous, no await, no throw-prone call — a DO commits the turn atomically (doc §3 OUT group 6) ---
  {
    file: "apps/platform/src/engine/campaigns.ts",
    header: "for (const lead of input.leads)",
    reason: "synchronous local sql.exec only, no vendor call; also caller-supplied input the customer can edit to skip the bad row",
  },
  {
    file: "apps/platform/src/engine/campaigns.ts",
    header: "for (const step of input.sequence)",
    reason: "synchronous local sql.exec only, no vendor call; same caller-supplied-input skip path as the leads loop above",
  },
  {
    file: "apps/platform/src/engine/deliverability-actions.ts",
    header: "for (const row of rows)",
    reason: "applySoftFlagDomain: synchronous local sql.exec cap-halving only, no vendor call — a DO commits the turn atomically",
  },
  {
    file: "apps/platform/src/engine/infrastructure-status.ts",
    header: "for (const { email, detail } of degraded)",
    reason: "synchronous logAction only, no vendor call — a DO commits the turn atomically",
  },
  {
    file: "apps/platform/src/engine/legacy-domain-intent-keys.ts",
    header: "for (const rebind of rebinds)",
    reason: "runs inside storage.transactionSync in the DO constructor — one synchronous input-gate turn with no await anywhere (source comment confirms)",
  },
  {
    file: "apps/platform/src/engine/mailbox-state.ts",
    header: "for (const row of rows)",
    reason: "synchronous local sql.exec only over already-fetched rows — a DO commits the turn atomically",
  },
  {
    file: "apps/platform/src/engine/provision-intents.ts",
    header: "for (const email of emails)",
    reason: "synchronous local sql.exec DELETEs only, no vendor call — a DO commits the turn atomically",
  },
  {
    file: "apps/platform/src/engine/tick.ts",
    header: "for (const orphan of orphaned)",
    reason: "orphan reclaim: synchronous local sql.exec UPDATE only, no vendor call — a DO commits the turn atomically",
  },
  // --- Callee swallows its own failure — the loop never sees a throw (doc §3 OUT group 2) ---
  {
    file: "apps/platform/src/engine/mailbox-credential-push.ts",
    header: "for (const row of pending)",
    reason: "pushRecordedMailbox catches internally and returns { pushed: false } — the loop cannot observe a throw",
  },
  {
    file: "apps/platform/src/engine/provisioning.ts",
    header: "for (const candidate of candidates)",
    reason: "findAdoptableDomain catches its own vendor error and returns null — the loop cannot observe a throw",
  },
  {
    file: "apps/platform/src/engine/webhook-delivery.ts",
    header: "for (const { id: deliveryId } of due)",
    reason: "realWebhookDeliverer returns a DeliveryOutcome on every path (incl. url_rejected); backoff + auto-disable at 5 failures makes the queue self-draining",
  },
  // --- STILL OPEN: doc-named IN/UNCERTAIN members this branch's 9 commits did NOT close. ---
  // Not a fix and not a safety claim — flagged to the orchestrator; scope
  // membership is the sweep inventory's call, not this tripwire's.
  {
    file: "apps/platform/src/admin/watchtower.ts",
    header: "for (const result of results)",
    reason: "STILL OPEN — doc §3 IN-6 (reconcileAlerts): no per-result catch around the D1 upsert; verified unfixed on this branch (no IN-6 commit in git log). Flagged, not fixed — out of this test's scope to close.",
  },
  {
    file: "apps/platform/src/engine/webhook-enqueue.ts",
    header: "for (const sub of subs)",
    reason: "STILL OPEN — doc §3 U2 (enqueueEventWebhooks): unguarded JSON.parse(sub.event_types_json); doc lists it UNCERTAIN, not settled, and no U2 commit exists on this branch. Flagged, not fixed.",
  },
  {
    file: "apps/platform/src/engine/suppression.ts",
    header: "for (const lead of leads)",
    reason: "STILL OPEN — doc §3 U4 (unsubscribe): carries U2's webhook fan-out per-lead; doc says U4 is OUT only if U2 resolves OUT, which it has not. Flagged, not fixed.",
  },
];

export function isAllowedUnisolatedLoop(site: LoopSite): boolean {
  return ALLOWED_UNISOLATED_LOOPS.some((a) => a.file === site.file && a.header === site.header);
}
