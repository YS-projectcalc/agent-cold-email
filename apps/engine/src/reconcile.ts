import type { GmailTransport, SendTransport } from "./config.js";
import type { GmailLookup } from "./gmail.js";
import type { DanglingIntent, EngineStore } from "./store.js";

// Boot reconciliation: before the daemon accepts traffic, resolve every dangling
// intent the crash-recovery replay surfaced. Per-transport verifiers enforce the
// governing rule — DROP one send rather than ever duplicate one — so any
// uncertainty PARKS (a durable 424 until an operator resolves it) instead of
// re-sending. Only a gmail send that durably reached `submitted{id}` can be
// auto-FINALIZED (via messages.get); everything else parks in v1 (the Gmail
// SENT-folder scan that could verify-absent intent-only gmail danglings is the
// flagged increment 5, out of scope here).
//
// Design table (docs/research/pre-send-intent-log-design-2026-07-27.md):
//   gmail_api + submitted{id} -> messages.get: found⇒finalize wire+minted alias,
//                                404/exists⇒finalize minted, uncertain⇒park
//   gmail_api intent-only     -> park (v1)
//   ms_graph                  -> park (202 is an async accept; not-found never definitive)
//   smtp                      -> park (nothing server-side to read)

/** The minimal gmail capability reconcile needs (createGmailSender satisfies it). */
export interface GmailVerifier {
  lookup(transport: GmailTransport, gmailId: string): Promise<GmailLookup>;
}

export interface ReconcileDeps {
  store: EngineStore;
  /** Resolve a mailbox's SEND transport by from-address (undefined ⇒ no longer configured). */
  resolveSend: (from: string) => SendTransport | undefined;
  /** The gmail verifier (absent in an smtp-only deployment ⇒ gmail danglings park). */
  gmail?: GmailVerifier;
  now: () => number;
  /**
   * Global wall-clock ceiling: once elapsed, remaining danglings PARK WITHOUT a
   * provider verify so a mass crash cannot hold `server.listen` past the Worker's
   * retry budget (adversary NB2). smtp/graph/intent-only danglings park instantly
   * regardless — only gmail-with-submitted verifies hit the network.
   */
  aggregateDeadlineMs?: number;
}

export interface ReconcileSummary {
  finalized: number;
  parked: number;
  /** Parked specifically because the aggregate deadline was hit before a verify. */
  overflowParked: number;
  /**
   * Danglings this boot could neither finalize nor park because resolving them
   * THREW. They stay dangling (so `isBlocked` still refuses their key — drop,
   * never duplicate) and the next boot retries them. Nonzero here is a durable
   * store problem, not a per-send one.
   */
  failed: number;
}

const DEFAULT_AGGREGATE_DEADLINE_MS = 120_000;

export async function reconcile(deps: ReconcileDeps): Promise<ReconcileSummary> {
  const aggregateDeadlineMs = deps.aggregateDeadlineMs ?? DEFAULT_AGGREGATE_DEADLINE_MS;
  const startedAt = deps.now();
  const summary: ReconcileSummary = { finalized: 0, parked: 0, overflowParked: 0, failed: 0 };
  const danglings = deps.store.listDanglings();
  let firstError: unknown;

  for (const d of danglings) {
    // PER-ITEM ISOLATION (head-of-line class sweep 2026-08-17, U3). This loop
    // runs at BOOT, before `server.listen`, and index.ts's `main().catch` exits
    // 1 — so an unguarded throw here is a crash loop that starves every dangling
    // AND all sends and polls for every tenant.
    //
    // Written as a plain try/catch rather than the platform's forEachIsolated:
    // the engine is a separate Node service and @coldstart/shared is a
    // devDependency it only imports TYPES from, so a runtime import across that
    // boundary would not survive the build.
    //
    // VERDICT, stated honestly (the sweep listed this as UNCERTAIN): the only
    // throw surfaces reachable here are `store.park` / `store.recordSend`, both
    // of which are appends to the same fsync'd log — `gmail.lookup` has a
    // catch-all (gmail.ts) and `resolveSend` is a map read. A failing append is
    // a GLOBAL durable-I/O condition (a full or broken disk), so it fails every
    // item identically: the loop shape is in-class, but the STARVATION half of
    // the class does not apply, and "park + alert instead of exiting" is not
    // implementable in that exact failure mode because parking IS an append.
    // Isolation still earns its place for the partial/intermittent case — one
    // item's failure no longer costs the others — while a WHOLLY unwritable
    // store still aborts boot below, which is the correct signal: an engine that
    // cannot durably record anything must not accept traffic.
    try {
      const needsVerify =
        d.transport === "gmail_api" && d.last === "submitted" && d.providerRef !== undefined && deps.gmail !== undefined;
      if (needsVerify && deps.now() - startedAt >= aggregateDeadlineMs) {
        deps.store.park(d.key, "reconcile aggregate deadline exceeded — parked without provider verify");
        summary.parked++;
        summary.overflowParked++;
        continue;
      }
      if (needsVerify) {
        await verifyGmail(deps, d, summary);
      } else {
        deps.store.park(d.key, parkReasonFor(d));
        summary.parked++;
      }
    } catch (err) {
      summary.failed++;
      firstError ??= err;
      // eslint-disable-next-line no-console
      console.error(`[engine] boot reconciliation could not resolve dangling ${d.key} — left dangling for the next boot`, err);
    }
  }

  // EVERY dangling failed. That is the store itself, not the items, and an
  // engine that cannot write its own log must fail loudly at boot rather than
  // start and silently fail-closed on every subsequent send.
  if (summary.failed > 0 && summary.failed === danglings.length) throw firstError;
  return summary;
}

async function verifyGmail(deps: ReconcileDeps, d: DanglingIntent, summary: ReconcileSummary): Promise<void> {
  const send = deps.resolveSend(d.from);
  if (!send || send.kind !== "gmail_api") {
    deps.store.park(d.key, "gmail dangling but the mailbox no longer resolves to a gmail_api transport");
    summary.parked++;
    return;
  }
  const gmail = deps.gmail!;
  const providerRef = d.providerRef!;
  // 15s/2-try bound per verify: retry once on an inconclusive result (a transient
  // network blip) before parking. Each lookup is itself timeout-bounded (gmail.ts).
  let result = await gmail.lookup(send, providerRef);
  if (result.kind === "uncertain") result = await gmail.lookup(send, providerRef);

  if (result.kind === "found") {
    // Finalize with the WIRE id + the minted id as an alias (heals reply-matching).
    deps.store.recordSend(d.key, result.wireId, d.threadId, deps.now(), [d.mintedId]);
    summary.finalized++;
  } else if (result.kind === "sent") {
    // Confirmed sent but no readable wire id (404/purged/no header) ⇒ minted id.
    deps.store.recordSend(d.key, d.mintedId, d.threadId, deps.now(), []);
    summary.finalized++;
  } else {
    deps.store.park(d.key, "gmail messages.get inconclusive after 2 tries — parked (drop, never re-send)");
    summary.parked++;
  }
}

function parkReasonFor(d: DanglingIntent): string {
  switch (d.transport) {
    case "gmail_api":
      return "gmail intent-only (no provider id) — v1 parks (SENT-scan is increment 5)";
    case "ms_graph":
      return "ms_graph send cannot be read back (202 is an async accept) — parked";
    default:
      return "smtp has no server-side sent record — parked (the safe default)";
  }
}
