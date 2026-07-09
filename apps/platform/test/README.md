# apps/platform/test

Vitest (`@cloudflare/vitest-pool-workers`) — tests run inside the actual
Workers runtime with real `DB`/`TENANT` bindings, per `vitest.config.ts`.

- `e2e.test.ts` — the B0 walking-skeleton flow end to end (signup ->
  setup_infrastructure -> warmup ramp -> launch_campaign -> tick ->
  poll/reply/bounce -> inbox/thread/reply -> metrics -> account), plus two
  focused integration tests asserting per-mailbox daily-cap enforcement and
  pause/pause_all actually blocking sends (not just returning 200).
- `tenant-isolation.test.ts` — the required guardrail: a second tenant's
  token cannot read the first tenant's campaigns/inbox/account data.
- `demo-adapter-guard.test.ts` — the required guardrail: a demo/free-plan
  tenant is structurally forced onto the sandbox `VendorPort` bundle even if
  a `realAdaptersActivated` flag is (hypothetically) true.
- `helpers.ts` — `api()` (wraps `SELF.fetch` with JSON + bearer-token
  headers), `signup()`, `tenantStub()` (direct DO access for the
  sandbox-only `advanceClock`/`tick`/`pollInbox` calls that aren't HTTP
  facade intents).

`cloudflare:test`'s `env`/`SELF` are typed via the global `Cloudflare.Env`
augmentation in `../src/env.ts` (the same one Hono's `c.env` uses) — no
separate test-only type declaration needed.

## How to run

```
npm test -w apps/platform
```
