---
name: failure-mechanisms-coldstart
description: Non-obvious failure mechanisms found in the ColdStart platform worker — check this list first on any ColdStart incident.
metadata:
  type: project
---

Running list of failure mechanisms proven by code-trace/live evidence in `apps/platform`. One line each; verify against current code before acting on any of them.

- **Paid tenants run a FROZEN clock.** `VirtualClock.now() = base + offset` (src/clock.ts) has no wall-clock term, and both offset writers (`TenantDO.advanceClock`, `engine/demo.ts`) are demo/free-only. Signup always creates plan `demo` (routes/signup.ts), checkout only flips `plan` (engine/billing.ts) — so every timestamp a paying tenant writes via `ctx.clock.now()` is stuck at its pre-upgrade instant. Consequence: D1/DO rows look "missing" when queried by date, `periodKey` never rolls over, `epochDay` counters never reset, and cron reapers (which use `RealClock`) see every fresh row as instantly stale.
- **DO SQLite writes survive a thrown RPC** (proven live 2026-08-04: the `tenant_profile` brand UPDATE persisted through a 500). So "row absent" ⇒ that line never executed — a valid bisect signal.
- **`app.onError` maps by `err.name` only** (src/index.ts). `VendorError`/`NotActivatedError` are unmapped ⇒ opaque 500. The MCP surface (src/mcp/handler.ts tools/call) instead returns HTTP 200 + `isError:true` + `err.message`. Same error, two very different-looking symptoms depending on surface — never infer the error class from the customer-visible shape.
- **The `real` adapter bundle hands out throwing stubs.** `RealBillingPort`, `RealDnsScanPort`, `RealDomainReputationPort`, `RealMetricsPort` all throw `NotActivatedError`. Any code path that touches them for an activated tenant dies mid-saga, after real vendor spend.

**Why:** all four are invisible to the test suite (tests inject their own clocks, stub fetch, and never build a real bundle end-to-end), so they only appear against a live paying tenant.
**How to apply:** on any ColdStart production incident, check the clock and the adapter-bundle kind before trusting timestamps or "no rows" evidence.
