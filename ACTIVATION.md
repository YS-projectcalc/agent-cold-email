# ColdStart — ACTIVATION (owner-hands checklist)

> The single list of steps that need Yaakov's identity, card, or a human decision — the only things NOT done autonomously. Everything else ships in test mode. Work top-to-bottom to go live. Each item says WHY it can't be automated and WHAT's already wired waiting for it.
> Status maintained through the build; grouped by go-live phase. Nothing here is a blocker to the test-mode product being complete.

## Gate 0 — Decisions only you can make
- [x] **Pick the brand name** — **DECIDED 2026-07-12 (verbal, in-session): brand word = coldrig.** Founder registered `coldrig.dev` on Cloudflare the same day. Adversarial review (`docs/adversarial/name-review-2026-07-12.md`): the pure-keyword brand candidate "agentcoldemail" is **NO-SHIP** (untrademarkable, uncitable, spam-optics, double lock-in). Structure stays as shipped — distinct display brand **Coldrig** + the permanent `agent-cold-email` keyword slug on every discovery surface, never collapsed into one. Availability at decision time (RDAP, 2026-07-12): `coldrig.com` registered/parked; `.net`/`.tech`/`.io`/`.sh` all available. REMAINING OWNER ACTION: attorney trademark clearance on "coldrig" — public display-brand rollout (site header, server-card display name, Stripe entity naming) is deliberately held until clearance; domain + infrastructure wiring may proceed now. Gate 0 is fully closed (all three items decided).
- [x] **Resale legal model** (SPEC §13 gate) — **DECIDED 2026-07-12 (verbal, in-session):** start with (b) **Mailforge** as the activation-time real mailbox vendor (only vendor whose ToS explicitly permits reselling; accept shared-IP isolation), while pursuing (a) an **Inboxkit enterprise/reseller agreement** in parallel; (c) **management-service** structure (customer is the account principal) — **APPROVED 2026-07-12 (verbal, in-session: "that dedicated tier makes sense")** as an ADDITIONAL premium "Dedicated" tier alongside the Mailforge-backed Standard tier; sequenced as fast-follow, not launch-day (build prerequisite: per-tenant vendor credentials in the `VendorPort` facade). Positioning rationale: ROADMAP session log 2026-07-12 "Two conversation-level design conclusions". The `VendorPort` facade makes any of these a config swap, not a rebuild.
- [x] **Pricing sign-off** — **DECIDED 2026-07-12 (verbal, in-session): tiers SIGNED OFF unchanged** (Launch $99 / Growth $299 / Scale $799, quotas per `packages/shared/src/pricing.ts`) on the ramp-only COGS basis (~$4.50–5.00/mbx all-in, clearing ~2.6–3.3× — `docs/research/warmforge-bundle-verification-2026-07-12.md`). Signed off TOGETHER WITH the **deferred-paywall onboarding model**: the free no-card sandbox setup stage is the marketed onboarding path (not a "demo") — the payment gate sits at the go-live `/checkout` moment only. Full flow live-verified against the deployed API on 2026-07-12 (no-card signup → setup on demo plan → checkout simulate → same tenant flips to launch with pre-payment state intact; junk tenant `ten_d1707c7c-69f3-4704-8b88-8b8f134981b0`). Competitive-landscape + COGS research: `docs/research/pricing-landscape-2026-07-12.md` and `docs/research/vendor-costs-mailforge-inboxkit-2026-07-12.md`.

## Gate 1 — Prove the real pipe ($ + identity; do BEFORE onboarding any paying customer)
- [ ] **Real-world deliverability smoke test** (the deferred SPEC §11 Phase-0 spike): buy 1 real domain → set DNS (SPF/DKIM/DMARC/rDNS) → provision 2 real mailboxes → send 1 email → confirm inbox placement → detect the reply. This is the one thing sandbox cannot prove. Everything is built to run it; it needs a card + a live mailbox.
- [ ] **Vendor free-API-key signup + fixture capture** — get free API keys (Mailforge — chosen start; Inboxkit — pending reseller deal — plus Porkbun/Namecheap), run the read-only real-contract capture, and re-seed the `VendorPort` contract-test fixtures from real responses (replaces the doc-derived sandbox fixtures). Confirms the real adapters match reality before the swap.
- [ ] **Written resale-permission confirmation** from the chosen mailbox vendor + the exact per-tenant isolation boundary (separate Google/M365 org per customer vs shared) — settles SPEC §7's isolation claim.
- [x] **Salesforge→Warmforge bundle — DESK-RESOLVED 2026-07-12: BUNDLE LIMITED, do not build pricing on it** (`docs/research/warmforge-bundle-verification-2026-07-12.md`): ToS reserves a 99-connected-accounts-per-workspace warmup cap, and Salesforge's own Whitelabel FAQ excludes Warmforge from the reseller option outright. Pricing basis switches to the **ramp-only warmup model** (~$4.50–5.00/mbx all-in, clears 2.5×+ — math in the frozen record). OPTIONAL remaining owner step: send the drafted 3-question support inquiry (in the same record) to chase the warm-only-connection upside — upside only, not a blocker.
- [ ] **Confirm Mailforge API availability/limits with their support before relying on it** — their pricing page omits API from included features while their ToS presupposes it exists.

## Gate 2 — Live keys & accounts (identity/KYC-gated)
- [ ] **Stripe live KYC** — swap test keys for live; the billing/metering/dunning/dispute lanes are built against the real Stripe API in test mode, so this is a key swap + business verification.
- [ ] **Set `STRIPE_WEBHOOK_SECRET`** (wrangler secret) — the `/webhooks/stripe` endpoint now **fails closed (503) until this is set** (a panel #3 security fix: without it, unsigned events could forge any tenant's plan/billing). Setting it enables the real webhook lane. Set the matching endpoint secret in the Stripe dashboard.
- [ ] **Mailbox vendor account + card** (Mailforge — chosen start / Inboxkit — pending reseller deal) — real `MailboxPort` adapter is coded, throws `NotActivatedError` until wired.
- [ ] **Registrar account + card** — Namecheap (confirmed buy-domain API) or Porkbun (confirm purchase endpoint w/ support); real `DomainPort` adapter coded, unactivated.
- [ ] ⛔ **Go-engine host — DO NOT PROVISION YET: the engine is NO-SHIP** (double-send race, `docs/adversarial/engine-host-review-2026-07-14.md`; fix + clean re-attack first). Runbook below is otherwise ready. **Go-engine host** — stand up the email engine (24/7 SMTP/IMAP daemon) and wire the Worker↔engine boundary. This is the real `EmailPort`. **BUILT + verified 2026-07-14** (`apps/engine/`, Node service reusing the A5-validated nodemailer/imapflow/mailparser stack; Worker client `apps/platform/src/vendors/real/email-port.ts`). Ships dark: `RealEmailPort` throws `NotActivatedError` until BOTH env vars below are set. Runbook (owner-hands, ~20 min):

  1. **Build the image (host):** `npm run build -w @coldstart/engine && docker build -t coldstart-engine apps/engine`
  2. **Generate the shared secret (once):** `SECRET=$(openssl rand -hex 24)` — the SAME value goes to both the droplet and the Worker.
  3. **Provision the droplet (doctl — account authed):**
     ```
     doctl compute droplet create coldstart-engine --region nyc1 --size s-1vcpu-1gb \
       --image docker-20-04 --ssh-keys "$(doctl compute ssh-key list --format ID --no-header | head -1)" --wait
     IP=$(doctl compute droplet get coldstart-engine --template '{{.PublicIPv4}}')
     ```
     *Size:* `s-1vcpu-1gb` (~$6/mo). Node 24 baseline (~60–90 MB) + a handful of concurrent imapflow IMAP connections fit 1 GB with headroom; the 512 MB/$4 tier risks OOM under concurrent polls. 1 vCPU is ample for one pilot tenant's few mailboxes. (Cloudflare Containers is the alternative but is a worse fit for a single always-on long-lived-connection daemon — revisit only if multi-region/autoscale is needed.)
  4. **Lock inbound (DO Cloud Firewall):** allow SSH (22) + the engine port (8080) only. Tighten 8080 to your IP for the smoke test if possible.
  5. **Write the mailbox creds file** on the droplet (`/root/mailboxes.json`) — the `{ email → { smtp, imap } }` map from `apps/engine/.env.example` (BYO Google Workspace = app password + `smtp.gmail.com:465` / `imap.gmail.com:993`). Ship the image + run:
     ```
     docker save coldstart-engine | ssh root@$IP docker load
     ssh root@$IP docker run -d --name engine --restart unless-stopped -p 8080:8080 \
       -e ENGINE_AUTH_SECRET="$SECRET" -e MAILBOX_CREDENTIALS_FILE=/run/mailboxes.json \
       -v /root/mailboxes.json:/run/mailboxes.json:ro -v engine-state:/app/state coldstart-engine
     ```
  6. **Set the Worker secrets** (in `apps/platform`): `# ⚠️ NEVER a plain http:// URL — the client rejects it as a PERMANENT error and every due send goes terminal 'failed' with no requeue path. Use an https tunnel (Cloudflare Tunnel) or localhost ONLY.
   echo "https://<tunnel-host>" | wrangler secret put ENGINE_BASE_URL` and `echo "$SECRET" | wrangler secret put ENGINE_AUTH_SECRET`.
  7. **Smoke test** (proves one real send/receive once a real mailbox is in the creds file):
     ```
     curl http://$IP:8080/health                                  # -> {"status":"ok",...}
     curl -H "Authorization: Bearer $SECRET" -X POST http://$IP:8080/v1/send \
       -d '{"input":{"fromEmail":"<box>","toEmail":"<you>","subject":"coldrig smoke","body":"hi","threadId":"smoke1","inReplyToMessageId":null},"idempotencyKey":"smoke1"}'
     # confirm inbox placement at <you>; reply from <you>, then:
     curl -H "Authorization: Bearer $SECRET" -X POST http://$IP:8080/v1/poll -d '{"mailboxEmail":"<box>","sinceCursor":0}'
     # expect a reply event carrying threadId "smoke1" + a cursor to store for the next poll
     ```

  ⚠️ **`http://IP:8080` sends the bearer secret in cleartext** — acceptable only for a firewall-locked bootstrap smoke test. BEFORE any real tenant traffic, front the engine with HTTPS (Cloudflare Tunnel: `cloudflared` on the droplet → a hostname on the CF account), set `ENGINE_BASE_URL` to the `https://` tunnel URL, and drop the public 8080 firewall rule.
  ⚠️ **Steps 1–7 prove the ENGINE end-to-end, but do NOT by themselves route a live TENANT send through it** — the adapter factory still hands every tenant `sandbox` (`realAdaptersActivated` is hard-`false`). Flipping a tenant onto the real EmailPort while keeping sandbox billing/domain/mailbox (the comped-pilot shape) needs the per-port activation decision — see the engine session log in ROADMAP.md.
- [x] **Stale-'pending' idempotency-claim reclaim** (recorded 2026-07-12, engine increment `d342cd0`) — `withRequestIdempotency`'s claim-then-execute leaves a PERMANENT 'pending' row if a DO dies mid-`fn` (eviction removes 'done' rows only), which then 409s every retry of that key. Unreachable with sandbox adapters (no real I/O across a crash); MUST add a TTL-bounded stale-claim reclaim before wiring real vendor adapters. **DONE 2026-07-14** — commit `6152b47`: 10-min TTL-bounded reclaim (`REQUEST_IDEMPOTENCY_PENDING_CLAIM_TTL_MS`), 3 new tests incl. concurrent-race atomicity, revert-fail proven (2 tests fail on old code), platform suite 242/242. See `apps/platform/src/engine/idempotency.ts` liveness note.

## Gate 3 — Distribution surfaces that need your login
- [x] **npm publish** `agent-cold-email` — DONE 2026-07-14 (Yaakov, 2FA): `agent-cold-email@0.1.0` LIVE; verified `npm view` + `npx agent-cold-email --help`. ORIGINAL NOTE: — CLI is built + repo-hosted; needs `npm login` (npm NOT authed on this machine). This is the surface agents install from — high priority.
- [ ] **GitHub org** — create the `agent-cold-email` (or brand) org and transfer the repo from YS-projectcalc (keep the old namespace to preserve the 301 redirect). Repo already public + AEO-optimized under YS-projectcalc.
- [x] **Custom domain** — DONE 2026-07-14: coldrig.dev attached to Pages, host-swap deployed + verified live. ORIGINAL NOTE: — point the brand domain at the Cloudflare Pages site + set the MCP/API on a branded host; update `server-card.json` + OpenAPI `servers`.
- [x] **MCP registry submissions** — official MCP Registry DONE 2026-07-14 (`io.github.YS-projectcalc/agent-cold-email` v0.1.0). REMAINING (blocked, need Yaakov's hands — see ROADMAP): mcp.so + cursor.directory (OAuth walls), llmstxt directories (scripts rescued + ready). ORIGINAL NOTE: — Smithery / mcp.so / PulseMCP (some are form/login-gated); `.well-known/mcp/server-card.json` is served so scans are clean.
- [x] **Awesome-list PRs** — awesome-mcp-servers PR #10106 OPEN 2026-07-14. ORIGINAL NOTE: — submit to awesome-mcp-servers / relevant lists under the org identity (outward PRs = your identity).

## Gate 4 — Legal & ops arming
- [ ] **Attorney review** of ToS / Privacy / AUP (built to the specified clause inventory, DRAFT-flagged) before real customers.
- [ ] **Fill the CAN-SPAM mailing address** — replace `[EpiphanyMade mailing address — inserted at activation]` in `site/terms.html` §13 and `site/privacy.html` §12 (2 occurrences) before attorney sign-off / any real waitlist send.
- [ ] **Arm email routing** for support@ + reply ingestion (Cloudflare Email Routing / vendor IMAP) — AI support triage lane is built, disarmed.
- [ ] **Arm scheduled ops** — deliverability loop, dunning sweep, metrics digest crons (built, disabled in test mode).
- [ ] **OFAC screening provider** key (if using a paid list) — screening hook is built; wire the data source.

## Cron watchdog note (session-scoped)
The autonomous build watchdog cron (`baf7d82d`, every 3h) is **session-only and auto-expires after 7 days** — it does not survive a machine restart. Not part of the product; just keeps this build session resilient to usage-limit interruptions.
