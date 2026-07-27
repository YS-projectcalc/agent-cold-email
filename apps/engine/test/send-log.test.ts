import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SendLog, type IntentLine, type RecordedLine, type SendLogLine } from "../src/send-log.js";

let dir: string;
let logPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "send-log-"));
  logPath = join(dir, "send-log.jsonl");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function intent(key: string): IntentLine {
  return { v: 1, type: "intent", key, ts: 1, attempt: 1, transport: "smtp", from: "a@x.test", to: "b@y.test", mintedId: `<${key}@x.test>`, threadId: `thr_${key}` };
}
function recorded(key: string): RecordedLine {
  return { v: 1, type: "recorded", key, ts: 2, messageId: `<${key}@x.test>`, aliasIds: [], threadId: `thr_${key}`, sentAt: 2 };
}

describe("SendLog", () => {
  it("appends lines and a fresh SendLog over the same file replays them in order", () => {
    const log = new SendLog(logPath);
    log.append(intent("k1"));
    log.append(recorded("k1"));
    log.append(intent("k2"));
    log.close();

    const reopened = new SendLog(logPath);
    expect(reopened.replayed.map((l) => `${l.type}:${l.key}`)).toEqual(["intent:k1", "recorded:k1", "intent:k2"]);
    expect(reopened.droppedTornTail).toBe(false);
  });

  it("a MISSING log is a normal first boot (empty replay, no throw)", () => {
    const log = new SendLog(logPath); // file does not exist yet
    expect(log.replayed).toEqual([]);
    expect(log.droppedTornTail).toBe(false);
  });

  it("fsyncs the fd on EVERY append (durability spy)", () => {
    const fsync = vi.fn();
    const log = new SendLog(logPath, { fsync });
    const before = fsync.mock.calls.length; // may include a dir-fsync at creation
    log.append(intent("k1"));
    log.append(recorded("k1"));
    // Two appends ⇒ at least two more fsync calls (one data-fsync each).
    expect(fsync.mock.calls.length - before).toBeGreaterThanOrEqual(2);
  });

  it("LOOPS writeSync until the whole line is written (a short write must not leave a torn NON-final line)", () => {
    // Force a pathological short write: at most 4 bytes per syscall. A single
    // unchecked writeSync would leave the line truncated; the loop must complete
    // it so the byte-identical line survives a reload (no false corruption).
    const shortWrite = (fd: number, buf: Buffer, off: number, len: number): number =>
      writeSync(fd, buf, off, Math.min(len, 4));
    const log = new SendLog(logPath, { write: shortWrite });
    log.append(intent("k1"));
    log.append(recorded("k1"));
    log.close();

    const raw = readFileSync(logPath, "utf8");
    // Every line terminated cleanly despite 4-byte writes.
    expect(raw.endsWith("\n")).toBe(true);
    const reopened = new SendLog(logPath);
    expect(reopened.droppedTornTail).toBe(false);
    expect(reopened.replayed.map((l) => l.key)).toEqual(["k1", "k1"]);
  });

  it("drops + quarantines a torn FINAL line (crash mid-append) and heals the file so the next boot is clean", () => {
    const log = new SendLog(logPath);
    log.append(intent("k1"));
    log.close();
    // A crash mid-append: a partial final line with NO terminating newline.
    appendFileSync(logPath, `{"v":1,"type":"intent","key":"k2","ts":1,"attem`);

    const reopened = new SendLog(logPath);
    expect(reopened.droppedTornTail).toBe(true);
    expect(reopened.replayed.map((l) => l.key)).toEqual(["k1"]); // torn k2 dropped
    // A quarantine copy was written next to the log.
    expect(readdirSync(dir).some((f) => f.startsWith("send-log.jsonl.corrupt-"))).toBe(true);

    // The heal truncated the torn bytes: appending now + reloading stays clean
    // (the torn tail did NOT become a corrupt interior line).
    reopened.append(recorded("k1"));
    reopened.close();
    const final = new SendLog(logPath);
    expect(final.droppedTornTail).toBe(false);
    expect(final.replayed.map((l) => `${l.type}:${l.key}`)).toEqual(["intent:k1", "recorded:k1"]);
  });

  it("FAILS LOUD on a corrupt NON-final line (real bit-rot, not a torn tail)", () => {
    const log = new SendLog(logPath);
    log.append(intent("k1"));
    log.close();
    // A cleanly-terminated garbage line FOLLOWED by a valid one ⇒ interior
    // corruption, which a normal crash can never produce ⇒ refuse to start.
    appendFileSync(logPath, `{ half-written garbage\n`);
    appendFileSync(logPath, `${JSON.stringify(recorded("k1"))}\n`);

    expect(() => new SendLog(logPath)).toThrow(/corrupt NON-final line/i);
  });

  it("rotate() discards every line (compaction has already captured them durably)", () => {
    const log = new SendLog(logPath);
    log.append(intent("k1"));
    log.append(recorded("k1"));
    log.rotate();
    // After rotation the on-disk log is empty; a subsequent append starts fresh.
    log.append(intent("k2"));
    log.close();

    const reopened = new SendLog(logPath);
    expect(reopened.replayed.map((l) => l.key)).toEqual(["k2"]);
  });

  it("unreadable NON-ENOENT parse still yields typed lines the store can fold", () => {
    // A sanity check that replay returns the parsed objects verbatim (the store
    // validates shape in its fold, not here).
    const log = new SendLog(logPath);
    const line: SendLogLine = intent("k1");
    log.append(line);
    log.close();
    const reopened = new SendLog(logPath);
    expect(reopened.replayed[0]).toMatchObject({ type: "intent", key: "k1", transport: "smtp" });
  });
});
