---
name: ctx-clock-anchors-are-virtual-domain-forever
description: "⚠️ ColdStart: clock-migration shifts exactly SIX columns and is one-shot-already-ran, so every OTHER ctx.clock-stamped timestamp is virtual-domain forever — an age bound built on one is never crossed and the check SILENTLY never fires."
metadata:
  type: project
---

⚠️ **Any age bound built on a `ctx.clock`-stamped column that `clock-migration.ts` does not shift is
silently dead** for every tenant that lived on the demo/free VirtualClock (up to 1440× ahead of real
time) before upgrading. `now − anchor` goes NEGATIVE, the bound is never crossed, the check never
fires — no error, no alert, indistinguishable from a healthy tenant.

**The shift list is closed and short.** Reading every `UPDATE` in `apps/platform/src/engine/clock-migration.ts`,
the additive `+ delta` shifts are exactly six:
`scheduled_sends.send_at` · `scheduled_sends.sending_since` · `request_idempotency.created_at` ·
`domains.first_send_eligible_at` · `domains.dns_first_checked_at` · `domains.dns_gave_up_at`.
(The file's other UPDATEs are provider backfill, `released_at` marking, demo terminalization — not
time shifts.) **Everything else is virtual-domain**: `webhook_events.ts`, `domain_intents.updated_at`,
`mailbox_intents.updated_at`, `tenant_messages.created_at`, `deliverability_actions.ts`,
`domains.purchased_at` (which carries its own warning at `schema.ts:224-229`).

**The migration route is CLOSED — do not propose it.** `migrateTenantClockToReal` is one-shot per
tenant, guarded by `clock_mode != 'real'` and stamping `clock_mode='real'` on completion
(`clock-migration.ts:286`). It has already run for every paid tenant, so adding a column to it does
nothing for exactly the population that needs it.

**How to apply:**
- Read every age anchor as `MIN(anchorTs, new RealClock().now())`. Clamping UNDERSTATES age, which
  delays an alert and can never fire one early — correct direction for a founder-facing channel.
- Make it ONE helper (`clampedAge(anchorTs, realNow)`) plus a tripwire that no age computation
  subtracts a raw column value, so the rule cannot be half-applied. Per-site judgement is how this
  gets missed: it was missed twice in one design (first on `first_paid_at`, then again on
  `domain_intents.updated_at` after the first was fixed).
- Clamp even the six shifted columns. Uniformity beats correctness-per-site here, because the cost of
  a future reader re-deriving which columns are safe is another silent miss.
- The population that carries future-dated anchors — demo-era provisioning, then upgraded — is
  disproportionately the one with half-finished setups, i.e. exactly what these checks hunt.

Related: [[anchor-stamped-before-the-read-defeats-its-own-bound]] (the other way an age bound
self-defeats), [[coldstart-per-tick-recompute-clobbers-control-state]].
Design: `docs/research/customer-continuity-design-2026-08-18.md` §7.19.
