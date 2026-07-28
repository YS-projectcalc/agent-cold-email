# ColdStart / coldrig — Handoff

Agent-operated cold-email platform. **LIVE + has its FIRST PAYING CUSTOMER (Mordy, 2026-07-28).** Site https://coldrig.dev · API+dashboard https://agent-cold-email-api.yaakovscher.workers.dev (`/app`) · branded API https://api.coldrig.dev (new 2026-07-28) · npm `agent-cold-email@0.2.1` (published 2026-07-28) · MCP Registry 0.2.2 (25 tools) · repo https://github.com/YS-projectcalc/agent-cold-email · Code: `~/dev/coldstart/`

> **You are resuming coldrig with zero prior context. Re-orient from `## Resume` below, then VERIFY its preconditions still hold** (lane states, git SHAs, live URLs). If they hold and the step is non-destructive, proceed — don't ask open-endedly what to work on. If anything CHANGED, surface exactly what and ask. **STOP and confirm before any destructive/irreversible/founder-owned step** — EXCEPT where the 2026-07-22 autonomy grant (merge/push/deploy/arm to customer-ready; browser-consent clicks excepted) covers it.

## Where we are right now (2026-07-28 evening — MORDY PAID, provisioning-arming lane in flight)

**🎉 First real customer.** Mordy Tokayer paid 17:06Z: tenant "Press Outreach" (`ten_91aab24a-43a8-45c1-bf43-af88ef633221`), Stripe sub `sub_1TyESe…` ACTIVE (platform×1 + mailbox×5), MORDYPILOT redeemed, invoice amount **$39.60** (Stripe-verified). ⚠️ **`tenants_index.plan` still reads `demo` — that column is NEVER updated post-signup by design (db.ts only writes `status`); read the tenant DO `/account` or Stripe for real plan/billing state.** He is in sandbox and CANNOT send yet — his mailboxes don't exist until the registrar-arming lane deploys and his agent runs setup (see `## Resume`).

**Shipped THIS session (all pushed):** Stripe success/cancel redirect routes (were unrouted → 404 JSON, first customer hit it; now 302 → /app/billing; Worker `860542ea`) · branded `api.coldrig.dev` host (Worker `f94139e1`; workers.dev kept via explicit `workers_dev=true`) · byo-domain subdomain-burn copy (Mordy-contributed) · npm `0.2.1` published (kills the waitlist line). Prior wave (07-27/28, five lanes: SDN weekend-fix, intent-log dark, CLI fix, go-live UX, claims-truth) fully documented in `ROADMAP.md ## Now`.

**Standing authorization (founder, verbatim):** *"Keep working autonomously. You have authorization to merge and push and deploy everything when done."* Arming executes autonomously (Keychain + SSH droplet + wrangler secrets); only browser-consent clicks return to the founder.

## In flight / next

- **Still running (result-bearing — do NOT `/clear`):**
  - **Registrar-arming build lane** — worktree `.claude/worktrees/agent-ae2d6f14e41fd6a02`, task `ae2d6f14e41fd6a02` (output under this session's `tasks/`). Wires `REGISTRAR_PROVIDER=inboxkit` + a per-tenant `registerDomains` opt-in in `SetupInfrastructureInput` so InboxKit-as-registrar arms WITHOUT auto-arming (key regression test: mailbox-armed-but-no-opt-in still throws `RegistrarUnarmedError`). On completion: adversary-gate → merge → deploy → `wrangler secret put REGISTRAR_PROVIDER`. **This is Mordy's critical-path blocker.**
  - **Token prefix + rotation lane** — worktree `.claude/worktrees/agent-a2cb852d0853de94a`, DONE (report in), adversary-gate PENDING. `cr_live_` mint (legacy `cs_test_` grandfathered, hash lookup prefix-blind) + `POST /token/rotate` (session+CSRF and bearer) + Settings "Rotate API token" card. Both found live by Mordy's agent. Platform suite 1101/1101, RED/GREEN proven → adversary → merge → deploy.
  - **Warmup-posture research lane** — agent `research-warmup-posture` (Sonnet). Answers "who generates not-spam/reply signals in ramp-only vs warmup-networks vs prewarmed" + the ramp schedule numbers. Feeds the Fast-Start SKU design + Mordy's warmup decision.
- **Next action after the arming lane merges + deploys:** hand Mordy's agent the two-call setup — `setup_infrastructure {primaryDomain:"authorpitchdesk.com", domains:1, inboxesEach:3, registerDomains:true}` then `{..., domains:1, inboxesEach:2, registerDomains:true}` = 2 domains × (3+2) mailboxes, all 5 paid seats, bill stays $39.60. Then the fleet-mint OAuth verify (his mailboxes are its FIRST live test; 10-min manual grant is the fallback) → first-live warmup-ramp watch.
- **Founder click queue (unchanged in kind):** Stripe receipts toggle (Settings → Customer emails → "Successful payments") → Glama manual description edit (Glama's API still serves "~12 tools"; paste text in Landmines) → send Mordy his messages → G2/Capterra listing packs (`docs/research/review-site-listing-packs-2026-07-27.md`, 25-gate cleared) → `listings@coldrig.dev` routing rule → PulseMCP word → InboxKit UI connect attempt (moot for Mordy) → uptime-prober.
- **Open decisions / blockers (ledgered `ROADMAP.md`, none block the arming lane):** unit-economics + build-our-own-infra study ([ASK], NOT started) · Fast-Start prewarmed SKU (authorized for next-session background orchestration) · agency-bundle billing · owner spend-ceiling wiring + billing self-serve actions (both flagged by Mordy's agent).

## Landmines / gotchas

- **Live money is real.** Worker runs LIVE Stripe keys — NEVER complete a live checkout in testing. `MORDYPILOT` already redeemed (single-use, now inactive). Never print Keychain values (`security find-generic-password -a coldrig -s <service> -w`).
- **`tenants_index.plan` is a signup snapshot, NEVER updated** — three payment-detection watches this session built polled it and were blind. Read the DO `/account` or Stripe.
- **`wrangler.toml` `routes` implicitly disables workers.dev** unless `workers_dev=true` is explicit — this took prod down ~3 min on 07-28 (Stripe webhook + every customer MCP config point at workers.dev). Both hosts must stay live: api.coldrig.dev + workers.dev.
- **Registrar arming is DECOUPLED from mailbox arming by design** (`apps/platform/src/vendors/factory.ts` comment ~L56-67) — the arming lane must preserve it: `RegistrarUnarmedDomainPort` throws until BOTH `REGISTRAR_PROVIDER` env AND the tenant `registerDomains` opt-in are present. Do not collapse them.
- **Pre-send intent log is `[dark-unarmed]`** — merged `608c80a`, engine-side, NOT armed; don't treat the double-send residual as closed until arming is verified live. `ACTIVATION.md` Gate-2 residual (1) line is STALE ("uncommitted") — fix on next doc-touch.
- **SDN "unchanged" fix** (weekend false-alarm): a byte-identical re-push is `ok:true reason:"unchanged"` 200 and advances `fetched_at` (so the 5-min direct-refresh cron doesn't 525-storm); a >10% entry-count drop is still `stale`/422. Never hand-load bypassing `swapInSdnList`.
- **Glama API stale at "~12 tools"** independent of our surfaces (confirmed 25) — needs a manual Glama dashboard description edit, NOT a rebuild. Paste: *"Agent-run cold-email infrastructure: 25 MCP/HTTP tools for domains, mailboxes, warmup, campaigns, and replies behind one bearer token. Free self-serve sandbox, no card required. Real sending is live in production. $99/month all-in for 5 mailboxes (+$10/mailbox after) bundles mailbox seats, domains, warmup, and compliance infrastructure, $0 per-send fees. No inbox-placement, deliverability, or reply-rate guarantees, ever."*
- **promotion_codes API:** pin `Stripe-Version: 2024-06-20`.
- **Site deploys whatever is on disk;** Worker before site when counts/claims change; IndexNow fires post-site-deploy.
- **dmhadvisor.com probe residue:** its mail DNS + kwong root CNAME were deleted and its InboxKit workspace entity removed; full pre-probe DNS snapshot for restore at `archive/2026-07-28-mordy-golive-wave/scratch-rescue/dmhadvisor-dns-snapshot-pre-probe.json`.
- **Uncommitted at handoff:** `ROADMAP.md` + `HANDOFF.md` (this pass's edits) staged for the Phase-6 commit; the two build-lane worktrees hold uncommitted work (their own trees) pending adversary+merge. UNVERIFIED: origin-sync state after the last push (main was in sync at the `fcb233e` push; the ROADMAP/HANDOFF commit here is NOT yet pushed — push is founder/main-loop cadence).

## Key files

- `apps/platform/src/vendors/factory.ts` — adapter arming decisions (sandbox/real/unarmed); the registrar-decouple comment block.
- `apps/platform/src/engine/warmup.ts` — the ramp engine (Mordy's mailboxes = first live run).
- `apps/platform/src/routes/checkout.ts` — checkout + the new success/cancel return routes.
- `docs/research/cf-registrar-domain-connect-2026-07-28.md` — domain-connect wall research + support ticket.
- `docs/research/review-site-listing-packs-2026-07-27.md` — paste-ready G2/Capterra/AlternativeTo packs.
- `ROADMAP.md ## Now` — the live ledger; `## Open` — everything outstanding; `archive/2026-07-28-mordy-golive-wave/` — this session's scratch + prior HANDOFF.

## Resume — the next action is gated on the in-flight registrar-arming lane (verify its state first)

**KIND B — the immediate next step is an in-flight lane + a founder-owned deploy/arm.** First check whether the registrar-arming lane (`.claude/worktrees/agent-ae2d6f14e41fd6a02`, task `ae2d6f14e41fd6a02`) has finished — read its task output / `git -C ~/dev/coldstart worktree list`. Then:

1. **If the lane is still running:** wait; nothing to hand Mordy until it deploys. Meanwhile you MAY adversary-gate + merge the token-rotation lane (`agent-a2cb852d0853de94a`): after a fresh-context adversary SHIP, merge and deploy the Worker.
2. **If the arming lane is DONE (report in its worktree):** dispatch a fresh-context adversary (attack the decouple guard + the domain-spend-ceiling metering + contact-detail sourcing). On SHIP → merge → run the full battery from `~/dev/coldstart` (`npm run typecheck && npm test`, both green) → deploy the Worker (`cd apps/platform && npm run deploy`) → **arm** `echo -n inboxkit | npx wrangler secret put REGISTRAR_PROVIDER` (autonomy grant covers this; verify a test tenant's `/account` still resolves after).
3. **Then unblock Mordy:** hand his agent the two-call `setup_infrastructure` shape above (2 domains × 3+2 mailboxes, `registerDomains:true`), and watch the first real provisioning + fleet-mint OAuth attempt live.

Do NOT push past the deploy/arm without a green battery. The 2026-07-22 autonomy grant covers merge/deploy/arm; a genuinely new scope (self-hosted-infra build, Fast-Start SKU build) needs a fresh founder ask. Prior HANDOFF: `archive/2026-07-28-mordy-golive-wave/prior-HANDOFF.md`.
