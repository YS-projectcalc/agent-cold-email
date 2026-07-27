import { closeSync, copyFileSync, existsSync, fsyncSync, ftruncateSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";

// The durable pre-send intent WAL (write-ahead log). An append-only JSONL file,
// each line fsync'd before it returns, that records a send's lifecycle BEFORE the
// wire transaction begins — so a crash after the transport accepts but before the
// result is recorded leaves a durable dangling intent that boot reconciliation
// finalizes or parks, instead of a lost claim the consumer re-drives into a
// double-send (the ACTIVATION Gate-2 residual this closes). The main JSON store
// (engine-state.json) becomes a periodic COMPACTION snapshot of this log — the
// log is the only thing that must be power-loss durable.
//
// Design: docs/research/pre-send-intent-log-design-2026-07-27.md.

/** The per-mailbox SEND transport a dangling was dispatched over (config.send.kind). */
export type Transport = "smtp" | "gmail_api" | "ms_graph";

interface BaseLine {
  v: 1;
  key: string;
  ts: number;
}

/** Written BEFORE dispatch; its fsync must resolve before any wire I/O (the intent gate). */
export interface IntentLine extends BaseLine {
  type: "intent";
  attempt: number;
  transport: Transport;
  from: string;
  to: string;
  mintedId: string;
  threadId: string;
}

/** gmail_api only: the messages.send response id, appended BETWEEN the POST return and the read-back. */
export interface SubmittedLine extends BaseLine {
  type: "submitted";
  providerRef: string;
}

/** The completed send — mirrors recordSend's payload (the canonical id + any aliases). */
export interface RecordedLine extends BaseLine {
  type: "recorded";
  messageId: string;
  aliasIds: string[];
  threadId: string;
  sentAt: number;
}

/** An alive-process transport throw (dispatch failed ⇒ nothing went out ⇒ the intent is NOT a dangling). */
export interface AttemptFailedLine extends BaseLine {
  type: "attempt-failed";
  attempt: number;
  error: string;
}

/** Boot reconciliation could not verify a dangling ⇒ it stays 424 until an operator resolves it. */
export interface ParkedLine extends BaseLine {
  type: "parked";
  reason: string;
}

/** Operator resolution of a parked key (POST /v1/intents/resolve). */
export interface ResolvedLine extends BaseLine {
  type: "resolved";
  by: string;
  outcome: "sent" | "resendable";
  /** Present for outcome:"sent" — the id to record so a retry hits the cache. */
  messageId?: string;
  threadId?: string;
}

export type SendLogLine =
  | IntentLine
  | SubmittedLine
  | RecordedLine
  | AttemptFailedLine
  | ParkedLine
  | ResolvedLine;

/**
 * Injectable low-level fs ops so tests can (a) spy that every append fsyncs and
 * (b) force a short `writeSync` to prove the write LOOP handles it. Both default
 * to the real syscalls; production never passes this.
 */
export interface SendLogIo {
  write?: (fd: number, buffer: Buffer, offset: number, length: number) => number;
  fsync?: (fd: number) => void;
}

export class SendLog {
  private fd: number;
  private readonly filePath: string;
  private readonly dir: string;
  private readonly write: (fd: number, buffer: Buffer, offset: number, length: number) => number;
  private readonly fsync: (fd: number) => void;
  /** Every well-formed line recovered at construction (torn tail already dropped). */
  readonly replayed: SendLogLine[];
  /** True if a torn final line was dropped + quarantined at construction. */
  readonly droppedTornTail: boolean;

  constructor(filePath: string, io: SendLogIo = {}) {
    this.filePath = filePath;
    this.dir = dirname(filePath);
    this.write = io.write ?? ((fd, buf, off, len) => writeSync(fd, buf, off, len));
    this.fsync = io.fsync ?? fsyncSync;
    mkdirSync(this.dir, { recursive: true });

    const existedBefore = existsSync(filePath);
    const { lines, droppedTornTail, cleanBytes } = replay(filePath);
    this.replayed = lines;
    this.droppedTornTail = droppedTornTail;

    if (droppedTornTail) {
      // Heal the torn tail on disk: without this, the next append would land
      // AFTER the torn bytes, turning them into a corrupt NON-final line that
      // fails-loud on the following boot (a self-inflicted DoS). Quarantine a
      // copy first, then truncate to the last clean line boundary.
      copyFileSync(filePath, `${filePath}.corrupt-${Date.now()}`);
      const healFd = openSync(filePath, "r+");
      try {
        ftruncateSync(healFd, cleanBytes);
        this.fsync(healFd);
      } finally {
        closeSync(healFd);
      }
      // eslint-disable-next-line no-console
      console.warn(`[send-log] dropped a torn final line from ${filePath} (crash mid-append); quarantined a copy`);
    }

    this.fd = openSync(filePath, "a");
    // dir-fsync only at file creation (and rotation): appending to an existing
    // file changes no directory entry, so per-append dir-fsync is unnecessary.
    if (!existedBefore) this.fsyncDir();
  }

  /**
   * Append one line, fsync'd before returning. LOOPS `writeSync` until the whole
   * buffer is on the fd — `fs.writeSync` may short-write, and a single unchecked
   * write could leave a torn NON-final line under NO crash (which the loader then
   * fails-loud on: a self-inflicted DoS, adversary N2). Synchronous by design:
   * the send path's intent gate depends on the fsync having RESOLVED before
   * dispatch, so a disk-full append THROWS here and the caller fails closed (503)
   * before any wire I/O. The sync fsync is an accepted single-instance throughput
   * ceiling (design NB1 — multi-instance is a non-goal).
   */
  append(line: SendLogLine): void {
    const buf = Buffer.from(`${JSON.stringify(line)}\n`, "utf8");
    let offset = 0;
    while (offset < buf.length) {
      offset += this.write(this.fd, buf, offset, buf.length - offset);
    }
    this.fsync(this.fd);
  }

  /**
   * Discard every line. MUST be called ONLY after the compaction snapshot is
   * durably renamed (the snapshot has already captured everything, including
   * un-resolved danglings) — so a crash mid-rotate replays snapshot + the
   * un-truncated log idempotently. Truncate in place (O_APPEND then writes at the
   * new EOF = 0), fsync the truncation, dir-fsync.
   */
  rotate(): void {
    ftruncateSync(this.fd, 0);
    this.fsync(this.fd);
    this.fsyncDir();
  }

  close(): void {
    closeSync(this.fd);
  }

  private fsyncDir(): void {
    const dfd = openSync(this.dir, "r");
    try {
      this.fsync(dfd);
    } finally {
      closeSync(dfd);
    }
  }
}

/**
 * Read + parse every line, tolerant of a single torn FINAL line and fail-loud on
 * interior corruption. Because each append fsyncs before the next begins
 * (single-threaded, synchronous), only the LAST line can ever be torn: a torn
 * final line has no terminating `\n` (the `\n` is the buffer's last byte, written
 * last), which means its fsync never returned ⇒ its submit never started ⇒ it is
 * safe to drop. A malformed line that DID terminate cleanly is real bit-rot ⇒
 * THROW (the store's F5 fail-loud discipline). `cleanBytes` is the byte length of
 * the last clean line boundary, used to heal a torn tail on disk.
 */
function replay(filePath: string): { lines: SendLogLine[]; droppedTornTail: boolean; cleanBytes: number } {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { lines: [], droppedTornTail: false, cleanBytes: 0 };
    throw new Error(`send log ${filePath} is unreadable — refusing to start: ${(err as Error).message}`);
  }
  if (raw === "") return { lines: [], droppedTornTail: false, cleanBytes: 0 };

  const endsClean = raw.endsWith("\n");
  const parts = raw.split("\n");
  if (parts[parts.length - 1] === "") parts.pop(); // trailing "" after a final \n

  let droppedTornTail = false;
  if (!endsClean) {
    // The final element has no terminating \n ⇒ a torn append. Drop it.
    parts.pop();
    droppedTornTail = true;
  }

  const cleanBytes = byteLengthOfCleanPrefix(raw);
  const lines: SendLogLine[] = [];
  for (let i = 0; i < parts.length; i++) {
    const text = parts[i]!;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new Error(
        `send log ${filePath} has a corrupt NON-final line ${i + 1} — refusing to start (only a torn FINAL line is tolerated; interior corruption is real bit-rot). Repair or quarantine the file. Parse error: ${(err as Error).message}`,
      );
    }
    lines.push(parsed as SendLogLine);
  }
  return { lines, droppedTornTail, cleanBytes };
}

/** Byte length up to and including the last `\n` — the clean prefix a torn tail truncates back to. */
function byteLengthOfCleanPrefix(raw: string): number {
  const lastNl = raw.lastIndexOf("\n");
  if (lastNl === -1) return 0;
  return Buffer.byteLength(raw.slice(0, lastNl + 1), "utf8");
}
