import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SendEmailInput } from "@coldstart/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CredentialsMap } from "../src/config.js";
import { EmailEngine } from "../src/engine.js";
import { SendUnverifiedError } from "../src/errors.js";
import { EngineStore } from "../src/store.js";
import { CountingSmtp, CrashSignal, FaultySendLog, NoopImap } from "./crash-doubles.js";

// Deterministic, in-process crash injection for the durable pre-send intent log.
// Each test drives a real EmailEngine over a real tmpdir, injects a fault at a
// precise point in the write-ahead sequence, then rebuilds a FRESH store over the
// SAME dir (the store tests' restart idiom) to prove the durable outcome:
// DROP-not-duplicate across a crash. See docs/research/pre-send-intent-log-
// design-2026-07-27.md + docs/adversarial/pre-send-intent-log-design-review.

const SENDER = "sender@coldstart.test";
const LEAD = "lead@example.com";
const creds: CredentialsMap = {
  [SENDER]: {
    smtp: { host: "smtp", port: 465, secure: true, user: SENDER, pass: "p" },
    imap: { host: "imap", port: 993, secure: true, user: SENDER, pass: "p" },
  },
};

function baseInput(overrides: Partial<SendEmailInput> = {}): SendEmailInput {
  return { fromEmail: SENDER, toEmail: LEAD, subject: "hi", body: "hello", threadId: "thr_1", inReplyToMessageId: null, ...overrides };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "intent-log-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("pre-send intent log — crash injection (drop, never duplicate)", () => {
  it("HEADLINE: crash after the transport accepts but before recordSend ⇒ the retry is DROPPED (424) ⇒ the lead is submitted EXACTLY ONCE", async () => {
    // This is the exact ACTIVATION Gate-2 residual the log closes: a crash in the
    // accept→record window. With the write-ahead intent, the durable dangling
    // makes the consumer's retry a 424 instead of a second SMTP transaction.
    const smtp = new CountingSmtp();
    const store1 = new EngineStore(dir, { makeSendLog: (p) => new FaultySendLog(p, (l) => l.type === "recorded") });
    const engine1 = new EmailEngine({ credentials: creds, store: store1, smtp, imap: new NoopImap() });

    // The SMTP transaction is accepted (smtp.calls === 1); the recorded append
    // then faults. Memory is updated so this call returns 200, but the "crash" is
    // modeled by discarding store1 and rebuilding from disk below.
    await engine1.send(baseInput(), "send:t1:r1");
    expect(smtp.calls).toHaveLength(1);
    store1.close();

    // Reboot: a fresh store replays the durable intent (the recorded never landed).
    const store2 = new EngineStore(dir);
    const engine2 = new EmailEngine({ credentials: creds, store: store2, smtp, imap: new NoopImap() });
    await expect(engine2.send(baseInput(), "send:t1:r1")).rejects.toBeInstanceOf(SendUnverifiedError);

    // The single most load-bearing assertion: still ONE submit total, never two.
    expect(smtp.calls).toHaveLength(1);
    store2.close();
  });

  it("a disk-full INTENT append fails closed (before any wire I/O) — the transport spy is NEVER called", async () => {
    const smtp = new CountingSmtp();
    const store = new EngineStore(dir, { makeSendLog: (p) => new FaultySendLog(p, (l) => l.type === "intent") });
    const engine = new EmailEngine({ credentials: creds, store, smtp, imap: new NoopImap() });

    // The intent append throws BEFORE dispatch — the engine never sends without
    // logging (a generic throw is graded 503, a retry, by statusFor).
    await expect(engine.send(baseInput(), "k")).rejects.toBeInstanceOf(CrashSignal);
    expect(smtp.calls).toHaveLength(0);
    store.close();
  });

  it("a recorded-append failure AFTER a successful submit returns 200 off memory; an ALIVE retry hits the cache (no double-send)", async () => {
    const smtp = new CountingSmtp();
    const store = new EngineStore(dir, { makeSendLog: (p) => new FaultySendLog(p, (l) => l.type === "recorded") });
    const engine = new EmailEngine({ credentials: creds, store, smtp, imap: new NoopImap(), now: () => 5 });

    const first = await engine.send(baseInput(), "k");
    expect(first.sentAt).toBe(5); // returned 200 off memory despite the faulted append
    expect(smtp.calls).toHaveLength(1);

    // getSend hits (memory updated before the faulted append) ⇒ cached result, no second submit.
    const retry = await engine.send(baseInput(), "k");
    expect(retry).toEqual(first);
    expect(smtp.calls).toHaveLength(1);
    store.close();
  });

  it("B1 (substrate): a dangling SURVIVES live compaction + log rotation — a reboot still blocks the key (FAILS if `danglings` is dropped from the snapshot)", async () => {
    // Key B is mid-flight (intent only). A recorded line for a DIFFERENT key A
    // trips the compaction threshold while B is dangling: the snapshot MUST carry
    // B's dangling forward before rotation discards the log.
    const smtp = new CountingSmtp();
    const store1 = new EngineStore(dir, { compactEveryRecorded: 1 });
    store1.appendIntent("B", { transport: "smtp", from: SENDER, to: LEAD, mintedId: "<b@coldstart.test>", threadId: "thr_b" });
    // A completes → recorded → compaction fires WITH B still dangling.
    store1.recordSend("A", "<a@coldstart.test>", "thr_a", 1);
    store1.close();

    // Reboot from snapshot(+empty log): B must still be present as a dangling.
    const store2 = new EngineStore(dir);
    expect(store2.isBlocked("B")).toBe(true);
    const engine2 = new EmailEngine({ credentials: creds, store: store2, smtp, imap: new NoopImap() });
    await expect(engine2.send(baseInput(), "B")).rejects.toBeInstanceOf(SendUnverifiedError);
    expect(smtp.calls).toHaveLength(0);
    store2.close();
  });

  it("migration: a v1 snapshot (no version / parked / danglings) loads as {parked:{}, danglings:{}} with sends/threads intact", () => {
    // Write an OLD-shape engine-state.json (pre-intent-log) directly, then boot.
    const store = new EngineStore(dir);
    // Seed via a normal record + compact to produce a v2 snapshot, then rewrite it
    // as a v1 shape to prove backward compatibility on the FIRST boot after upgrade.
    store.recordSend("k1", "<m1@d>", "thr_1", 111);
    store.close();
    writeFileSync(join(dir, "engine-state.json"), JSON.stringify({ sends: { k1: { messageId: "<m1@d>", sentAt: 111 } }, threads: { "<m1@d>": "thr_1" } }));
    // Remove the log so replay is a no-op (models a fresh upgrade with an empty WAL).
    writeFileSync(join(dir, "send-log.jsonl"), "");

    const booted = new EngineStore(dir);
    expect(booted.getSend("k1")).toEqual({ messageId: "<m1@d>", sentAt: 111 });
    expect(booted.resolveThread("<m1@d>")).toBe("thr_1");
    expect(booted.listParked()).toEqual([]);
    expect(booted.listDanglings()).toEqual([]);
    booted.close();
  });
});
