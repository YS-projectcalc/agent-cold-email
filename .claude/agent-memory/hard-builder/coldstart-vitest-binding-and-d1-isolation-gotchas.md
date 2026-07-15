---
name: coldstart-vitest-binding-and-d1-isolation-gotchas
description: ColdStart apps/platform vitest — a wrangler.toml binding IS present in the test env (breaks "absent" assumptions), and direct env.DB writes are NOT rolled back per-test.
metadata:
  type: reference
---

Two ColdStart `apps/platform` test-env gotchas that cost a debugging cycle (2026-07-15, ops-email/watchtower build):

1. **A binding declared in `wrangler.toml` is BOUND in the vitest env.** `vitest.config.ts` loads the real config via `wrangler: { configPath: "./wrangler.toml" }`, so adding `[[send_email]] name = "OPS_EMAIL"` made `env.OPS_EMAIL` a live JsRpc proxy in tests — NOT `undefined`. Consequences: a factory that switches on `env.X ? real : sandbox` returns REAL in tests; and `expect(env.X).toBeUndefined()` throws unhandled `TypeError: The RPC receiver does not implement the method "inspect"/"hasAttribute"` (vitest pretty-prints the proxy). Fix: test binding-present-vs-absent branches with FAKE env objects (`{ X: {...} } as unknown as Env` / `{ X: undefined }`), never by asserting on the real `env`. `[vars]` entries (e.g. `OPS_ALERT_EMAIL`) are likewise present in the test env for free.

2. **Direct `env.DB` writes are NOT isolated/rolled back between `it`s** in this pool for control-plane D1 state. A row written to a new D1 table (e.g. `watchtower_state`) by one test leaked into the next (a "first-ever" case saw prior state and behaved as a transition). Existing tests dodge this by scoping to their own `tenantId`; a STATE-MACHINE test can't. Fix: `beforeEach(() => env.DB.prepare("DELETE FROM <table>").run())` to force a clean baseline. (`[[send_email]].send()` in local miniflare is simulated — no real send without `remote: true` — so the default real mailer in a route-path test is safe.)

Also: `test/setup.ts` imports migrations by EXPLICIT name (0001..000N) — a new migration file is silently absent from the test D1 until you add its `?raw` import there.
