import { describe, expect, it } from "vitest";
import { api } from "./helpers.js";

describe("GET /status — public health check (D6)", () => {
  it("returns ok with no auth and no tenant data", async () => {
    const res = await api<{ status: string }>("/status");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });
});
