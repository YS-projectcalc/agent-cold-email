import { Hono } from "hono";
import { DemoRunInput } from "@coldstart/shared";
import type { Env } from "../env.js";
import type { AuthedVariables } from "../require-auth.js";
import { declaresOverCap, readTextBodyWithCap, SMALL_BODY_MAX_BYTES } from "../validate.js";

// POST /demo/run (B5 brief; params extended by backend gaps brief item 3) —
// authed, but the demo/free-plan guard is enforced INSIDE TenantDO.demoRun()
// (a structural type-level check, not an HTTP-layer policy — ARCHITECTURE.md
// #8), which throws TenantIsolationError for any other plan. index.ts's
// onError maps that to 403. Nothing in this file decides who is allowed to
// run it.
export const demoRoute = new Hono<{ Bindings: Env; Variables: AuthedVariables }>().post("/demo/run", async (c) => {
  // The body is OPTIONAL (every existing caller posts none at all) — unlike
  // parseJsonBody's other callers, an empty body here is not an error, it's
  // the params-omitted case DemoRunInput's own defaults (leads=3,
  // campaigns=1) already cover. That optionality is why this route reads the
  // body by hand, and why it was the ONE body-reading route with no size cap
  // at all — not even the declared-length one every sibling had.
  if (declaresOverCap(c, SMALL_BODY_MAX_BYTES)) {
    return c.json({ error: "request body too large" }, 413);
  }
  const raw = await readTextBodyWithCap(c, SMALL_BODY_MAX_BYTES);
  if (raw === null) {
    return c.json({ error: "request body too large" }, 413);
  }
  let json: unknown = {};
  if (raw) {
    try {
      json = JSON.parse(raw);
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
  }
  const parsed = DemoRunInput.safeParse(json);
  if (!parsed.success) {
    return c.json({ error: "validation failed", issues: parsed.error.issues }, 400);
  }
  const result = await c.get("tenantStub").demoRun(parsed.data);
  return c.json(result, 200);
});
