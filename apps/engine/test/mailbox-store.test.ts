import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MailboxCredentialStore } from "../src/mailbox-store.js";

// The pilot's real credential shape: a gmail_api mailbox carries an OAuth
// refresh token — the exact secret the F5 "never silently drop credentials"
// finding is about.
const GMAIL_CREDS = {
  imap: { host: "imap.gmail.com", port: 993, secure: true, user: "mordy@authorpitchdesk.com", pass: "app-pass" },
  send: { kind: "gmail_api", clientId: "cid", clientSecret: "csecret", refreshToken: "refresh-token-v1" },
};
const GMAIL_CREDS_ROTATED = {
  ...GMAIL_CREDS,
  send: { ...GMAIL_CREDS.send, refreshToken: "refresh-token-v2" },
};
const EMAIL = "mordy@authorpitchdesk.com";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "engine-mbx-store-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("MailboxCredentialStore — F5 corrupt-file fail-loud", () => {
  it("a MISSING file is a normal first boot: starts empty, no throw", () => {
    const store = new MailboxCredentialStore(dir);
    expect(store.get(EMAIL)).toBeUndefined();
    expect(store.emails()).toEqual([]);
  });

  it("a CORRUPT (invalid JSON) file FAILS LOUD on construction — never silently drops the pushed credentials", () => {
    writeFileSync(join(dir, "pushed-mailboxes.json"), "{ this is not json");
    expect(() => new MailboxCredentialStore(dir)).toThrow(/corrupt/i);
  });

  it("a structurally-wrong (non-object) file FAILS LOUD", () => {
    writeFileSync(join(dir, "pushed-mailboxes.json"), "[1,2,3]");
    expect(() => new MailboxCredentialStore(dir)).toThrow(/corrupt/i);
  });
});

describe("MailboxCredentialStore — F4 idempotency + overwrite policy", () => {
  it("first push CREATES; resolves the pushed credentials", async () => {
    const store = new MailboxCredentialStore(dir);
    const res = await store.upsert(EMAIL, GMAIL_CREDS);
    expect(res.outcome).toBe("created");
    expect(store.get(EMAIL)).toMatchObject({ send: { refreshToken: "refresh-token-v1" } });
  });

  it("re-pushing byte-identical credentials is a content-hash no-op (UNCHANGED) — the F6 retry loop is safe", async () => {
    const store = new MailboxCredentialStore(dir);
    const first = await store.upsert(EMAIL, GMAIL_CREDS);
    const second = await store.upsert(EMAIL, GMAIL_CREDS);
    expect(second.outcome).toBe("unchanged");
    expect(second.contentHash).toBe(first.contentHash);
  });

  it("re-pushing identical creds under the SAME idempotency key is a REPLAYED no-op", async () => {
    const store = new MailboxCredentialStore(dir);
    await store.upsert(EMAIL, GMAIL_CREDS, "idem-1");
    const replay = await store.upsert(EMAIL, GMAIL_CREDS, "idem-1");
    expect(replay.outcome).toBe("replayed");
  });

  it("rotation: DIFFERENT credentials for a known mailbox OVERWRITE (replaced), echoing the prior hash", async () => {
    const store = new MailboxCredentialStore(dir);
    const created = await store.upsert(EMAIL, GMAIL_CREDS);
    const rotated = await store.upsert(EMAIL, GMAIL_CREDS_ROTATED);
    expect(rotated.outcome).toBe("replaced");
    expect(rotated.priorContentHash).toBe(created.contentHash);
    expect(store.get(EMAIL)).toMatchObject({ send: { refreshToken: "refresh-token-v2" } });
  });

  it("reusing one idempotency key for a DIFFERENT payload is rejected (key discipline), NOT silently applied", async () => {
    const store = new MailboxCredentialStore(dir);
    await store.upsert(EMAIL, GMAIL_CREDS, "idem-2");
    await expect(store.upsert(EMAIL, GMAIL_CREDS_ROTATED, "idem-2")).rejects.toThrow(/idempotency key/i);
    // The rejected push did NOT overwrite the good credentials.
    expect(store.get(EMAIL)).toMatchObject({ send: { refreshToken: "refresh-token-v1" } });
  });

  it("invalid credentials are rejected at the boundary (BadRequest), never stored", async () => {
    const store = new MailboxCredentialStore(dir);
    // smtp transport (default) with no smtp endpoint fails the schema's superRefine.
    await expect(store.upsert(EMAIL, { imap: GMAIL_CREDS.imap })).rejects.toThrow();
    expect(store.get(EMAIL)).toBeUndefined();
  });

  it("persists pushed credentials across a reload (durable JSON file)", async () => {
    const store1 = new MailboxCredentialStore(dir);
    await store1.upsert(EMAIL, GMAIL_CREDS);
    const store2 = new MailboxCredentialStore(dir);
    expect(store2.get(EMAIL)).toMatchObject({ send: { refreshToken: "refresh-token-v1" } });
  });
});

describe("MailboxCredentialStore — remove (revoke path)", () => {
  it("removes a pushed mailbox; a second remove is an idempotent no-op (removed:false)", async () => {
    const store = new MailboxCredentialStore(dir);
    await store.upsert(EMAIL, GMAIL_CREDS);
    expect((await store.remove(EMAIL)).removed).toBe(true);
    expect(store.get(EMAIL)).toBeUndefined();
    expect((await store.remove(EMAIL)).removed).toBe(false);
  });
});

// F1 (wave 2, CREDSTORE) — the audit's proven rotation-revert attack, closed by
// a Worker-owned monotonic push_seq. pushSeq orders CLAIMS, not content: a push
// CLAIMED earlier (lower seq) can never overwrite one claimed later, regardless
// of arrival order at the engine.
describe("MailboxCredentialStore — F1 pushSeq ordering", () => {
  it("audit's exact attack: v1(seq1) -> rotate v2(seq2) -> replay stale v1(seq1) stays v2, outcome 'stale'", async () => {
    const store = new MailboxCredentialStore(dir);
    await store.upsert(EMAIL, GMAIL_CREDS, undefined, 1);
    await store.upsert(EMAIL, GMAIL_CREDS_ROTATED, undefined, 2);
    const replay = await store.upsert(EMAIL, GMAIL_CREDS, undefined, 1);
    expect(replay.outcome).toBe("stale");
    expect(store.get(EMAIL)).toMatchObject({ send: { refreshToken: "refresh-token-v2" } });
  });

  it("equal seq + same content -> 'unchanged'", async () => {
    const store = new MailboxCredentialStore(dir);
    await store.upsert(EMAIL, GMAIL_CREDS, undefined, 1);
    const replay = await store.upsert(EMAIL, GMAIL_CREDS, undefined, 1);
    expect(replay.outcome).toBe("unchanged");
  });

  it("equal seq + DIFFERENT content -> BadRequest (two claims for one seq is a caller bug), original content untouched", async () => {
    const store = new MailboxCredentialStore(dir);
    await store.upsert(EMAIL, GMAIL_CREDS, undefined, 1);
    await expect(store.upsert(EMAIL, GMAIL_CREDS_ROTATED, undefined, 1)).rejects.toThrow(/seq/i);
    expect(store.get(EMAIL)).toMatchObject({ send: { refreshToken: "refresh-token-v1" } });
  });

  it("absent pushSeq is exact legacy behavior: content-hash rotation still overwrites, unaffected by any stored seq", async () => {
    const store = new MailboxCredentialStore(dir);
    await store.upsert(EMAIL, GMAIL_CREDS, undefined, 5);
    const legacyPush = await store.upsert(EMAIL, GMAIL_CREDS_ROTATED);
    expect(legacyPush.outcome).toBe("replaced");
    expect(store.get(EMAIL)).toMatchObject({ send: { refreshToken: "refresh-token-v2" } });
  });
});

// F1/F2 tombstones — the audit's proven resurrection attack (push in flight
// across a remove()), closed by retaining the last-seen pushSeq as a tombstone
// so a late/stale push against a removed mailbox grades 'stale' instead of
// resurrecting a revoked credential.
describe("MailboxCredentialStore — tombstones (in-flight resurrection + revive)", () => {
  it("audit's resurrection attack: push in flight when remove() lands grades 'stale', not 'created'", async () => {
    const store = new MailboxCredentialStore(dir);
    await store.upsert(EMAIL, GMAIL_CREDS, undefined, 1);
    await store.remove(EMAIL);
    // The in-flight push (same seq it was claimed with) lands after the remove.
    const late = await store.upsert(EMAIL, GMAIL_CREDS, undefined, 1);
    expect(late.outcome).toBe("stale");
    expect(store.get(EMAIL)).toBeUndefined();
  });

  it("seqless push against a tombstone grades 'stale' (resurrection is the harm; no escape hatch via omitting the seq)", async () => {
    const store = new MailboxCredentialStore(dir);
    await store.upsert(EMAIL, GMAIL_CREDS, undefined, 1);
    await store.remove(EMAIL);
    const seqless = await store.upsert(EMAIL, GMAIL_CREDS);
    expect(seqless.outcome).toBe("stale");
    expect(store.get(EMAIL)).toBeUndefined();
  });

  it("seqless push against a LIVE record (no tombstone involved) keeps exact legacy behavior", async () => {
    const store = new MailboxCredentialStore(dir);
    await store.upsert(EMAIL, GMAIL_CREDS);
    const secondSeqless = await store.upsert(EMAIL, GMAIL_CREDS_ROTATED);
    expect(secondSeqless.outcome).toBe("replaced");
    expect(store.get(EMAIL)).toMatchObject({ send: { refreshToken: "refresh-token-v2" } });
  });

  it("revive-after-cancel: a push with seq > tombstone is accepted and the tombstone clears", async () => {
    const store = new MailboxCredentialStore(dir);
    await store.upsert(EMAIL, GMAIL_CREDS, undefined, 1);
    await store.remove(EMAIL);
    const revived = await store.upsert(EMAIL, GMAIL_CREDS_ROTATED, undefined, 2);
    expect(revived.outcome).toBe("created");
    expect(store.get(EMAIL)).toMatchObject({ send: { refreshToken: "refresh-token-v2" } });
    // The tombstone cleared -- a subsequent stale replay of the OLD seq must not
    // be graded against the (now-gone) tombstone; it's ordinary live-record
    // ordering against the revived record's seq 2.
    const staleReplay = await store.upsert(EMAIL, GMAIL_CREDS, undefined, 1);
    expect(staleReplay.outcome).toBe("stale");
    expect(store.get(EMAIL)).toMatchObject({ send: { refreshToken: "refresh-token-v2" } });
  });

  it("old-shape state file (no tombstones key) loads fine -- shape tolerance for pre-wave2 state files", () => {
    writeFileSync(join(dir, "pushed-mailboxes.json"), JSON.stringify({ mailboxes: {}, idempotency: {} }));
    expect(() => new MailboxCredentialStore(dir)).not.toThrow();
    const store = new MailboxCredentialStore(dir);
    expect(store.get(EMAIL)).toBeUndefined();
  });

  it("a corrupt state file still FAILS LOUD (standing F5 rule, unaffected by the tombstones addition)", () => {
    writeFileSync(join(dir, "pushed-mailboxes.json"), "{ not json");
    expect(() => new MailboxCredentialStore(dir)).toThrow(/corrupt/i);
  });
});
