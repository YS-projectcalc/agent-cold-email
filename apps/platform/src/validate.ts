import type { Context } from "hono";
import type { ZodType } from "zod";

// Boundary validation helper — CLAUDE.md rule h: "Validate ALL tenant input
// at the boundary." Every route parses its body through a zod schema from
// @coldstart/shared before touching the DO.

// Default request-body cap. Small-schema routes (signup, waitlist, setup) pass
// a tight cap; launch_campaign passes a large one (up to 5000 leads). An
// over-cap body is rejected 413 before it is parsed — adversarial panel-02:
// parse-before-validate on unauthenticated, unthrottled endpoints is a cheap
// CPU/memory amplifier. Enforced on BYTES READ, not on a declared
// Content-Length the client controls (readTextBodyWithCap, below).
export const SMALL_BODY_MAX_BYTES = 8 * 1024; // signup, waitlist, setup_infrastructure
export const LARGE_BODY_MAX_BYTES = 4 * 1024 * 1024; // launch_campaign (5000 leads)
// SPEC.md §19.3 — a dashboard view's layout can carry up to 50 widgets, each
// with up to a 10,000-char agent_note markdown prop: 512 KiB comfortably
// bounds the worst case (~500 KB) with headroom, well under LARGE_BODY_MAX_BYTES.
export const DASHBOARD_LAYOUT_MAX_BYTES = 512 * 1024;
// G1a droplet-relay — POST /admin/sdn/ingest's raw SDN.CSV body (routes/
// admin-sdn-ingest.ts). The real feed is ~10-15 MB; 30 MiB gives headroom
// without accepting an unbounded upload from a route gated by a narrow,
// droplet-held token (require-admin-auth.ts's SDN_INGEST_TOKEN carve-out).
export const SDN_INGEST_MAX_BYTES = 30 * 1024 * 1024;

// Query-string booleans need their OWN parsing — zod's `z.coerce.boolean()`
// treats ANY non-empty string (including the literal string "false") as
// `true` (JS `Boolean("false") === true`), which would silently invert a
// `?read=false` or `?include_nonreply=false` filter. Returns `undefined` for
// an absent/unrecognized value so a caller's zod default still applies.
export function parseBoolQueryParam(raw: string | undefined): boolean | undefined {
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  return undefined;
}

/**
 * Query-string integers need the SAME empty-string handling as the booleans
 * above, for a different reason: Hono's `c.req.query("limit")` returns `""`
 * (not `undefined`) for a literal `?limit=`, and `Number("")` is `0` — a
 * caller that only checks `raw !== undefined` (D9, docs/adversarial/
 * class-sweep-vendor-truth-2026-08-18.md) clamps an explicitly-empty param to
 * its minimum instead of falling back to the intended default. Returns
 * `undefined` for an absent OR empty value so the caller's own default
 * applies; a present-but-non-numeric value passes through as `NaN` for the
 * caller's own clamp (every caller here already guards `Number.isFinite`) to
 * catch.
 */
export function parseIntQueryParam(raw: string | undefined): number | undefined {
  return raw ? Number(raw) : undefined;
}

/**
 * The one clamp every bounded list read shares (S8, docs/adversarial/
 * scale-readiness-audit-2026-08-17.md). Absent, non-finite (`NaN` from
 * `parseIntQueryParam`'s pass-through) or non-positive falls back to
 * `fallback`; anything larger than `max` is capped there, so a caller cannot
 * ask for the unbounded read the bound exists to remove.
 */
export function clampListLimit(limit: number | undefined, fallback: number, max: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return fallback;
  return Math.min(Math.max(Math.trunc(limit), 1), max);
}

/**
 * A caller-supplied string as a LITERAL prefix pattern for SQL `LIKE ? ESCAPE
 * '\'` (F3, docs/adversarial/admin-read-endpoints-gate-2026-08-17.md).
 *
 * `LIKE` is a pattern language, not a prefix test: `_` matches any single
 * character and `%` matches anything, so `setup_infrastructure:%` also selects
 * `setupXinfrastructure:...`, and a caller passing a bare `%` selects the whole
 * table. Escaping the three metacharacters (the escape char FIRST, or it
 * double-escapes the ones added after it) makes the pattern mean exactly the
 * characters it contains.
 */
export function likePrefixPattern(prefix: string): string {
  return `${prefix.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

/**
 * THE one sanctioned way to read a request body in this codebase. Returns the
 * body text, or `null` when it exceeds `maxBytes` of ACTUAL bytes read.
 *
 * A declared-`Content-Length` check only stops an HONEST client: a
 * chunked/streamed request carries no such header, so `Number(undefined)` is
 * NaN, `Number.isFinite` is false, and the cap is skipped entirely while the
 * full body is materialised anyway (audit-stripe-webhook-2026-08-06.md finding
 * 7 — the cap on the unauthenticated Stripe webhook, which every other
 * body-reading route in the app had copied). Counting bytes as they arrive is
 * the only cap a client cannot opt out of, and the stream is CANCELLED at the
 * ceiling so an over-cap body is never fully buffered.
 *
 * `null` rather than a ready-made 413 Response: /mcp answers over-cap in a
 * JSON-RPC error envelope and /unsubscribe in plain text, so the status body is
 * the caller's to shape. `body-cap-coverage.test.ts` fails if any route reads a
 * body without coming through here.
 *
 * Decoding happens once over the joined bytes, never per chunk — a multi-byte
 * UTF-8 character can straddle a chunk boundary, and the result has to be the
 * exact string a signature was computed over.
 */
export async function readTextBodyWithCap(c: Context, maxBytes: number): Promise<string | null> {
  const body = c.req.raw.body;
  if (!body) return "";

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }

  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

/**
 * The cheap pre-filter every capped route runs before touching the stream: an
 * honest client that DECLARES an over-cap body is rejected without reading a
 * byte. Never the enforcement on its own — see readTextBodyWithCap.
 */
export function declaresOverCap(c: Context, maxBytes: number): boolean {
  const declaredLength = Number(c.req.header("content-length"));
  return Number.isFinite(declaredLength) && declaredLength > maxBytes;
}

export async function parseJsonBody<T>(
  c: Context,
  schema: ZodType<T>,
  maxBytes: number = SMALL_BODY_MAX_BYTES,
  // SPEC.md §19.3 — dashboard-view writes report an invalid/unknown widget
  // via 422 (Unprocessable Entity: syntactically valid JSON, semantically
  // invalid), not this helper's platform-wide 400 default — a deliberate,
  // spec-mandated exception, not drift (see routes/dashboard.ts).
  invalidStatus: 400 | 422 = 400,
): Promise<{ ok: true; data: T } | { ok: false; response: Response }> {
  if (declaresOverCap(c, maxBytes)) {
    return { ok: false, response: c.json({ error: "request body too large" }, 413) };
  }

  // Was `c.req.json()`, which reads the WHOLE body regardless of the cap above
  // — so all 25 call sites inherited finding 7's bypass, on unauthenticated
  // routes (/signup, /api/waitlist) included. The capped read closes them at
  // this one choke point.
  const text = await readTextBodyWithCap(c, maxBytes);
  if (text === null) {
    return { ok: false, response: c.json({ error: "request body too large" }, 413) };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, response: c.json({ error: "invalid JSON body" }, invalidStatus) };
  }

  const result = schema.safeParse(raw);
  if (!result.success) {
    return { ok: false, response: c.json({ error: "validation failed", issues: result.error.issues }, invalidStatus) };
  }
  return { ok: true, data: result.data };
}
