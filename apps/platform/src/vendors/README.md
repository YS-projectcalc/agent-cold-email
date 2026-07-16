# src/vendors

Implements the `VendorPort` interfaces from `@coldstart/shared` twice:

- `sandbox/` — **active**, in-memory, deterministic simulators. This is what
  every tenant uses today (test-mode go-live, SPEC.md §0.1/§0.4). Notably
  `sandbox/email-port.ts` decides bounce/reply/silence by the recipient
  local-part (`bounce`/`reply` substrings) — see the comment at the top of
  that file for the exact contract; it's what the E2E tests key off of.
- `real/` — mostly **typed stubs**: domain/mailbox/billing/metrics every
  method throws `NotActivatedError` immediately (coded against the vendor
  shapes now so a later real implementation is a drop-in, but nothing there
  ever makes a network call). `real/email-port.ts`'s `RealEmailPort` is the
  one exception — a genuine HTTP client to the external engine (`apps/engine`)
  — but it too stays dark (`NotActivatedError`) until `ENGINE_BASE_URL`/
  `ENGINE_AUTH_SECRET` are set AND the factory's ENGINE_TENANTS gate below
  admits the tenant.
- `dns-scan-port.ts` / `reputation-port.ts` (both sandbox + real) — SPEC.md
  §20.1/§20.5's `DnsScanPort`/`DomainReputationPort` — the BYO-domain
  pre-flight scan + reputation-ladder signals. The `real/` adapters are
  "coded-but-unactivated" like every other real port ABOVE (a DNS-over-HTTPS/
  RDAP/DNSBL implementation is deferred), NOT because of vendor spend (a DNS
  lookup is free) but because it's a new external network dependency scanning
  a tenant-supplied hostname — deliberately activation-gated, not silently wired.
  The sandbox adapters are fixture-map + magic-substring hostnames (e.g.
  `liveinfra-`, `parked-`, `delegated-`, `established-`, `blocklisted-` — see
  each file's own doc comment for the full list) so `byo-intake.ts`'s tests
  can drive every intake branch deterministically.

`factory.ts` is the single choke point that decides which bundle a tenant
gets (`createVendorAdapters(plan, clock, realAdaptersActivated, engineConfig?,
tenantId?, engineTenantsRaw?)`). Demo/free plans are forced to `sandbox`
unconditionally, before the activation flag is even consulted — see
`test/demo-adapter-guard.test.ts` in `apps/platform` for the guardrail test
that fails if this is ever weakened.

`ENGINE_TENANTS` (ROADMAP "Mordy-pilot activation lane") layers a second,
narrower gate scoped to the EmailPort only: a tenant reaches `RealEmailPort`
solely when `realAdaptersActivated` is on, its `tenantId` (the DO's own
verified identity, never request-supplied) is an exact member of the parsed
`ENGINE_TENANTS` allowlist, its plan is non-demo/free, AND `engineConfig` is
present. Being allowlisted also pins that tenant's domain/mailbox/billing/
metrics to sandbox regardless of the global flag — there is no per-port
activation for those ports yet (EmailPort-only, this phase). Default-empty
and fail-closed: unset/malformed `ENGINE_TENANTS` activates nobody, ever (no
wildcard syntax, exact string match only). See
`test/engine-tenants-allowlist.test.ts` for the five guards this proves.

## How to run

Part of `apps/platform`; no standalone build. Exercised by
`apps/platform/test/*.test.ts` via `npm test` (workspace root or this app).

## Depended on by

`src/tenant-do.ts` (constructs a `VendorAdapterBundle` per tenant via
`factory.ts` and uses it for `setup_infrastructure`, warmup, send, and poll).
