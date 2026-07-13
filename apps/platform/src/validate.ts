import type { Context } from "hono";
import type { ZodType } from "zod";

// Boundary validation helper — CLAUDE.md rule h: "Validate ALL tenant input
// at the boundary." Every route parses its body through a zod schema from
// @coldstart/shared before touching the DO.

// Default request-body cap. Small-schema routes (signup, waitlist, setup) pass
// a tight cap; launch_campaign passes a large one (up to 5000 leads). A
// Content-Length above the cap is rejected 413 BEFORE c.req.json() materializes
// and parses the whole body — adversarial panel-02: parse-before-validate on
// unauthenticated, unthrottled endpoints is a cheap CPU/memory amplifier.
export const SMALL_BODY_MAX_BYTES = 8 * 1024; // signup, waitlist, setup_infrastructure
export const LARGE_BODY_MAX_BYTES = 4 * 1024 * 1024; // launch_campaign (5000 leads)
// SPEC.md §19.3 — a dashboard view's layout can carry up to 50 widgets, each
// with up to a 10,000-char agent_note markdown prop: 512 KiB comfortably
// bounds the worst case (~500 KB) with headroom, well under LARGE_BODY_MAX_BYTES.
export const DASHBOARD_LAYOUT_MAX_BYTES = 512 * 1024;

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
  const declaredLength = Number(c.req.header("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    return { ok: false, response: c.json({ error: "request body too large" }, 413) };
  }

  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return { ok: false, response: c.json({ error: "invalid JSON body" }, invalidStatus) };
  }

  const result = schema.safeParse(raw);
  if (!result.success) {
    return { ok: false, response: c.json({ error: "validation failed", issues: result.error.issues }, invalidStatus) };
  }
  return { ok: true, data: result.data };
}
