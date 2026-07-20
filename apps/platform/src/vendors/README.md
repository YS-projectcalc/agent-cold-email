# src/vendors

Implements the `VendorPort` interfaces from `@coldstart/shared` twice:

- `sandbox/` — **active**, in-memory, deterministic simulators. This is what
  every tenant uses today (test-mode go-live, SPEC.md §0.1/§0.4). Notably
  `sandbox/email-port.ts` decides bounce/reply/silence by the recipient
  local-part (`bounce`/`reply` substrings) — see the comment at the top of
  that file for the exact contract; it's what the E2E tests key off of.
- `real/` — mostly **typed stubs**: billing/metrics every method throws
  `NotActivatedError` immediately (coded against the vendor shapes now so a
  later real implementation is a drop-in, but nothing there ever makes a
  network call). Three adapters are genuine HTTP clients, activation-gated
  the same way (dark until their config is present AND the factory selects
  them — never reachable from the deployed default):
  - `real/email-port.ts`'s `RealEmailPort` — the external engine
    (`apps/engine`); dark until `ENGINE_BASE_URL`/`ENGINE_AUTH_SECRET` are set
    AND the factory's ENGINE_TENANTS gate below admits the tenant.
  - `real/mailbox-port.ts`'s `RealMailboxPort` — InboxKit (ACTIVATION.md Gate
    0, founder ruling 2026-07-20 "go inboxkit"; SPEC.md §11/§12's decided
    mailbox vendor). Dark until an `InboxKitClientConfig`
    (`real/inboxkit-client.ts`) is supplied to `factory.ts`'s
    `createVendorAdapters`.
  - `real/inboxkit-domain-port.ts`'s `RealInboxKitDomainPort` — InboxKit's OWN
    domain provisioning (register-through-InboxKit, or connect an
    already-owned domain by pointing its nameservers at InboxKit's Cloudflare
    zone). Same `InboxKitClientConfig` as the mailbox port, but wired into a
    SEPARATE factory slot: `real/domain-port.ts`'s Porkbun-backed
    `RealDomainPort` stays the DEFAULT registrar path (SPEC.md §11/§12,
    ACTIVATION.md:25) unless a dedicated InboxKit domain config is supplied —
    see `real/inboxkit-domain-port.ts`'s doc comment for the open
    Porkbun-vs-InboxKit registrar question this pass deliberately did not
    resolve. `real/inboxkit-client.ts`/`real/inboxkit-errors.ts` hold the
    shared authed-HTTP-client + error-envelope-mapping plumbing both InboxKit
    adapters use (Bearer JWT + `X-Workspace-Id` auth; InboxKit's two live
    error shapes — gateway-level `{code,message}` vs app-level
    `{error:true,message}` — both graded 5xx/429-retryable,
    other-4xx-permanent). Contract/unit tests:
    `apps/platform/test/real-inboxkit-client.test.ts`,
    `test/real-mailbox-port.test.ts`, `test/real-inboxkit-domain-port.test.ts`,
    `test/inboxkit-adapter-dark-gating.test.ts`; sanitized fixtures in
    `test/fixtures/inboxkit.ts`.
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
tenantId?, engineTenantsRaw?, inboxKitConfig?, inboxKitDomainRegistrant?)`).
The two trailing InboxKit params are additive/optional — no current call site
(`tenant-do.ts`) supplies them, so `RealMailboxPort`/`RealInboxKitDomainPort`
stay exactly as dark as every other real/ adapter today; see
`test/inboxkit-adapter-dark-gating.test.ts` for the RED-provable guard.
Demo/free plans are forced to `sandbox` unconditionally, before the
activation flag is even consulted — see `test/demo-adapter-guard.test.ts` in
`apps/platform` for the guardrail test that fails if this is ever weakened.

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
