import { fsyncSync } from "node:fs";
import type { SendEmailInput } from "@coldstart/shared";
import type { ImapFetcher, RawMessage } from "../src/imap.js";
import { SendLog, type SendLogLine } from "../src/send-log.js";
import type { SmtpSender } from "../src/smtp.js";

// Shared crash-injection doubles for the intent-log tests (deterministic,
// in-process, CI-runnable). NOT a *.test.ts, so vitest does not collect it as a
// suite; build tsconfig excludes test/, so it never reaches dist/.

/** Distinguishes a modeled process crash from a real error in assertions. */
export class CrashSignal extends Error {
  constructor(message = "simulated crash during append") {
    super(message);
    this.name = "CrashSignal";
  }
}

/** Where the FIRST matching append fails, modeling two distinct real IO faults. */
export type FaultMode =
  /** Throw BEFORE any bytes are written — models a hard crash / persistent write failure (nothing lands). */
  | "before-write"
  /** writeSync LANDS the bytes, only the fsync throws — models a TRANSIENT fsync IO error (the line IS in the file). */
  | "after-fsync";

/**
 * A SendLog that fails the FIRST `append` matching `faultOn`. `before-write`
 * throws before writeSync (nothing lands; a fresh SendLog replays only the
 * earlier fsync'd lines). `after-fsync` lets writeSync land the bytes and throws
 * on that append's fsync — a transient IO error where the data DID reach the file
 * (reviewer NB1: a submitted-line whose fsync fails momentarily yet whose bytes
 * survive, so boot reconciliation can still finalize it).
 */
export class FaultySendLog extends SendLog {
  private tripped = false;
  private readonly faultOn: (line: SendLogLine) => boolean;
  private readonly mode: FaultMode;
  private readonly armed: { fail: boolean };
  constructor(filePath: string, faultOn: (line: SendLogLine) => boolean, mode: FaultMode = "before-write") {
    const armed = { fail: false };
    super(
      filePath,
      mode === "after-fsync"
        ? {
            fsync: (fd) => {
              if (armed.fail) throw new CrashSignal("fault-injected transient fsync IO error (bytes already written)");
              fsyncSync(fd);
            },
          }
        : {},
    );
    this.faultOn = faultOn;
    this.mode = mode;
    this.armed = armed;
  }
  override append(line: SendLogLine): void {
    if (!this.tripped && this.faultOn(line)) {
      this.tripped = true;
      if (this.mode === "before-write") {
        throw new CrashSignal(`fault-injected (before write) on ${line.type} for ${line.key}`);
      }
      this.armed.fail = true; // let writeSync land the bytes; the armed fsync then throws
      try {
        super.append(line);
      } finally {
        this.armed.fail = false;
      }
      return;
    }
    super.append(line);
  }
}

/** Records every SMTP send; used to count transport submits across a crash + retry. */
export class CountingSmtp implements SmtpSender {
  calls: { messageId: string; input: SendEmailInput }[] = [];
  async send(_creds: unknown, input: SendEmailInput, messageId: string): Promise<void> {
    this.calls.push({ messageId, input });
  }
}

/**
 * An SMTP double that STALLS a send whose `toEmail` matches `stallTo` until
 * released, and resolves all others immediately — lets a test hold key B mid-
 * dispatch (intent written, not yet accepted) while key A completes and triggers
 * a live compaction (the exact B1 interleaving).
 */
export class ControllableSmtp implements SmtpSender {
  calls: { messageId: string; input: SendEmailInput }[] = [];
  private release!: () => void;
  private readonly gate = new Promise<void>((resolve) => {
    this.release = resolve;
  });
  constructor(private readonly stallTo: string) {}
  async send(_creds: unknown, input: SendEmailInput, messageId: string): Promise<void> {
    this.calls.push({ messageId, input });
    if (input.toEmail === this.stallTo) await this.gate;
  }
  releaseStalled(): void {
    this.release();
  }
}

/** Minimal IMAP double (send-path tests never poll). */
export class NoopImap implements ImapFetcher {
  async currentUidNext(): Promise<number> {
    return 1;
  }
  async fetchRange(): Promise<RawMessage[]> {
    return [];
  }
}
