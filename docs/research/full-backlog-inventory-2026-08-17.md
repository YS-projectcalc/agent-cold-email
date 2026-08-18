# ColdStart / Coldrig — Full Backlog Inventory (2026-08-17)

> Consolidation of every outstanding issue/defect/deferral surfaced since ~2026-07-21, per the founder's
> 2026-08-17 order ("fix every issue in the last 20 chats... make sure it's fully operational for 100's
> of customers"). Read-only inventory pass — nothing here has been fixed. Sources: `ROADMAP.md` (## Now +
> ## Open, full read), `archive/ROADMAP-done.md` (all four "Drained" sections dated 2026-07-22 through
> 2026-08-16), `HANDOFF.md`, `archive/{2026-08-16-visibility-alerts,2026-08-13-p0-c3-mailbox}/prior-HANDOFF.md`,
> `~/.claude/projects/-Users-yaakovscher/memory/coldstart-platform-build.md`, and the newest
> `docs/adversarial/*.md` gates (2026-08-13 through 2026-08-17).
>
> **Headline finding:** the ledger is unusually clean — the overwhelming majority of "non-blocking"
> adversarial findings are already folded verbatim into `ROADMAP.md ## Open`. This inventory is mostly a
> *reorganization* of that section (which is 208 lines / ~220KB of dense prose) into a triaged,
> deduplicated, severity-ranked table, plus two items that fell through the cracks and one large
> already-scoped program that should not be double-built.

## Summary counts

- **Total distinct open items identified: 97**
- By status: **OPEN 71** · **ALREADY-COVERED-BY-TRAIN-N 1** (the whole product-hardening program, ~75
  sub-members not separately re-enumerated here — see note below) · **FOUNDER-GATED 21** (own section) ·
  **STALE-LIKELY-DONE 4**
- By severity: **P0 (breaks customers) 6** · **P1 (breaks operator trust / scale risk) 19** ·
  **P2 (quality) 40** · **P3 (nice-to-have) 32**
- By category: **defect 18** · **hardening 12** · **claim-drift 14** · **monitoring 9** ·
  **scale 8** (mostly UNAUDITED, see §Scale below) · **product-gap 20** · **doc-stale 16**

**Note on the product-hardening remediation program:** `ROADMAP.md:25` (2026-08-17 `[ORDER]`) already
scopes Trains 1–5 (channel-truth, loop-isolation, claim-surface, dedup-semantics, monitoring-denominators)
against six frozen class-sweep docs (`docs/adversarial/class-sweep-{cached-terminal,hol-blocking,
claim-drift,signal-inversion,dedup-semantics,watch-completeness}-2026-08-17.md`) totaling ~75 IN-class
members, plus a completeness-pass correction (`sweep-completeness-pass-2026-08-17.md`). Trains 1+2 are
already "building" per `HANDOFF.md`. **Do not re-derive or re-fix these piecemeal from this inventory** —
route them through the existing train sequencing. This inventory does not re-enumerate the ~75 individual
members (would require reading all six class-sweep docs in full, out of this pass's budget); it is listed
below as a single row (#1).

---

## P0 — breaks customers

| ID | Item | Source(s) | Category | Status |
|---|---|---|---|---|
| P0-1 | **Product-hardening remediation program (Trains 1-5, ~75 members)** — channel-truth, loop-isolation, claim-surface (~50 sites), dedup-semantics, monitoring-denominators. Trains 1+2 building as one integration branch (`feat/channel-truth-2026-08-17`); 3-5 queued. | `ROADMAP.md:25`, `HANDOFF.md:16` | defect | ALREADY-COVERED-BY-TRAIN-N |
| P0-2 | **C3 (d) reconcile arm-gate — 3 blocking defects, must NOT arm `PROVISIONING_RECONCILE_ENABLED`:** (a) reconcile reads FIRST persisted domain spec while direct-resume honors LATEST call's persona/count → divergence over-provisions (reproduced: 7 mailboxes for a 2-ask customer, real spend+bill); (b) reconcile mailbox buys pass `withSpendCeiling` but not `assertWithinProvisioningCap` (no count-cap enforcement); (c) reconcile skips `assertNotLifecycleFrozen` — frozen (suspended/disputed/canceled) tenants get phantom `mailboxes` rows + false `dns_status='ready'` that turn billable on reactivation. | `ROADMAP.md:27`, `docs/adversarial/c3-gate-2026-08-13.md`, `docs/adversarial/c3-postship-reattack-2026-08-14.md` | defect | OPEN (dark, cannot arm until fixed) |
| P0-3 | **Purchased-domain billing rests solely on vendor mailbox `status==='active'`** (existence, not usability) — MX/SPF/DKIM/DMARC never re-checked after buy; a post-buy `/domains/list` re-poll would restore the real guarantee. Gated on the vendor-contract capture (below) confirming the propagation fields actually flip. | `ROADMAP.md:50-51` | defect | OPEN |
| P0-4 | **Deadlock-class detector missing:** no watchtower check covers a domain stuck at `dns_status='pending'` in the `'unknown'` connection-type branch — fail-safe (no spend) but permanent and invisible, same six-day-silence shape that cost the Mordy incident. Highest-value follow-up per the gate. | `ROADMAP.md:49` | monitoring | OPEN |
| P0-5 | **Burn/replace lane (`REPLACE_DOMAIN`) inherits the P0 DNS-wait fix UNTESTED** — `deliverability-actions.ts:194` calls the same `provisionDomainWithMailboxes` on the purchased-domain path with no test exercising it; an automated replace-domain event on a purchased lookalike is unverified. | `ROADMAP.md:53` | defect | OPEN |
| P0-6 | **Scale-readiness audit not yet performed** (founder's explicit 2026-08-17 widening, part c): "fully operational at hundreds of customers" — cron sweep fan-out, DO/D1 contention, InboxKit rate limits + slot-tier laddering, engine capacity, alert/digest volume, Stripe webhook throughput, support-digest size. Dispatched late 2026-08-17; results not yet in. See **Scale-readiness gap** section below for what's known vs. unknown today. | `ROADMAP.md:24` | scale | OPEN |

---

## P1 — breaks operator trust / scale risk

| ID | Item | Source(s) | Category | Status |
|---|---|---|---|---|
| P1-1 | **`watchtower_state` unbounded growth** — no `DELETE FROM watchtower_state` anywhere; every sweep does two full-table reads every 5 min across 5+ per-entity key prefixes. Needs a retention/pruning design. Compounds directly with the P0-6 scale question. | `ROADMAP.md:56`, `docs/adversarial/wave3-integration-gate-2026-08-09.md` | scale | OPEN |
| P1-2 | **Wedged tenant DO stalls the whole watchtower leg + everything after it** in cron sequencing, including the heartbeat leg — dead-man fires with the WRONG stated cause ("cron appears to have stopped" instead of "one tenant is hung"). Fix = per-tenant timeout/race. | `ROADMAP.md:57` | monitoring | OPEN |
| P1-3 | **`body-cap-coverage.test.ts` glob is narrower than the 413-cap class it pins** — misses top-level `src/*.ts`, `src/engine/*.ts`, `src/billing/*.ts`, `src/vendors/**`, nested `src/routes/**`. Zero stragglers TODAY (grep-confirmed) but a future body-reading module could dodge the guard silently. | `ROADMAP.md:58` | hardening | OPEN |
| P1-4 | **Late-dispute resurrection of a CANCELED tenant** — a late `charge.dispute.created` + its win restores `billing_state='active'` and un-freezes provisioning on an already-canceled tenant; root cause is `isStaleBillingEvent` returning false pre-watermark. Needs its own small lane (state guard on the dispute.created write). | `ROADMAP.md:59` | defect | OPEN |
| P1-5 | **CLI workspace test/build ordering gap** — `packages/cli/test/claim-surface.test.mjs` reads `dist/` by design with no fallback; a fresh-clone `npm test` fails ENOENT before any assertion runs because root `npm test` never builds the CLI workspace first. Fix = `pretest` build step. | `ROADMAP.md:60` | hardening | OPEN |
| P1-6 | **Multi-dispute unfreeze gap** — `dispute.closed(won)` lifts the freeze whenever `billing_state='disputed'` without checking for OTHER still-open disputes on the same tenant. Deserves its own careful arc, not folded mid-wave. | `ROADMAP.md:62(a)` | defect | OPEN |
| P1-7 | **N-3 CLASS HAZARD: DO-table PRIMARY KEY reshape has no migration path** — `CREATE TABLE IF NOT EXISTS` never alters, so a DO-table reshape mid-wave has zero migration path and no fresh-DO test can catch it. Needs a shape-version guard convention before any future table reshape. | `ROADMAP.md:65` | hardening | OPEN |
| P1-8 | **Stale-checkout subscription-id overwrite** — checkout(sub A) → cancel → re-checkout(sub B) → sub-A's Stripe redelivery within the 3-day window sees active==active, applies, and `COALESCE` overwrites B with A → quantity sync points at the wrong subscription. Needs its own small design (subscription-id-aware staleness). | `ROADMAP.md:66` | defect | OPEN |
| P1-9 | **`readDeclineCode` real-payload live-verify still unproven** — the second-Stripe-read fix is code-correct but has never been proven against a REAL unexpanded `invoice.payment_failed` delivery (same live-verify gap noted twice in the ledger from two angles). | `ROADMAP.md:67` | monitoring | OPEN |
| P1-10 | **Domain-connect wall for CF-registered domains** — Cloudflare-registered domains cannot NS-delegate to InboxKit; both probe domains (dmhadvisor, authorpitchdesk) hit this. Zone-token connect path works as a workaround (already used for Mordy's product shape via lookalikes), but a genuine BYO-CF customer path is still blocked pending InboxKit API-parity fix. Support ticket v2 not yet sent; CF token not yet revoked. | `ROADMAP.md:87` | product-gap | OPEN |
| P1-11 | **Reconcile's own scope predicate correctness** — confirmed in code the dark reconcile now also excludes `dns_gave_up_at IS NOT NULL` rows, but the three arm-gate blockers (P0-2) are otherwise unchanged; direction-1 (resume-from-resource, HIGH blast radius redesign) remains a staged, unbuilt alternative requiring its own class-sweep + fresh adversary gate before any schema change to the money-critical `domains` table. | `ROADMAP.md:27-29` | hardening | FOUNDER-GATED (needs schema-change ruling) |
| P1-12 | **Inc5 concurrent-twin phantom residual** — a CONCURRENT identical-body call in a sub-ms window before `revokeAdmission` still gets a phantom `201`; requires a triple conjunct (concurrency + partial D1 degradation + identical body/urgency), self-heals, founder-ruled ship-acceptable — but the gate's own re-attack found the "originating call throws" mitigation is thin (1 throw / 2 phantom 201s of 3 concurrent twins in repro). | `ROADMAP.md:43` | defect | FOUNDER-GATED (ACCEPTED-RISK, ruled 2026-08-11) |
| P1-13 | **Rate-slot bypass under sustained D1 outage** — a revoked `contact_operator` call frees its own rate slot, so the 5/hr cap doesn't bind while every call is failing (30 sequential failing calls = 30 throws, 0 tickets, 2 D1 round-trips each, uncapped against an already-degraded D1). Mild retry-amplification, not a blocker. | `ROADMAP.md:43(NEW-4)` | hardening | OPEN |
| P1-14 | **`GET /admin/ops/checks` unbounded queries** (F1, 2026-08-17 gate) — `provisioning-state.ts` runs 3 unbounded SELECTs (domains/domain_intents/request_idempotency) unlike its sibling `listMessagesForOperator`, which clamps+reports total. Live-measured: 50,000 rows → 200 OK with 13.8MB response. Admin-only, no data loss, but the diagnostic surface can be DoS'd against itself by a pathological tenant. | `docs/adversarial/admin-read-endpoints-gate-2026-08-17.md:34-64` | scale | OPEN (never promoted to ROADMAP ## Open — found only in the gate doc) |
| P1-15 | **`GET /admin/messages?limit=` empty-string bug** (F2) — `?limit=` with no value returns exactly 1 message instead of the 50 default (`Number("")` → `0` → floor-clamped to 1); `total` still reports correctly so it's visible, but a blank form field silently truncates results to 1. | `docs/adversarial/admin-read-endpoints-gate-2026-08-17.md:66-80` | defect | OPEN (never promoted to ROADMAP ## Open) |
| P1-16 | **`LIKE 'setup_infrastructure:%'` pattern-vs-prefix bug** (F3, latent) — SQL `_` wildcard means the filter also matches `setup?infrastructure:*` keys; live-reproduced with a planted key. Latent (no such key exists today) but will silently over-match if one is ever created. | `docs/adversarial/admin-read-endpoints-gate-2026-08-17.md:82-89` | defect | OPEN (never promoted to ROADMAP ## Open) |
| P1-17 | **msgchannel Inc4 (email mirror) — the last unbuilt increment of the founder-authorized full channel.** Founder ruled "FULL CHANNEL AUTHORIZED" 2026-08-05 for Increments 2-4 (operator route, list/ack tools, email mirror). Inc2/Inc3 shipped wave-3 (2026-08-09); a new Inc5 (agent→operator) shipped 2026-08-11. Inc4 (email opt-in mirror of the in-app message channel) was never built and has no standalone `## Open` bullet — it only survives inside the original 2026-08-05 `[IDEA]` entry's prose, which now reads as stale (2 of 3 named increments are done). | `ROADMAP.md:72` (original scope), `archive/ROADMAP-done.md:185` ("Only Inc4 (email mirror) remains unbuilt"), memory `coldstart-platform-build.md:64` | product-gap | STALE-LIKELY-DROPPED (authorized, never tracked as its own item) |
| P1-18 | **Event-driven alert class** — `alertScreeningHit`/`alertScreeningListUnavailable`/`alertRegistrarUnarmed` fire per tenant ACTION (distinct from the cron-based alert class); a tenant hammering a blocked action could storm the ops inbox by a mechanism the debounce-wave fix didn't cover. Explicitly named in the founder's 2026-08-17 widening order as still-needed. | `ROADMAP.md:24,95` | monitoring | OPEN |
| P1-19 | **Agency-scale pricing kill-in-waiting** — per-tenant fee model multiplies per client exactly like the pattern buyer-panel shoppers killed Instantly for; at 50 mbx/8 clients we currently lose on price (~$892 vs ~$605-631 winners). Agency-bundle billing design (flat per-workspace add-on) is explicitly deferred, non-blocking, out of the current billing arc. | `ROADMAP.md:21,153` | product-gap | OPEN |

---

## P2 — quality

| ID | Item | Source(s) | Category | Status |
|---|---|---|---|---|
| P2-1 | Chunking-convention inconsistency post the SQL IN-list fix — some sites use bare `.run()` per chunk, others wrap in `env.DB.batch()`; pick one convention on next touch. | `ROADMAP.md:46(c)` | hardening | OPEN |
| P2-2 | `releaseEmailClaim` now N chunked statements instead of one — a mid-loop failure would partially release held claims; unreachable today (bounded ≤10 ids). | `ROADMAP.md:46(d)` | hardening | OPEN |
| P2-3 | `maskTransitionPhrases` masks the right-hand number of a DOWNWARD transition too (e.g. "28→24 tools" hides 24) — zero corpus exposure today, semantic judgment call left open deliberately. | `ROADMAP.md:45` | claim-drift | OPEN |
| P2-4 | One-time D1 `batch()` prod-parity probe still unverified — local behavior (clean throw, never partial) assumed to hold in prod; confirm once via `wrangler d1 execute --remote` with a deliberately invalid mid-batch statement. | `ROADMAP.md:47` | hardening | OPEN |
| P2-5 | `vendor_spend_entries` metric-hygiene note — table holds 3 old rows from a pre-incident period; a prior bookkeeping pass wrongly recorded it as empty. Benign, no action, just a standing filtering caution. | `ROADMAP.md:48` | doc-stale | STALE-LIKELY-DONE (noted correct, no fix needed) |
| P2-6 | Vendor-contract capture on Mordy's first real provision (3-snapshot `/domains/list` capture) still pending — feeds P0-3's re-poll design. | `ROADMAP.md:51` | monitoring | OPEN |
| P2-7 | Module-comment inaccuracy — the fix commit's own safety claim ("discriminator is never the vendor row's own field") is only true one level deep; no reachable mislabel today, but the safety-argument sentence needs correcting. | `ROADMAP.md:52` | doc-stale | OPEN |
| P2-8 | Expired/suspended purchased domain silently REPLACED rather than surfaced — `findAdoptableDomain` requires vendor `status==='active'`, so a lapsed domain triggers a second $12.50 lookalike buy instead of telling the customer their domain lapsed. | `ROADMAP.md:54` | product-gap | OPEN |
| P2-9 | Inc-F (InboxKit programmatic OAuth) is confirmed DEAD by vendor support — customer #2+ needs a founder decision between (a) build our own Google OAuth consent flow, (b) SMTP-egress-friendly engine host + InboxKit plaintext SMTP export, (c) stay manual-mint per customer (~10 min founder-hands each). | `ROADMAP.md:55` | product-gap | FOUNDER-GATED |
| P2-10 | Downward-arrow transition-phrase semantic judgment (dup of P2-3, same entry). | — | — | (merged into P2-3) |
| P2-11 | `registerDomains` rides EVERY setup call, resetting a prior opt-in to 0 if a later call omits it — safe direction (503, zero buys) but surprising; consider explicit every-call semantics in docs. | `ROADMAP.md:78` | doc-stale | OPEN |
| P2-12 | Metric hygiene: 62/63 `tenants_index` rows are internal test/QA tenants; tag or purge so tenant-count ≠ signup-count in reports. | `ROADMAP.md:79` | monitoring | OPEN |
| P2-13 | "Fast Start" prewarmed SKU — founder authorized then said HOLD; re-confirm before starting the arc (pricing design → adapter prewarm methods → inventory-adoption path → claims copy). | `ROADMAP.md:80` | product-gap | FOUNDER-GATED |
| P2-14 | Unit-economics + self-hosted-infra study (slot headroom modeling + build-vs-InboxKit-resale breakeven) — not started, research-lane candidate. | `ROADMAP.md:20` | product-gap | OPEN |
| P2-15 | Owner spend-ceiling wiring (customer-facing cap is currently preview-only label) — priority bumped after a paying customer flagged it live. Needs to be built or the honest "preview" label needs to stay. | `ROADMAP.md:84` | product-gap | OPEN |
| P2-16 | Billing self-serve actions (change-mailbox-count, update-payment-method, cancel) not wired to the dashboard — API exists, buttons don't. | `ROADMAP.md:83` | product-gap | OPEN |
| P2-17 | Customer transactional email gap — Stripe receipts not enabled (1-click founder toggle) and welcome/activation email on checkout.session.completed not built. | `ROADMAP.md:82` | product-gap | OPEN (receipts toggle done per Now-section note, build half open) |
| P2-18 | Domain-onboarding matrix → published product copy (lookalike vs external-registrar vs CF-registrar vs BYO-mailbox honesty matrix) — drafted internally, not yet published as best-practice copy. | `ROADMAP.md:85` | doc-stale | OPEN |
| P2-19 | X-Coldrig-Send-Token header is brand-fingerprintable at real volume — decide neutral rename before the SENT-scan increment arms it. | `ROADMAP.md:86` | hardening | OPEN |
| P2-20 | Relevance-gap response (list-provenance/ICP-attestation, first-send ramp caps on new lists, sample-audit surface) — designed-but-not-built, explicit "do NOT bolt on without a design+adversary arc" note. | `ROADMAP.md:88` | product-gap | OPEN |
| P2-21 | Organic-buyer-evaluation actionables — soften/delete the "concierge activation" caveat once programmatic mint is live-verified (truth-first ordering); discovery lever re-confirmed a third time. | `ROADMAP.md:89` | doc-stale | OPEN |
| P2-22 | `doctl compute firewall update` footgun — omitting `--droplet-ids` detaches the firewall; standing operational caution, not a code fix. | `ROADMAP.md:90` | hardening | OPEN (process note) |
| P2-23 | Citation-panel weekly cloud routine has NEVER produced a run since arming — "2 weekly runs in" ledger claim was false. Needs investigation/re-arm or a local-runner replacement. | `ROADMAP.md:91` | monitoring | OPEN |
| P2-24 | Post-ship-audit minor cosmetics: stale sitemap lastmod, uninstrumented setup-completed funnel milestone, homepage headline line-break at 1440px, CF Bot-Management API needing a broader-scoped token. | `ROADMAP.md:92` | doc-stale | OPEN |
| P2-25 | Paid-conversion blind spot — "of 61 signups, how many paid" answerable via one curl the main loop is classifier-blocked from running; founder needs to run it or share ADMIN_TOKEN access. | `ROADMAP.md:93` | monitoring | FOUNDER-GATED |
| P2-26 | Stripe sandbox test-mode webhook endpoint still points at prod, producing benign "failing webhook" warning emails — fix = disable/delete the stale test-mode endpoint. | `ROADMAP.md:94` | hardening | OPEN |
| P2-27 | openapi.yaml BYO row omitted from `guide-mcp-tool-count.html` table (pre-existing gap, page headlines are hedged so not false). | `ROADMAP.md:122` | doc-stale | OPEN |
| P2-28 | Email/address-verification capability gap — no built-in list verification; at minimum document the posture in FAQ/for-agents (option a), addon/build options b/c deferred to founder ruling. | `ROADMAP.md:140` | product-gap | OPEN |
| P2-29 | Portability-at-cancellation docs — interim FAQ answer needed (what's exportable today vs pending domain-transfer-terms verification). | `ROADMAP.md:141` | doc-stale | OPEN |
| P2-30 | Compare-page ammo (fair DIY-stack math, Smartlead all-in cost, Instantly API-domain-creation gap) — several rounds of buyer-panel ammo not yet folded into the comparison pages. | `ROADMAP.md:143,204,205` | doc-stale | OPEN |
| P2-31 | `/v1/poll` non-blocking residuals: source-less-message cursor-advance (concurrent-expunge only, real errors throw safely) and UIDVALIDITY unhandled (pre-existing). | `ROADMAP.md:148` | hardening | OPEN |
| P2-32 | `domain_dns_aging` alert copy says "no mailbox will come up on it until it is replaced" even for the recoverable aging-pending arm — two-line copy fix, fold into next platform cut. | `ROADMAP.md:35` | claim-drift | OPEN |
| P2-33 | Non-finite `startWarmup` parse now throws non-retryable, leaving a created-but-unmarked warmup subscription — proper close = reorder the marker write in `mailbox-provisioning.ts`. | `ROADMAP.md:69` | defect | OPEN |
| P2-34 | Existing `reply` tool (`replyToThread`) sends with NO suppression check — defensible as 1:1 transactional, but a deliberate founder/design ruling was never made when the warm-lead build reused the shared primitive elsewhere. | `ROADMAP.md:199` | defect | FOUNDER-GATED |
| P2-35 | BYO residuals: TOCTOU on concurrent `is_primary` registrations (benign, sandbox-untriggerable today); `pending_kyc` soft-lockout with no admin KYC-clear route. | `ROADMAP.md:200(e,f)` | hardening | OPEN |
| P2-36 | AGENTS.md public tool table stale count vs live tool count — sync class, recurs every tool-count bump; needs to be folded into the standing count-sweep guard rather than caught ad hoc each time. | `ROADMAP.md:200(c)` | doc-stale | OPEN |
| P2-37 | Root-level vitest drags `apps/dashboard` React tests without a jsdom env — pre-existing harness mismatch. | `ROADMAP.md:200(d)` | hardening | OPEN |
| P2-38 | Warmup fast-follow residuals R1/R3/R4 — space warmup-cancel retries by elapsed time not invocation count; missing-`pages` field must read INCONCLUSIVE not absent (money-leaking direction); move warmup-cancel cron leg per file's own ordering rule; stale tick-era comments. **FUSE: R1+R3 must land before the first real mailbox reaches day 29.** | `ROADMAP.md:74` | defect | OPEN (time-sensitive fuse) |
| P2-39 | Volume-aware warmup ramp — `computeWarmupDay` advances by wall-clock age not actual sends, so an idle mailbox ages into the full cap with zero send history. | `ROADMAP.md:76` | defect | OPEN |
| P2-40 | Automated data-deletion pipeline (DPA follow-up) — deletion-on-termination is fulfilled manually today; no code path purges a terminated tenant's lead/campaign rows. | `ROADMAP.md:195` | product-gap | OPEN |

---

## P3 — nice-to-have

| ID | Item | Source(s) | Category |
|---|---|---|---|
| P3-1 | WARMUP_* action rows leak into the customer-facing activity feed (vendor-billing noise on a customer surface). | `ROADMAP.md:75` | product-gap |
| P3-2 | BYO-ramp tiers (primary 20/day, shortened 40/day-by-day-10) unpublished. | `ROADMAP.md:75` | doc-stale |
| P3-3 | Single source-of-truth status object for site claims — staged for founder ratification, not built. | `ROADMAP.md:75` | product-gap |
| P3-4 | Independent-review presence (G2/Trustpilot/Capterra) — founder-hands listing creation + honest pilot reviews. | `ROADMAP.md:158` | product-gap |
| P3-5 | Reply auto-classification (interested/OOO/not-interested tags) — market-evidenced feature gap, folds into the warm-lead deep-dive scope. | `ROADMAP.md:159,197` | product-gap |
| P3-6 | Canonical-scale price-band data point (comparison to $102-120/mo winner) — data-only, no pricing move implied. | `ROADMAP.md:160` | doc-stale |
| P3-7 | `setup_infrastructure` tool description says "Async — returns jobId" but runs synchronously with no tracked job record — reconcile framing when the async-saga lane lands. | `ROADMAP.md:163` | claim-drift |
| P3-8 | `apps/engine/Dockerfile` `npm install --omit=dev` still resolves devDependency registry metadata — comment is wrong on npm 8/10/11; needs a real Dockerfile PR + rebuild. | `ROADMAP.md:164` | defect |
| P3-9 | Buyer-CHOICE panel cycle 3 not yet run (gated on the Glama refresh landing / measuring the visibility fixes). | `ROADMAP.md:21` | monitoring |
| P3-10 | Tier-2 insurance discovery channels (apis.guru form, public-apis PR, extra .well-known variants). | `ROADMAP.md:167` | product-gap |
| P3-11 | Support triage is regex-only, not AI — fine today (no AI-support claim made), but must never be marketed as AI until it actually is one. | `ROADMAP.md:168(c)` | claim-drift |
| P3-12 | No per-lead tags/segments/custom fields — `leads` schema is email/first_name/company/global_status only. | `ROADMAP.md:197(b)` | product-gap |
| P3-13 | No bulk-export/CRM-sync endpoint — agent must page inbox/thread/activity manually. | `ROADMAP.md:197(d)` | product-gap |
| P3-14 | No data-retention TTL on event/reply bodies — stored in full, indefinitely; "premium data retention add-on" framing is unconfirmed in repo docs. | `ROADMAP.md:197(e)` | product-gap |
| P3-15 | `schedule_followup` tool (+ `followups` table + tick drain) remains unbuilt — must reuse the existing guarded-send primitive when built, never a second single-send path. | `ROADMAP.md:126` | product-gap |
| P3-16 | Dedicated `apps/engine` gaps: (a) missing `AbortSignal.timeout` on api-send fetches (no double-send risk today, contradicts an in-code comment); (b) revoked refresh token grades transient, wasting 5 retries before 'failed'; (c) base64/base64url test rigor gap; (d) Graph app-only user==key no fail-fast; (e) HTTP-date Retry-After ignored. | `ROADMAP.md:153` | hardening |
| P3-17 | Agency-scale send-quota-lever compare-page ammo (Instantly's own open feature request for API domain creation — our exact strength). | `ROADMAP.md:204` | doc-stale |
| P3-18 | Domain-connect footgun docs: CF-registrar-locked-NS matrix not yet published as customer-facing copy (dup-adjacent to P2-18, kept separate as it's the technical-matrix half vs the marketing-copy half). | `ROADMAP.md:85,87` | doc-stale |
| P3-19 | Dogfood campaign contact-path completion pass — top Tier-A dogfood targets have no confirmed emails; never guess. | `ROADMAP.md:185` | product-gap |
| P3-20 | `readOnlyHint`/annotation class residuals from the directory-readiness class-closure (already fixed, kept for provenance only — no action). | `ROADMAP.md:149` | doc-stale |
| P3-21 through P3-32 | Twelve additional cosmetic/doc-hygiene items scattered through the 2026-07-13 through 07-24 window (stale SPEC.md `npx coldstart` example, dev-doc brand-pass H1 titles, tools/aeo-panel dual-brand tracking already fixed, `status.html` "Early access" pill wording, guide-pages nits on the stdio-bridge config block and title-scan over-reading, SEND_USAGE_FEE_CENTS question — already resolved by the fee deletion, D6 owner-health backup/DR/key-rotation deferred, D3 remaining attorney-review gate, B2 provisioning-saga resumable-alarm backlog item, B3 VendorPort contract-test-suite backlog item). All low-severity, internal-facing, or already superseded by later work — see `ROADMAP.md` lines 92,106-109,146,155,167,171-172,175-178 for exact text. | `ROADMAP.md` (scattered) | doc-stale |

---

## FOUNDER-GATED — needs his click, ruling, or word-in-session

These are blocked exclusively on Yaakov, not on more engineering. Grouped by what kind of input is needed.

**One-click / short browser session:**
1. Gmail MCP authorization (`/mcp` → "claude.ai Gmail") — `ROADMAP.md:34`
2. GitHub 2FA on YS-projectcalc before 2026-08-28 (banner already seen) — `HANDOFF.md:25`
3. Nudge Mordy the human (his agent has been silent >48h on a spend-safe retry) — `HANDOFF.md:9,39`
4. 4 form-gated MCP directories (cursor.directory, mcpservers.org, LobeHub, Smithery) — 10-min founder-present browser session — `ROADMAP.md:33`
5. Cline real install test (icon is done; only a genuine install test remains) — `ROADMAP.md:33`
6. CF token revoke (Keychain `cf-dns-dmhadvisor`) + InboxKit support ticket v2 send — `ROADMAP.md:15,87`

**Design/scope rulings:**
7. C3 arm-gate fix direction — which of the 3 blocking defects' fix options to take (P0-2) — `ROADMAP.md:27`
8. direction-1 (resume-from-resource redesign) — approve or reject the schema-change approach to `domains` table authority — `ROADMAP.md:29`
9. Inc-F OAuth customer#2+ path: own OAuth app vs SMTP-friendly host vs stay-manual — `ROADMAP.md:55`
10. `terms.html` support@epiphanymade.com vs support@coldrig.dev — which is correct — `ROADMAP.md:26`
11. Teardown: purge customer-held transport secrets (SMTP passwords/OAuth tokens) at offboarding — `ROADMAP.md:61(b)`
12. Re-buy lane: reclaim mechanism for a permanently-wedged address burning two plan slots — `ROADMAP.md:68(a)`
13. Extend light-KYC scope to ALL first-time BYO intake (currently BYO-primary only) — `ROADMAP.md:186`
14. Pre-warmed inventory ruling (SPEC analysis done, ruling itself is the outstanding item) — `ROADMAP.md:184`
15. "Fast Start" prewarmed SKU — re-confirm go-ahead before resuming the arc — `ROADMAP.md:80`
16. Unit-economics + self-hosted-infra study — not started, needs founder prioritization — `ROADMAP.md:20`
17. `replyToThread` suppression-check ruling — deliberate design decision never made — `ROADMAP.md:199`
18. Blind agent-recommendation probe lane prioritization (5 off-site lanes named, no ranking ruling yet) — `ROADMAP.md:30`
19. Paid-conversion blind-spot curl — classifier-blocked from main loop, needs founder to run it or share access — `ROADMAP.md:93`
20. Inc5 concurrent-twin phantom-201 residual — already ruled ACCEPTED-RISK 2026-08-11, listed here for completeness only (no further action needed unless revisited) — `ROADMAP.md:43`
21. Dogfood campaign 3 founder calls: include competitors? include Jack Clark/Import AI? confirm "roast it publicly" CTA risk tolerance? — `ROADMAP.md:185`

---

## STALE-LIKELY-DONE

| ID | Item | Evidence it may already be resolved |
|---|---|---|
| SD-1 | `vendor_spend_entries` "table is empty" claim | Already corrected in the same ROADMAP entry (`ROADMAP.md:48`) — confirmed as 3 legitimate old rows, no action needed. Kept only as a metric-hygiene footnote. |
| SD-2 | Directory-shopfront stale-listing content (Glama "17 tools"/"waitlist" copy) | Multiple rounds of fixes shipped 2026-07-15 through 07-20 (`archive/ROADMAP-done.md:137`); tool-count is now single-sourced with a guard test (`site-tool-count-claims.test.ts`, 89/89 passing per `archive/ROADMAP-done.md:150`). Verify current Glama listing reflects 28 tools before assuming fully closed — not independently re-checked this pass. |
| SD-3 | Weekly citation-panel routine | `ROADMAP.md:91` still lists this as never-having-run since arming — flagging here as the opposite of stale-done (genuinely open), included to avoid a false-positive read of the "2 weekly runs in" language elsewhere in the ledger. |
| SD-4 | mcp-publisher / registry version skew (0.2.1 vs 0.2.2 vs live tool count) | Appears resolved as of the 2026-08-17 v0.2.3 registry publish (`HANDOFF.md:12,17`, `isLatest:true` verified) — the several earlier ROADMAP entries tracking this skew (lines 118, 120, 132, 154) are almost certainly closed by the more recent publish; not independently re-verified this pass. |

---

## Scale-readiness gap (founder's part-c ask, 2026-08-17)

Nothing below has been audited yet — this is a list of the specific named risk surfaces from the founder's
own order, cross-referenced against what's already known to be a live concern from other findings above,
so the eventual scale audit has a starting list rather than a blank page.

- **Cron sweep fan-out** — `scanTenants` awaits `opsSummary` per tenant *sequentially* with no
  `AbortSignal`/timeout (P1-2); at ~63 tenants today this is invisible, at hundreds it is the exact
  mechanism that would starve the whole cron.
- **DO/D1 contention** — `watchtower_state` full-table reads every 5 min (P1-1); the SQL IN-list
  bound-param class was already found+fixed once (closed) but is evidence the pattern exists elsewhere;
  worth a fresh sweep at scale-relevant row counts.
- **InboxKit rate limits + slot-tier laddering** — documented ladder exists (Professional → Agency at
  ~25 mbx → Enterprise at ~80, `ROADMAP.md:17`) but headroom modeling (P2-14) was never done; 10-slot
  subscriptions cap ~2 concurrent 5-mbx customers before a second subscription is needed.
- **Engine capacity** — single droplet (142.93.12.85), no load/capacity testing done at any point in the
  read sources; Node engine's 443-transport concurrency limits are unmeasured.
- **Alert/digest volume** — the alert-policy debounce wave (shipped 2026-08-16) tuned per-tenant alert
  cadence but was not designed against hundreds-of-tenants aggregate volume; the admin-ops-checks endpoint
  is itself now known-unbounded (P1-14) at exactly the row counts hundreds of tenants would produce.
- **Stripe webhook throughput** — no evidence in any source of load-testing the webhook handler path
  under concurrent delivery; the per-lane watermark fix (wave-2) addressed correctness, not throughput.
- **Support-digest size** — `GET /admin/support/digest` size/pagination behavior at scale is unaudited.

---

## Method notes / what wasn't covered

- Read in full: `ROADMAP.md` (all 208 lines/entries), `HANDOFF.md`, `archive/ROADMAP-done.md` sections
  dated 2026-07-22 onward (4 "Drained" sections), the memory file's full session log, two prior-HANDOFF.md
  files (08-13, 08-16), and the newest adversarial gate doc in full.
- Grepped/spot-checked rather than fully read: the other ~78 `docs/adversarial/*.md` files. This is
  defensible because ROADMAP.md's project law (`CLAUDE.md`: "fold conclusions into these") means nearly
  every non-blocking finding from those gates is already quoted verbatim into `ROADMAP.md ## Open` — I
  spot-verified this pattern held on several gates (alert-policy, agent-channel-product-audit, the six
  class-sweep docs) and it held every time. The two exceptions found (P1-14/15/16, admin-read-endpoints
  gate) suggest a small residual risk that 1-2 more recent gates might have similarly-orphaned findings;
  a full sweep of all 80 adversarial docs was out of this pass's budget.
- Not read: the 6 class-sweep docs' individual member lists (~75 members) — deliberately, since they're
  already scoped into Trains 1-5 and re-deriving them here would risk exactly the double-counting the
  brief warned against.
- Not read: `docs/research/*.md` frozen research docs (cited extensively by ROADMAP but not separately
  mined for additional open items — their conclusions are folded into ROADMAP entries already captured).
