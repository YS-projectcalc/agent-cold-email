# ColdStart / coldrig — Handoff

Agent-operated cold-email platform. **LIVE + has its FIRST PAYING CUSTOMER (Mordy, 2026-07-28); registrar ARMED, awaiting his first provisioning.** Site https://coldrig.dev · API+dashboard https://agent-cold-email-api.yaakovscher.workers.dev (`/app`) · branded API https://api.coldrig.dev · npm `agent-cold-email@0.2.1` · MCP Registry 0.2.2 (25 tools) · repo https://github.com/YS-projectcalc/agent-cold-email · Code: `~/dev/coldstart/`

> **You are resuming coldrig with zero prior context. Re-orient from `## Resume` below, then VERIFY its preconditions still hold** (armed secret, latest deploy, whether Mordy has run setup yet). If they hold and the step is non-destructive, proceed — don't ask open-endedly what to work on. If anything CHANGED, surface exactly what and ask. **STOP and confirm before any destructive/irreversible/founder-owned step** — EXCEPT where the 2026-07-22 autonomy grant (merge/push/deploy/arm to customer-ready; browser-consent clicks excepted) covers it.

## Where we are right now (2026-07-29)

**🎉 First real customer, platform fully armed for his first send.** Mordy Tokayer paid 2026-07-28 17:06Z: tenant "Press Outreach" (`ten_91aab24a-43a8-45c1-bf43-af88ef633221`), Stripe sub `sub_1TyESe…` ACTIVE (platform×1 + mailbox×5), MORDYPILOT redeemed, invoice **$39.60** (Stripe-verified). ⚠️ `tenants_index.plan` still reads `demo` — that column is NEVER updated post-signup (by design; `db.ts` only writes `status`); read the tenant DO `/account` or Stripe for real plan/billing state.

**Shipped LIVE + ARMED across this milestone (all drained to `archive/ROADMAP-done.md` 2026-07-29):** (1) **Token prefix + rotation** — `cr_live_` mint (legacy `cs_test_` grandfathered), `POST /token/rotate` + Settings rotate card; adversary NO-SHIP→fix→SHIP (frozen `docs/adversarial/token-rotation-review-2026-07-28.md`), merged `b843963`. (2) **Registrar arming** — `REGISTRAR_PROVIDER` env leg + per-tenant `registerDomains` opt-in + structured `Registrant` capture (required-when-true; `registrant_json` column; `IncompleteRegistrantError`→400 naming fields, no PII); adversary NO-SHIP on B1 (domain port read one call stale) → fixed (setup re-selects the domain port from THIS call's validated input) → round-2 SHIP with 5 repros (frozen `docs/adversarial/registrar-arming-review-2026-07-28.md`), merged `c1e24a5`. Integration battery GREEN (typecheck clean all 5 workspaces; platform 1122/1122; dashboard 143/143, engine 126+4skip, cli 12/12), pushed `a68361c`. **Deployed + armed by founder 2026-07-29:** Worker `4a7bbf0d-299b-4db4-b949-0bf25e841209`, both hosts live, cron intact; `REGISTRAR_PROVIDER=inboxkit` confirmed present via `wrangler secret list` alongside `INBOXKIT_API_KEY`/`INBOXKIT_WORKSPACE_ID` (the arm is real, not sandbox). Post-arm checks: `/account`→401, `/checkout/success`→302, `/app`→307→200.

**CF-registrar wall — Q1 ROOT CAUSE FOUND 2026-07-29 (support ticket DROPPED).** Deep research (frozen in `docs/research/cf-registrar-domain-connect-2026-07-28.md`): the 400 `"domain is not allowed"` was OUR malformed request — InboxKit's blog guide documents a stale `{zone_id, domain, api_token}` shape; the real OpenAPI schema wants a `domains` **array** (or `connect_all`), no `zone_id`/singular-`domain`. Live-corroborated read-only via `GET /cloudflare-domains/zones` → 200 (docs source is genuine, not a WebFetch hallucination). No vendor support ticket needed. This unblocks a future **BYO-Cloudflare product path** (zone-scoped token, no NS change) — NOT on Mordy's path (he uses lookalikes); ledgered IDEA in `## Open`.

**Mordy site feedback shipped:** subdomain-vs-separate-domain mechanics (the burn/disposal argument) added to the deliverability guide's burn section, deployed + IndexNow-fired, committed `775b529`.

**Standing authorization (founder, verbatim):** *"Keep working autonomously. You have authorization to merge and push and deploy everything when done."* Arming executes autonomously (Keychain + SSH droplet + wrangler secrets); only browser-consent clicks return to the founder.

## In flight / next

- **No lanes in flight, no result-bearing background work.** All build/adversary/verifier/research agents this session completed (token-rotation, registrar-arming + registrant-gap, integration-verifier, cf-connect research). Three sibling worktrees (`agent-a2cb852d…`, `agent-ae2d6f14…`, `agent-a25bfeea…`) hold only already-merged commits — reap candidates, not active work.
- **2026-07-29 update: go message SENT (founder confirmed), Mordy not yet provisioned** (InboxKit workspace: 0 mailboxes, 1 unassigned domain = stray dmhadvisor zone). Live-watch armed in-session (persistent monitor polling InboxKit workspace domain/mailbox counts every 60s). Fast-Start arc: founder said HOLD 07-29 despite standing authorization — re-confirm before starting. CF token NOT yet revoked as of 07-29 — cleanup race vs Mordy's first provisioning is live (see Landmines).
- **Next action (was founder-owned; go message now sent — see `## Resume`):** Mordy's agent runs `setup_infrastructure` **twice** (`{primaryDomain:"authorpitchdesk.com", domains:1, inboxesEach:3, registerDomains:true, registrant:{…}}` then `{…, inboxesEach:2, registerDomains:true, registrant:{…}}`) = 2 domains × (3+2) mailboxes, all 5 paid seats, bill stays $39.60. `registerDomains:true` + full `registrant` required on EACH call (see Landmines).
- **Watch live once he runs them:** first real domain buy + mailbox provisioning + fleet-mint OAuth attempt (first live test; 10-min manual grant is the fallback) → first-live warmup-ramp watch. Known watch item: double-buy saga risk on downstream throw + retry (`ROADMAP.md ## Open` 2026-07-29, spend-ceiling-bounded, proper home = the B2 async-saga arc).
- **Founder click queue (none block Mordy):** revoke the CF token (Keychain `cf-dns-dmhadvisor`) → then Claude clears the Keychain entry + the stray InboxKit CF credential/`dmhadvisor` zone from workspace `c5188ced…` → G2/Capterra listing packs (`docs/research/review-site-listing-packs-2026-07-27.md`, paste-ready; AlternativeTo has a 1-week account-age gate started 2026-07-27) → `listings@coldrig.dev` routing rule → PulseMCP word → uptime-prober. **DONE this session:** Stripe receipts toggle, Glama manual description edit.
- **Open decisions / blockers (ledgered `ROADMAP.md ## Open`, none block Mordy):** unit-economics + build-our-own-infra study ([ASK], NOT started) · Fast-Start prewarmed SKU ([ORDER], founder-authorized for next-session background orchestration) · agency-bundle billing · owner spend-ceiling wiring + billing self-serve actions · BYO-Cloudflare connect path (IDEA, schema known, live end-to-end test pending) · stray InboxKit CF credential + workspace-isolation question ([ASK]) · metric hygiene (63 `tenants_index` rows = 62 internal + 1 real signup).

## Landmines / gotchas

- **Live money is real.** Worker runs LIVE Stripe keys — NEVER complete a live checkout in testing. `MORDYPILOT` redeemed (single-use, inactive). Never print Keychain values (`security find-generic-password -a coldrig -s <service> -w`).
- **`tenants_index.plan` is a signup snapshot, NEVER updated** — payment-detection must read the DO `/account` or Stripe, never that column.
- **`tenants_index` row count ≠ signups** — 63 rows (2026-07-29), 62 internal test/QA, only 1 real (Mordy). Filter known-internal patterns (`yaakovscher+*`, `@example.com`, `Burst*`, `*Test*`, verify/probe/smoke) before any business metric.
- **`registerDomains` + `registrant` must ride EVERY `setup_infrastructure` call that uses the registrar** — omitting either on a later call resets the tenant's opt-in to 0 (safe direction: 503, zero buys — but surprising). Every registrar-using call needs the full registrant object, not just the first.
- **CF-connect real schema = `{auth_type, api_token, domains:[…]}` (array) or `connect_all:true`** — NOT the blog guide's `{zone_id, domain, api_token}` (stale). Two-step dashboard flow = connect(save-credential) → `GET /zones` → connect(domains). Wire this when building the BYO-CF path.
- **Stray InboxKit CF credential + zone** — the founder's zone-scoped CF token is stored server-side at InboxKit (from the 07-28 UI connect); `dmhadvisor.com` zone is `scheduled_for_deletion` but the credential persists. Revoking the CF token invalidates it; clear both from workspace `c5188ced…` before Mordy provisions. Whether all tenants share ONE InboxKit workspace vs one-per-tenant is an open isolation question (`## Open`).
- **Registrar arming is DECOUPLED from mailbox arming by design** (`apps/platform/src/vendors/factory.ts`) — `RegistrarUnarmedDomainPort` throws until BOTH `REGISTRAR_PROVIDER` env AND the tenant `registerDomains` opt-in present. Do not collapse them.
- **`wrangler.toml` `routes` implicitly disables workers.dev** unless `workers_dev=true` is explicit — took prod down ~3 min on 07-28. Both hosts must stay live.
- **Pre-send intent log is `[dark-unarmed]`** — merged `608c80a`, engine-side, NOT armed; don't treat the double-send residual as closed until arming is verified live. `ACTIVATION.md` Gate-2 residual (1) line is STALE ("uncommitted") — fix on next doc-touch.
- **SDN "unchanged" fix** (weekend false-alarm): byte-identical re-push is `ok:true reason:"unchanged"` 200 and advances `fetched_at`; a >10% entry-count drop is still `stale`/422. Never hand-load bypassing `swapInSdnList`.
- **Glama API stale at "~12 tools"** independent of our surfaces (confirmed 25) — DONE this session (founder ran the manual description edit).
- **promotion_codes API:** pin `Stripe-Version: 2024-06-20`.
- **Site deploys whatever is on disk;** Worker before site when counts/claims change; IndexNow fires post-site-deploy.
- **dmhadvisor.com probe residue:** its mail DNS + kwong root CNAME were deleted; pre-probe DNS snapshot for restore at `archive/2026-07-28-mordy-golive-wave/scratch-rescue/dmhadvisor-dns-snapshot-pre-probe.json`.
- **Committed + pushed at handoff:** all this-session work is committed and pushed (`origin/main` at `8df8391` before this handoff's commit; this handoff's ROADMAP/HANDOFF/archive commit is the last one). No uncommitted source in the tree.

## Key files

- `apps/platform/src/vendors/factory.ts` — adapter arming decisions (sandbox/real/unarmed); registrar-decouple comment block.
- `apps/platform/src/vendors/registrar-arming.ts` — registrar arming + registrant derivation/validation (new this milestone).
- `apps/platform/src/routes/token-rotate.ts` — `POST /token/rotate` (new this milestone).
- `apps/platform/src/engine/warmup.ts` — the ramp engine (Mordy's mailboxes = first live run).
- `apps/platform/src/routes/checkout.ts` — checkout + success/cancel return routes.
- `docs/research/cf-registrar-domain-connect-2026-07-28.md` — CF-connect research; Q1 root cause + corrected schema.
- `docs/research/warmup-posture-2026-07-28.md` — ramp-only default + warmup-network honest-add-on verdict; ramp numbers.
- `docs/research/review-site-listing-packs-2026-07-27.md` — paste-ready G2/Capterra/AlternativeTo packs.
- `docs/adversarial/{registrar-arming,token-rotation}-review-2026-07-28.md` — frozen adversary verdicts for this milestone's two lanes.
- `ROADMAP.md ## Now` / `## Open` — live ledger (drained clean 2026-07-29); `archive/ROADMAP-done.md` — completed-item history.

## Resume — founder sends Mordy's go message, then watch first provisioning live (verify armed-state first)

**KIND B — the immediate next step is founder-owned (send Mordy the go message), then a live-watch, not a build.** First verify the armed state still holds: `cd ~/dev/coldstart/apps/platform && npx wrangler secret list` should list `REGISTRAR_PROVIDER`; `npx wrangler deployments list` should show `4a7bbf0d…` (or later) as latest. If both hold, proceed:

1. **If the founder hasn't sent Mordy's go message yet:** nothing to watch — the registrar is merged, deployed, and armed. No build unblocks him; the ball is in the founder's court (send the go message) then Mordy's agent's.
2. **Once Mordy's agent runs its two `setup_infrastructure` calls:** watch the first real domain buy + mailbox provisioning + fleet-mint OAuth attempt live. Watch for the double-buy saga risk (`ROADMAP.md ## Open` 2026-07-29) — a downstream throw + agent retry could re-buy a domain; spend-ceiling-bounded but real money.
3. **After his first send lands:** verify the warmup ramp engine enforces daily caps at the boundary (first-live proof, `ROADMAP.md ## Now` warmup entry; ramp numbers in `docs/research/warmup-posture-2026-07-28.md`).
4. **Founder cleanup (do when the founder confirms the CF token is revoked):** clear the Keychain entry `cf-dns-dmhadvisor` and remove the stray InboxKit CF credential + `dmhadvisor` zone from workspace `c5188ced…` (see Landmines).
5. **Next session, background-orchestrate the Fast-Start prewarmed SKU arc** (founder-authorized 2026-07-28: pricing design → adapter prewarm methods → inventory-adoption path → claims copy, adversary-gated per lane) while awaiting Mordy — don't let it block watching his provisioning.

Do NOT push past founder-owned clicks (CF token revoke, G2/Capterra, listings@ rule, PulseMCP, uptime-prober — see `## In flight / next`) without the founder doing them. Prior HANDOFF: `archive/2026-07-29-cf-connect-crack/prior-HANDOFF.md`.
