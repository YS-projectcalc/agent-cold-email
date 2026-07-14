# ColdStart / coldrig — Handoff

Agent-operated cold-email platform. **LIVE (test mode):** site https://coldrig.dev · API + dashboard https://agent-cold-email-api.yaakovscher.workers.dev (`/app`) · npm `agent-cold-email@0.1.0` · MCP Registry `io.github.YS-projectcalc/agent-cold-email` · repo https://github.com/YS-projectcalc/agent-cold-email · Code: `~/dev/coldstart/`

> **You are resuming with zero prior context. Re-orient from `## Resume` below, then VERIFY its preconditions still hold.** If they hold and the step is non-destructive, proceed — don't ask open-endedly what to work on. If anything has CHANGED, surface exactly what and ask before acting. **STOP and confirm before any destructive/irreversible/founder-owned step** (deploy · push · real vendor spend · npm publish · external send) — SPEC §0 locks NO real vendor spend until the owner works `ACTIVATION.md`.

## Where we are right now (2026-07-14 — "activation day")

- **Distribution identity surfaces LIVE — Gate 3 headline closed.** `agent-cold-email@0.1.0` published to npm (Yaakov, 2FA, his hands; verified `npm view` + `npx agent-cold-email --help`). Official **MCP Registry** listing LIVE: `io.github.YS-projectcalc/agent-cold-email` v0.1.0 (`server.json`, commit `aee3679`, verified via registry API). `llms-install.md` committed (`619fd6f`). **awesome-mcp-servers PR #10106 OPEN** (https://github.com/punkpeye/awesome-mcp-servers/pull/10106 — maintainer-disclosed, early-access caveat stated). Standing approval GRANTED for disclosed registry/directory listings (`47cfeb6`).
- **coldrig.dev LIVE, host-swap deployed** (`355926c`): canonical/OG/sitemap/robots/server-card → coldrig.dev; CAN-SPAM address filled (EpiphanyMade, 209 Crest Hill Road, Toms River NJ 08755); IndexNow re-fired (HTTP 202); Wayback + DeepWiki seeded. Verified live this session.
- **Worker deployed twice:** 17 tools live (`14316ad6`, verified via `tools/list`), then field-path validation errors (`9576e9b8`, live-verified) after a stranger-agent funnel drive (PASS end-to-end; 3 frictions found + fixed).
- **SPEC §20 (BYO domains & mailboxes) SHIPPED** after 4 adversarial rounds (`5627be4`) — subdomain-first, apex never NS-delegated, primary-domain guardrails, abuse gate, warmup branching on verified ACTIVE-sending evidence. **Spec only — the build is the next code step.**
- **Waitlist form was silently dead for every visitor since launch** — the status `<p>` is a *sibling* of the `<form>`, so `setStatus` threw before `fetch()` ever ran (no request, no message, no cleared field). FIXED + revert-fail proven + deployed (`a12a773`).
- **Engine BUILT DARK but NO-SHIP** (uncommitted) — see In flight.

## In flight / next

- **Still running: none.** Both of this session's lanes landed at the end (verdicts below); nothing is mid-flight.
  - ~~`engine-adversary` re-attack~~ **LANDED: NO-SHIP** (see below) — the engine stays uncommitted; the named fix is the next code step.
  - ~~`cascade-2`~~ **LANDED: 4 surfaces blocked, all needing Yaakov's hands** — llmstxt.site + directory.llmstxt.cloud forms are fully prepared (scripts rescued to `archive/2026-07-14-activation-day/scratch-rescue/`, ~10s each to run); mcp.so + cursor.directory now sit behind GitHub-OAuth sign-in walls (one headed login persists a profile for all future submissions). ⚠️ mcp.so defaults to a PAID $39 tier — choose free deliberately. See `ROADMAP.md` `## Open`.
- **In progress (not finished) — the engine arc, UNCOMMITTED and NO-SHIP.** Round 1's class (*"durable state advanced before the cross-boundary effect is confirmed"*) was genuinely fixed and the adversary CONFIRMED it: consumer-owned cursor (engine now cursor-stateless; lost responses redeliver; Message-ID dedupe makes redelivery safe), class sweep clean (no other members), https guard unbypassable, §0 sandbox safety intact, platform 259/259.
  **But re-attack #2 found a NEW BLOCKER — a DOUBLE-SEND race:** `SEND_CLAIM_TTL_MS = 5 min` (`apps/platform/src/engine/tick.ts:43`) is **half** nodemailer's default 10-min socket timeout (`apps/engine/src/smtp.ts` sets no timeout overrides; `email-port.ts` has no `AbortSignal`; engine `send()` at `apps/engine/src/engine.ts:42-57` is bare check-then-act with no in-flight claim). A stalled SMTP send gets reclaimed by the next tick **while still in flight** → **the lead receives the email twice.**
  **To ship:** bound the in-flight send well under the TTL (set nodemailer connection/greeting/socket timeouts in `smtp.ts` + an `AbortSignal` on the Worker fetch) and/or give the engine's send store a claim-then-execute in-flight row mirroring `withRequestIdempotency`. Details + the runbook landmine: `ROADMAP.md` `## Open` (two 2026-07-14 engine entries).
- **Open decisions / blockers (all founder):** Stripe live activation (Gate 2 — see Landmines) · mailbox provider for the Mordy pilot (**Inboxkit** — real Google mailboxes via API, ~$6/mbx, 10-min signup + card — **vs** Mordy's own Google Workspace seats) · ~$10 test domain purchase · light-KYC scope for BYO intake · Cline listing icon (brand/TM-gated).
- Full itemized list: `ROADMAP.md` `## Now` + `## Open` (27 open items).

## Landmines / gotchas

- **UNCOMMITTED engine source in the tree:** `apps/engine/**` (untracked) + modifications to `apps/platform/src/{engine/reply-processor.ts,engine/tick.ts,env.ts,schema.ts,tenant-do.ts,vendors/**}`, `packages/shared/src/vendor-ports.ts`, `ACTIVATION.md`, `.gitignore`, and 3 test files. It is **NO-SHIP** (double-send race, above) — **do not commit it until a fresh-context adversary pass comes back clean, and never `git checkout`/`reset` those paths** (you would destroy the round-1 fixes, which the adversary confirmed are good). Full verdict: `docs/adversarial/engine-host-review-2026-07-14.md`.
- **Stripe CANNOT take money:** `STRIPE_SECRET_KEY` is unset in prod, so `POST /checkout` returns a **simulated** URL and hitting it upgrades a tenant to a paid plan with **zero card and zero dollars** (intentional test-mode — but anyone who knows the API can self-upgrade). The webhook correctly fails closed (503, `STRIPE_WEBHOOK_SECRET` unset). To take real money: Stripe live KYC → swap key → set webhook secret (no Price objects needed — created inline). ACTIVATION Gate 2.
- **No human can buy or use this today:** there is no human signup form (only `POST /signup`, framed as the agent's job) and the dashboard has **no billing controls** (no upgrade/downgrade/cancel/payment-method). Recorded as an `[ORDER]` in `ROADMAP.md` for the external design lane. Evidence: `pw-shots/human-journey-2026-07-14/` (14 screenshots, both widths; gitignored).
- **Design is EXTERNALLY owned** (Yaakov's ruling, `685a202`): a different LLM is building the landing page + all human pages in `~/Documents/Codex/2026-07-14` (it read `docs/research/agent-buyer-research-forensics-2026-07-14.md`). **Do NOT design here** — integrate + re-verify when it's handed over.
- Deploys: Worker via `npm run deploy` in `apps/platform/` (applies D1 migrations FIRST — never bare `wrangler deploy`). Pages deploys from an agent worktree **must pass `--branch main`** or they land as a preview, not production.
- `apps/platform/vitest.config.ts` `fileParallelism: false` is REQUIRED (shared Miniflare) — removing it re-introduces flakes.
- npm + MCP-Registry credentials are Yaakov's identity (2FA / device-flow) — those publishes need his hands. Test-mode junk tenants from this session's drives (`mordytest-*`) exist in prod — harmless, identifiable.
- A session-only wake-up cron (`63ab20ad`, hourly) was armed this session as usage-limit insurance; it dies with the session — re-arm if wanted.

## Key files

- `SPEC.md` (§0 locks · §19 dashboard · **§20 BYO domains/mailboxes**) · `ROADMAP.md` (`## Now` / `## Open` ledger) · `ACTIVATION.md` (owner-hands gates; **Gate 2 holds the engine-host `doctl` runbook**) · `CLAUDE.md` (project law) · `MEMORY.md` (build lessons) · `AGENTS.md` (the 17-tool surface).
- `docs/adversarial/byo-domain-design-review-2026-07-14.md` — 4-round BYO verdict (frozen) · `docs/research/traffic-channels-selfserve-2026-07-13.md` — 13 ranked zero-touch discovery channels · `docs/research/byo-domain-verification-2026-07-14.md` — competitor/Cloudflare BYO norms · `docs/research/agent-buyer-research-forensics-2026-07-14.md` — how an agent actually shops (the design LM read this).
- `apps/engine/` — the dark Node SMTP/IMAP daemon (UNCOMMITTED) · `tools/indexnow/submit.sh` — post-deploy search ping · `pw-scripts/waitlist-form-drive.js` — browser drive proving the CTA fires.
- `archive/2026-07-14-activation-day/prior-HANDOFF.md` — the resume state this file replaced.

## Resume — KIND B: the next step is founder-owned (verify, then confirm before acting)

**Verify first:** `git -C ~/dev/coldstart status --short` — the engine diff (`apps/engine/**` untracked + the `apps/platform/src` modifications under Landmines) must still be uncommitted and intact.

**The next code step is decided and NON-destructive — fix the double-send race, then re-attack.** Dispatch a builder (sonnet/opus, never Fable) with this brief: in `apps/engine/src/smtp.ts` set explicit nodemailer `connectionTimeout` / `greetingTimeout` / `socketTimeout` well under `SEND_CLAIM_TTL_MS` (5 min — `apps/platform/src/engine/tick.ts:43`), add an `AbortSignal` timeout to the Worker's fetch in `apps/platform/src/vendors/real/email-port.ts`, and/or give the engine's send store a claim-then-execute in-flight row mirroring `withRequestIdempotency` (`apps/platform/src/engine/idempotency.ts` is the pattern) so a reclaim can never race a live send. Ship a test that FAILS on the current code (stalled send + reclaim ⇒ two SMTP sends) and passes fixed. **Third defect (do not drop it):** the TTL reclaim does not bump `attempts`, so an orphan-reclaim loop has no ceiling — give it one. **Also fix `ACTIVATION.md:42` step 6** (it tells the operator to set `ENGINE_BASE_URL=http://$IP:8080`, which the new https guard rejects as PERMANENT ⇒ every due send goes terminal `'failed'` with no requeue path) — the runbook must set only an https tunnel/localhost URL; and re-grade a 422 UnknownMailbox as operator-fixable rather than lead-permanent. Then **re-attack with a fresh-context adversary** and only commit on a clean pass.

**Then, and only with Yaakov's confirmation** (each is founder-owned or spends money):
1. Provision the engine host — he verbally approved the ~$6/mo droplet ("whatever size we need"); runbook in `ACTIVATION.md` Gate 2 (`doctl compute droplet create`, `nyc1`, `s-1vcpu-1gb`).
2. Build the per-tenant `ENGINE_TENANTS` allowlist — guards: default-empty (never wildcard), fail-closed on malformed input, plan-check dominant (a demo/free tenant on the allowlist STILL gets sandbox), `realAdaptersActivated` stays a separate global gate, tenantId from the verified DO identity.
3. Ask him to rule on the **mailbox provider** (Inboxkit vs Mordy's own Google Workspace seats) and the **~$10 test domain** — both block the Gate-1 real-send smoke, which blocks the Mordy pilot.

Do NOT deploy, push, or spend without confirming with Yaakov first.
