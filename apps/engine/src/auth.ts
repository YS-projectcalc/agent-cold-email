import { timingSafeEqual } from "node:crypto";
import { UnauthorizedError } from "./errors.js";

/**
 * Constant-time bearer-token check for the Worker↔engine boundary. Throws
 * UnauthorizedError (401) on any mismatch. Length is compared first because
 * timingSafeEqual throws on unequal-length buffers; that length check is not a
 * secret leak (the secret is fixed-length in practice and an attacker learning
 * "wrong length" gains nothing exploitable).
 */
export function assertAuthorized(header: string | undefined, expectedSecret: string): void {
  if (!header) throw new UnauthorizedError();
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) throw new UnauthorizedError();
  const presented = Buffer.from(header.slice(prefix.length), "utf8");
  const expected = Buffer.from(expectedSecret, "utf8");
  if (presented.length !== expected.length) throw new UnauthorizedError();
  if (!timingSafeEqual(presented, expected)) throw new UnauthorizedError();
}
