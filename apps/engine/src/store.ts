import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface SendRecord {
  messageId: string;
  sentAt: number;
}

interface StoreState {
  /** idempotencyKey -> the SendEmailResult that key already produced. */
  sends: Record<string, SendRecord>;
  /**
   * outbound Message-ID -> the threadId supplied at send time (reverse lookup).
   * A single send can register MORE THAN ONE id here: for an API transport whose
   * wire Message-ID differs from the one we minted (Gmail rewrites it), BOTH the
   * minted and the wire id map to the same threadId, so an inbound reply's
   * In-Reply-To/References matches whichever id ended up on the delivered message.
   * For SMTP (header preserved) the two ids are equal and this is a single entry.
   */
  threads: Record<string, string>;
}

const EMPTY: StoreState = { sends: {}, threads: {} };

/**
 * Single-daemon durable state, JSON-file-backed with atomic (write-temp +
 * rename) flushes and a serialized write queue so concurrent HTTP handlers can't
 * interleave a read-modify-write. This is deliberately the simplest thing that
 * satisfies the pilot's ONE-engine-instance topology; a multi-instance
 * deployment would swap this for a shared store (Redis/SQLite) behind the same
 * interface — see README "Scaling beyond one instance".
 *
 * NOTE: the engine holds NO poll cursor. The CONSUMER (the Worker DO) owns the
 * per-mailbox IMAP UID high-water and passes it as `sinceCursor` on every poll,
 * persisting the returned cursor only after transactionally processing the
 * events. That is what makes a lost poll response safe (redelivery on retry) —
 * an engine-side cursor advanced before the response reached the consumer would
 * silently drop those events forever.
 */
export class EngineStore {
  private state: StoreState;
  private readonly filePath: string;
  private writeChain: Promise<void> = Promise.resolve();
  /**
   * Idempotency keys whose send is CURRENTLY executing (claimed, not yet
   * recorded). In-memory only — it exists to stop a SECOND concurrent send()
   * for the same key from opening a second SMTP transaction while the first is
   * still in flight (the double-send race). Not persisted: single-daemon Node
   * is single-threaded so the claim/release is atomic against other handlers.
   * KNOWN RESIDUAL (adversary R3, ACTIVATION Gate 2): a crash AFTER the SMTP
   * server accepts but BEFORE recordSend() flushes drops both this Set and the
   * cache entry, so the consumer's retry re-sends — a durable pre-send intent
   * log is the eventual fix; resolve or founder-accept before arming.
   */
  private readonly inFlight = new Set<string>();

  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true });
    this.filePath = join(stateDir, "engine-state.json");
    this.state = loadState(this.filePath);
  }

  /** The result a prior send with this idempotency key produced, if any. */
  getSend(idempotencyKey: string): SendRecord | undefined {
    return this.state.sends[idempotencyKey];
  }

  /**
   * Reserve an idempotency key as in-flight before the SMTP send. Returns false
   * if a send for this key is ALREADY in flight — the caller MUST NOT start a
   * second SMTP transaction (this is the guard that makes a TTL-reclaim retry
   * racing a still-live send safe). Synchronous check-and-set: it must run with
   * NO await between the getSend() miss and this claim so the input-gate turn
   * that reads an empty cache and the one that takes the claim are the same,
   * mirroring withRequestIdempotency's claim-before-await invariant.
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

  /**
   * Records a completed send and its Message-ID→threadId mapping(s) atomically.
   * `messageId` is the CANONICAL id returned to the caller (the wire id when the
   * transport learned one, else the minted id). `aliasMessageIds` are any OTHER
   * ids for the same message that a reply might carry — for a wire-rewriting
   * transport this is the minted id, mapped alongside the canonical so the reply
   * loop matches on either. Empty for SMTP (wire == minted, one entry).
   */
  async recordSend(
    idempotencyKey: string,
    messageId: string,
    threadId: string,
    sentAt: number,
    aliasMessageIds: string[] = [],
  ): Promise<void> {
    this.state.sends[idempotencyKey] = { messageId, sentAt };
    this.state.threads[messageId] = threadId;
    for (const alias of aliasMessageIds) this.state.threads[alias] = threadId;
    await this.flush();
  }

  /** Resolve an outbound Message-ID back to the threadId it was sent under. */
  resolveThread(messageId: string): string | undefined {
    return this.state.threads[messageId];
  }

  private flush(): Promise<void> {
    // Chain writes so an atomic-rename is never interleaved with another. The
    // snapshot is taken INSIDE the chained task so it reflects all prior writes.
    this.writeChain = this.writeChain.then(() => {
      const tmp = `${this.filePath}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.state));
      renameSync(tmp, this.filePath);
    });
    return this.writeChain;
  }
}

function loadState(filePath: string): StoreState {
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Partial<StoreState>;
    return {
      sends: parsed.sends ?? {},
      threads: parsed.threads ?? {},
    };
  } catch {
    // Missing/corrupt file on first boot -> start empty (the file is written on
    // the first successful send/poll).
    return structuredClone(EMPTY);
  }
}
