import { describe, expect, it } from "vitest";
import { assertAuthorized } from "../src/auth.js";
import { UnauthorizedError } from "../src/errors.js";

const SECRET = "correct-horse-battery-staple";

describe("assertAuthorized", () => {
  it("accepts the exact bearer secret", () => {
    expect(() => assertAuthorized(`Bearer ${SECRET}`, SECRET)).not.toThrow();
  });

  it("rejects a missing header", () => {
    expect(() => assertAuthorized(undefined, SECRET)).toThrow(UnauthorizedError);
  });

  it("rejects a non-Bearer scheme", () => {
    expect(() => assertAuthorized(`Basic ${SECRET}`, SECRET)).toThrow(UnauthorizedError);
  });

  it("rejects a wrong secret of equal length", () => {
    const wrong = "x".repeat(SECRET.length);
    expect(() => assertAuthorized(`Bearer ${wrong}`, SECRET)).toThrow(UnauthorizedError);
  });

  it("rejects a wrong secret of different length (no timingSafeEqual crash)", () => {
    expect(() => assertAuthorized(`Bearer short`, SECRET)).toThrow(UnauthorizedError);
  });
});
