---
name: vendor-prepaid-wallet-exhaustion-reads-as-permanent
description: A vendor funded by a PREPAID CREDIT WALLET refuses money-out calls with a 4xx once the balance runs out; status-based grading maps that to retryable=false and the customer is told "retrying will not help" for a condition ONE operator top-up fixes.
metadata:
  type: project
---

Live incident 2026-08-18, tenant `ten_91aab24a…` (Mordy / theauthorpitchdesk.com): `startWarmup` on `mordytee12@` failed non-retryably at step "warmup enrollment" on every retry. Vendor read `GET /v1/api/billing/wallet` returned `total_credits:36, credits_used:35, credits_remaining:1, auto_topup_enabled:false`, while `GET /v1/api/warmup/pricing` prices the add-on at 3/mailbox. The wallet, not the code, was the wall.

**Why:** `mapInboxKitError` grades on HTTP status alone — 5xx/429 retryable, every other 4xx permanent (`apps/platform/src/vendors/real/inboxkit-errors.ts:24`). "Insufficient balance" is a 4xx, so a FUNDABLE, operator-recoverable condition is graded identically to "your input is invalid", and `provisioning.ts`'s non-retryable branch emits a `setup_failed` / severity `terminal` tenant message telling the agent to stop forever. Compounding it, `spendCostCents(env,'warmup')` returns **0** (`engine/spend-ceiling.ts`), so this money-out call reserves nothing and no spend guard can see it coming; and the whole ceiling models OUR dollar cost model, never the vendor's actual balance.

**How to apply:** any vendor with a prepaid wallet/credit balance needs (1) a periodic watchtower check on the vendor balance, (2) an error class distinct from "permanently rejected" — `retryable:false` but *operator-fundable*, so the message says "an operator must act, then your same-key retry completes" instead of "this will never complete", and (3) a non-zero reserve at every money-out choke point. Read-only balance probe: `GET https://api.inboxkit.com/v1/api/billing/wallet` (also live: `/billing/subscription`, `/warmup/pricing`, `/warmup/list`, `/mailboxes/list`, `/domains/list`). Related: [[fail-loud-throw-after-billed-vendor-call]], [[return-type-destroys-the-terminal-distinction]], [[vendor-200-with-error-true-reads-as-absent]].
