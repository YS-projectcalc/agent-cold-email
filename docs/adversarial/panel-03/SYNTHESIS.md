# Adversarial Panel #3 — Final Gate (Synthesis)

> 4 opus lenses (money-billing, security-admin-tenancy, correctness-integration, gtm-honesty-completeness) attacked the WHOLE live business before "done". All findings LIVE-PROVEN where marked. Verdicts: 4× FIX_THEN_SHIP (no BLOCK, no fabricated CRITICAL). Raw records frozen alongside (`*.json`). 2026-07-09.

## The class: billing/lifecycle state has no state-machine discipline
Most HIGH findings are one underlying defect — `billing_state`/`status` are written by many handlers (checkout, subscription.updated, payment_failed, dispute, cancel, terminate, dunning) with no sticky-terminal-state or reactivation model, and lifecycle freeze isn't enforced on every spend path. Symptoms:
- **Webhook fails OPEN** (HIGH, live): no `STRIPE_WEBHOOK_SECRET` → unsigned `/webhooks/stripe` mutates any tenant by body-supplied id (free upgrade / freeze-any-tenant). Worst finding. → fail closed.
- **Dispute/cancel freeze not sticky** (HIGH, live): routine checkout/subscription events overwrite `disputed`/`canceled` → freeze lifts. → sticky terminal states.
- **Deliverability cron not lifecycle-frozen** (HIGH): a frozen tenant can still REPLACE_DOMAIN (buy a domain = spend at activation). → freeze guard in `runDeliverabilitySweep`.
- **Cancel/re-subscribe leaks quota + infra** (HIGH, live): quota counts released/burning resources (locks out paying customer); teardown tombstone permanent → second cancel never releases new infra. → count live-only; per-epoch teardown.
- **Canceled tenant keeps full write access** (live): re-provisions/relaunches. → add canceled to tick freeze + block setup/launch.
- **No reactivation from dunning suspension** / **end-of-period cancel tears down immediately** (MED). → reactivation path; defer teardown.

## Other findings
- Body-size cap bypass on `/webhooks/stripe` + `/cancel` (MED) — post-panel-2 endpoints skipped the guard.
- Waitlist leads expire (90d TTL) + no owner retrieval (MED) — funnel silently empties before activation. → durable store + digest count.
- No throttle on /checkout,/cancel; /checkout unbounded self-storage (LOW).
- Sitemap/canonicals point at `.html` → 308 (MED, AEO) — dilutes the discovery flywheel. → clean URLs.
- openapi vs MCP tools/list `required`-field mismatch (LOW) — zod `.default()` → required in output-mode schema. → input-mode gen.

## Remediation (2 disjoint waves; orchestrator commits + redeploys)
- **Wave 1 (hard-builder/opus, apps/platform):** the billing/lifecycle state machine (webhook fail-closed, sticky disputed/canceled, deliverability-sweep freeze, quota-live-only, teardown-epoch, cancel-blocks-writes, dunning reactivation, end-of-period defer, body caps, checkout throttle, waitlist durable+digest, MCP input-mode schema) — each with a fail-on-old-code test; #1-#5 revert-proven (live-proven).
- **Wave 2 (design-builder/sonnet, site/):** clean-URL sitemap + self-canonical on all 12 pages + internal-link/llms cleanup.

## Deferred (activation-hardening backlog, documented not silently dropped)
Tick send→bill reaper for the eviction-between-send-and-bill window = B2 resumable-saga work (real sends aren't armed in test mode). Real Stripe dispute→tenant routing, real vendor release calls = activation. B2 (resumable provisioning sagas), D4 (OFAC), A5 (engine spike), real-signal deliverability tuning remain the documented activation backlog.
