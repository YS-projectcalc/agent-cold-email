import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeSync } from "node:fs";
import { join } from "node:path";
import { SendLog, type SendLogLine, type Transport } from "./send-log.js";
import { loadJsonStateFile } from "./json-store.js";

interface SendRecord {
  messageId: string;
  sentAt: number;
}

/** A key whose latest log line is `intent`/`submitted` (no terminal line) — the reconciliation worklist AND the 424-gate signal. */
interface DanglingRecord {
  last: "intent" | "submitted";
  attempt: number;
  transport: Transport;
  from: string;
  to: string;
  mintedId: string;
  threadId: string;
  /** Set once `submitted` is appended (gmail_api): the messages.get id reconcile needs. */
  providerRef?: string;
  ts: number;
}

/** A dangling boot reconciliation could not verify — 424 until an operator resolves it. */
interface ParkedRecord {
  reason: string;
  transport?: Transport;
  from?: string;
  to?: string;
  mintedId?: string;
  threadId?: string;
  ts: number;
}

/**
 * The v2 snapshot shape `{version:2, sends, threads, parked, danglings}` — a
 * COMPACTION of the send log, not a store with its own fsync discipline (the log
 * is the power-loss-durable truth). `danglings` (B1 amendment) carries every
 * un-resolved intent VERBATIM so LIVE compaction can never discard an in-flight
 * send's intent and re-open the crash double-send. A v1 snapshot (no version
 * field, no parked/danglings) loads with both defaulted to `{}` (backward
 * compatible).
 */
interface StoreState {
  sends: Record<string, SendRecord>;
  threads: Record<string, string>;
  parked: Record<string, ParkedRecord>;
  danglings: Record<string, DanglingRecord>;
}

const EMPTY: StoreState = { sends: {}, threads: {}, parked: {}, danglings: {} };

const DEFAULT_COMPACT_EVERY_RECORDED = 500;

/** The metadata a caller supplies to open a write-ahead intent (attempt is engine-local, computed here). */
export interface IntentMeta {
  transport: Transport;
  from: string;
  to: string;
  mintedId: string;
  threadId: string;
}

/** A parked intent as surfaced by GET /v1/intents (ops). */
export interface ParkedIntent {
  key: string;
  reason: string;
  transport?: Transport;
  from?: string;
  to?: string;
  mintedId?: string;
  threadId?: string;
  ts: number;
}

/** An un-resolved dangling as surfaced to boot reconciliation. */
export interface DanglingIntent {
  key: string;
  last: "intent" | "submitted";
  transport: Transport;
  from: string;
  to: string;
  mintedId: string;
  threadId: string;
  providerRef?: string;
  ts: number;
}

export interface EngineStoreOptions {
  /** Injected for tests; defaults to wall-clock. Stamps every log line's `ts`. */
  now?: () => number;
  /** Live-compaction cadence (recorded lines between snapshots). Injected small in crash tests. */
  compactEveryRecorded?: number;
  /** Injected in crash tests to fault a specific append; defaults to the real SendLog. */
  makeSendLog?: (filePath: string) => SendLog;
}

/**
 * Single-daemon durable state: an append-only, fsync'd send log (the durable
 * truth) periodically COMPACTED into a JSON snapshot (`engine-state.json`). The
 * in-memory index (sends/threads/parked/danglings) is rebuilt at boot from the
 * snapshot + a full log re-apply (idempotent), so a crash anywhere in the
 * write-ahead sequence or in compaction recovers to a consistent state.
 *
 * The write-ahead sequence per send (driven by engine.ts): appendIntent (fsync,
 * fail-closed) -> dispatch -> [gmail: appendSubmitted before the read-back] ->
 * recordSend. A crash after dispatch accepts but before recordSend leaves a
 * durable dangling that boot reconciliation finalizes or parks — closing the
 * ACTIVATION Gate-2 crash double-send residual.
 *
 * NOTE: the engine holds NO poll cursor (the consumer owns it) — the snapshot
 * carries none, keeping the engine cursor-stateless.
 */
export class EngineStore {
  private state: StoreState;
  private readonly stateDir: string;
  private readonly snapshotPath: string;
  private readonly log: SendLog;
  private readonly now: () => number;
  private readonly compactEveryRecorded: number;
  private recordedSinceCompaction = 0;
  /** Engine-local per-key attempt counter (observability on intent/attempt-failed lines). */
  private readonly attemptByKey = new Map<string, number>();
  /**
   * Idempotency keys whose send is CURRENTLY executing (claimed, not yet
   * recorded). In-memory only: single-daemon Node is single-threaded so the
   * claim/release is atomic against other handlers. This stops a SECOND
   * concurrent send() for the same key from opening a second transaction while
   * the first is in flight. The crash-after-accept case is now covered durably by
   * the log (dangling -> reconcile), not by this Set.
   */
  private readonly inFlight = new Set<string>();

  constructor(stateDir: string, opts: EngineStoreOptions = {}) {
    mkdirSync(stateDir, { recursive: true });
    this.stateDir = stateDir;
    this.snapshotPath = join(stateDir, "engine-state.json");
    this.now = opts.now ?? Date.now;
    this.compactEveryRecorded = opts.compactEveryRecorded ?? DEFAULT_COMPACT_EVERY_RECORDED;
    // Seed from the snapshot (v1 or v2, fail-loud on corruption), then re-apply
    // the full log on top (idempotent) so any lines newer than the last
    // compaction — and any dangling the snapshot carried forward — are present.
    this.state = loadState(this.snapshotPath);
    const makeSendLog = opts.makeSendLog ?? ((filePath: string) => new SendLog(filePath));
    this.log = makeSendLog(join(stateDir, "send-log.jsonl"));
    for (const line of this.log.replayed) this.fold(line);
  }

  /** The result a prior send with this idempotency key produced, if any. */
  getSend(idempotencyKey: string): SendRecord | undefined {
    return this.state.sends[idempotencyKey];
  }

  /**
   * Reserve an idempotency key as in-flight. Returns false if a send for this key
   * is ALREADY in flight. Synchronous check-and-set with NO await between the
   * getSend miss and this claim (same input-gate turn), mirroring
   * withRequestIdempotency's claim-before-await invariant.
   */
  claimSend(idempotencyKey: string): boolean {
    if (this.inFlight.has(idempotencyKey)) return false;
    this.inFlight.add(idempotencyKey);
    return true;
  }

  /** Release an in-flight reservation once the send completed OR threw. */
  releaseSend(idempotencyKey: string): void {
    this.inFlight.delete(idempotencyKey);
  }

  /** Resolve an outbound Message-ID back to the threadId it was sent under. */
  resolveThread(messageId: string): string | undefined {
    return this.state.threads[messageId];
  }

  /**
   * Open a write-ahead intent, fsync'd before returning. APPEND-FIRST: a disk-full
   * append THROWS here (propagated as 503) leaving NO in-memory dangling, so the
   * send fails closed BEFORE any wire I/O and a retry genuinely re-sends (nothing
   * went out). The intent gate depends on this fsync having resolved before
   * dispatch begins.
   */
  appendIntent(key: string, meta: IntentMeta): void {
    const attempt = (this.attemptByKey.get(key) ?? 0) + 1;
    const ts = this.now();
    this.log.append({ v: 1, type: "intent", key, ts, attempt, ...meta });
    this.attemptByKey.set(key, attempt);
    this.state.danglings[key] = { last: "intent", attempt, ts, ...meta };
  }

  /** gmail_api only: record the provider id BETWEEN the POST return and the wire-id read-back. */
  appendSubmitted(key: string, providerRef: string): void {
    const ts = this.now();
    this.log.append({ v: 1, type: "submitted", key, ts, providerRef });
    const d = this.state.danglings[key];
    if (d) this.state.danglings[key] = { ...d, last: "submitted", providerRef, ts };
  }

  /**
   * Record a completed send. UPDATE-MEMORY-FIRST: if the recorded append throws
   * (disk full) AFTER a successful submit, memory is already updated (getSend
   * hits ⇒ an alive retry returns cached, no double-send) and the caller returns
   * 200; the dangling reconciles at next boot. The append failure propagates so
   * the caller can log it.
   */
  recordSend(
    idempotencyKey: string,
    messageId: string,
    threadId: string,
    sentAt: number,
    aliasMessageIds: string[] = [],
  ): void {
    this.applyRecordedToMemory(idempotencyKey, messageId, threadId, sentAt, aliasMessageIds);
    const ts = this.now();
    this.log.append({ v: 1, type: "recorded", key: idempotencyKey, ts, messageId, aliasIds: aliasMessageIds, threadId, sentAt });
    this.recordedSinceCompaction++;
    this.maybeCompact();
  }

  /** An alive-process transport throw: nothing went out ⇒ the intent is NOT a dangling. */
  appendAttemptFailed(key: string, error: string): void {
    const ts = this.now();
    const attempt = this.attemptByKey.get(key) ?? 1;
    this.log.append({ v: 1, type: "attempt-failed", key, ts, attempt, error });
    delete this.state.danglings[key];
  }

  /** Reconciliation could not verify a dangling: park it (424 until resolved). */
  park(key: string, reason: string): void {
    const ts = this.now();
    this.log.append({ v: 1, type: "parked", key, ts, reason });
    const d = this.state.danglings[key];
    this.state.parked[key] = { reason, ts, transport: d?.transport, from: d?.from, to: d?.to, mintedId: d?.mintedId, threadId: d?.threadId };
    delete this.state.danglings[key];
  }

  /**
   * Operator resolution of a parked (or dangling) key. `sent` records the minted
   * id so a retry hits the cache; `resendable` clears the block (engine-local
   * only — the platform row is already terminal 'failed' with no requeue, so a
   * legitimate re-send is a campaign-level re-drive, not this action).
   */
  resolveIntent(key: string, outcome: "sent" | "resendable", by: string): { resolved: boolean } {
    const meta = this.state.parked[key] ?? this.state.danglings[key];
    if (!meta) return { resolved: false };
    const ts = this.now();
    if (outcome === "sent") {
      const messageId = meta.mintedId;
      const threadId = meta.threadId;
      this.log.append({ v: 1, type: "resolved", key, ts, by, outcome, messageId, threadId });
      if (messageId) {
        this.state.sends[key] = { messageId, sentAt: ts };
        if (threadId) this.state.threads[messageId] = threadId;
      }
    } else {
      this.log.append({ v: 1, type: "resolved", key, ts, by, outcome });
    }
    delete this.state.parked[key];
    delete this.state.danglings[key];
    return { resolved: true };
  }

  /** True if a send for this key must be DROPPED (424): parked, or a prior-life dangling. */
  isBlocked(key: string): boolean {
    return this.state.parked[key] !== undefined || this.state.danglings[key] !== undefined;
  }

  listParked(): ParkedIntent[] {
    return Object.entries(this.state.parked).map(([key, p]) => ({
      key,
      reason: p.reason,
      transport: p.transport,
      from: p.from,
      to: p.to,
      mintedId: p.mintedId,
      threadId: p.threadId,
      ts: p.ts,
    }));
  }

  listDanglings(): DanglingIntent[] {
    return Object.entries(this.state.danglings).map(([key, d]) => ({
      key,
      last: d.last,
      transport: d.transport,
      from: d.from,
      to: d.to,
      mintedId: d.mintedId,
      threadId: d.threadId,
      providerRef: d.providerRef,
      ts: d.ts,
    }));
  }

  parkedCount(): number {
    return Object.keys(this.state.parked).length;
  }

  inFlightCount(): number {
    return this.inFlight.size;
  }

  /**
   * Compact the log into the snapshot: write snapshot -> fsync file -> rename ->
   * fsync dir -> THEN rotate the log. The ordering makes a crash anywhere safe:
   * the log is never rotated until the snapshot (INCLUDING danglings) is durably
   * renamed, and replay (snapshot + full log) is idempotent.
   */
  compact(): void {
    const snapshot = { version: 2, ...this.state };
    const tmp = `${this.snapshotPath}.tmp`;
    const fd = openSync(tmp, "w");
    try {
      const buf = Buffer.from(JSON.stringify(snapshot), "utf8");
      let offset = 0;
      while (offset < buf.length) offset += writeSync(fd, buf, offset, buf.length - offset);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.snapshotPath);
    this.fsyncDir();
    this.log.rotate();
    this.recordedSinceCompaction = 0;
  }

  close(): void {
    this.log.close();
  }

  private maybeCompact(): void {
    if (this.recordedSinceCompaction >= this.compactEveryRecorded) this.compact();
  }

  private applyRecordedToMemory(
    key: string,
    messageId: string,
    threadId: string,
    sentAt: number,
    aliasMessageIds: string[],
  ): void {
    this.state.sends[key] = { messageId, sentAt };
    this.state.threads[messageId] = threadId;
    for (const alias of aliasMessageIds) this.state.threads[alias] = threadId;
    delete this.state.danglings[key];
    delete this.state.parked[key];
  }

  private fsyncDir(): void {
    const dfd = openSync(this.stateDir, "r");
    try {
      fsyncSync(dfd);
    } finally {
      closeSync(dfd);
    }
  }

  /** Re-apply one replayed log line onto the (snapshot-seeded) in-memory index — idempotent. */
  private fold(line: SendLogLine): void {
    switch (line.type) {
      case "intent":
        this.state.danglings[line.key] = {
          last: "intent",
          attempt: line.attempt,
          transport: line.transport,
          from: line.from,
          to: line.to,
          mintedId: line.mintedId,
          threadId: line.threadId,
          ts: line.ts,
        };
        this.attemptByKey.set(line.key, Math.max(this.attemptByKey.get(line.key) ?? 0, line.attempt));
        break;
      case "submitted": {
        const d = this.state.danglings[line.key];
        if (d) this.state.danglings[line.key] = { ...d, last: "submitted", providerRef: line.providerRef, ts: line.ts };
        break;
      }
      case "recorded":
        this.applyRecordedToMemory(line.key, line.messageId, line.threadId, line.sentAt, line.aliasIds);
        break;
      case "attempt-failed":
        delete this.state.danglings[line.key];
        break;
      case "parked": {
        const existing = this.state.parked[line.key];
        const d = this.state.danglings[line.key];
        this.state.parked[line.key] =
          existing ?? { reason: line.reason, ts: line.ts, transport: d?.transport, from: d?.from, to: d?.to, mintedId: d?.mintedId, threadId: d?.threadId };
        delete this.state.danglings[line.key];
        break;
      }
      case "resolved":
        if (line.outcome === "sent" && line.messageId) {
          this.state.sends[line.key] = { messageId: line.messageId, sentAt: line.ts };
          if (line.threadId) this.state.threads[line.messageId] = line.threadId;
        }
        delete this.state.parked[line.key];
        delete this.state.danglings[line.key];
        break;
    }
  }
}

function loadState(filePath: string): StoreState {
  return loadJsonStateFile(filePath, EMPTY, "engine state (send/thread idempotency)", (parsed) => ({
    sends: (parsed.sends as StoreState["sends"]) ?? {},
    threads: (parsed.threads as StoreState["threads"]) ?? {},
    parked: (parsed.parked as StoreState["parked"]) ?? {},
    danglings: (parsed.danglings as StoreState["danglings"]) ?? {},
  }));
}
