import { Hono } from "hono";
import type { Env } from "./env.js";
import { requireAuth, type AuthedVariables } from "./require-auth.js";
import { signupRoute } from "./routes/signup.js";
import { infrastructureRoute } from "./routes/infrastructure.js";
import { campaignsRoute } from "./routes/campaigns.js";
import { inboxRoute } from "./routes/inbox.js";
import { accountRoute } from "./routes/account.js";
import { checkoutRoute, checkoutSimulateRoute } from "./routes/checkout.js";
import { webhooksRoute } from "./routes/webhooks.js";
import { demoRoute } from "./routes/demo.js";
import { mcpRoute } from "./routes/mcp.js";
import { waitlistRoute } from "./routes/waitlist.js";

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

const authed = new Hono<{ Bindings: Env; Variables: AuthedVariables }>();
authed.use("*", requireAuth);
authed.route("/", infrastructureRoute);
authed.route("/", campaignsRoute);
authed.route("/", inboxRoute);
authed.route("/", accountRoute);
authed.route("/", checkoutRoute);
authed.route("/", demoRoute);
app.route("/", authed);

app.onError((err, c) => {
  const name = err instanceof Error ? err.name : "";
  if (name === "ValidationError") return c.json({ error: err.message }, 400);
  if (name === "NotFoundError") return c.json({ error: err.message }, 404);
  if (name === "TenantIsolationError") return c.json({ error: err.message }, 403);
  if (name === "RateLimitError") return c.json({ error: err.message }, 429);
  console.error(err);
  return c.json({ error: "internal error" }, 500);
});

export default app;
