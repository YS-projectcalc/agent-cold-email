import { createHash } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type MailboxCredentials, mailboxCredentialsSchema } from "./config.js";
import { BadRequestError } from "./errors.js";
import { loadJsonStateFile } from "./json-store.js";

/**
 * Durable store for PUSHED mailbox credentials (self-serve activation I3).
 *
 * The Worker provisions a mailbox at the vendor, mints/collects its send+IMAP
 * credentials, and PUSHes them here over the authed `POST /v1/mailboxes`
 * boundary (ARCHITECTURE push-to-droplet: the internet-facing Worker never
 * durably stores a refresh token — it lands ONLY on this firewalled daemon).
 * Kept a SEPARATE responsibility from EngineStore (send/thread idempotency) per
 * the anti-god-file rule: this file owns credential lifecycle, that one owns
 * send lifecycle.
 *
 * F4 (design review) — the write path is idempotent two ways:
 *   1. CONTENT-HASH replay-safety (primary): a re-push of byte-identical
 *      credentials is a no-op, so the Worker's F6 retry/reconcile loop can push
 *      the same creds any number of times without churning state.
 *   2. IDEMPOTENCY KEY (optional, defensive): a client MAY stamp each push with
 *      a key; replaying that key with the SAME payload returns the recorded
 *      outcome, and reusing it with a DIFFERENT payload is rejected as a client
 *      bug (Stripe-style key discipline) rather than silently overwriting.
 *
 * OVERWRITE POLICY (explicit): `POST /v1/mailboxes` is an UPSERT keyed by email.
 *   - new email                      -> "created"
 *   - existing email, same content   -> "unchanged" (idempotent no-op)
 *   - existing email, different, NO reused key -> "replaced" (credential
 *     ROTATION is first-class: OAuth refresh tokens rotate, so a fresh push for
 *     a known mailbox must be allowed to overwrite). The prior content hash is
 *     echoed for audit.
 *   - existing key, different content -> REJECTED (BadRequest) — key reuse.
 *
 * F5 — a corrupt state file FAILS LOUD (loadJsonStateFile): the daemon refuses
 * to start rather than boot with an empty credential set and then overwrite the
 * only copy of the real refresh tokens on the next flush.
 *
 * F1 (Wave 2 CREDSTORE) — a Worker-owned monotonic `pushSeq` per mailbox closes
 * the content-hash scheme's blind spot: content-hash is DEDUP, not ORDERING, so
 * a stale-but-different push landing after a rotation used to silently revert
 * it (the audit's proven attack — see mailbox-store.test.ts). `pushSeq` orders
 * CLAIMS, not content: a push claimed earlier can never overwrite one claimed
 * later, full stop, regardless of arrival order at the engine.
 *   - incoming.pushSeq < stored.pushSeq          -> "stale", NO write.
 *   - incoming.pushSeq === stored.pushSeq, same content  -> "unchanged".
 *   - incoming.pushSeq === stored.pushSeq, different content -> REJECTED
 *     (BadRequest) — two claims for one seq is a caller bug, surfaced loudly
 *     rather than silently picking a winner.
 *   - incoming.pushSeq is ABSENT (no live comparable seq on either side) ->
 *     exact legacy content-hash-only behavior. Static-config and any caller
 *     that never sends a seq is completely unaffected.
 *
 * TOMBSTONES (Wave 2 CREDSTORE, the in-flight resurrection case) — `remove()`
 * deletes the credential record but retains `tombstones[email] = <last-seen
 * pushSeq>`. A later upsert with no live record consults the tombstone:
 *   - incoming.pushSeq <= tombstone  -> "stale", NO write (the removed mailbox
 *     stays removed; a claim from before or at cancel time cannot resurrect it).
 *   - incoming.pushSeq > tombstone   -> accepted ("created"), tombstone cleared
 *     (legitimate re-provision: the Worker-side push_seq counter survives the
 *     status flip, so a genuine revive always carries a strictly higher seq).
 *   - a SEQLESS push against a tombstone -> "stale". Resurrection is the harm
 *     being closed here, so an absent seq gets no special exemption post-cancel
 *     (unlike the legacy-behavior carve-out for a LIVE record above) — every
 *     prod push carries a seq after this wave.
 *
 * Recovery for a tombstoned email that legitimately needs credentials again:
 *   (a) the droplet's static `MAILBOX_CREDENTIALS(_FILE)` config, which the
 *       resolve-union checks BEFORE the pushed store and is entirely unaffected
 *       by a tombstone (an operator can always pin credentials by hand), or
 *   (b) a fresh seq-bearing push (the normal re-provision path).
 * A manual seqless `curl` re-push against a tombstoned email has no escape
 * hatch other than (a)/(b) above — by design.
 *
 * Tombstone retention tradeoff: entries are retained FOREVER (never pruned),
 * so `tombstones` grows monotonically with mailbox churn across the life of
 * the daemon's state file. Accepted for now — the state file is small JSON and
 * churn volume is low; revisit with a retention/GC policy if it ever isn't.
 */

export type UpsertOutcome = "created" | "replaced" | "unchanged" | "replayed" | "stale";

export interface UpsertResult {
  email: string;
  outcome: UpsertOutcome;
  contentHash: string;
  /** Set only when outcome === "replaced": the hash of the credentials that were overwritten. */
  priorContentHash?: string;
}

export interface RemoveResult {
  email: string;
  removed: boolean;
}

interface MailboxRecord {
  credentials: MailboxCredentials;
  contentHash: string;
  updatedAt: number;
  /** The claim sequence this record was last written under, if any (F1). Preserved across a legacy seqless overwrite so ordering stays enforceable. */
  pushSeq?: number;
}

interface IdempotencyRecord {
  email: string;
  contentHash: string;
  outcome: UpsertOutcome;
  appliedAt: number;
}

interface MailboxStoreState {
  /** email -> the pushed credential record. */
  mailboxes: Record<string, MailboxRecord>;
  /** idempotencyKey -> the upsert it first produced (replay-safety). */
  idempotency: Record<string, IdempotencyRecord>;
  /** email -> last-seen pushSeq at removal time (F1 tombstones — see doc comment above). */
  tombstones: Record<string, number>;
}

const EMPTY: MailboxStoreState = { mailboxes: {}, idempotency: {}, tombstones: {} };

export class MailboxCredentialStore {
  private state: MailboxStoreState;
  private readonly filePath: string;
  private writeChain: Promise<void> = Promise.resolve();
  private readonly now: () => number;

  constructor(stateDir: string, now: () => number = Date.now) {
    mkdirSync(stateDir, { recursive: true });
    this.filePath = join(stateDir, "pushed-mailboxes.json");
    this.now = now;
    this.state = loadJsonStateFile<MailboxStoreState>(this.filePath, EMPTY, "pushed mailbox credentials", (parsed) => ({
      mailboxes: (parsed.mailboxes as MailboxStoreState["mailboxes"]) ?? {},
      idempotency: (parsed.idempotency as MailboxStoreState["idempotency"]) ?? {},
      // A pre-wave2 state file has no `tombstones` key at all -- default to
      // empty rather than throwing, so an old-shape file still loads (only a
      // genuinely corrupt file, per loadJsonStateFile's own contract, throws).
      tombstones: (parsed.tombstones as MailboxStoreState["tombstones"]) ?? {},
    }));
  }

  /** Pushed credentials for `email`, if any. The resolve-union consults this AFTER the static config (config wins). */
  get(email: string): MailboxCredentials | undefined {
    return this.state.mailboxes[email]?.credentials;
  }

  /** All email addresses that currently have pushed credentials. */
  emails(): string[] {
    return Object.keys(this.state.mailboxes);
  }

  /**
   * Upsert (F4 + F1). Validates `rawCredentials` through the SAME schema the
   * static config uses, so a pushed mailbox can never carry a shape the send
   * path can't resolve. Returns the applied outcome; throws BadRequestError on
   * invalid credentials, idempotency-key reuse with a different payload, or a
   * `pushSeq` reused for different content (see class doc comment for the full
   * F1/tombstone rule set).
   */
  async upsert(email: string, rawCredentials: unknown, idempotencyKey?: string, pushSeq?: number): Promise<UpsertResult> {
    const parsed = mailboxCredentialsSchema.safeParse(rawCredentials);
    if (!parsed.success) {
      throw new BadRequestError(`invalid mailbox credentials for ${email}: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
    }
    const credentials = parsed.data;
    const contentHash = hashCredentials(credentials);

    if (idempotencyKey) {
      const seen = this.state.idempotency[idempotencyKey];
      if (seen) {
        // Same key MUST describe the same request (email + content). A replay of
        // the identical push returns the recorded outcome WITHOUT re-writing —
        // never resurrecting stale content over whatever the current state is.
        if (seen.email === email && seen.contentHash === contentHash) {
          return { email, outcome: "replayed", contentHash };
        }
        throw new BadRequestError(
          `idempotency key ${idempotencyKey} was already used for a different mailbox push (${seen.email}) — a key must map to one request`,
        );
      }
    }

    const existing = this.state.mailboxes[email];
    let outcome: UpsertOutcome;
    let priorContentHash: string | undefined;

    if (existing) {
      if (pushSeq !== undefined && existing.pushSeq !== undefined) {
        // F1 claim ordering: both sides carry a comparable seq.
        if (pushSeq < existing.pushSeq) {
          return { email, outcome: "stale", contentHash };
        }
        if (pushSeq === existing.pushSeq) {
          if (existing.contentHash === contentHash) {
            outcome = "unchanged";
          } else {
            throw new BadRequestError(
              `push_seq ${pushSeq} for ${email} was already claimed with different content — two claims for one seq is a caller bug`,
            );
          }
        } else if (existing.contentHash === contentHash) {
          outcome = "unchanged";
        } else {
          outcome = "replaced";
          priorContentHash = existing.contentHash;
        }
      } else {
        // Absent pushSeq on either side -> exact legacy content-hash-only
        // behavior (no ordering to enforce without a comparable seq on both
        // sides).
        if (existing.contentHash === contentHash) {
          outcome = "unchanged";
        } else {
          outcome = "replaced";
          priorContentHash = existing.contentHash;
        }
      }
    } else {
      const tombstone = this.state.tombstones[email];
      if (tombstone !== undefined) {
        // A seqless push against a tombstone, or one at/below the tombstoned
        // seq, cannot resurrect the removed mailbox.
        if (pushSeq === undefined || pushSeq <= tombstone) {
          return { email, outcome: "stale", contentHash };
        }
        outcome = "created";
        delete this.state.tombstones[email];
      } else {
        outcome = "created";
      }
    }

    // "unchanged" still (re)writes an identical record — harmless and keeps
    // updatedAt fresh — but the observable state is a no-op. pushSeq is
    // preserved from the existing record when the incoming push is seqless, so
    // a legacy write never regresses a record's ordering metadata to
    // unknown.
    const nextPushSeq = pushSeq !== undefined ? pushSeq : existing?.pushSeq;
    this.state.mailboxes[email] = {
      credentials,
      contentHash,
      updatedAt: this.now(),
      ...(nextPushSeq !== undefined ? { pushSeq: nextPushSeq } : {}),
    };
    if (idempotencyKey) {
      this.state.idempotency[idempotencyKey] = { email, contentHash, outcome, appliedAt: this.now() };
    }
    await this.flush();
    return { email, outcome, contentHash, ...(priorContentHash ? { priorContentHash } : {}) };
  }

  /**
   * Remove pushed credentials for `email` (the cancel/teardown REVOKE path).
   * Naturally idempotent: removing an unknown/already-removed email returns
   * `removed: false` and is not an error, so a retried teardown is safe. Only
   * the PUSHED store is affected — a mailbox pinned in the operator's static
   * config is not removable via this API (see the resolve-union precedence).
   *
   * F1 tombstone: retains the removed record's last-seen `pushSeq` (0 if the
   * record never carried one) so a push claimed before or at cancel time can
   * never resurrect it — see the class doc comment for the full rule.
   */
  async remove(email: string): Promise<RemoveResult> {
    const existing = this.state.mailboxes[email];
    if (!existing) return { email, removed: false };
    delete this.state.mailboxes[email];
    this.state.tombstones[email] = existing.pushSeq ?? 0;
    await this.flush();
    return { email, removed: true };
  }

  private flush(): Promise<void> {
    // Chained atomic (write-temp + rename) flush, mirroring EngineStore.flush so
    // a credential write is never torn or interleaved with another.
    this.writeChain = this.writeChain.then(() => {
      const tmp = `${this.filePath}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.state));
      renameSync(tmp, this.filePath);
    });
    return this.writeChain;
  }
}

/**
 * Stable content hash of a validated credential record — deterministic
 * regardless of key insertion order, so a byte-for-byte-equal credential
 * re-push always collides (content-hash replay-safety) even if the client
 * serialized its JSON keys in a different order.
 */
function hashCredentials(credentials: MailboxCredentials): string {
  return createHash("sha256").update(stableStringify(credentials)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}
