import { ImapFlow } from "imapflow";
import type { Endpoint } from "./config.js";
import { UpstreamTransientError } from "./errors.js";

export interface RawMessage {
  uid: number;
  source: string;
}

export interface ImapFetcher {
  /**
   * Cheap STATUS probe for the mailbox's current UIDNEXT (the UID that will be
   * assigned to the next arriving message) — no message fetch, no mailbox
   * SELECT/lock. Used to initialize a first-contact cursor without pulling any
   * history, and to bound every incremental poll's fetch range.
   */
  currentUidNext(creds: Endpoint): Promise<number>;
  /** Fetch every INBOX message with UID in the inclusive range (sinceUid, throughUid]. */
  fetchRange(creds: Endpoint, sinceUid: number, throughUid: number): Promise<RawMessage[]>;
}

async function withClient<T>(creds: Endpoint, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  const client = new ImapFlow({
    host: creds.host,
    port: creds.port,
    secure: creds.secure,
    auth: { user: creds.user, pass: creds.pass },
    logger: false,
  });
  try {
    await client.connect();
  } catch (err) {
    throw new UpstreamTransientError(`IMAP connect failed for ${creds.user}: ${(err as Error).message}`, {
      cause: err,
    });
  }
  try {
    return await fn(client);
  } finally {
    await client.logout().catch(() => {});
  }
}

/**
 * Real IMAP fetcher via imapflow (the A5-validated library). Every poll is now
 * bounded: `currentUidNext` lets the caller (engine.ts) initialize a new
 * mailbox's cursor at its current high-water WITHOUT fetching any history, and
 * lets it cap every incremental fetch to an explicit numeric UID range instead
 * of the open-ended `sinceUid+1:*` — the unbounded-fetch defect (a real
 * pre-existing mailbox's full history buffered as full RFC5322 sources in one
 * array, found live by the Gate-1 smoke on a >147k-UID test account).
 */
export const imapflowFetcher: ImapFetcher = {
  async currentUidNext(creds) {
    return withClient(creds, async (client) => {
      try {
        const status = await client.status("INBOX", { uidNext: true });
        // UIDNEXT is always defined per RFC 3501 (starts at 1 on an empty
        // mailbox); the fallback is defensive only.
        return status.uidNext ?? 1;
      } catch (err) {
        throw new UpstreamTransientError(`IMAP STATUS failed for ${creds.user}: ${(err as Error).message}`, {
          cause: err,
        });
      }
    });
  },

  async fetchRange(creds, sinceUid, throughUid) {
    if (throughUid <= sinceUid) return [];
    return withClient(creds, async (client) => {
      const out: RawMessage[] = [];
      const lock = await client.getMailboxLock("INBOX");
      try {
        // An explicit bounded numeric range (never `*`) — the server can never
        // hand back more than `throughUid - sinceUid` messages, which is what
        // makes the batch cap in engine.ts an actual hard bound, not just a
        // client-side truncation of an already-unbounded fetch.
        for await (const msg of client.fetch({ uid: `${sinceUid + 1}:${throughUid}` }, { uid: true, source: true })) {
          // Defensive re-check: some IMAP servers substitute the nearest
          // existing message when an endpoint of a range doesn't exist.
          if (msg.uid > sinceUid && msg.uid <= throughUid && msg.source) {
            out.push({ uid: msg.uid, source: msg.source.toString("utf8") });
          }
        }
      } catch (err) {
        throw new UpstreamTransientError(`IMAP fetch failed for ${creds.user}: ${(err as Error).message}`, {
          cause: err,
        });
      } finally {
        lock.release();
      }
      return out;
    });
  },
};
