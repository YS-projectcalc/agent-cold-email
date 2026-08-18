import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SendEmailInput } from "@coldstart/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CredentialsMap, GmailTransport, SendTransport } from "../src/config.js";
import { EmailEngine } from "../src/engine.js";
import { SendUnverifiedError } from "../src/errors.js";
import type { GmailLookup, GmailSender } from "../src/gmail.js";
import { reconcile, type GmailVerifier } from "../src/reconcile.js";
import { EngineStore } from "../src/store.js";
import { ControllableSmtp, CountingSmtp, FaultySendLog, NoopImap } from "./crash-doubles.js";

const SENDER = "sender@coldstart.test";
const GMAIL_BOX = "gmail@coldstart.test";
const A_LEAD = "a@example.com";
const B_LEAD = "b@example.com";
const gmailTransport: GmailTransport = { kind: "gmail_api", clientId: "c", clientSecret: "s", refreshToken: "rt" };

const creds: CredentialsMap = {
  [SENDER]: {
    smtp: { host: "smtp", port: 465, secure: true, user: SENDER, pass: "p" },
    imap: { host: "imap", port: 993, secure: true, user: SENDER, pass: "p" },
  },
  [GMAIL_BOX]: {
    imap: { host: "imap", port: 993, secure: true, user: GMAIL_BOX, pass: "p" },
    send: gmailTransport,
  },
};

function baseInput(overrides: Partial<SendEmailInput> = {}): SendEmailInput {
  return { fromEmail: SENDER, toEmail: A_LEAD, subject: "hi", body: "hello", threadId: "thr_1", inReplyToMessageId: null, ...overrides };
}

/** A gmail verifier that returns a scripted sequence of lookup results (drained per call). */
class FakeGmailVerifier implements GmailVerifier {
  calls: string[] = [];
  constructor(private readonly results: GmailLookup[]) {}
  async lookup(_t: GmailTransport, gmailId: string): Promise<GmailLookup> {
    this.calls.push(gmailId);
    return this.results.shift() ?? { kind: "uncertain" };
  }
}

/** A gmail transport that additionally serves the reconcile lookup (used by the end-to-end crash test). */
class FullGmail implements GmailSender {
  submits = 0;
  lookups: string[] = [];
  constructor(private readonly wire: string) {}
  async submit(): Promise<string | undefined> {
    this.submits++;
    return "gm123";
  }
  async wireId(): Promise<string | undefined> {
    return this.wire;
  }
  async lookup(_t: GmailTransport, gmailId: string): Promise<GmailLookup> {
    this.lookups.push(gmailId);
    return { kind: "found", wireId: this.wire };
  }
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "reconcile-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const resolveGmail: (from: string) => SendTransport | undefined = () => gmailTransport;
const resolveSmtp: (from: string) => SendTransport | undefined = () => undefined; // omitted send ⇒ smtp

// U3 of the head-of-line class sweep (docs/adversarial/class-sweep-hol-blocking-
// 2026-08-17.md), settled. This loop runs at BOOT, before server.listen, and
// index.ts's `main().catch` exits 1 — so an unguarded throw is a crash loop that
// starves every dangling AND all sends and polls for every tenant.
//
// The verdict is split, and the tests below assert BOTH halves. The only throw
// surfaces reachable here are store.park / store.recordSend, which are appends
// to one fsync'd log (gmail.lookup has a catch-all; resolveSend is a map read).
// So a PARTIAL failure is worth isolating — one item must not cost the others —
// while a WHOLLY unwritable store must still abort boot, because "park + alert"
// is not implementable when parking is itself an append, and an engine that can
// durably record nothing must not accept traffic.
describe("U3 — one unresolvable dangling must not cost the others, but a dead store still aborts boot", () => {
  /** Fails `park` for one specific key — the partial/intermittent case. */
  function storeWithPoisonedPark(store: EngineStore, poisonKey: string): EngineStore {
    return new Proxy(store, {
      get(target, prop, receiver) {
        if (prop !== "park") return Reflect.get(target, prop, receiver);
        return (key: string, reason: string): void => {
          if (key === poisonKey) throw new Error("simulated durable append failure");
          target.park(key, reason);
        };
      },
    });
  }

  it("parks the other danglings and leaves the failing one dangling for the next boot", async () => {
    const store = new EngineStore(dir, { now: () => 1 });
    store.appendIntent("k-poison", { transport: "smtp", from: SENDER, to: A_LEAD, mintedId: "<a@x>", threadId: "thr_a" });
    store.appendIntent("k-ok", { transport: "smtp", from: SENDER, to: B_LEAD, mintedId: "<b@x>", threadId: "thr_b" });

    // Pre-fix this THREW out of reconcile, so index.ts exited 1 and the engine
    // crash-looped: no dangling was resolved and no traffic was ever accepted.
    const summary = await reconcile({
      store: storeWithPoisonedPark(store, "k-poison"),
      resolveSend: resolveSmtp,
      now: () => 1,
    });

    expect(summary).toMatchObject({ parked: 1, failed: 1 });
    expect(store.listParked().map((p) => p.key)).toEqual(["k-ok"]);
    // The failing one stays dangling, so it is still BLOCKED (drop, never
    // duplicate) and the next boot retries it — the state is behind reality,
    // never ahead of it.
    expect(store.isBlocked("k-poison")).toBe(true);
    expect(store.listDanglings().map((d) => d.key)).toEqual(["k-poison"]);
  });

  it("a store that can resolve NOTHING still aborts boot rather than starting blind", async () => {
    const store = new EngineStore(dir, { now: () => 1 });
    store.appendIntent("k1", { transport: "smtp", from: SENDER, to: A_LEAD, mintedId: "<a@x>", threadId: "thr_a" });
    store.appendIntent("k2", { transport: "smtp", from: SENDER, to: B_LEAD, mintedId: "<b@x>", threadId: "thr_b" });

    const dead = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop !== "park") return Reflect.get(target, prop, receiver);
        return (): void => {
          throw new Error("disk full");
        };
      },
    });

    await expect(reconcile({ store: dead, resolveSend: resolveSmtp, now: () => 1 })).rejects.toThrow(/disk full/);
  });
});

describe("reconcile — per-transport verifiers (park on any uncertainty)", () => {
  it("smtp dangling ⇒ PARK (nothing server-side to read)", async () => {
    const store = new EngineStore(dir, { now: () => 1 });
    store.appendIntent("k", { transport: "smtp", from: SENDER, to: A_LEAD, mintedId: "<m@x>", threadId: "thr" });
    const summary = await reconcile({ store, resolveSend: resolveSmtp, now: () => 1 });
    expect(summary).toMatchObject({ finalized: 0, parked: 1 });
    expect(store.listParked().map((p) => p.key)).toContain("k");
    expect(store.isBlocked("k")).toBe(true); // 424 until an operator resolves it
  });

  it("ms_graph dangling ⇒ PARK (202 is an async accept; not-found is never definitive)", async () => {
    const store = new EngineStore(dir, { now: () => 1 });
    store.appendIntent("k", { transport: "ms_graph", from: SENDER, to: A_LEAD, mintedId: "<m@x>", threadId: "thr" });
    const summary = await reconcile({ store, resolveSend: () => undefined, now: () => 1 });
    expect(summary.parked).toBe(1);
    expect(store.listParked().map((p) => p.key)).toContain("k");
  });

  it("gmail INTENT-ONLY (no submitted) ⇒ PARK (v1; the SENT-scan is increment 5)", async () => {
    const store = new EngineStore(dir, { now: () => 1 });
    store.appendIntent("k", { transport: "gmail_api", from: GMAIL_BOX, to: A_LEAD, mintedId: "<m@x>", threadId: "thr" });
    const gmail = new FakeGmailVerifier([{ kind: "found", wireId: "<never@x>" }]);
    const summary = await reconcile({ store, resolveSend: resolveGmail, gmail, now: () => 1 });
    expect(summary.parked).toBe(1);
    expect(gmail.calls).toHaveLength(0); // no provider id ⇒ no lookup at all
    expect(store.listParked().map((p) => p.key)).toContain("k");
  });

  it("gmail submitted + messages.get FOUND ⇒ FINALIZE with the wire id + the minted alias", async () => {
    const store = new EngineStore(dir, { now: () => 1 });
    store.appendIntent("k", { transport: "gmail_api", from: GMAIL_BOX, to: A_LEAD, mintedId: "<minted@x>", threadId: "thr" });
    store.appendSubmitted("k", "gm123");
    const gmail = new FakeGmailVerifier([{ kind: "found", wireId: "<wire@mail.gmail.com>" }]);
    const summary = await reconcile({ store, resolveSend: resolveGmail, gmail, now: () => 2000 });

    expect(summary.finalized).toBe(1);
    expect(gmail.calls).toEqual(["gm123"]);
    expect(store.getSend("k")).toEqual({ messageId: "<wire@mail.gmail.com>", sentAt: 2000 });
    expect(store.resolveThread("<wire@mail.gmail.com>")).toBe("thr");
    expect(store.resolveThread("<minted@x>")).toBe("thr"); // minted alias heals reply-matching
    expect(store.isBlocked("k")).toBe(false);
  });

  it("gmail submitted + messages.get 404/exists ⇒ FINALIZE with the minted id (the 200 proved it was sent)", async () => {
    const store = new EngineStore(dir, { now: () => 1 });
    store.appendIntent("k", { transport: "gmail_api", from: GMAIL_BOX, to: A_LEAD, mintedId: "<minted@x>", threadId: "thr" });
    store.appendSubmitted("k", "gm123");
    const gmail = new FakeGmailVerifier([{ kind: "sent" }]);
    const summary = await reconcile({ store, resolveSend: resolveGmail, gmail, now: () => 2000 });

    expect(summary.finalized).toBe(1);
    expect(store.getSend("k")).toEqual({ messageId: "<minted@x>", sentAt: 2000 });
    expect(store.isBlocked("k")).toBe(false);
  });

  it("gmail submitted + messages.get UNCERTAIN twice ⇒ PARK after the 2-try bound", async () => {
    const store = new EngineStore(dir, { now: () => 1 });
    store.appendIntent("k", { transport: "gmail_api", from: GMAIL_BOX, to: A_LEAD, mintedId: "<m@x>", threadId: "thr" });
    store.appendSubmitted("k", "gm123");
    const gmail = new FakeGmailVerifier([{ kind: "uncertain" }, { kind: "uncertain" }]);
    const summary = await reconcile({ store, resolveSend: resolveGmail, gmail, now: () => 1 });

    expect(summary.parked).toBe(1);
    expect(gmail.calls).toHaveLength(2); // retried once (2-try) before parking
    expect(store.listParked().map((p) => p.key)).toContain("k");
  });

  it("gmail submitted + UNCERTAIN then FOUND ⇒ the 2-try retry recovers and FINALIZES", async () => {
    const store = new EngineStore(dir, { now: () => 1 });
    store.appendIntent("k", { transport: "gmail_api", from: GMAIL_BOX, to: A_LEAD, mintedId: "<m@x>", threadId: "thr" });
    store.appendSubmitted("k", "gm123");
    const gmail = new FakeGmailVerifier([{ kind: "uncertain" }, { kind: "found", wireId: "<w@x>" }]);
    const summary = await reconcile({ store, resolveSend: resolveGmail, gmail, now: () => 2 });

    expect(summary.finalized).toBe(1);
    expect(gmail.calls).toHaveLength(2);
    expect(store.getSend("k")?.messageId).toBe("<w@x>");
  });
});

describe("reconcile — aggregate bound (a mass crash must not hold server.listen open)", () => {
  it("past the aggregate deadline, remaining gmail danglings PARK WITHOUT a provider verify", async () => {
    const store = new EngineStore(dir, { now: () => 1 });
    store.appendIntent("k1", { transport: "gmail_api", from: GMAIL_BOX, to: A_LEAD, mintedId: "<m1@x>", threadId: "thr1" });
    store.appendSubmitted("k1", "g1");
    store.appendIntent("k2", { transport: "gmail_api", from: GMAIL_BOX, to: B_LEAD, mintedId: "<m2@x>", threadId: "thr2" });
    store.appendSubmitted("k2", "g2");
    const gmail = new FakeGmailVerifier([{ kind: "found", wireId: "<w1@x>" }, { kind: "found", wireId: "<w2@x>" }]);
    // deps.now(): start=0, k1-check=0 (verify), k1-recordSentAt=0, k2-check=150 (past the 100ms deadline).
    const values = [0, 0, 0, 150];
    let i = 0;
    const now = () => values[Math.min(i++, values.length - 1)]!;

    const summary = await reconcile({ store, resolveSend: resolveGmail, gmail, now, aggregateDeadlineMs: 100 });

    expect(gmail.calls).toEqual(["g1"]); // ONLY k1 verified; k2 overflow-parked without a lookup
    expect(summary).toMatchObject({ finalized: 1, parked: 1, overflowParked: 1 });
    expect(store.getSend("k1")?.messageId).toBe("<w1@x>");
    expect(store.listParked().map((p) => p.key)).toContain("k2");
  });
});

describe("reconcile — end-to-end crash recovery (the load-bearing guarantees)", () => {
  it("B1 (end-to-end): live compaction fires between key B's intent and its terminal; the dangling survives snapshot+rotation; boot reconciliation PARKS it; the retry is 424 — exactly ONE B submit (FAILS if `danglings` is dropped from the snapshot)", async () => {
    const smtp = new ControllableSmtp(B_LEAD); // stalls B, resolves A
    const store1 = new EngineStore(dir, {
      compactEveryRecorded: 1,
      makeSendLog: (p) => new FaultySendLog(p, (l) => l.type === "recorded" && l.key === "B"),
    });
    const engine1 = new EmailEngine({ credentials: creds, store: store1, smtp, imap: new NoopImap() });

    // B is dispatched first and STALLS with only its intent durable.
    const bSend = engine1.send(baseInput({ toEmail: B_LEAD }), "B");
    // A completes → its recorded line trips the compaction threshold WHILE B is
    // dangling. The snapshot MUST carry B forward before rotation discards the log.
    await engine1.send(baseInput({ toEmail: A_LEAD }), "A");
    // Release B: SMTP accepts (2 submits total); B's recorded append then faults.
    smtp.releaseStalled();
    await bSend;
    expect(smtp.calls).toHaveLength(2);
    store1.close();

    // Reboot: B's intent survives ONLY via the snapshot's danglings.
    const store2 = new EngineStore(dir);
    expect(store2.isBlocked("B")).toBe(true);
    const engine2 = new EmailEngine({ credentials: creds, store: store2, smtp, imap: new NoopImap() });
    const summary = await engine2.reconcilePendingSends();
    expect(summary.parked).toBe(1);
    expect(store2.parkedCount()).toBe(1);

    // The consumer retries B → 424 (parked), never a second SMTP transaction.
    await expect(engine2.send(baseInput({ toEmail: B_LEAD }), "B")).rejects.toBeInstanceOf(SendUnverifiedError);
    expect(smtp.calls).toHaveLength(2);
    store2.close();
  });

  it("gmail crash after submitted{id}: boot reconciliation FINALIZES via messages.get; the retry hits the cache (no second submit)", async () => {
    const wire = "<CAMwire@mail.gmail.com>";
    const gmail = new FullGmail(wire);
    const smtp = new CountingSmtp();
    const store1 = new EngineStore(dir, { makeSendLog: (p) => new FaultySendLog(p, (l) => l.type === "recorded") });
    const engine1 = new EmailEngine({ credentials: creds, store: store1, smtp, imap: new NoopImap(), gmail, graph: undefined });

    // Crash after submitted{gm123} is durable but before recordSend.
    await engine1.send(baseInput({ fromEmail: GMAIL_BOX }), "k");
    expect(gmail.submits).toBe(1);
    store1.close();

    // Reboot: the dangling has providerRef gm123 ⇒ reconcile can messages.get.
    const store2 = new EngineStore(dir);
    const minted = store2.listDanglings()[0]!.mintedId;
    const engine2 = new EmailEngine({ credentials: creds, store: store2, smtp, imap: new NoopImap(), gmail, graph: undefined });
    const summary = await engine2.reconcilePendingSends();
    expect(summary.finalized).toBe(1);
    expect(store2.getSend("k")).toMatchObject({ messageId: wire });
    expect(store2.resolveThread(wire)).toBe("thr_1");
    expect(store2.resolveThread(minted)).toBe("thr_1"); // minted alias

    // Retry hits the cache — never a second submit.
    const retry = await engine2.send(baseInput({ fromEmail: GMAIL_BOX }), "k");
    expect(retry.messageId).toBe(wire);
    expect(gmail.submits).toBe(1);
    store2.close();
  });

  it("NB1: gmail submit() SENT the message, then the submitted-append fsync fails TRANSIENTLY ⇒ the key stays DANGLING (424 on the alive retry, boot finalizes) — never a second messages.send", async () => {
    // The reviewer's NB1 double-send window: once submit() resolves the message is
    // on the wire, so a failure in the SUBSEQUENT bookkeeping append must NOT
    // downgrade the key to attempt-failed/clear (which would let an alive retry
    // re-send). after-fsync mode lands the submitted bytes but throws its fsync —
    // a transient IO error where the message went out AND the submitted line
    // survives (so boot reconciliation can finalize it).
    const wire = "<CAMnb1@mail.gmail.com>";
    const gmail = new FullGmail(wire);
    const smtp = new CountingSmtp();
    const store1 = new EngineStore(dir, {
      makeSendLog: (p) => new FaultySendLog(p, (l) => l.type === "submitted", "after-fsync"),
    });
    const engine1 = new EmailEngine({ credentials: creds, store: store1, smtp, imap: new NoopImap(), gmail, graph: undefined });

    // The send throws (the submitted-append fsync IO error), but the message IS on
    // the wire (exactly one submit) — the guard must keep the key dangling.
    await expect(engine1.send(baseInput({ fromEmail: GMAIL_BOX }), "k")).rejects.toBeTruthy();
    expect(gmail.submits).toBe(1);

    // Alive retry: the dangling survives ⇒ 424 (NOT a second submit).
    await expect(engine1.send(baseInput({ fromEmail: GMAIL_BOX }), "k")).rejects.toBeInstanceOf(SendUnverifiedError);
    expect(gmail.submits).toBe(1);
    store1.close();

    // Boot: the submitted line landed (writeSync succeeded) ⇒ reconcile finalizes.
    const store2 = new EngineStore(dir);
    const engine2 = new EmailEngine({ credentials: creds, store: store2, smtp, imap: new NoopImap(), gmail, graph: undefined });
    const summary = await engine2.reconcilePendingSends();
    expect(summary.finalized).toBe(1);
    expect(store2.getSend("k")).toMatchObject({ messageId: wire });

    const retry = await engine2.send(baseInput({ fromEmail: GMAIL_BOX }), "k");
    expect(retry.messageId).toBe(wire);
    expect(gmail.submits).toBe(1); // exactly ONE messages.send across the whole scenario
    store2.close();
  });
});
