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
    AND the factory's product-driven `activated` gate below admits the tenant.
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
gets (`createVendorAdapters(plan, clock, activated, engineConfig?,
inboxKitConfig?, inboxKitDomainRegistrant?)`). The two trailing InboxKit
params are additive/optional — no current call site (`tenant-do.ts`) supplies
them, so `RealMailboxPort`/`RealInboxKitDomainPort` stay exactly as dark as
every other real/ adapter today; see `test/inboxkit-adapter-dark-gating.test.ts`
for the RED-provable guard. Demo/free plans are forced to `sandbox`
unconditionally, before the activation flag is even consulted — see
`test/demo-adapter-guard.test.ts` in `apps/platform` for the guardrail test
that fails if this is ever weakened.

`activated` (self-serve activation design §2.1, I1) is a PRODUCT-DRIVEN gate,
not an operator-maintained allowlist: `engine/activation.ts`'s
`readActivationState` re-derives it with a FRESH SQL read on every
`buildAdapters()` call (`tenant-do.ts`) from persisted `tenant_profile` state —
`isPaidPlanTier(plan) && billing_state === 'active' && NOT
isLifecycleFrozen(status, billing_state) && screening_status === 'clear'`
(the screening check is a documented STUB until I5 lands real OFAC screening).
Paying flips `billing_state` to 'active', which flips this on; the existing
freeze/abuse machine (dunning suspend, dispute, cancel) flips it back off —
no allowlist to hand-edit, ever.

`activated` gates the **EmailPort ONLY** (mirrors the retired ENGINE_TENANTS
lane's own "EmailPort-only, this phase" scope discipline). Domain/mailbox/
billing/metrics have no per-tenant activation path yet — they need BOTH
`activated` AND `inboxKitConfig` to ever go real (I3/I4, unbuilt); since no
call site supplies `inboxKitConfig` today, a genuinely activated paid tenant
still gets sandbox domain/mailbox/billing (functional, not merely dark) and
ONLY a real (dark-until-`ENGINE_BASE_URL`/`ENGINE_AUTH_SECRET`) EmailPort.
`tenant-do.ts`'s `buildAdapters()` reflects this: it caches the sandbox bundle
for the DO's lifetime (several sandbox ports hold in-memory state that must
survive) and swaps in a fresh `email` port on each call based on the
freshly-read activation state — see `test/activation-gate.test.ts` for the
gate's own unit tests and the fresh-read (no-DO-restart-needed) proof.

## How to run

Part of `apps/platform`; no standalone build. Exercised by
`apps/platform/test/*.test.ts` via `npm test` (workspace root or this app).

## Depended on by

`src/tenant-do.ts` (constructs a `VendorAdapterBundle` per tenant via
`factory.ts` and uses it for `setup_infrastructure`, warmup, send, and poll).
