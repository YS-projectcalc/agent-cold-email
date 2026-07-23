import { createHash } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type MailboxCredentials, mailboxCredentialsSchema } from "./config.js";
import { BadRequestError } from "./errors.js";
import { loadJsonStateFile } from "./store.js";

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
 */

export type UpsertOutcome = "created" | "replaced" | "unchanged" | "replayed";

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
}

const EMPTY: MailboxStoreState = { mailboxes: {}, idempotency: {} };

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
   * Upsert (F4). Validates `rawCredentials` through the SAME schema the static
   * config uses, so a pushed mailbox can never carry a shape the send path
   * can't resolve. Returns the applied outcome; throws BadRequestError on
   * invalid credentials or idempotency-key reuse with a different payload.
   */
  async upsert(email: string, rawCredentials: unknown, idempotencyKey?: string): Promise<UpsertResult> {
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
    if (!existing) {
      outcome = "created";
    } else if (existing.contentHash === contentHash) {
      outcome = "unchanged";
    } else {
      outcome = "replaced";
      priorContentHash = existing.contentHash;
    }

    // "unchanged" still (re)writes an identical record — harmless and keeps
    // updatedAt fresh — but the observable state is a no-op.
    this.state.mailboxes[email] = { credentials, contentHash, updatedAt: this.now() };
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
   */
  async remove(email: string): Promise<RemoveResult> {
    if (!this.state.mailboxes[email]) return { email, removed: false };
    delete this.state.mailboxes[email];
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
