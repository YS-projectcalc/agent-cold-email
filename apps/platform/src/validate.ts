import type { Context } from "hono";
import type { ZodType } from "zod";

// Boundary validation helper — CLAUDE.md rule h: "Validate ALL tenant input
// at the boundary." Every route parses its body through a zod schema from
// @coldstart/shared before touching the DO.
export async function parseJsonBody<T>(c: Context, schema: ZodType<T>): Promise<{ ok: true; data: T } | { ok: false; response: Response }> {
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
