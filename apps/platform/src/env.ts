import type { TenantDO } from "./tenant-do.js";
import type { RateLimiterDO } from "./rate-limiter-do.js";

// Cloudflare's convention (what `wrangler types` generates): augment the
// global `Cloudflare.Env` namespace so both `c.env` in Hono and the `env`
// export from `cloudflare:test`/`cloudflare:workers` pick up these bindings.
declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      TENANT: DurableObjectNamespace<TenantDO>;
      SIGNUP_LIMITER: DurableObjectNamespace<RateLimiterDO>;
      TOKEN_HASH_PEPPER: string;
      WAITLIST: KVNamespace;
      // B1 money path — optional test-mode Stripe secrets. Unset in this
      // build (CLAUDE.md rule g: no real vendor secret anywhere in the
      // repo); wiring a real Stripe TEST key is an ACTIVATION.md step. Every
      // code path that reads these must treat them as absent and fall back
      // to the simulated checkout / accept-without-verification webhook mode.
      STRIPE_SECRET_KEY?: string;
      STRIPE_WEBHOOK_SECRET?: string;
      // D1/D2/D6 admin surface (apps/platform/src/admin/README.md) — bearer
      // secret gating every /admin/* route (cross-tenant data, never the
      // per-tenant token from require-auth.ts). Optional binding: unset ->
      // requireAdminAuth fails closed (401 on every /admin/* call, never an
      // open-by-default bypass). Set via `wrangler secret put ADMIN_TOKEN`
      // for a deployed environment, or `.dev.vars` locally (see
      // .dev.vars.example) — CLAUDE.md rule g: never in code or git.
      ADMIN_TOKEN?: string;
      // External email engine (apps/engine — ARCHITECTURE.md #6). BOTH must be
      // set to activate the real EmailPort; either unset keeps RealEmailPort
      // dark (it throws NotActivatedError), so the deployed default cannot reach
      // a live mail server (CLAUDE.md rule g: the secret is a wrangler secret,
      // never in code/git; see ACTIVATION.md Gate 2 "Go-engine host"). Note:
      // even with both set, the adapter factory (vendors/factory.ts) still only
      // hands the real adapter to an activated paid tenant — a demo/free tenant
      // is forced to sandbox first, unconditionally.
      ENGINE_BASE_URL?: string;
      ENGINE_AUTH_SECRET?: string;
      // Ops email + monitoring (watchtower/dunning/support). The Cloudflare
      // Email Service `send_email` binding (wrangler.toml `[[send_email]]`
      // name = "OPS_EMAIL") — NO api keys, sends from a domain onboarded via
      // `wrangler email sending enable coldrig.dev` (ACTIVATION.md, owner-
      // hands). OPTIONAL/dark by design: absent (binding undeclared or the
      // domain not yet onboarded) -> RealOpsMailer throws OpsMailNotConfigured
      // which every caller catches-and-logs, so an unsendable alert can never
      // take down a request path or the sweep. Present + domain live -> real
      // sends. Never bound in tests/dev (the sandbox mailer records instead).
      OPS_EMAIL?: SendEmail;
      // Destination for founder ops alerts + the support@ inbound forward
      // (src/admin/watchtower.ts, src/admin/support-inbound.ts). A plain
      // `[vars]` entry (jacob@epiphanymade.com), NOT a secret — it is already
      // public on the legal pages (site/privacy.html, site/terms.html). The
      // forward target must additionally be a VERIFIED Email Routing
      // destination before `message.forward` works (ACTIVATION.md arming step).
      OPS_ALERT_EMAIL: string;
      // SPEC.md §19.1 — the dashboard SPA's static asset bundle (public/app/),
      // served by Cloudflare's own asset layer via [assets] in wrangler.toml.
      // Not fetched from Worker code today (run_worker_first excludes /app/*
      // so the asset layer serves it directly) — typed here so a future
      // Worker-side ASSETS.fetch shim (the spec's documented fallback if the
      // declarative [assets] config can't scope cleanly) has a binding ready.
      ASSETS: Fetcher;
      // B4 opt-out — the public https origin this Worker is reachable at,
      // embedded in the RFC 8058 hosted one-click unsubscribe URL a tick
      // builds (engine/tick.ts's buildListUnsubscribe). NOT a secret (this
      // exact URL is already published in README.md/HANDOFF.md) — a plain
      // `[vars]` entry in wrangler.toml, not a wrangler secret. Optional:
      // engine/tick.ts falls back to the same real deployed URL as a
      // code-literal default, so local dev/test needs no configuration and a
      // missing binding never breaks the hosted link.
      PUBLIC_BASE_URL?: string;
    }
  }
}

export type Env = Cloudflare.Env;
