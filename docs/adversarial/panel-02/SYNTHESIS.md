# Adversarial Panel #2 — Live Real Surfaces (Synthesis)

> 4 opus lenses attacked the LIVE deployed platform + distribution surfaces (all findings VERIFIED against live endpoints). Raw per-lens records frozen alongside (`*.json`). 2026-07-09.

## Verdicts
- **security-isolation: CLEAN** ✅ — the load-bearing property holds. No cross-tenant data leak; MCP `/mcp` resolves the tenant fresh per request (two-token probe isolated); token hashing sound; TenantDO-per-tenant isolation intact. (One LOW: /signup rate limit — folded into abuse lens.)
- **abuse-cost-dos: FIX_THEN_SHIP** — 2 HIGH, 2 MED, 1 LOW.
- **correctness-engine: FIX_THEN_SHIP** — 1 HIGH, 4 MED (the "passes-in-sandbox, corrupts-at-activation" class).
- **distribution-honesty: FIX_THEN_SHIP** — 1 HIGH, 2 MED, 2 LOW.

## The load-bearing finding
**The third-party-brand lookalike guardrail was ADVERTISED as "enforced in code" (README/AGENTS/ARCHITECTURE §8/SPEC §8) but ABSENT.** Verified live: `setup_infrastructure` with brand="Google" provisioned `trygoogle.com` mailboxes. Both a real safety gap (impersonation vector at activation) and an honesty/FTC problem (claiming a guardrail that doesn't exist). It was specced (panel #1 amendment #11) but never built. → Wave 1 builds the real validator (denylist + own-brand-derivation) with a failing test, then aligns the doc claims.

## Fix waves dispatched (both leave uncommitted changes; orchestrator commits + redeploys)
**Wave 1 (hard-builder/opus — `apps/platform` + root docs):** lookalike validator (HIGH); /signup atomic per-IP rate limit, NO CAPTCHA — must stay agent-drivable (HIGH); suppression checked at send-time in tick (HIGH); stop_on_reply flag actually read (MED); send-window enforced/wire dead `isWithinSendWindow` (MED); atomic send-claim + ledger idempotency to kill the double-send/double-count race (MED); billing.recordUsage ordering + try/catch (MED); /demo/run per-tenant rate limit + state reset (MED); body-size cap before JSON.parse (MED); token prefix `cs_live_`→`cs_test_` (LOW); waitlist KV TTL (LOW). Each with a fail-on-old-code test.

**Wave 2 (design-builder/sonnet — `site/` only):** docs.html "MCP not live" → LIVE-in-test-mode (HIGH); `{{BRAND}}` literal leaking into raw `<title>` → pre-render keyword slug (MED, discovery-critical); CLI `setup-infrastructure`→`setup` + verify all shown commands/tools vs live (LOW).

## Not-a-defect / respected constraints
Sandbox-only (no real spend/sends), Stripe-live + real adapters deferred, brand-name deferred — all by design, not attacked. NO Turnstile on signup (would break the agent-native flow — rate-limit instead).
