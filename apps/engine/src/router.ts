import { assertAuthorized } from "./auth.js";
import { BadRequestError, statusFor } from "./errors.js";
import type { EmailEngine } from "./engine.js";
import { pollRequestSchema, sendRequestSchema } from "./wire.js";

export interface EngineRequest {
  method: string;
  path: string;
  authHeader: string | undefined;
  rawBody: string;
}

export interface EngineResponse {
  status: number;
  body: unknown;
}

const startedAt = Date.now();

/**
 * The engine's HTTP surface as a PURE function (no sockets) so the whole
 * boundary contract is unit-testable. `index.ts` adapts node:http onto it.
 *
 *   GET  /health   -> 200, no auth (host/load-balancer probe; leaks nothing)
 *   POST /v1/send  -> 200 SendEmailResult            (bearer-authed)
 *   POST /v1/poll  -> 200 { events, cursor }         (bearer-authed; consumer
 *                    passes its stored sinceCursor and persists the returned
 *                    cursor AFTER processing the events)
 *
 * Errors map to a status the Worker re-grades: 401/400/422 permanent, 5xx
 * transient (see errors.ts / RealEmailPort).
 */
export async function route(engine: EmailEngine, authSecret: string, req: EngineRequest): Promise<EngineResponse> {
  try {
    if (req.method === "GET" && req.path === "/health") {
      return { status: 200, body: { status: "ok", uptimeSec: Math.floor((Date.now() - startedAt) / 1000) } };
    }

    if (req.method === "POST" && req.path === "/v1/send") {
      assertAuthorized(req.authHeader, authSecret);
      const { input, idempotencyKey } = sendRequestSchema.parse(parseJson(req.rawBody));
      const result = await engine.send(input, idempotencyKey);
      return { status: 200, body: result };
    }

    if (req.method === "POST" && req.path === "/v1/poll") {
      assertAuthorized(req.authHeader, authSecret);
      const { mailboxEmail, sinceCursor } = pollRequestSchema.parse(parseJson(req.rawBody));
      const result = await engine.poll(mailboxEmail, sinceCursor);
      return { status: 200, body: result };
    }

    return { status: 404, body: { error: "not found" } };
  } catch (err) {
    const status = err instanceof BadRequestError ? 400 : isZodError(err) ? 400 : statusFor(err);
    return { status, body: { error: err instanceof Error ? err.message : String(err) } };
  }
}

function parseJson(raw: string): unknown {
  if (!raw) throw new BadRequestError("empty request body");
  try {
    return JSON.parse(raw);
  } catch {
    throw new BadRequestError("request body is not valid JSON");
  }
}

function isZodError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { name?: string }).name === "ZodError";
}
