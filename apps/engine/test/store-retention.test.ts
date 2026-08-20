import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EngineStore } from "../src/store.js";

// S7 (docs/adversarial/scale-readiness-audit-2026-08-17.md) — `sends` and
// `threads` were kept in memory AND in the snapshot FOREVER: nothing pruned
// them, so the snapshot grew with the daemon's LIFETIME send count. Measured:
// 500k sends = 88 MB and a 1,130 ms fully-frozen event loop every 500th send;
// 2M = 358 MB, 4,925 ms and a 1.2 GB resident heap.
//
// Retention bounds the state. What it must NOT bound is anything UN-RESOLVED:
// a dangling or a parked key is the 424 gate's only evidence that a send may
// have gone out, and dropping one re-opens the crash double-send the intent log
// exists to close (the B1 amendment). Age is precisely the wrong reason to
// forget those — an OLD dangling is a more serious one, not a staler one.

const DAY_MS = 24 * 60 * 60 * 1000;
const T0 = 1_700_000_000_000;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "engine-retention-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A store whose clock and retention window the test controls, compacting on every record. */
function storeAt(nowMs: number, retentionMs: number): EngineStore {
  return new EngineStore(dir, { now: () => nowMs, retentionMs, compactEveryRecorded: 1 });
}

function snapshot(): { sends: Record<string, unknown>; threads: Record<string, unknown> } {
  return JSON.parse(readFileSync(join(dir, "engine-state.json"), "utf8"));
}

describe("S7 — retention bounds sends/threads", () => {
  it("prunes a send past the window and keeps one inside it", () => {
    const store = storeAt(T0, 30 * DAY_MS);
    store.recordSend("old", "<old@d>", "thr_old", T0 - 31 * DAY_MS);
    store.recordSend("fresh", "<fresh@d>", "thr_fresh", T0 - 1 * DAY_MS);

    expect(store.getSend("old")).toBeUndefined();
    expect(store.getSend("fresh")).toEqual({ messageId: "<fresh@d>", sentAt: T0 - DAY_MS });
    store.close();
  });

  it("prunes the thread mapping on the same cutoff, so resolveThread forgets it too", () => {
    const store = storeAt(T0, 30 * DAY_MS);
    store.recordSend("old", "<old@d>", "thr_old", T0 - 31 * DAY_MS);
    store.recordSend("fresh", "<fresh@d>", "thr_fresh", T0 - DAY_MS);

    expect(store.resolveThread("<old@d>")).toBeUndefined();
    expect(store.resolveThread("<fresh@d>")).toBe("thr_fresh");
    store.close();
  });

  it("prunes an aged alias Message-ID with its send (gmail's wire id and the minted one age together)", () => {
    const store = storeAt(T0, 30 * DAY_MS);
    store.recordSend("old", "<wire@d>", "thr_old", T0 - 31 * DAY_MS, ["<minted@d>"]);

    expect(store.resolveThread("<wire@d>")).toBeUndefined();
    expect(store.resolveThread("<minted@d>")).toBeUndefined();
    store.close();
  });

  it("the prune is DURABLE — a reboot does not resurrect pruned state from the log", () => {
    const store1 = storeAt(T0, 30 * DAY_MS);
    store1.recordSend("old", "<old@d>", "thr_old", T0 - 31 * DAY_MS);
    store1.recordSend("fresh", "<fresh@d>", "thr_fresh", T0 - DAY_MS);
    store1.close();

    // Snapshot + a rotated log: replaying the log must not re-apply the pruned
    // `recorded` line (that is what makes this a bound rather than a filter).
    const store2 = new EngineStore(dir, { now: () => T0, retentionMs: 30 * DAY_MS });
    expect(store2.getSend("old")).toBeUndefined();
    expect(store2.getSend("fresh")).toEqual({ messageId: "<fresh@d>", sentAt: T0 - DAY_MS });
    expect(Object.keys(snapshot().sends)).toEqual(["fresh"]);
    store2.close();
  });
});

// THE GUARD THAT MATTERS. Everything above is a cost fix; this is the one that
// would turn a cost fix into a double-send.
describe("S7 — retention NEVER touches un-resolved state, at any age", () => {
  it("keeps a DANGLING far older than the window, and it still blocks its key after a reboot", () => {
    const store1 = storeAt(T0, 30 * DAY_MS);
    // An ancient in-flight intent: the crash happened long ago, and the question
    // "did this send go out?" is still unanswered.
    const ancient = new EngineStore(dir, {
      now: () => T0 - 400 * DAY_MS,
      retentionMs: 30 * DAY_MS,
      compactEveryRecorded: 1,
    });
    ancient.appendIntent("ancient-b", {
      transport: "smtp",
      from: "s@d",
      to: "l@d",
      mintedId: "<b@d>",
      threadId: "thr_b",
    });
    ancient.close();
    store1.close();

    // A fresh store, well past the window, compacts with the dangling present.
    const store2 = storeAt(T0, 30 * DAY_MS);
    store2.recordSend("trigger", "<t@d>", "thr_t", T0);
    expect(store2.isBlocked("ancient-b")).toBe(true);
    store2.close();

    const store3 = new EngineStore(dir, { now: () => T0, retentionMs: 30 * DAY_MS });
    expect(store3.isBlocked("ancient-b")).toBe(true);
    expect(store3.listDanglings().map((d) => d.key)).toEqual(["ancient-b"]);
    store3.close();
  });

  it("keeps a PARKED key far older than the window (it is 424 until an operator resolves it)", () => {
    const store1 = storeAt(T0, 30 * DAY_MS);
    store1.appendIntent("ancient-p", {
      transport: "smtp",
      from: "s@d",
      to: "l@d",
      mintedId: "<p@d>",
      threadId: "thr_p",
    });
    store1.park("ancient-p", "could not verify at boot");
    store1.recordSend("trigger", "<t@d>", "thr_t", T0);
    store1.close();

    const store2 = new EngineStore(dir, { now: () => T0 + 400 * DAY_MS, retentionMs: 30 * DAY_MS });
    expect(store2.isBlocked("ancient-p")).toBe(true);
    expect(store2.listParked().map((p) => p.key)).toEqual(["ancient-p"]);
    store2.close();
  });
});

describe("S7 — snapshot migration", () => {
  it("loads a v2 snapshot (threads as bare strings) and gives its entries a FULL window, not an instant expiry", () => {
    // A pre-retention snapshot carries no per-thread timestamp. Ageing those from
    // an unknown past would delete a live customer's thread mappings on the first
    // compaction after deploy — they are stamped at LOAD instead.
    writeFileSync(
      join(dir, "engine-state.json"),
      JSON.stringify({
        version: 2,
        sends: { k1: { messageId: "<m1@d>", sentAt: T0 - DAY_MS } },
        threads: { "<m1@d>": "thr_1" },
        parked: {},
        danglings: {},
      }),
    );
    writeFileSync(join(dir, "send-log.jsonl"), "");

    const store = storeAt(T0, 30 * DAY_MS);
    expect(store.resolveThread("<m1@d>")).toBe("thr_1");
    store.recordSend("trigger", "<t@d>", "thr_t", T0); // forces a compaction
    expect(store.resolveThread("<m1@d>")).toBe("thr_1"); // survived it
    store.close();
  });

  it("still loads a v1 snapshot (no version/parked/danglings)", () => {
    writeFileSync(
      join(dir, "engine-state.json"),
      JSON.stringify({ sends: { k1: { messageId: "<m1@d>", sentAt: T0 } }, threads: { "<m1@d>": "thr_1" } }),
    );
    writeFileSync(join(dir, "send-log.jsonl"), "");

    const store = new EngineStore(dir, { now: () => T0 });
    expect(store.getSend("k1")).toEqual({ messageId: "<m1@d>", sentAt: T0 });
    expect(store.resolveThread("<m1@d>")).toBe("thr_1");
    expect(store.listParked()).toEqual([]);
    expect(store.listDanglings()).toEqual([]);
    store.close();
  });
});

// COMPACTION STAYS INLINE, and this pins why so the next person does not
// re-derive it from scratch.
//
// S7's other half asks for compaction "off the request path". Deferring it to a
// macrotask was implemented and REVERTED: `recordSend` is UPDATE-MEMORY-FIRST,
// so when its `recorded` append faults after the transport already accepted,
// memory has advanced past the log — the dangling is gone from `state` while the
// log still holds only the intent. Compacting INLINE snapshots memory while the
// two still agree; a DEFERRED compaction snapshots it after they diverge, writes
// the in-memory success into the snapshot, and rotates the intent away —
// promoting a failed durable write into a durable success and erasing the very
// dangling boot reconciliation must park. reconcile.test.ts's B1 end-to-end case
// caught it: `expected false to be true` at `store2.isBlocked("B")`.
describe("S7 — compaction remains synchronous with the record that triggers it", () => {
  it("writes the snapshot on the recording call, so memory and the log are captured in agreement", () => {
    const store = new EngineStore(dir, { now: () => T0, compactEveryRecorded: 1 });

    expect(existsSync(join(dir, "engine-state.json"))).toBe(false);
    store.recordSend("k1", "<m1@d>", "thr_1", T0);
    expect(existsSync(join(dir, "engine-state.json"))).toBe(true);
    expect(Object.keys(snapshot().sends)).toEqual(["k1"]);
    store.close();
  });
});
