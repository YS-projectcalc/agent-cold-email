# Post-ship audit — 2026-07-27

Founder-requested 2026-07-12, due 2026-07-26 (`ROADMAP.md:115`). Read-only pass on code + live systems (Cloudflare API/GraphQL, live D1, curl, public search). No code changed; no live systems mutated. Scope items (a)-(h) below match the ROADMAP entry verbatim.

## (a) Citation-panel trend review

**Finding: the ROADMAP entry's "2 weekly runs in" is wrong.** `tools/aeo-panel/runs/TREND.md` has exactly **one row** — the 2026-07-12 baseline (0% mention/cite/clickable across 46/46 queries, pre-publication). No live aeo-panel measurement cycle has ever been run since baseline. `tools/aeo-panel/runs/` contains only `TREND.md`; there are no per-cycle run files.

What *did* run twice is a different instrument: the buyer-CHOICE panel (`tools/buyer-panel/`), 2026-07-15 and 2026-07-19, 3 briefs each (6 runs total), all Claude-side. Its own `CHOICE-TREND.md` is current and well-kept. The two panels appear to have been conflated when the ROADMAP line was written — the citation panel (mention/cite/clickable across 46 frozen queries) is the one still stuck at n=1.

**Buyer-panel cross-reference (cycles 1-2), which does explain the discovery failures:**

| date | brief | surfaced? | how | kill reason |
|---|---|---|---|---|
| 07-15 | canonical | NO | — | never surfaced |
| 07-15 | starter | YES | organic, via Glama listing | "no published pricing... waitlist" (Glama's stale copy) |
| 07-15 | agency | YES | organic generic query | "not yet available for real sending," no published pricing |
| 07-19 | canonical | NO (2nd consecutive) | — | never surfaced |
| 07-19 | starter | YES | WebSearch snippet only, no fetch | stale cached phrase "no live production deployment... no real customers" |
| 07-19 | agency | YES | direct Glama page fetch | Glama's cached pre-reframe copy: "test mode... no real sending" |

Pattern, consistent across both cycles: **every organic surfacing came through the Glama directory listing, never through a Google/Bing/direct-site path** — because (per (c) below) Google/Bing don't have us indexed at all. And even when a buyer agent does find us via Glama, it kills us on **stale cached listing text** describing a pre-reframe state (no real sending, no pricing) that is no longer true of the live site. Canonical-scale (the mid-size buyer persona) has NEVER surfaced us in either cycle — that's the single biggest visibility gap of the three brief scales.

**Verdict:** citation-panel (aeo-panel) trend review is a **no-data verdict** — re-run it, it hasn't moved since baseline. Buyer-panel trend is real and its lesson is: (1) directory re-sync (Glama) is the only working discovery channel today, and (2) stale directory-listing cache is now the dominant kill reason, worse than the original "not live" objection which is fixed.

## (b) Cloudflare crawler analytics (AI-bot fetches) + human traffic

Ran directly against the Cloudflare GraphQL Analytics API for the `coldrig.dev` zone (`f27e38034a07ac3e648a21331b807568`), using the account's existing wrangler OAuth token (has `#analytics:read` on this zone — confirmed via `GET /zones?name=coldrig.dev`). Free-plan `httpRequestsAdaptiveGroups` caps each query at a 1-day window and data older than ~8 days is rejected, so this is 3 non-contiguous 1-day snapshots inside the last week, not a full daily time series:

| window (UTC, ~1 day) | total reqs | ClaudeBot | GPTBot | OAI-SearchBot | PerplexityBot | Googlebot | Bingbot | meta-externalagent |
|---|---|---|---|---|---|---|---|---|
| 07-20→07-21 (6d ago) | 611 | 23 | 10 | 1 | 0 | 10 | 14 | 0 |
| 07-22→07-23 (4d ago) | 690 | 29 | 5 | 11 | 7 | 31 | 6 | 7 |
| 07-26→07-27 (today) | 639 | 6 | 1 | 1 | 5 | 6 | 0 | 10 |

Every one of these bot hits sampled returned `edgeResponseStatus: 200`. All 7 named AI/search crawlers (ClaudeBot, GPTBot, OAI-SearchBot, PerplexityBot, Googlebot, Bingbot, meta-externalagent/Meta AI) are **actively and repeatedly crawling the site every day**, unblocked. Applebot (8/day) also present. The rest of the ~600-700 daily requests are a mix of real human traffic and non-AI noise — a large chunk is vulnerability-scanner traffic (`/wp-admin/install.php` probes from DE/SE/NL/GB, ~150+/day combined; `CensysInspect`; misc scanners) that inflates the raw "non-bot-UA" count, so true human-visitor volume is meaningfully lower than "total minus named bots" would suggest — I did not attempt to isolate it further (would need Bot Management's `botScore` field, which this token can't read — see (e)).

**This is new, useful evidence for the standing index-absence question:** crawlers ARE fetching the site daily and successfully (200s), yet (c) below shows zero Google/Bing/DuckDuckGo index presence. Crawl ≠ index here — consistent with the 07-23 ROADMAP conclusion ("domain age/authority, not a technical block") rather than any fetch-side problem.

## (c) GSC/Bing indexation status

Re-checked from outside, same method as the 07-21 ROADMAP entry, for freshness:

- DuckDuckGo (Bing-fed), `site:coldrig.dev` via `html.duckduckgo.com/html/?q=site%3Acoldrig.dev`: **"No results found for site:coldrig.dev"** — unchanged from 07-21, still zero.
- Google direct fetch of `google.com/search?q=site:coldrig.dev`: served an interstitial ("if Google Search isn't working...") — same captcha/automation-block pattern noted for Bing on 07-21, just now on Google's side too. Not a usable read either way; no evidence of ranking presence to report.
- Claude's own WebSearch tool for `site:coldrig.dev` returned zero coldrig.dev results (only unrelated "cold"/"coldrig"-named third parties — DeviantArt, TikTok, Wikipedia ColdFusion, etc.).

No new information beyond what's already frozen in ROADMAP.md's 07-23 "GSC STATUS CORRECTED" entry (property verified, sitemap submitted + Success/35 pages, homepage individually confirmed indexed by the founder's GSC screenshot, category-term ranking absent — attributed to domain age, not a technical block) and the 07-21 "Indexation re-checked from outside" entry. **I could not independently re-verify the GSC-side "homepage indexed" claim** — that requires the founder's own GSC login, which I don't have. From the outside, the site is still not surfacing on any of the three engines I can query directly.

**Verdict: unchanged since 07-23.** Zero external-facing regression, zero external-facing improvement. The remaining accelerants are still exactly the founder-click items already on the ledger (`## Now` founder click queue: GSC URL-Inspect Request-Indexing batch on ~10 money pages, Bing Webmaster verification-status check) — nothing new to add here.

## (d) Design-pass QA — human-visitor polish

Live Playwright screenshots, desktop (1440×900) and mobile (390×844), homepage and pricing page (the two highest-traffic money pages):

- Homepage: clean, consistent design system on both breakpoints — no overflow, no broken components, mobile nav/hero/feature-card stack all render correctly. One minor cosmetic nit: the "Brief it like a teammate. Inspect it like a system." section headline has an unusually narrow text measure that produces an awkward line-break (orphaned single word "a" on its own line) on desktop — cosmetic only, not a regression, low priority.
- Pricing page: the interactive mailbox-count slider/estimator renders and defaults correctly ($99/mo at 5 mailboxes) on both breakpoints; tier cards, FAQ accordion, and footer all hold structure at mobile width.

**Verdict: no design regression found.** The "human-visitor polish holding the extraction structure" concern (that AEO-oriented markup/content changes might have degraded the visual experience) does not reproduce on the two pages spot-checked. Screenshots saved at `/private/tmp/claude-503/-Users-yaakovscher/a65595b1-39df-45fb-a15c-1b86e31516e1/scratchpad/audit-shots/` (session scratchpad, not part of this repo).

## (e) coldrig.dev wiring + zone AI-bot-block settings verification

**Fetch-side (verified, no regression):** curled `coldrig.dev/` and 3 money pages (`pricing`, `compare-vs-smartlead`, `guide-cold-email-with-ai-agent`) with a plain Chrome UA, a spoofed `GPTBot/1.4` UA, and a spoofed `ClaudeBot/1.0` UA. **All 9 requests returned 200** (the `.html`-suffixed URLs 308-redirect to their clean-URL form first, then 200 — that's the site's own URL-canonicalization, not a bot block; confirmed by following redirects). `robots.txt` is still permissive (`Allow: /`, only `/unsubscribe` and `/why-email` disallowed) and `sitemap.xml` is present, listed in robots.txt, and returns 35 `<loc>` entries. **The 2026-07-16 ROADMAP item ("ChatGPT and Claude search could NOT fetch coldrig.dev") does NOT reproduce today** — matches the standing "hypothesis dead, site was fetchable all along" conclusion.

**Zone-settings API (still blocked, same as before):** attempted `GET /zones/{zone}/bot_management` → `{"success":false,"errors":[{"code":10000,"message":"Authentication error"}]}`. Attempted `GET /zones/{zone}/settings/security_level` → `{"success":false,"errors":[{"code":9109,"message":"Unauthorized to access requested resource"}]}`. **This confirms the standing finding is still true 11 days later: the current wrangler OAuth token cannot read zone-level Bot Management or Security settings**, even though it *can* read zone metadata and GraphQL Analytics (different permission grant). Sitemap `lastmod` dates are stale (`2026-07-14`/`2026-07-15` on all 35 URLs) despite real content changes since (brand sweep 07-23, pricing changes) — worth regenerating at the next site deploy, low priority.

**Verdict:** wiring is fine and live-verified; the settings-read gap is a token-scope limitation, not a live problem — (b)'s crawler-analytics data (all bots getting 200s) is independent proof there's no live AI-bot block regardless of not being able to read the dashboard toggle directly. **BLOCKED (needs founder dashboard):** confirming the *Security → Bots* toggle state directly requires either the founder's own CF dashboard login, or minting a new API token with `Zone Settings:Edit` + `Bot Management:Edit` scopes — same ask as 07-16, still outstanding, still not required for site function.

## (f) Deferred-paywall funnel numbers (signups → setup-completed → checkout)

**Signups:** live-queried (remote, not local dev) D1 `coldstart-platform-db`:
```sql
SELECT plan, status, COUNT(*) as n FROM tenants_index GROUP BY plan, status;
-- → plan='demo', status='active', n=61
```
**61 total signups to date.** Caveat, straight from the code's own comment (`src/engine/ops-summary.ts:8`): `tenants_index` is "D1's (possibly stale — see db.ts's insertTenantIndex, never updated post-signup) mirror of plan/status" — it's a write-once snapshot taken at signup time, so it will show `demo`/`active` forever regardless of what a tenant does afterward. **61 is a real, correct count of signups; it says nothing about what happened next.**

**Setup-completed and checkout:** the authoritative state (`billing_state`, plan tier, provisioning progress) lives only inside each tenant's own Durable Object (`tenant_profile` table), reachable only via `TenantDO.opsSummary()` RPC — by design (ARCHITECTURE.md: "D1 = control-plane index only"). There is exactly one place that aggregates this cross-tenant: `GET /admin/ops/digest` (`src/routes/admin-ops.ts:37`, logic in `src/admin/ops-sweep.ts:199`), which returns `tenants.activeByPlan` (paid-tier counts = checkout completions), `mrrCents`, `pastDueCount`, `lifecycle.{canceled,terminated,disputed}`. **I don't have `ADMIN_TOKEN`** (confirmed: `.dev.vars` has the key present with an empty value locally, and `wrangler secret list --remote` confirms it exists as a live Worker secret I can enumerate the name of but not read) — so this endpoint is unreachable from this read-only audit.

There is also **no "setup-completed" milestone anywhere in the schema or code** — I grepped for it and it doesn't exist as a tracked field. Even with `ADMIN_TOKEN` in hand, the digest would answer "signups" (61) and "checkout-completed" (via `activeByPlan`), but the middle funnel stage genuinely isn't instrumented.

**Verdict: partially BLOCKED, partially a genuine gap.**
- Signups = 61, confirmed live.
- Checkout-completed = **BLOCKED (needs founder or ADMIN_TOKEN access)** — the exact command to close this gap: `curl https://agent-cold-email-api.yaakovscher.workers.dev/admin/ops/digest -H "Authorization: Bearer $ADMIN_TOKEN"`, read `tenants.activeByPlan`.
- Setup-completed = **not instrumented at all**, not a blocked-read, an actual missing metric.

## (g) Engine defect-class guards re-check (soft-bounce streak + idempotency ledger)

Ran the relevant test files directly against current `main`:
```
Test Files  8 passed (8)   [deliverability×4, bounce-severity, idempotency, provision-idempotency, reply-processor]
     Tests  46 passed (46)
```
Then the full platform suite for a blast-radius check:
```
Test Files  116 passed (116)
     Tests  817 passed (817)
Duration  222.54s
```
Soft-bounce streak lives in `apps/platform/src/engine/reply-processor.ts` (not `deliverability.ts` — that file only reports the resulting rate): `SOFT_BOUNCE_SUPPRESS_THRESHOLD = 3` (line 16), cumulative-until-reply by design (line 172: "absence-of-bounce is unobservable here"; `tick.ts:421-425` explicitly notes a send must NOT reset the streak, or the threshold becomes unreachable), reset only on positive engagement. Idempotency ledger (`src/engine/idempotency.ts`, `withRequestIdempotency`) claims synchronously before the first `await` — both guards' tests are green and match the documented design.

**Verdict: holding.** No regression found in either guard. (Note: this re-confirms the *tests* pass, which is the audit's stated scope — it is not a fresh adversarial attack on the guards; the class-sweeper's `idempotency-at-least-once-surfaces.md` reference doc lists other known non-idempotent surfaces — Stripe usage-record double-bill risk, `manual-reply:...:${now}` self-defeating key, fresh-`newId()` retry double-inserts — that are a **different, already-catalogued class**, out of this audit's two named guards but worth the founder knowing they're still open, filed reference only, not new.)

## (h) grep.app indexation recheck

Attempted `grep.app/api/search?q=agent-cold-email` and `grep.app/search?q=%22agent-cold-email%22` via direct fetch: **both returned HTTP 429 (rate-limited)** on every attempt (3 tries, two different endpoints). WebSearch for `site:grep.app coldrig OR agent-cold-email` returned no grep.app hits, but that tool does semantic search rather than a literal site: filter, so it's not a reliable negative signal either way.

**Verdict: INCONCLUSIVE this session** — could not get a clean re-read due to rate-limiting, so there's neither confirmation nor refutation of the 07-14 "NOT-INDEXED" status. No regression evidence, no improvement evidence. Per the ROADMAP note, there's still no on-demand seed mechanism for grep.app (it indexes public GitHub repos on its own crawl schedule) — nothing actionable changes here regardless of the read.

---

## Ranked "what would move discovery most"

1. **GSC URL-Inspect → Request Indexing on the ~10 money pages, + Bing Webmaster sitemap submit/verification check.** *Founder click* (~10-15 min). This is the one lever every other finding in this audit points back to: (b) proves crawlers already reach every page fine, (a)'s buyer-panel data proves the ONLY working discovery path today is a directory (Glama), and (c) confirms zero index presence outside that. Nothing else on this list matters if the pages aren't in the index to be surfaced from.
2. **Force a Glama listing re-sync / re-crawl to purge the stale "no real sending / no pricing / test mode" cached copy.** *Founder click* (Glama's own re-sync button on the claimed listing, or contact their support if there's no self-serve refresh). This is now the single highest-value fix in the buyer-panel data: it's not that shoppers can't find us — Glama IS surfacing us — it's that the copy Glama shows them is stale and pre-emptively kills us on an objection ("not live," "no pricing") that's been false since before 07-15. Two consecutive cycles killed on cached text, not on anything currently true about the product.
3. **Get `ADMIN_TOKEN` access (or have the founder run one curl) to close the checkout-conversion blind spot, and separately decide whether "setup-completed" is worth instrumenting as a real funnel stage.** *Founder action* — either share the token for a one-time read this session, or run `curl .../admin/ops/digest -H "Authorization: Bearer $ADMIN_TOKEN"` and paste the `tenants.activeByPlan`/`mrrCents`/`pastDueCount` fields back. Right now nobody — founder included, as far as this audit found — has an easy answer to "of the 61 signups, how many actually paid," and that's the single most important pilot-health number missing from the ledger.

Everything else in this audit (aeo-panel's stale TREND.md, the sitemap `lastmod` staleness, the design nit, the grep.app 429s, the zone-settings token-scope gap) is real but lower-leverage than these three — noted above for the record, not re-ranked here.
