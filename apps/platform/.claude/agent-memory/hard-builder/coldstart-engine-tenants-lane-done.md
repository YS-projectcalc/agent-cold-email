---
name: coldstart-engine-tenants-lane-done
description: coldstart ENGINE_TENANTS per-port email allowlist (Mordy comped-pilot lane) is BUILT + committed at f74687d, adversary-SHIP, dark; the ROADMAP's older email-engine entry still lists it stale-OPEN.
metadata:
  type: project
---

The ENGINE_TENANTS per-tenant email-port allowlist (comped-pilot shape) is DONE and committed at `f74687d` ("ENGINE_TENANTS per-tenant email-port allowlist, dark (adversary SHIP)").

Implementation locations (verify still current before acting):
- `apps/platform/src/vendors/factory.ts` — `parseEngineTenants` (total, fail-closed) + 4-conjunct gate (`!isDemoOrFree && realAdaptersActivated && isEngineAllowlisted`), EmailPort-only; other ports pinned sandbox.
- `apps/platform/src/tenant-do.ts:287-293` — wiring: passes hard-`false` global flag, `this.tenantId` (DO-verified identity), `this.env.ENGINE_TENANTS`.
- `apps/platform/test/engine-tenants-allowlist.test.ts` — 21 tests.
- Frozen adversary verdict: `docs/adversarial/engine-tenants-allowlist-review-2026-07-14.md` (SHIP).

**Why:** The lane is dark end-to-end (`realAdaptersActivated` hard-false + RealEmailPort needs ENGINE_BASE_URL+ENGINE_AUTH_SECRET). Deployed behavior is byte-identical to before-fix until arming.

**How to apply:** The ROADMAP's older email-engine entry (`eb8ee42` line) still lists item (1) "per-port activation factory change" as OPEN — that is STALE/undrained; the Mordy-pilot-lane entry correctly records it BUILT+committed. Do not re-build. Carried residual (by design, not a bug): adapters cached per-DO, so removing a tenant from ENGINE_TENANTS needs a DO restart/eviction. Related: [[brief-orders-already-shipped-work]].
