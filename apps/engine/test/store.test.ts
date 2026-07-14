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
});
