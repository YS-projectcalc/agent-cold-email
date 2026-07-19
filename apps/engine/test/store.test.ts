import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EngineStore } from "../src/store.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "engine-store-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("EngineStore", () => {
  it("caches a send result by idempotency key and maps Message-ID -> threadId", async () => {
    const store = new EngineStore(dir);
    expect(store.getSend("k1")).toBeUndefined();
    await store.recordSend("k1", "<m1@d>", "thr_1", 111);
    expect(store.getSend("k1")).toEqual({ messageId: "<m1@d>", sentAt: 111 });
    expect(store.resolveThread("<m1@d>")).toBe("thr_1");
    expect(store.resolveThread("<unknown@d>")).toBeUndefined();
  });

  it("persists state across a reload (durable JSON file)", async () => {
    const store1 = new EngineStore(dir);
    await store1.recordSend("k2", "<m2@d>", "thr_2", 222);

    const store2 = new EngineStore(dir); // reloads from disk
    expect(store2.getSend("k2")).toEqual({ messageId: "<m2@d>", sentAt: 222 });
    expect(store2.resolveThread("<m2@d>")).toBe("thr_2");
  });

  it("dual-records the minted AND the wire Message-ID onto one thread (a reply matches on either)", async () => {
    // Gmail rewrites the wire Message-ID: the canonical id (returned to the Worker)
    // is the wire id, but a reply might carry either — so BOTH resolve to the thread.
    const store = new EngineStore(dir);
    const wire = "<CAMc35@mail.gmail.com>";
    const minted = "<minted@coldstart.test>";
    await store.recordSend("k3", wire, "thr_3", 333, [minted]);

    // The canonical id stored on the send record is the wire id (what /v1/send returns).
    expect(store.getSend("k3")).toEqual({ messageId: wire, sentAt: 333 });
    // Both ids reverse-resolve to the same thread; an unrelated id does not.
    expect(store.resolveThread(wire)).toBe("thr_3");
    expect(store.resolveThread(minted)).toBe("thr_3");
    expect(store.resolveThread("<unrelated@d>")).toBeUndefined();

    // The dual mapping survives a reload (both keys are on disk).
    const reloaded = new EngineStore(dir);
    expect(reloaded.resolveThread(wire)).toBe("thr_3");
    expect(reloaded.resolveThread(minted)).toBe("thr_3");
  });
});
