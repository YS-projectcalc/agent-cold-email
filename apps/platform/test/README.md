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
  the product-driven `activated` gate is (hypothetically) true.
- `activation-gate.test.ts` — I1 self-serve activation: the product-driven
  `activated(tenant)` gate (paid + billing-active + not frozen + screening
  clear) replaces the old `ENGINE_TENANTS` allowlist, and a billing-state
  flip is visible on the VERY NEXT adapter build (no DO restart needed).
- `helpers.ts` — `api()` (wraps `SELF.fetch` with JSON + bearer-token
  headers), `signup()`, `tenantStub()` (direct DO access for the
  sandbox-only `advanceClock`/`tick`/`pollInbox` calls that aren't HTTP
  facade intents), `adminApi()` (same, but with the `ADMIN_TOKEN` bearer —
  see `setup.ts`), `failPayment()`/`activatePaidPlan()` (drive a tenant's
  billing state via the same Stripe-webhook path `webhook.test.ts` uses).
- `admin-auth.test.ts` — the required guardrail: every `/admin/*` route
  401s with no/wrong `ADMIN_TOKEN` (and rejects a valid TENANT token too),
  200s with the correct one.
- `admin-support.test.ts` — D1 AI support triage: billing question ->
  classified + FAQ-drafted; abuse report -> escalated, no draft; digest
  lists both; boundary validation on a bad payload.
- `admin-dunning.test.ts` — D2 dunning sweep: past_due tenant -> action;
  idempotent within a cycle; escalate/suspend thresholds; a current tenant
  produces nothing.
- `admin-digest.test.ts` — D6 owner digest: MRR/plan-count/past-due
  aggregation across multiple tenants, `?hours=` window param.
- `admin-unit.test.ts` — pure unit tests for the D1/D2 decision functions
  (`classifySupportMessage`/`triageSupportMessage`, `decideDunningAction`),
  same style as `deliverability.test.ts`'s `evaluate` tests.
- `scheduled.test.ts` — D2's `scheduled()` Cron Trigger export actually runs
  the ops sweep end to end (the wrangler.toml `[triggers]` block it will be
  wired to is commented-out — armed at activation).
- `status.test.ts` — `GET /status` public health check.

`cloudflare:test`'s `env`/`SELF` are typed via the global `Cloudflare.Env`
augmentation in `../src/env.ts` (the same one Hono's `c.env` uses) — no
separate test-only type declaration needed.

## Hermetic test env (`hermetic-env.ts` + `hermetic-env.test.ts`)

`@cloudflare/vitest-pool-workers` loads `apps/platform/.dev.vars` through
wrangler and injects **every** key in it as a binding on the test `env`. Left
unmanaged, a developer's locally-wired real secret (e.g. a truthy
`STRIPE_SECRET_KEY` set for local E2E) silently flips behavior gates under test
— `engine/billing.ts`'s `isRealSpendArmed` returns true, so the simulated-
checkout tests get real-Stripe-mode behavior. The suite would then be green only
in fresh worktrees (which copy the empty-key `.dev.vars.example`): its result
would depend on ambient machine state.

`hermetic-env.ts` closes this. `vitest.config.ts` CONSTRUCTS the test env from
an allowlist: tests see only `TOKEN_HASH_PEPPER`, `ADMIN_TOKEN`, and
`STRIPE_WEBHOOK_SECRET` (fixed in-repo test values), and **every other**
`.dev.vars` key is neutralized to `null`. New env vars are hermetic by default —
a key not on the allowlist is neutralized no matter when it was added, so a
future binding cannot bypass this. `hermetic-env.test.ts` guards it at two
layers: a unit test that the builder neutralizes any non-allowlisted key
(including a novel one), and an end-to-end test that the `.dev.vars.example`
canary (`HERMETIC_LEAK_CANARY`) and every `// spend-arming` binding read falsy
in the live `env`.

## How to run

```
npm test -w apps/platform
```
