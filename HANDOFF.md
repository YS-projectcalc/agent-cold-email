# ColdStart / coldrig — Handoff

Agent-operated cold-email platform. **LIVE, FIRST PAYING CUSTOMER Mordy (2026-07-28).** Site https://coldrig.dev · API https://api.coldrig.dev + https://agent-cold-email-api.yaakovscher.workers.dev · repo https://github.com/YS-projectcalc/agent-cold-email · Code: `~/dev/coldstart/`. **Standing autonomy (founder, 2026-07-22): merge/push/deploy/arm to customer-ready is authorized; browser-consent clicks excepted.**

> **You are resuming `coldrig` with zero prior context. Re-orient from `## Resume` below, then VERIFY its preconditions still hold** (deploy version, C3 build state, whether Mordy's agent retried). If they hold and the step is non-destructive, proceed. **STOP and confirm before any destructive/founder-owned step** — EXCEPT where the standing autonomy grant covers it (merge/push/deploy/arm).

## Where we are right now (2026-08-13)
**A live P0 was found, root-caused, fixed, gated, and DEPLOYED this session — and a follow-on (C3) is building.**

1. **🔥 P0 — SHIPPED + DEPLOYED + ARMED (Worker `d8055e22`).** Mordy's agent used the new `contact_operator` channel for the first time (ticket `sup_3ca260e4`, 2026-08-12) to report that his `setup_infrastructure` retry **MINTED + BOUGHT a second lookalike domain** (`theauthorpitchdesk.com`) instead of resuming the first — idempotency key not gating domain generation — and still failed at `step: "domain DNS setup"`. Root cause CONFIRMED: wave-3 commit `85f48af` changed the domain-intent key derivation with no backfill, orphaning Mordy's committed intent (`apd-setup-a-2mbx#0`), so resume never fired and `findAdoptableDomain` excludes any already-recorded domain — his paid domain was "too owned to adopt, not committed enough to resume." A structural second defect (C3, below) guarantees the retryable error that triggered the mint. Fix = dated one-shot constructor reconciliation (`engine/legacy-domain-intent-keys.ts`) rebinding the orphan to ordinal 1, zero new buys; excludes the deliverability `replace:` writer; + C1 literal-derivation guard + C4 previous-build-state fixture. Adversary gate SHIP 0-blocking, money invariant RED-proven ($15 mint reproduced then vanishes); frozen `docs/adversarial/intentfix-gate-2026-08-13.md`. Merged `main` `8a66976`, deployed, live-verified. **The fix ARMS on Mordy's DO's next touch** (the reconciliation runs in the `TenantDO` constructor) — his next retry rebinds + provisions with zero buys.
2. **C3 + direction-1 design pass DELIVERED, founder-ruled.** C3 (first-buy latency: every first domain buy ends in a customer-facing `retryable:true` because the ~2.3s in-call DNS wait can't outlast the vendor's ~32s registration — what made Mordy's agent feel the loop was broken) → **BUILD C3 NOW** (approved). Direction-1 (resume-from-resource root redesign) → **STAGE AFTER C3** (approved). Priorart `~/.claude/priorart-archive/coldrig-async-provisioning-and-resource-reconcile-2026-08-13.md`; both folded into `ROADMAP.md ## Open` 2026-08-13 [ASK].

## In flight / next
- **Still running (RESULT-BEARING — this is why the session must `/compact`, not `/clear`):** the **C3 builder** (subagent `coldrig-c3-builder`, working in worktree `~/dev/coldstart-wt-c3`, branch `feat/c3-provisioning-progress-2026-08-13`). Building: part (b) reclassify benign propagation-wait as a non-error (ships ARMED), part (d) out-of-band reconcile cron leg behind a flag `PROVISIONING_RECONCILE_ENABLED` (ships DARK). Uncommitted src edits in that lane as of handoff (5 files: ops-sweep, domain-dns, provision-intents, provisioning, env). **When it reports:** run its adversary gate → merge → deploy under the standing grant. ⚠️ **Arming the (d) reconcile-sweep auto-completes Mordy's 2 pending domains on a timer (SPENDS)** — treat arming as a separate deliberate step, not automatic on deploy.
- **Next action after C3 lands:** gate + merge + deploy C3 (see `## Resume`).
- **Open decisions / blockers:** the reply to Mordy's agent (he's HOLDING) is BLOCKED on the owner-held prod `ADMIN_TOKEN` (no local copy — `ROADMAP.md ## Open`). Once C3's reconcile-sweep is armed, it auto-completes him without any reply, making the token less urgent. Direction-1 staged (founder ask). Two design decisions in `ROADMAP.md ## Open` 2026-08-13 [ASK] (C3 contract change, direction-1 schema change).

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

## Resume — C3 build is in flight; gate+ship it when it lands (KIND B — deploy is founder-owned but standing-grant-covered)
1. **Check the C3 builder's state:** is `~/dev/coldstart-wt-c3` committed and has `coldrig-c3-builder` reported? If mid-work, let it finish (do NOT touch its worktree). If done: dispatch a fresh-context adversary gate on the C3 lane (correctness + customer-facing-contract + real-spend change — full ceremony, RED-prove the benign-vs-real-failure reclassification boundary, prove the `replace:` path is never touched, prove the flag OFF = dark).
2. **On gate SHIP:** merge the C3 lane `--no-ff` into `main`, build, deploy (`cd apps/platform && npx wrangler deploy`), live-verify `/status` both hosts. This is standing-grant-covered.
3. **DECISION at deploy (bring to founder):** whether to ARM `PROVISIONING_RECONCILE_ENABLED` — arming it auto-completes Mordy's 2 pending domains (SPENDS on his funded wallet). Recommend arming deliberately + watching the first sweep, not automatic.
4. **Then:** stage direction-1 (founder-approved to follow C3); the Mordy reply stays ADMIN_TOKEN-gated (or moots once (d) arms).

Prior HANDOFF (reconcile-sweep era): `archive/2026-08-13-p0-c3-mailbox/prior-HANDOFF.md`.
