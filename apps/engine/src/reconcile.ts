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
}

const DEFAULT_AGGREGATE_DEADLINE_MS = 120_000;

export async function reconcile(deps: ReconcileDeps): Promise<ReconcileSummary> {
  const aggregateDeadlineMs = deps.aggregateDeadlineMs ?? DEFAULT_AGGREGATE_DEADLINE_MS;
  const startedAt = deps.now();
  const summary: ReconcileSummary = { finalized: 0, parked: 0, overflowParked: 0 };

  for (const d of deps.store.listDanglings()) {
    // Non-network transports park instantly (no deadline pressure). Only a gmail
    // send with a provider id verifies — and only while inside the aggregate
    // deadline; past it, park without verifying.
    const needsVerify = d.transport === "gmail_api" && d.last === "submitted" && d.providerRef !== undefined && deps.gmail !== undefined;
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
  }
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
