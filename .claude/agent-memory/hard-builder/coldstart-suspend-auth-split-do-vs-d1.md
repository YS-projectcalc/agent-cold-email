---
name: coldstart-suspend-auth-split-do-vs-d1
description: ColdStart — suspending a tenant in DO tenant_profile.status does NOT lock its API token; requireAuth checks D1 tenants_index.status. Flip BOTH to truly disable a tenant.
metadata:
  type: project
---

In ColdStart (`~/dev/coldstart`), tenant auth and tenant runtime state live in two different stores:
- `requireAuth`/`resolveTenantFromToken` (`src/require-auth.ts`) rejects a token only when the **D1 `tenants_index.status` != 'active'**.
- `suspendTenant`/dunning-suspend/terminate mutate the **DO `tenant_profile.status`** (per-tenant SQLite) — a DIFFERENT column in a DIFFERENT store.

**The trap:** setting `tenant_profile.status='suspended'` alone leaves the token fully valid, so a "suspended" tenant can still call every authed route — e.g. `/setup-infrastructure` to re-provision and undo an abuse-teardown reclaim. The DO-side status only gates things that READ it (e.g. the D5 `runTick` freeze guard).

**How to apply:** to actually lock a tenant out (abuse terminate), ALSO call `setTenantIndexStatus(env, id, 'suspended')` from the Worker/route layer (the DO must never write D1 — that invariant is why it's split). Voluntary cancel deliberately does NOT lock the token (a canceled tenant keeps read access so `account()` reflects its state). Note `tenants_index.status` is set once at signup and otherwise never updated, so digest/active-by-plan counts read DO status via `opsSummary`, not D1. See [[coldstart-per-tick-recompute-clobbers-control-state]] for the sibling "state lives in a surprising column" hazard.
