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
    }
  }
}

export type Env = Cloudflare.Env;
