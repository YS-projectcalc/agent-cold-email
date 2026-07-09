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

export async function parseJsonBody<T>(
  c: Context,
  schema: ZodType<T>,
  maxBytes: number = SMALL_BODY_MAX_BYTES,
): Promise<{ ok: true; data: T } | { ok: false; response: Response }> {
  const declaredLength = Number(c.req.header("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    return { ok: false, response: c.json({ error: "request body too large" }, 413) };
  }

  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return { ok: false, response: c.json({ error: "invalid JSON body" }, 400) };
  }

  const result = schema.safeParse(raw);
  if (!result.success) {
    return { ok: false, response: c.json({ error: "validation failed", issues: result.error.issues }, 400) };
  }
  return { ok: true, data: result.data };
}
