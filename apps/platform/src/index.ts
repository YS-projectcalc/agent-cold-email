import { Hono } from "hono";
import type { Env } from "./env.js";
import { requireAdminAuth } from "./require-admin-auth.js";
import { requireAuth, type AuthedVariables } from "./require-auth.js";
import { csrfGuard } from "./csrf-guard.js";
import { signupRoute } from "./routes/signup.js";
import { infrastructureRoute } from "./routes/infrastructure.js";
import { campaignsRoute } from "./routes/campaigns.js";
import { inboxRoute } from "./routes/inbox.js";
import { accountRoute } from "./routes/account.js";
import { checkoutRoute, checkoutSimulateRoute } from "./routes/checkout.js";
import { lifecycleRoute } from "./routes/lifecycle.js";
import { webhooksRoute } from "./routes/webhooks.js";
import { unsubscribeRoute } from "./routes/unsubscribe.js";
import { demoRoute } from "./routes/demo.js";
import { mcpRoute } from "./routes/mcp.js";
import { waitlistRoute } from "./routes/waitlist.js";
import { adminSupportRoute } from "./routes/admin-support.js";
import { adminOpsRoute } from "./routes/admin-ops.js";
import { statusRoute } from "./routes/status.js";
import { dashboardSessionRoute } from "./routes/dashboard-session.js";
import { dashboardRoute } from "./routes/dashboard.js";
import { activityRoute } from "./routes/activity.js";
import { webhookSubscriptionsRoute } from "./routes/webhook-subscriptions.js";
import { runScheduledOpsSweep } from "./scheduled.js";
import { handleInboundSupportEmail } from "./admin/support-inbound.js";

export { TenantDO } from "./tenant-do.js";
export { RateLimiterDO } from "./rate-limiter-do.js";

const app = new Hono<{ Bindings: Env; Variables: AuthedVariables }>();

app.route("/", signupRoute);
// /mcp does its own per-JSON-RPC-method auth (see src/mcp/handler.ts) — not
// mounted behind requireAuth. /api/waitlist is unauthenticated (public
// form). /checkout/simulate, /webhooks/stripe, and /unsubscribe are
// unauthenticated for the same reason a real Stripe hosted checkout page /
// webhook caller / mail client can't present our bearer token — see
// routes/checkout.ts, routes/webhooks.ts, and routes/unsubscribe.ts for
// their own credential (session id / signature / signed token).
app.route("/", mcpRoute);
app.route("/", waitlistRoute);
app.route("/", checkoutSimulateRoute);
app.route("/", webhooksRoute);
app.route("/", unsubscribeRoute);
// GET /status — public, no tenant/admin data (see routes/status.ts).
app.route("/", statusRoute);
// POST /dashboard/session — UNAUTHENTICATED (SPEC.md §19.1): the token-gate
// screen POSTs the pasted tenant bearer token in the JSON BODY (there is no
// Authorization header yet at this point in the flow), verifies it itself,
// then mints the cookie session — the same reason /checkout/simulate and
// /webhooks/stripe are unauthenticated (their own credential lives somewhere
// other than a bearer header).
app.route("/", dashboardSessionRoute);

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

// Every literal top-level path this API exposes behind requireAuth (bearer OR
// dashboard cookie — SPEC.md §19.1). An EXPLICIT list, not a blanket "*",
// mirrors the admin scoping above and for the SAME reason: Hono composes
// every middleware whose PATTERN matches a request path into one chain
// regardless of whether any route ultimately handles it, so a blanket "*"
// here would swallow a genuinely-unknown path (e.g. GET /zzz) into this
// middleware's 401 before it ever reaches app.notFound() below — proven live
// by the M1 serving-spike gate (§19.1), which requires an unknown API path to
// 404, not 401 (this was a real, previously-undetected gap: every path used
// to 401 here, unknown or not). Adding a new authed route anywhere below MUST
// add its path pattern here too, or it will 404 instead of resolving.
const AUTHED_PATH_PATTERNS = [
  "/setup-infrastructure",
  "/infrastructure-status",
  "/campaigns",
  "/campaigns/*",
  "/metrics",
  "/inbox",
  "/threads/*",
  "/account",
  "/checkout",
  "/cancel",
  "/demo/run",
  "/dashboard/logout",
  "/dashboard/views",
  "/dashboard/views/*",
  "/activity",
  "/webhook-subscriptions",
  "/webhook-subscriptions/*",
];

const authed = new Hono<{ Bindings: Env; Variables: AuthedVariables }>();
// GLOBAL CSRF guard (§19.1 NEW-1) runs immediately after requireAuth (reads
// `authVia` off the context) on the SAME explicit surface — covers every
// legacy destructive route (/cancel, /checkout, /campaigns, /threads/*), not
// just /dashboard/*, per the spec's hard requirement.
for (const pattern of AUTHED_PATH_PATTERNS) authed.use(pattern, requireAuth, csrfGuard);
authed.route("/", infrastructureRoute);
authed.route("/", campaignsRoute);
authed.route("/", inboxRoute);
authed.route("/", accountRoute);
authed.route("/", checkoutRoute);
authed.route("/", lifecycleRoute);
authed.route("/", demoRoute);
authed.route("/", dashboardRoute);
authed.route("/", activityRoute);
authed.route("/", webhookSubscriptionsRoute);
app.route("/", authed);

// SPEC.md §19.1 (M1 serving spike) — Hono's default 404 is `text/plain`
// ("404 Not Found"); every other response on this API is JSON, so an unknown
// API path (anything NOT under /app/*, which `run_worker_first` already
// routes around this Worker entirely) must 404 as JSON too.
app.notFound((c) => c.json({ error: "not found" }, 404));

app.onError((err, c) => {
  const name = err instanceof Error ? err.name : "";
  if (name === "ValidationError") return c.json({ error: err.message }, 400);
  if (name === "NotFoundError") return c.json({ error: err.message }, 404);
  if (name === "TenantIsolationError") return c.json({ error: err.message }, 403);
  if (name === "RateLimitError") return c.json({ error: err.message }, 429);
  if (name === "RequestInProgressError") return c.json({ error: err.message }, 409);
  // SPEC.md §19.4 [F5] — a stale dashboard-view rev is a STRUCTURED 409: the
  // agent needs currentRev + currentLayout to rebase its edit, not just an
  // opaque "conflict" string.
  if (name === "RevConflictError") {
    const conflict = err as Error & { currentRev: number; currentLayout: unknown };
    return c.json({ error: err.message, currentRev: conflict.currentRev, currentLayout: conflict.currentLayout }, 409);
  }
  console.error(err);
  return c.json({ error: "internal error" }, 500);
});

export default {
  fetch: app.fetch,
  // Cron Trigger entry point (D2) — see scheduled.ts for what runs. The
  // wrangler.toml `[triggers]` cron is now armed (every 5 min).
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runScheduledOpsSweep(env));
  },
  // Inbound support@ (D1) — Cloudflare Email Routing delivers a message here
  // once support@coldrig.dev is routed to this Worker (ACTIVATION.md). Awaited
  // (not waitUntil): the handler MUST consume `message.raw` and forward before
  // returning, or Email Routing drops the message. A parse/persist failure
  // surfaces (Email Routing retries); the forward leg catches its own errors.
  async email(message: ForwardableEmailMessage, env: Env, _ctx: ExecutionContext): Promise<void> {
    const outcome = await handleInboundSupportEmail(message, env);
    console.log("inbound support email", JSON.stringify(outcome));
  },
};
