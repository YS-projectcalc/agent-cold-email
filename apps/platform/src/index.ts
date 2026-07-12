import { Hono } from "hono";
import type { Env } from "./env.js";
import { requireAdminAuth } from "./require-admin-auth.js";
import { requireAuth, type AuthedVariables } from "./require-auth.js";
import { signupRoute } from "./routes/signup.js";
import { infrastructureRoute } from "./routes/infrastructure.js";
import { campaignsRoute } from "./routes/campaigns.js";
import { inboxRoute } from "./routes/inbox.js";
import { accountRoute } from "./routes/account.js";
import { checkoutRoute, checkoutSimulateRoute } from "./routes/checkout.js";
import { lifecycleRoute } from "./routes/lifecycle.js";
import { webhooksRoute } from "./routes/webhooks.js";
import { demoRoute } from "./routes/demo.js";
import { mcpRoute } from "./routes/mcp.js";
import { waitlistRoute } from "./routes/waitlist.js";
import { adminSupportRoute } from "./routes/admin-support.js";
import { adminOpsRoute } from "./routes/admin-ops.js";
import { statusRoute } from "./routes/status.js";
import { runScheduledOpsSweep } from "./scheduled.js";

export { TenantDO } from "./tenant-do.js";
export { RateLimiterDO } from "./rate-limiter-do.js";

const app = new Hono<{ Bindings: Env; Variables: AuthedVariables }>();

app.route("/", signupRoute);
// /mcp does its own per-JSON-RPC-method auth (see src/mcp/handler.ts) — not
// mounted behind requireAuth. /api/waitlist is unauthenticated (public
// form). /checkout/simulate and /webhooks/stripe are unauthenticated for the
// same reason a real Stripe hosted checkout page / webhook caller can't
// present our bearer token — see routes/checkout.ts and routes/webhooks.ts
// for their own credential (session id / signature).
app.route("/", mcpRoute);
app.route("/", waitlistRoute);
app.route("/", checkoutSimulateRoute);
app.route("/", webhooksRoute);
// GET /status — public, no tenant/admin data (see routes/status.ts).
app.route("/", statusRoute);

// D1/D2/D6 admin surface (src/admin/README.md) — gated by a SEPARATE
// ADMIN_TOKEN secret bearer, never the per-tenant token below: these routes
// read/mutate CROSS-tenant data. The middleware pattern is scoped to
// "/admin/*" (NOT "*") on purpose: Hono composes every registered handler
// whose pattern matches a request's path into one middleware chain
// regardless of which "sub-app" it came from, so an unscoped "*" here would
// otherwise 401 every tenant-facing request below too (caught live: an
// unscoped "*" made `GET /account` etc. return the admin 401 body instead
// of account data).
const admin = new Hono<{ Bindings: Env }>();
admin.use("/admin/*", requireAdminAuth);
admin.route("/", adminSupportRoute);
admin.route("/", adminOpsRoute);
app.route("/", admin);

const authed = new Hono<{ Bindings: Env; Variables: AuthedVariables }>();
authed.use("*", requireAuth);
authed.route("/", infrastructureRoute);
authed.route("/", campaignsRoute);
authed.route("/", inboxRoute);
authed.route("/", accountRoute);
authed.route("/", checkoutRoute);
authed.route("/", lifecycleRoute);
authed.route("/", demoRoute);
app.route("/", authed);

app.onError((err, c) => {
  const name = err instanceof Error ? err.name : "";
  if (name === "ValidationError") return c.json({ error: err.message }, 400);
  if (name === "NotFoundError") return c.json({ error: err.message }, 404);
  if (name === "TenantIsolationError") return c.json({ error: err.message }, 403);
  if (name === "RateLimitError") return c.json({ error: err.message }, 429);
  if (name === "RequestInProgressError") return c.json({ error: err.message }, 409);
  console.error(err);
  return c.json({ error: "internal error" }, 500);
});

export default {
  fetch: app.fetch,
  // Cron Trigger entry point (D2) — see scheduled.ts for what runs + why the
  // wrangler.toml `[triggers]` block is commented-out (armed at activation).
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runScheduledOpsSweep(env));
  },
};
