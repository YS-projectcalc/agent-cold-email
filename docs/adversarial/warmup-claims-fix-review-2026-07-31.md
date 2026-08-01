# Adversarial review — warmup claims-surface fix wave (2026-07-31)

**Ref:** `git rev-parse HEAD` = `29a4560437223240a2fc2cb8694525f11d29fe5c`; target = the UNCOMMITTED working-tree diff (nothing staged): `SPEC.md`, `apps/platform/src/mcp/tools.ts`, `site/faq.html`, `site/guide-cold-email-deliverability.html`, `site/guide-domains-inboxes-warmup-compliance.html` (+ an unrelated spec-builder memory file).

**VERDICT: NO-SHIP** (3 BLOCKING).

**Batteries re-run by me:** `apps/platform` `npm run typecheck` → exit **0**. `apps/platform` `npm run test` → **122 files / 1122 tests passed**, 224.54s, exit 0. All 24 site JSON-LD blocks parse (`0 invalid`). Live `https://coldrig.dev/faq` = HTTP 200 and still serves the OLD copy ("AI-mimicry layer") — the fix is uncommitted/undeployed.

---

## BLOCKING

### B1 — The wave's headline denial is FALSE: the platform DOES start a vendor warmup subscription per real mailbox, and its cost IS bundled into the price

New copy asserts, in three places:
- `site/guide-cold-email-deliverability.html:111` — "no vendor warmup pool and no \"AI-driven\" engagement layer runs underneath it today"
- `site/faq.html:124` — "no vendor warmup pool and no \"AI-driven\" engagement layer runs underneath it"
- `SPEC.md:38` — "pool/\"AI-driven\" warmup is **NOT run or bundled**"

Code path (real/armed bundle):
- `apps/platform/src/engine/provisioning.ts:79-81` — every provisioned mailbox: `withSpendCeiling(ctx, "warmup", () => ctx.adapters.mailbox.startWarmup(...))`. Unconditional; not best-effort.
- `apps/platform/src/vendors/real/mailbox-port.ts:89-97` — `startWarmup` → `POST /warmup/add { mailbox_uids, activate_immediately: true }`, and **throws** `VendorError` if InboxKit does not return a subscription.
- `apps/platform/src/engine/spend-ceiling.ts:79-87` — the warmup add-on reserves 0 *because* "its cost is BUNDLED into `COST_MAILBOX_CENTS` at the provision site (design cost-table rationale: 'slot amortized + warmup add-on')". So "not bundled" is false **by design, today**, independent of any arming.
- `apps/platform/src/vendors/factory.ts:139-141,171` — `useSandbox = isDemoOrFree || !activated || !inboxKitConfig`; real branch hands out `RealMailboxPort`.
- `apps/platform/src/tenant-do.ts:398-404,425-429` — the DO **does** supply `inboxKitConfig()` from `INBOXKIT_API_KEY`/`INBOXKIT_WORKSPACE_ID` (the factory's own doc comment at `factory.ts:114-118` claiming "no call site supplies it" is STALE).

What that vendor product is: `docs/research/inboxkit-prewarm-2026-07-21.md:55-56` — "Warmup add-on ($3/mbx/mo)… **Pool type: isolated, not shared**… Ramp: **AI-powered**, ~14 days, smart volume ramp from 2 to 40 emails/day." That is precisely a vendor warmup pool with an AI-driven engagement ramp — both nouns the new copy denies.

Arming + intent evidence: `HANDOFF.md:11` — "`REGISTRAR_PROVIDER=inboxkit` confirmed present via `wrangler secret list` **alongside `INBOXKIT_API_KEY`/`INBOXKIT_WORKSPACE_ID`** (the arm is real, not sandbox)". `MEMORY.md:24` — same secrets armed. `ROADMAP.md:64` prices the customer's bill on it: "**warmup add-on $6/mo (2 × $3, while warming)**". `ROADMAP.md:76` — "his domain warms on-platform after connect (native ramp ± the $3/mbx warmup add-on)". And the platform's own public status board already says the opposite of the new copy: `site/status.html:8` — "**Production sending** — Real domains, mailboxes, **warmup**, and delivery — live for activated accounts. [Live]".

Failure scenario: an activated paid tenant calls `setup_infrastructure` → `RealMailboxPort.provision` → `POST /warmup/add` creates a paid InboxKit warmup subscription for each mailbox, billed inside the mailbox price the customer pays. A buyer who read `/faq` or `/guide-cold-email-deliverability` was told no vendor warmup pool runs and none is bundled. The fix over-corrected: the OLD copy's "vendor-provided base warmup" clause was TRUE (only the in-house "AI-mimicry layer" was fiction); the diff deleted the true clause and replaced it with a false denial.

Verification: read the full call chain; ran the suite (green — no test pins this claim); corroborated with the repo's own canonical docs. **UNVERIFIABLE sub-question:** whether a warmup subscription has *already* been created in prod (needs the InboxKit dashboard / prod DO state; `ROADMAP.md:18` suggests Mordy's agent has not provisioned yet). That does not rescue the claim: the "bundled" half is false now, and the "runs today" half flips false on the next self-serve provision with no flag, guard, or test standing between.

`file:line` — `site/guide-cold-email-deliverability.html:111`, `site/faq.html:124`, `SPEC.md:38` vs `apps/platform/src/engine/provisioning.ts:79-81`, `apps/platform/src/vendors/real/mailbox-port.ts:89-97`, `apps/platform/src/engine/spend-ceiling.ts:79-87`.

### B2 — "your agent cannot exceed that cap" is false: the `reply` tool sends with no cap check, no counter increment, and no paused-mailbox check

Absolute claims introduced by the diff:
- `apps/platform/src/mcp/tools.ts:67` — "New mailboxes are ramp-limited server-side … **and your own calls cannot exceed that cap**"
- `apps/platform/src/mcp/tools.ts:79` — "New mailboxes are ramp-limited server-side: 5 sends/day week 1 rising to 40/day after 4 weeks"
- `site/guide-cold-email-deliverability.html:102` — "a real server-side cap your agent cannot exceed, **no matter how eager it is to send**"
- `site/guide-domains-inboxes-warmup-compliance.html:36` (JSON-LD), `:65`, `:92` — "a hard limit your own agent cannot exceed" / "your agent can't override"
- `site/faq.html:124` — "that your own agent cannot exceed"

Reality: cap enforcement exists in exactly ONE place — the tick. `apps/platform/src/engine/scheduler.ts:28` (`sentToday < dailyCap`) + `apps/platform/src/engine/tick.ts:261-273` (mailbox SELECT excludes `deliv_status='paused'`) + `tick.ts:420` (`sent_today = sent_today + 1`). `apps/platform/src/engine/mailbox-state.ts:51-53` says so in its own words: "Called before anything that reads or enforces mailbox capacity on the write path (**currently just the tick**)".

The second live send path is unguarded: MCP tool `reply` (`tools.ts:122`) and `POST /threads/:id/reply` (`apps/platform/src/routes/inbox.ts:35-40`) → `tenant-do.ts:645-651` → `apps/platform/src/engine/threads.ts:111-178`. `replyToThread` reads the thread's sending mailbox (`threads.ts:124`) and calls `ctx.adapters.email.send` at **`threads.ts:147`** with **zero** reference to `daily_cap`, `sent_today`, or `deliv_status` (grep of the whole reply chain returns none), and never increments `sent_today`.

Failure scenario: day 1 of warmup, `dailyCap = 5`. The agent calls `reply` 200 times (idempotency dedupes only *identical* bodies — `threads.ts:134` hashes the body, so any varied body is a fresh send). 200 messages leave that mailbox on day 1. `infrastructure_status` still reports `sentToday: 0 / dailyCap: 5`. Same bypass lets a mailbox the deliverability loop **paused** keep sending. No API rate limiter covers this (the only limiter, `routes/waitlist.ts:61-74`, is signup/waitlist IP-scoped).

Verification: full static trace of every send call site (`ctx.adapters.email.send` appears at exactly two places: `tick.ts:363` and `threads.ts:147`), plus the code's own capacity-enforcement comment; suite green (no test asserts a cap on the reply path).

### B3 — `faq.html` publishes a week-4 number that contradicts `warmup.ts` and both sibling guides

`site/faq.html:124` — "5/day in week one, **rising to 40/day by week four**".
`apps/platform/src/engine/warmup.ts:18` — days 22-28 (week four) → **35**; 40 only at day 29+ (`warmup.ts:19`).
Siblings introduced by the same diff say 35: `site/guide-cold-email-deliverability.html:102` ("Days 22-28: 35/day"), `site/guide-domains-inboxes-warmup-compliance.html:36` and `:92` ("35/day in week four, reaching 40/day … on day 29"). `SPEC.md:38` and `tools.ts:67,79` use the correct "after 4 weeks" framing.

Failure scenario: a purchasing agent sizing week-4 capacity off `/faq` plans 40/mailbox/day and gets 35 — and the same site tells it 35 two clicks away. Charitable reading ("by [the end of] week four") exists, but this is the one published number in the wave that disagrees with its own siblings, on a wave whose entire purpose is exact-number fidelity. One-word fix.

Verification: read `warmup.ts:14-20`; diffed every numeric claim in the diff against it (full table below).

---

## NON-BLOCKING

- **N1 — the SPEC class sweep stopped at line 38.** `SPEC.md:152` (§9 "Warmup — what's true, what we do") still reads "**Our approach:** rent base warmup (vendor) + **AI human-mimicry layer** … + rented pre-warmed boxes", directly contradicting the new `SPEC.md:38`. `SPEC.md:548` still asserts "pool detection real". Same-file survivors on a claims-honesty edit. (Note: §152's "rent base warmup (vendor)" is closer to production truth than the new §38 — see B1.)
- **N2 — a new mechanism claim with no implementation.** `site/guide-domains-inboxes-warmup-compliance.html:92` (new): the cap is "**built on real recipient engagement** rather than a simulated pool". `warmupDailyCap` (`warmup.ts:14-20`) is a pure function of elapsed days; no engagement signal feeds the ramp anywhere. Engagement only ever *lowers* the cap (`deliverability-actions.ts:51-56` sets `cap_override`). The ramp is a calendar, not an engagement loop.
- **N3 — the published schedule is not the only live schedule.** `apps/platform/src/engine/byo-ramp.ts:29-51` implements two more tiers consumed live by `mailbox-state.ts:36-46,65-82`: `primary` clamps to **20/day** (`byo-ramp.ts:40`), `shortened` reaches **40/day by day 10** (25/day on day 7 — i.e. 5× the published "week one = 5/day"). The brief's premise that `warmup.ts:14-19` is the ONLY schedule authority is refuted by the code. Mitigated today: BYO intake is unreachable for exactly the activated tenants that could use it (see N7), so no live mailbox can currently hold a non-standard tier.
- **N4 — cap-as-entitlement.** The site states "reaching 40/day once fully warmed" with no health caveat; `deliverability.ts:63` (`throttleFloorCap: 5`) + `deliverability-actions.ts:51-56,259-274` can pin a mailbox at 5/day indefinitely via `cap_override` (`mailbox-state.ts:40` = MIN). `tools.ts:67,79` hedge correctly ("poll for the current dailyCap"); `pricing.html:195` hedges; the three changed guide/FAQ lines do not.
- **N5 — stale competitor comparison.** `site/compare-vs-maildoso.html:69` claims Coldrig has "**No published fixed daily figure**" — false as of this diff; `:95,:107` frame "a hard per-mailbox technical ceiling" as Maildoso's distinguishing disadvantage while Coldrig enforces one too (and week two = 15/day is *exactly* Maildoso's cited 15/day cap).
- **N6 — the new paragraph adopts the pool paragraph it later denies.** `guide-cold-email-deliverability.html:102` opens "the ramp above isn't marketing copy here", where "the ramp above" (`:101`, untouched) is "a handful of messages per day in week one to 25-40/day by week four — **while a pool of other inboxes opens, replies to, and rescues warmup messages from spam**". The denial lands 9 lines later at `:111`.
- **N7 — (pre-existing, untouched surface; attack #2's "other fictional mechanisms" sweep)** `site/byo-domain.html:10`: "Once you've gone live … actual DNS delegation, **live reputation/blocklist checks**, and platform-provisioned mailboxes on your own domain are automatic." Inverted: going live is what breaks it. `byo-intake.ts:131` calls `ctx.adapters.dnsScan.scan()` and `:144` `ctx.adapters.reputation.check()`; for an activated tenant with InboxKit armed the bundle is real, and `vendors/real/dns-scan-port.ts:15-17` + `vendors/real/reputation-port.ts:16-18` **both throw `NotActivatedError` on every call**. BYO intake works only in sandbox.
- **N8 — "(prewarm SKU)".** `SPEC.md:38` (new) lists "rented pre-warmed boxes (**prewarm SKU**)" in the same breath as the "NOT run" disclaimers, implying a shipped SKU. `spend-ceiling.ts:33,45` label prewarm the *future* SKU; `ROADMAP.md:28` has it as an unstarted, founder-HELD order; no purchase path exists.
- **N9 — evidence-grounding inversion.** The new `:111` rationale leans on "the pool-signal skepticism above" (`:105`, `:107`, and the JSON-LD at `:51`), which asserts Gmail/MS pool detection as fact. The diff's own cited authority says the opposite: `docs/research/warmup-posture-2026-07-28.md:13,15,29,32` — Google's guidelines say nothing about warmup networks, the counter-case is vendor-sourced and unverified, "**Treat both as marketing**", "Do NOT frame warmup networks as 'against Google's rules'". The "no neutral study confirms it lifts placement" clause IS supported (`:33`); the detection-as-fact framing is not.

---

## Number-fidelity table (every numeric claim in the diff vs `warmup.ts:14-20`)

| Site | Claim | Code | Verdict |
|---|---|---|---|
| `guide-cold-email-deliverability.html:102` | Days 1-7:5 · 8-14:15 · 15-21:25 · 22-28:35 · 29+:40 | identical | EXACT |
| `guide-domains…:36` (JSON-LD) | 5 wk1 → 15,25,35 → 40 on day 29 | identical | EXACT |
| `guide-domains…:92` | 5/15/25/35 by week, 40 on day 29 | identical | EXACT |
| `guide-domains…:65` (lede) | ~4 weeks, 5/day wk1 → 40 once fully warmed | 28-day ramp | OK |
| `tools.ts:67`, `tools.ts:79` | 5/day wk1 → 40/day after 4 weeks | day 29+ = 40 | OK |
| `SPEC.md:38` | 5/day wk1 → 40/day after 4 wks | day 29+ = 40 | OK |
| `faq.html:124` | 5/day wk1 → **40/day by week four** | week 4 = 35 | **B3** |

## Buyer-agent read (attack #5)

A skeptical purchasing agent reading only the public surfaces post-fix concludes **(a) yes, hard-capped at 5/day/mailbox in week one** — deciding lines `guide-cold-email-deliverability.html:102`, `guide-domains…:92`, `faq.html:124` — which is **wrong**: the `reply` tool is uncapped and uncounted (B2). And **(b) yes, no pool warmup is included** — deciding lines `guide-cold-email-deliverability.html:111`, `faq.html:124` — which is **wrong**: a $3/mbx/mo InboxKit warmup subscription is started per mailbox and its cost is bundled into the mailbox price (B1). Both halves of the buyer question fail.

## Attacks that FAILED (the fix held here)

- **JSON-LD integrity** — parsed all 24 `application/ld+json` blocks across every `site/*.html` (not just touched ones): 0 invalid. The new `:36` answer text is valid JSON (ASCII hyphen, no unescaped quotes).
- **Stale structured-data mirror** — hunted for the old fiction surviving in machine-readable mirrors: `faq.html`'s FAQPage (`:22-79`) never mirrored the edited visible Q; `guide-cold-email-deliverability.html`'s FAQPage warmup answer (`:50-51`) never carried the AI-layer claim; `site/.well-known/mcp/server-card.json` and `site/openapi.yaml:79,112,229` carry no ramp numbers. No drift.
- **Promissory drift** — read every new sentence for placement/deliverability guarantees. None introduced; "not a way to defeat spam filtering" / "never a default" / "no neutral study confirms" all preserve the no-guarantees posture.
- **Typecheck + suite** — `npm run typecheck` (workspace script, not raw `tsc`) exit 0; `npm run test` 122 files / 1122 tests green. The longer tool descriptions break nothing (`mcp-tool-annotations.test.ts` included).
- **Anchor/regression ring** — the H2 `id="warmup"` on the deliverability guide is untouched, so the `#warmup` inbound links from `guide-domains…:68,92` still resolve; `#warmup-timeline` unchanged.
- **Calculator coherence** — `site/assets/domain-calculator.js` math (30/day, ceil) and the 100→4/2, 500→17/6, 2000→67/23 tables are untouched and still internally consistent; 30/day stays conservative under the real 40/day ceiling.
- **Sandbox-simulated warmup** — checked that the diff does not accidentally deny the real sandbox feature (`docs.html:105`, `status.html:8` "Fault-injecting sandbox"); the new copy is scoped to production mechanisms and leaves the sandbox claims intact.
- **`llms.txt` / `agent-evaluation.md` / `index.html` / `pricing.html`** — swept for surviving "AI-driven"/pool claims: none (`agent-evaluation.md:81` and `pricing.html:103,140,195` already frame capacity as warmup/health/provider-bounded).

## UNVERIFIABLE

- Whether an InboxKit warmup subscription already exists in production (needs the InboxKit dashboard or prod DO state; `wrangler secret list` needs the founder's account). Resolved by: an operator running `wrangler secret list` + an InboxKit `GET /warmup/*` listing. Does not change B1's verdict (the "bundled" half is false today).
- Whether the live `site/` deploy is git-connected such that the fix ships on merge (live `/faq` still serves the old copy at review time — HTTP 200). Resolved by: the Pages project's build settings.
