# ColdStart / coldrig — Handoff

Agent-operated cold-email platform. **LIVE, FIRST PAYING CUSTOMER Mordy (2026-07-28).** Site https://coldrig.dev · API https://api.coldrig.dev + https://agent-cold-email-api.yaakovscher.workers.dev · repo https://github.com/YS-projectcalc/agent-cold-email · Code: `~/dev/coldstart/`. **Standing autonomy (founder, 2026-07-22): merge/push/deploy/arm to customer-ready is authorized; browser-consent clicks excepted.**

> **You are resuming `coldrig` with zero prior context. Re-orient from `## Resume` below, then VERIFY its preconditions still hold** (deploy version, C3 build state, whether Mordy's agent retried). If they hold and the step is non-destructive, proceed. **STOP and confirm before any destructive/founder-owned step** — EXCEPT where the standing autonomy grant covers it (merge/push/deploy/arm).

## Where we are right now (2026-08-13)
**A live P0 was found, root-caused, fixed, gated, and DEPLOYED this session — and a follow-on (C3) is building.**

1. **🔥 P0 — SHIPPED + DEPLOYED + ARMED (Worker `d8055e22`).** Mordy's agent used the new `contact_operator` channel for the first time (ticket `sup_3ca260e4`, 2026-08-12) to report that his `setup_infrastructure` retry **MINTED + BOUGHT a second lookalike domain** (`theauthorpitchdesk.com`) instead of resuming the first — idempotency key not gating domain generation — and still failed at `step: "domain DNS setup"`. Root cause CONFIRMED: wave-3 commit `85f48af` changed the domain-intent key derivation with no backfill, orphaning Mordy's committed intent (`apd-setup-a-2mbx#0`), so resume never fired and `findAdoptableDomain` excludes any already-recorded domain — his paid domain was "too owned to adopt, not committed enough to resume." A structural second defect (C3, below) guarantees the retryable error that triggered the mint. Fix = dated one-shot constructor reconciliation (`engine/legacy-domain-intent-keys.ts`) rebinding the orphan to ordinal 1, zero new buys; excludes the deliverability `replace:` writer; + C1 literal-derivation guard + C4 previous-build-state fixture. Adversary gate SHIP 0-blocking, money invariant RED-proven ($15 mint reproduced then vanishes); frozen `docs/adversarial/intentfix-gate-2026-08-13.md`. Merged `main` `8a66976`, deployed, live-verified. **The fix ARMS on Mordy's DO's next touch** (the reconciliation runs in the `TenantDO` constructor) — his next retry rebinds + provisions with zero buys.
2. **C3 + direction-1 design pass DELIVERED, founder-ruled.** C3 (first-buy latency: every first domain buy ends in a customer-facing `retryable:true` because the ~2.3s in-call DNS wait can't outlast the vendor's ~32s registration — what made Mordy's agent feel the loop was broken) → **BUILD C3 NOW** (approved). Direction-1 (resume-from-resource root redesign) → **STAGE AFTER C3** (approved). Priorart `~/.claude/priorart-archive/coldrig-async-provisioning-and-resource-reconcile-2026-08-13.md`; both folded into `ROADMAP.md ## Open` 2026-08-13 [ASK].

## In flight / next
- **C3 SHIPPED + DEPLOYED 2026-08-13 (part (b) ARMED, part (d) DARK) — Worker `52a65306`.** Adversary gate SHIP-dark (frozen `docs/adversarial/c3-gate-2026-08-13.md`), merged `main` `6c5140b` (--no-ff, lane preserved), pushed, live-verified, `PROVISIONING_RECONCILE_ENABLED` confirmed unset. Part (b) is LIVE: a benign terminal purchased-domain propagation-wait now returns success-pending, not the scary `retryable:true` — so Mordy's next retry reads "in progress" (no spend). Full detail + the arm-gate finding: `ROADMAP.md ## Open` 2026-08-13 [ASK].
- **🔴 ARM-GATE (must fix BEFORE arming (d); cannot fire while dark):** gate Finding 1 — the (d) reconcile reads the FIRST persisted spec while the DIRECT resume path honors the LATEST call's persona/count, so an armed (d) OVER-PROVISIONS (7 mailboxes for a customer whose last ask was 2). Also the reconcile buy path lacks the count cap (`assertWithinProvisioningCap`). **DO NOT arm `PROVISIONING_RECONCILE_ENABLED`** until fixed — fix options in `ROADMAP.md ## Open`.
- **Still running (in-flight):** ONLY the 2-hourly Mordy cron (session-scoped — see Landmines). No builders/gates running; the C3 arc is complete.
- **Open decisions / blockers (all founder-gated):** (a) the C3 (d) arm-gate fix (before any arming); (b) the reply to Mordy's agent — BLOCKED on the owner-held prod `ADMIN_TOKEN` (no local copy), but part (b) now makes his retry a non-error regardless, so it's low-urgency; (c) direction-1 (STAGED after C3, founder ask); (d) mailbox W7.T5/T6 (separate project — see `~/dev/agent-mailbox/HANDOFF.md`).

## Landmines / gotchas
- **2-hourly Mordy-activity cron (job `cb9426a6`) is SESSION-SCOPED — it dies when this Claude session ends.** It checks the `support_tickets` D1 table + InboxKit workspace `c5188ced-33db-436f-b970-1860e6c8c66b` for new activity, state in `~/.claude/mordy-watch/last-seen.json`. Re-create it in the resuming session if still watching Mordy. (⚠️ `support_tickets` has NO `urgency` column — schema is `id/from_email/subject/body/tenant_id/category/draft/status/created_at/message_id/source/email_sent_at`.)
- **Mordy's live state as of last cron:** 2 purchased domains both DNS-pending, 0 mailboxes, `last_nameserver_check=null` (the vendor-contract capture the 08-10 item wanted — the vendor's checker genuinely never runs pre-mailbox). $30 booked domain spend, 0 mailboxes. His agent is HOLDING (asked us whether to retry same-key or reconcile first).
- **The P0 fix is ARMED but not yet APPLIED to Mordy's DO** — it applies on his DO's next construct (his next retry, OR the C3 (d) sweep touching his DO). No live proof it applied yet (no read path to live `domain_intents`).
- **Standing autonomy grant covers the C3 deploy** — merge/push/deploy is authorized on a clean gate. Browser-consent clicks are NOT.
- **caffeinate re-armed (pid ~37722, 4h)** to fight idle-sleep, but the sleeps this session were LID-CLOSE (caffeinate can't override) — long agents died mid-response and were resumed. Expect the same.

## Key files
- `apps/platform/src/engine/legacy-domain-intent-keys.ts` — the shipped P0 one-shot reconciliation.
- `apps/platform/src/engine/provision-intents.ts` — the intent-key derivations (setup + `replacementDomainIntentKey`).
- `apps/platform/src/engine/domain-dns.ts` — `SET_DNS_BACKOFF_MS` (the C3 timing defect) + the anti-parking comment.
- `docs/adversarial/intentfix-gate-2026-08-13.md` — frozen P0 gate SHIP verdict.
- `ROADMAP.md ## Open` — the P0 close-out + the C3/direction-1 [ASK] entries; `## Now` — active work.

## Resume — no result-bearing work pending; the C3 arc is COMPLETE. All next steps are founder-gated (KIND B)
Both live P0/C3 arcs shipped + deployed this session; there is NO in-flight builder/gate. Pick a founder-gated next step (none is auto-runnable):
1. **C3 (d) arm-gate fix (do this BEFORE ever arming `PROVISIONING_RECONCILE_ENABLED`):** fix gate Finding 1 — the direct-resume and reconcile paths disagree on persona/count for the same ordinal, so an armed (d) over-provisions; and add the count cap to the reconcile buy path. Options in `ROADMAP.md ## Open` 2026-08-13 [ASK]. Build → adversary gate → deploy under the standing grant. Only THEN is arming (d) a live founder decision.
2. **Reply to Mordy's agent (he's HOLDING):** BLOCKED on the owner-held prod `ADMIN_TOKEN` — run `security add-generic-password -a coldrig -s admin-token -U -w '<TOKEN>'` in a terminal, then the reply can send. Low-urgency now: C3 part (b) already makes his retry a non-error.
3. **direction-1** (resume-from-resource redesign) — founder-approved to STAGE after C3; scope it as its own wave (schema change, full gate). `ROADMAP.md ## Open`.
4. **Mailbox W7 tail** — separate project, `~/dev/agent-mailbox/HANDOFF.md` (T5 interactive check / T6 Mordy round-trip).

Prior HANDOFF (reconcile-sweep era): `archive/2026-08-13-p0-c3-mailbox/prior-HANDOFF.md`.
