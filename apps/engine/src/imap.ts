import { ImapFlow } from "imapflow";
import type { Endpoint } from "./config.js";
import { UpstreamTransientError } from "./errors.js";

export interface RawMessage {
  uid: number;
  source: string;
}

export interface ImapFetcher {
  /** Fetch every INBOX message with UID strictly greater than `sinceUid`. */
  fetchSince(creds: Endpoint, sinceUid: number): Promise<RawMessage[]>;
}

/**
 * Real IMAP incremental fetch via imapflow (the A5-validated library). Fetches
 * only UIDs above the caller's high-water mark — the real equivalent of the
 * sandbox poll()'s "returns and clears" (there is no atomic clear over IMAP).
 * At-least-once by design: the Worker dedupes on each event's Message-ID, so a
 * re-fetch after a crash is safe.
 */
export const imapflowFetcher: ImapFetcher = {
  async fetchSince(creds, sinceUid) {
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
    const out: RawMessage[] = [];
    const lock = await client.getMailboxLock("INBOX");
    try {
      // `${sinceUid + 1}:*` is a UID range; on an empty/low mailbox IMAP still
      // returns the last message, so we defensively re-check the UID below.
      for await (const msg of client.fetch({ uid: `${sinceUid + 1}:*` }, { uid: true, source: true })) {
        if (msg.uid > sinceUid && msg.source) {
          out.push({ uid: msg.uid, source: msg.source.toString("utf8") });
        }
      }
    } catch (err) {
      throw new UpstreamTransientError(`IMAP fetch failed for ${creds.user}: ${(err as Error).message}`, {
        cause: err,
      });
    } finally {
      lock.release();
      await client.logout().catch(() => {});
    }
    return out;
  },
};
