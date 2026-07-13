# Adversarial review — SPEC §19 Dashboard + Unified Inbox (design-stage, pre-build)

Date: 2026-07-12 · Reviewer: fresh-context adversary (opus) · Target: SPEC §19 draft (dashboard + unified inbox) · Grounding: repo @ e1d1f94

## Round 1 — NO-SHIP (10 findings)

1. **BLOCKING** — Agent-authored content (agent_note markdown, labels, view names) sanitization asserted not specified while tenant bearer sat in localStorage; poisoned-reply → agent echoes into note → stored XSS on the credential origin → token grants full facade incl. teardown. Also cited a deferral gate (ACTIVATION Gate 2 session-auth item) that did not exist.
2. **BLOCKING** — §19.6 inbox UX unbuildable on reused `/inbox`: `listInbox` (engine/threads.ts:43-71) unpaginated full-scan + N+1 thread_marks per row; row fields (subject/snippet/mailbox/campaign-name/label) absent; no filter params. Scale-cliff complaint claimed closed but not.
3. SHOULD-FIX — Workers static-assets composition asserted, no `[assets]` config existed; "TenantDO v-bump" wrong (tables bootstrap via CREATE TABLE IF NOT EXISTS in DO constructor; ensureColumnMigrations for columns; no D1/DO-class migration).
4. SHOULD-FIX — Provenance actor client-asserted (spoofable header).
5. SHOULD-FIX — View PUT blind full-replace; agent/human silent clobber.
6. SHOULD-FIX — Default-view lifecycle unspecified (seed, single-default invariant, promote/demote).
7. SHOULD-FIX — "Per-mailbox last-poll" UI claim had no backing column.
8. SHOULD-FIX (scope) — Agent-layout-control net-new vs ROADMAP/YAGNI → resolved by founder directive 2026-07-12 (in scope).
9. NOTE — listCampaigns/activity are new DO methods, not thin wrappers.
10. NOTE — Unspecified: 401-mid-session, loading/error states, swipe undo, a11y floor, timezones, perf budget, READMEs, CI wiring.

## Round 2 (r2 diff re-attack) — SHIP with 2 build-gating conditions

All 8 fix-list items CLOSED (httpOnly cookie session; ONE sanitization pipeline incl. textContent-only labels + restricted-markdown agent_note + dangerouslySetInnerHTML CI guard; inbox v2 cursor/filters/fields/N+1-kill; exact [assets] config + wrangler-dev spike gate; transport-derived provenance; rev CAS + 409; default-view lifecycle traced safe; last_polled_at backed; scope recorded).

New findings, folded into r3:
- **NEW-1 SHOULD-FIX** — cookie fallback in requireAuth extends cookie auth to ALL legacy authed routes; SameSite=Strict is site-scoped (eTLD+1) so custom-domain activation (app+site on coldrig.dev) voids it → CSRF header `X-Coldstart-Client` must be enforced middleware-wide on every cookie-authed mutation (incl. `/cancel`) + DoD 403 test; hardening adopted: cookie carries opaque server-side session id (D1 0006), never the raw token.
- **NEW-2 SHOULD-FIX** — inbox cursor needs composite `(lastEventTs, rowid)` tiebreak (same-ts events routine per threads.ts:38-42) + same-ts page-boundary test.
- NEW-3/4/5 NOTES — subject/snippet via json_extract (verify per-step); spike criteria: `/app` no-slash, favicon under /app/, JSON app.notFound(); provenance plumbing via requireAuth `authVia` + explicit source param; seeded view stamped `system` (badge suppressed).

Attacks that FAILED (held): tenant isolation on new routes; actor-forcing as privilege escalation; delete-bricking; email-path XSS (iframe+sandbox+CSP+base); widget-prop injection; zod feasibility; /dashboard/session CSRF; rev CAS TOCTOU (DO serial + sync SqlStorage); SameSite first-load UX; default-view state machine; MCP-via-cookie provenance spoof (handler reads Authorization only).

Verdict: **SHIP (r3)** — build may proceed per §19.8.
