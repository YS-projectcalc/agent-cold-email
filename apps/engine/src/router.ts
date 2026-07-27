import { assertAuthorized } from "./auth.js";
import { BadRequestError, statusFor, UpstreamTransientError } from "./errors.js";
import type { EmailEngine } from "./engine.js";
import { intentResolveRequestSchema, mailboxRemoveRequestSchema, mailboxWriteRequestSchema, pollRequestSchema, sendRequestSchema } from "./wire.js";

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

export interface RouteOptions {
  /** False during a SIGTERM graceful drain: new sends are refused 503 (retry hits the restarted engine) while in-flight sends finish. */
  accepting?: boolean;
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
 *   POST   /v1/mailboxes -> 200 UpsertResult         (bearer-authed; self-serve
 *                    I3 credential push — idempotent upsert, F4)
 *   DELETE /v1/mailboxes -> 200 RemoveResult         (bearer-authed; revoke a
 *                    pushed mailbox on cancel/teardown)
 *
 * Errors map to a status the Worker re-grades: 401/400/422 permanent, 5xx
 * transient (see errors.ts / RealEmailPort).
 */
export async function route(engine: EmailEngine, authSecret: string, req: EngineRequest, opts: RouteOptions = {}): Promise<EngineResponse> {
  try {
    if (req.method === "GET" && req.path === "/health") {
      // `parked` = un-verified intents awaiting operator resolution (the watchtower
      // prober alerts on a non-zero/growing count — see GET /v1/intents).
      return { status: 200, body: { status: "ok", uptimeSec: Math.floor((Date.now() - startedAt) / 1000), parked: engine.parkedCount() } };
    }

    if (req.method === "POST" && req.path === "/v1/send") {
      assertAuthorized(req.authHeader, authSecret);
      // Graceful drain: refuse NEW sends as transient so the Worker retries
      // against the restarted engine, while in-flight sends finish (index.ts).
      if (opts.accepting === false) throw new UpstreamTransientError("engine is draining (shutting down) — retry");
      const { input, idempotencyKey } = sendRequestSchema.parse(parseJson(req.rawBody));
      const result = await engine.send(input, idempotencyKey);
      return { status: 200, body: result };
    }

    if (req.method === "GET" && req.path === "/v1/intents") {
      assertAuthorized(req.authHeader, authSecret);
      return { status: 200, body: { parked: engine.listParkedIntents() } };
    }

    if (req.method === "POST" && req.path === "/v1/intents/resolve") {
      assertAuthorized(req.authHeader, authSecret);
      const { key, outcome, by } = intentResolveRequestSchema.parse(parseJson(req.rawBody));
      const result = engine.resolveIntent(key, outcome, by ?? "operator");
      if (!result.resolved) return { status: 404, body: { error: `no parked or dangling intent for key ${key}` } };
      return { status: 200, body: { key, outcome, resolved: true } };
    }

    if (req.method === "POST" && req.path === "/v1/poll") {
      assertAuthorized(req.authHeader, authSecret);
      const { mailboxEmail, sinceCursor } = pollRequestSchema.parse(parseJson(req.rawBody));
      const result = await engine.poll(mailboxEmail, sinceCursor);
      return { status: 200, body: result };
    }

    if (req.method === "POST" && req.path === "/v1/mailboxes") {
      assertAuthorized(req.authHeader, authSecret);
      const parsed = mailboxWriteRequestSchema.parse(parseJson(req.rawBody));
      const result = await engine.upsertMailbox(parsed);
      return { status: 200, body: result };
    }

    if (req.method === "DELETE" && req.path === "/v1/mailboxes") {
      assertAuthorized(req.authHeader, authSecret);
      const parsed = mailboxRemoveRequestSchema.parse(parseJson(req.rawBody));
      const result = await engine.removeMailbox(parsed);
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
