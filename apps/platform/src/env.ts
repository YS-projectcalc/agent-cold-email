import type { TenantDO } from "./tenant-do.js";

// Cloudflare's convention (what `wrangler types` generates): augment the
// global `Cloudflare.Env` namespace so both `c.env` in Hono and the `env`
// export from `cloudflare:test`/`cloudflare:workers` pick up these bindings.
declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      TENANT: DurableObjectNamespace<TenantDO>;
      TOKEN_HASH_PEPPER: string;
    }
  }
}

export type Env = Cloudflare.Env;
