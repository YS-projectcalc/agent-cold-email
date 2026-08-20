import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeSync } from "node:fs";
import { join } from "node:path";
import { SendLog, type SendLogLine, type Transport } from "./send-log.js";
import { loadJsonStateFile } from "./json-store.js";

interface SendRecord {
  messageId: string;
  sentAt: number;
}

/**
 * An outbound Message-ID -> thread mapping, carrying its own age so retention
 * can bound it (S7). v1/v2 snapshots stored a bare `threadId` string with no
 * timestamp; `loadState` migrates those — see there for why they are stamped at
 * LOAD time rather than aged from an unknown past.
 */
interface ThreadRecord {
  threadId: string;
  ts: number;
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
 * The v3 snapshot shape `{version:3, sends, threads, parked, danglings}` — a
 * COMPACTION of the send log, not a store with its own fsync discipline (the log
 * is the power-loss-durable truth). `danglings` (B1 amendment) carries every
 * un-resolved intent VERBATIM so LIVE compaction can never discard an in-flight
 * send's intent and re-open the crash double-send. v3 differs from v2 only in
 * that `threads` values carry a timestamp (see ThreadRecord); v1 (no version
 * field, no parked/danglings) and v2 both still load.
 */
interface StoreState {
  sends: Record<string, SendRecord>;
  threads: Record<string, ThreadRecord>;
  parked: Record<string, ParkedRecord>;
  danglings: Record<string, DanglingRecord>;
}

const EMPTY: StoreState = { sends: {}, threads: {}, parked: {}, danglings: {} };

const DEFAULT_COMPACT_EVERY_RECORDED = 500;

/**
 * How long a SETTLED send stays in the index (S7, docs/adversarial/
 * scale-readiness-audit-2026-08-17.md). Nothing pruned `sends`/`threads` before
 * this, so the snapshot grew with the daemon's LIFETIME send count: measured 88
 * MB / a 1,130 ms frozen event loop at 500k sends, 358 MB / 4,925 ms / 1.2 GB
 * resident at 2M.
 *
 * THIS WINDOW IS A DEDUP HORIZON, not a cache TTL, which is why it is generous.
 * Dropping a `sends` entry means a later retry of that idempotency key is no
 * longer recognised and RE-SENDS; dropping a `threads` entry means an inbound
 * reply or bounce for that Message-ID no longer resolves to its thread. 90 days
 * is multiples past both realistic horizons (a cold-email reply lands in days,
 * a bounce in hours) and 3x the platform's own 30-day request-idempotency TTL,
 * so it can only expire keys the layer above has already forgotten.
 *
 * It deliberately does NOT apply to `danglings` or `parked` — see `prune`.
 */
const DEFAULT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

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
  /** How long a settled send/thread is retained (S7); defaults to DEFAULT_RETENTION_MS. */
  retentionMs?: number;
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
  private readonly retentionMs: number;
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
    this.retentionMs = opts.retentionMs ?? DEFAULT_RETENTION_MS;
    // Seed from the snapshot (v1, v2 or v3, fail-loud on corruption), then
    // re-apply the full log on top (idempotent) so any lines newer than the last
    // compaction — and any dangling the snapshot carried forward — are present.
    this.state = loadState(this.snapshotPath, this.now());
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
    return this.state.threads[messageId]?.threadId;
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
        if (threadId) this.state.threads[messageId] = { threadId, ts };
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
    this.prune(this.now());
    const snapshot = { version: 3, ...this.state };
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

  /**
   * INLINE, AND IT HAS TO BE (S7). The audit asks for compaction "off the
   * request path", and deferring it to a macrotask was tried and REVERTED —
   * it silently broke the B1 crash guarantee.
   *
   * The mechanism: `recordSend` is UPDATE-MEMORY-FIRST, so when its `recorded`
   * append faults (disk full) after the transport already accepted, memory has
   * advanced past the log — the dangling is gone from `state` while the log
   * still holds only the intent. Compacting INLINE snapshots memory at a moment
   * when the two still agree. A DEFERRED compaction snapshots it AFTER that
   * divergence, writing the in-memory success into the snapshot and rotating the
   * intent away — promoting a failed durable write to a durable success and
   * erasing exactly the dangling boot reconciliation must park.
   * `reconcile.test.ts`'s B1 end-to-end case fails on that change:
   * `expected false to be true` at `store2.isBlocked("B")`.
   *
   * What is left of S7 here is the RETENTION bound below, which is what makes
   * this call's cost stop growing with the daemon's lifetime. The remaining
   * freeze is the whole-state `JSON.stringify` itself, and removing THAT means
   * either incremental serialization (which reopens this same window and needs
   * prefix-only rotation) or the real datastore the audit's own fix class names
   * past ~50 MB — a design decision, not a scheduling one.
   */
  private maybeCompact(): void {
    if (this.recordedSinceCompaction >= this.compactEveryRecorded) this.compact();
  }

  /**
   * Drop SETTLED state past the retention window — and nothing else.
   *
   * `danglings` and `parked` are deliberately untouched AT ANY AGE. Each one is
   * a key whose send may or may not have gone out, and it is the only evidence
   * `isBlocked` has; expiring one silently converts a 424 into a fresh key and
   * re-opens the crash double-send the intent log exists to close (the B1
   * amendment). Age is the wrong reason to forget them — an old dangling is a
   * more serious one, not a staler one. They are bounded by RESOLUTION (boot
   * reconciliation, or an operator via `resolveIntent`), which is the only thing
   * that can actually answer the question they encode.
   *
   * Runs inside `compact`, before the snapshot is serialized and the log
   * rotated, so the pruned entries leave BOTH copies in one atomic sequence —
   * otherwise replay would re-apply the very lines just dropped.
   */
  private prune(nowMs: number): void {
    const cutoff = nowMs - this.retentionMs;
    for (const [key, record] of Object.entries(this.state.sends)) {
      if (record.sentAt >= cutoff) continue;
      delete this.state.sends[key];
      this.attemptByKey.delete(key); // engine-local counter for a key nothing can retry any more
    }
    for (const [messageId, record] of Object.entries(this.state.threads)) {
      if (record.ts < cutoff) delete this.state.threads[messageId];
    }
  }

  private applyRecordedToMemory(
    key: string,
    messageId: string,
    threadId: string,
    sentAt: number,
    aliasMessageIds: string[],
  ): void {
    this.state.sends[key] = { messageId, sentAt };
    // Aged on the SEND's own time, so a message and its aliases expire together
    // with the send they belong to (retention, see `prune`).
    this.state.threads[messageId] = { threadId, ts: sentAt };
    for (const alias of aliasMessageIds) this.state.threads[alias] = { threadId, ts: sentAt };
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
          if (line.threadId) this.state.threads[line.messageId] = { threadId: line.threadId, ts: line.ts };
        }
        delete this.state.parked[line.key];
        delete this.state.danglings[line.key];
        break;
    }
  }
}

function loadState(filePath: string, loadedAtMs: number): StoreState {
  return loadJsonStateFile(filePath, EMPTY, "engine state (send/thread idempotency)", (parsed) => ({
    sends: (parsed.sends as StoreState["sends"]) ?? {},
    threads: migrateThreads(parsed.threads, loadedAtMs),
    parked: (parsed.parked as StoreState["parked"]) ?? {},
    danglings: (parsed.danglings as StoreState["danglings"]) ?? {},
  }));
}

/**
 * v1/v2 stored `threads` as `messageId -> threadId` with no timestamp, so the
 * first boot after this upgrade has no age for them.
 *
 * They are stamped at LOAD time, which gives every legacy mapping a FULL
 * retention window starting now. The alternative — treating an unknown age as
 * old — would delete a live customer's thread mappings on the very first
 * compaction after deploy, breaking reply and bounce resolution for every
 * in-flight campaign. Erring toward keeping them costs one window of memory,
 * once.
 */
function migrateThreads(raw: unknown, loadedAtMs: number): StoreState["threads"] {
  if (!raw || typeof raw !== "object") return {};
  const threads: StoreState["threads"] = {};
  for (const [messageId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string") threads[messageId] = { threadId: value, ts: loadedAtMs };
    else if (value && typeof value === "object") threads[messageId] = value as ThreadRecord;
  }
  return threads;
}
