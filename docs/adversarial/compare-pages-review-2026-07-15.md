# Adversarial review — 5 competitor comparison pages (2026-07-15)

**Reviewer:** adversary (fresh context) · **Verdict frozen against:** git HEAD `0a87f7c1`, page bytes as of mtime 17:50:27 (editing settled ≥4 min idle at 17:54).
**Scope:** `site/compare-vs-{agentmail,skyp,foxreach,maildoso,smartlead}.html` (all untracked/new) + wiring diffs `site/{compare.html,llms.txt,sitemap.xml}`.
**Grounding:** `docs/research/competitor-pages-research-2026-07-15.md`, `tools/buyer-panel/runs/2026-07-15-claude-canonical.md`, ROADMAP "Send-framing pricing copy" ruling, `site/compare-vs-salesforge.html` (house template). Live-fetched all 5 vendor pricing pages + Smartlead helpcenter MCP article on 2026-07-15.

## VERDICT: SHIP (fix round verified 2026-07-15, 18:02:21)

Round 1 was NO-SHIP on one BLOCKING finding (B1, below). The builder applied the fix round; I re-attacked it fresh (grep + read + recompute + regression ring) and all items verify clean. **Verdict flipped to SHIP.** See "Fix round" at the bottom for the verification evidence. The original round-1 findings are retained below as the frozen record of what was found.

### Round-1 verdict (superseded): NO-SHIP
One BLOCKING finding: internal repo file paths leaked into public HTML (brief attack #3, explicitly prohibited). Trivial reword of 5 references on 3 pages — everything else passed, much of it unusually well.

---

## Findings (most severe first)

### BLOCKING

**B1 · attack #3 · Internal repo file paths printed in public HTML.**
`tools/buyer-panel/runs/2026-07-15-claude-canonical.md` (and `...-agency.md`) appears verbatim in `<code>` in the visible body and Sources of three pages:
- `compare-vs-agentmail.html:57` (body callout) and `:122` (Sources)
- `compare-vs-foxreach.html:130` (Sources)
- `compare-vs-smartlead.html:85` (body disclosure) and `:137` (Sources, two paths)

Brief attack #3: "Buyer-panel citations must not leak internal file paths into public HTML." Per the brief's rubric (CONFIRMED violation = BLOCKING unless noted; #3 not noted), this blocks. Beyond the rule: these paths are unfetchable by any reader, yet they are the *sole* citation for the most damaging competitor claims on each page (AgentMail category-rejection, FoxReach review-absence, Smartlead reliability). On pages whose entire pitch is "every number sourced and verifiable," a dead-end citation actively undercuts the thesis for the exact buyer agents these target.
**Verification:** grep of current on-disk files (not stale) + read of cited run file.
**Fix:** reword to "our own internal buyer-agent research run" with no path. (The paired sub-requirement of #3 — reported claims hedged, never asserted as fact — is otherwise well satisfied; see H-tone below.)

### NON-BLOCKING

**N1 · attack #2 · Smartlead agency-example printed equation is wrong.** `compare-vs-smartlead.html:114`: "$174/mo (Unlimited Smart license) + 8 × $29/mo (client workspaces) = $232/mo" — literally $174 + $232 = $232, false; $232 is only the 8×$29 workspace subtotal (license dropped). The final all-in ≈$605–$631 IS correct ($174 + $232 + $199.50–$225). Direction is a concession section (Coldrig loses on agency price), so not self-serving, but a number-checking buyer agent flags the equation. Fix: restructure to "$174 + $232 (8×$29) = $406, + $199.50–$225 mailboxes = ≈$605–$631."

**N2 · attack #2 · Coldrig agency counter-figure range is unsupported.** `compare-vs-smartlead.html:117`: Coldrig at "8 separate tenant accounts … 50 mailboxes total" quoted as "$650–$900/month … depending on how mailboxes are distributed." Under Coldrig's own linear formula ($49/account + $10/mailbox) the figure is fixed at 8×$49 + 50×$10 = **$892**, distribution-invariant. The "depending on distribution" rationale is wrong and the $650 low end is unreachable — it understates Coldrig's own agency cost (mildly self-flattering, though the page still concedes the loss). Fix: state ~$892, drop the range/rationale.

**N3 · attack #6 · Smartlead reliability claim is the highest legal-sensitivity content.** `compare-vs-smartlead.html:85` quotes the buyer run: "recurring G2/Reddit-documented reliability issues (send failures, warmup pausing, slow support)." The "G2/Reddit-documented" sub-claim's primary source is not preserved in the run file (query #23 searched it; findings not captured), and the page's only citation is the leaked internal path (B1). Heavily hedged ("reported … not independently re-verified … not a claim we're asserting as fact"), so probably legally defensible — but recommend, in the B1 edit pass, either linking an actual G2/Reddit primary source or trimming to just the verifiable support-ticket gate. Faithfully quotes the run (run line 52 == page line 85).

### Micro-nits (optional)
- `compare-vs-smartlead.html:69` "SSE transport only (HTTPS not yet supported)" — SSE runs over HTTPS; the helpcenter article means Streamable-HTTP transport isn't supported yet. Loose phrasing, competitor-neutral.
- `compare-vs-smartlead.html:114` domain estimate "~$65/year" for 5 Google mailboxes assumes 1 domain/mailbox (5 domains), inconsistent with the same page's "one domain per 2–3 mailboxes"; inflates Smartlead's add-on cost ~$39/yr. Labeled "roughly," competitor-unfavorable direction.

---

## Attacks that failed (why the PASS on everything but B1 is meaningful)

**#1 competitor-number accuracy — CLEAN (live-fetched every vendor).**
- Skyp: $149/$499/$1,199 annual & $199/$599/$1,499 monthly, 3/10/30 managed accounts + 1/5/15 domains, 1,500/5,000/15,000 capacity — all match skyp.ai/pricing. **MCP-at-Pro CONFIRMED**: "MCP, API, and webhooks" bullet sits inside the Pro ($149) feature block, before "Most popular / Team / $499." The page (skyp:61) also correctly traces the two conflicting buyer-run readings ("Teams $149", "~20 emails/day cap") to their real sources — Pro≠Team name-vs-price conflation, and "20 emails/day" is Skyp's generic educational-FAQ copy, not a plan cap. The flagged "two shoppers read this differently" concern is resolved on-page, correctly.
- Smartlead: $39/$94/$174/$379, 6,000/90,000/150,000/500,000 sends, 2,000/30,000/unlimited contacts — match live. "0 mailboxes included" backed by live FAQ ("unlimited email accounts at no extra cost … connect as many"). SmartSenders $13/$4.50, $16/$5, $19/$3.99, $18/$9 — **exact** match live. $29/mo whitelabel workspace, Pro+, 3 free on Prime — match live FAQ. First-party MCP `mcp.smartlead.ai`, SSE-only — confirmed via helpcenter article ("works only via SSE for now").
- AgentMail: $0/$20/$200, 3/10/150 inboxes, 3,000/10,000/150,000 emails, 100/day Free cap (live "Emails/day" row), 3GB/10GB/150GB, 10/150 domains, SOC 2, $6M seed GC/YC S25 — all match.
- FoxReach: $0 / $34($27) / $89($71) / $169($135), 200/5k/50k/200k contacts, 500/10k/100k/500k emails, unlimited accounts, API-gate at Growth $89 — match; both billing bases labeled.
- Maildoso: $0.49–$2.50/mbx, 30/$75·300/$225·1000/$499, 15-cold/day, $12/yr domain, 30-day guarantee, llms.txt+server-card 404 — match.

**#2 normalized math — CLEAN on load-bearing tables.** Maildoso cost-per-100-sends/day recomputes exactly: $75/4.5=$16.67, $225/45=$5.00, $499/150=$3.33; Coldrig $99/1.5=$66.00, $249/6=$41.50, $649/18=$36.06. Coldrig per-mbx $19.80→$10.82 and effective-$/mbx vs Skyp $49.67/$49.90/$39.97 exact. The 30-sends/day planning assumption is Coldrig's OWN published number (`pricing.html:103` "30 campaign sends per mailbox on 22 sending days" → ≈3,300/mo), consistently applied — not invented for the comparison. Coldrig tier prices all satisfy $49 + $10×N. (Wrinkles N1/N2 are in the new agency section only.)

**#4 Coldrig claim classes — HELD.** Every page carries an explicit "real sending is not active yet" decision-table row + early-access footer + "Free sandbox — simulated pipeline, no real spend." No bare "unlimited" for Coldrig (all "unlimited" = attributed competitor claims). Send-framing ruling applied: "No send quota" headline axis, ≈3,300 demoted to second position with the non-contractual planning-guidance qualifier. Pricing exactly "$99/5 then $10." No webhooks/AI-support/deliverability-guarantee claims for Coldrig. server-card.json + llms.txt claims backed by real files.

**#5 fairness/slop — HELD (strong).** Every page has a substantive "Where [competitor] is honestly stronger" section grounded in the research doc's honest-wins lists; Smartlead and Maildoso pages explicitly concede price/agency losses. No manufactured praise conceding a row Coldrig actually wins.

**#6 tone/disparagement — HELD** except the flagged N3 risk. No mockery, no motive speculation; opinions framed as opinion, competitor claims attributed to the competitor's own marketing (e.g., Smartlead 170k/$30M/50% case studies "attributed to Smartlead's own marketing, not independently verified by us").

**#7 mechanical — HELD.** JSON-LD parses on all 5 (TechArticle). Tags balanced (table 2/2, ul 5–6 matched, main 1/1). All 24 internal link targets exist under clean-URL routing. Wiring diffs correct & complete: compare.html +5 comparison links, llms.txt +5 entries, sitemap.xml +5 `<url>` (priority 0.9, real paths).

---

## UNVERIFIABLE / resolved-in-flight
- **Pages rewritten mid-review.** Opening mtimes 17:34–17:39 → all five 17:49–17:50; the builder added the early-access "real sending not active" row to every page and expanded Smartlead (agency-scale section + corrected the MCP row from a stale "not found as first-party" to the confirmed `mcp.smartlead.ai` first-party). Editing settled 17:50:27 (idle ≥4 min at 17:54); build task #41 flipped to completed during the review. Verdict is frozen against that state. **If any page changes before commit, re-confirm the B1 path-leak fix.**
- Smartlead case-study numbers (170,000 lead replies / $30M / 50% reply) not independently verified — framed on-page as Smartlead's own marketing claims (generous-to-competitor direction), low risk.

## NEW (out-of-scope) observations
- None affecting these pages. (The stale `$299/$799` support-KB tiers noted in a prior coldstart review are main-side, unrelated.)

---

## Fix round — verification (2026-07-15, files @ 18:02:21; re-attacked fresh, all clean)

**B1 (blocker) — RESOLVED.** `grep -rn -E 'tools/buyer-panel|runs/2026'` across all 5 pages → 0 hits (exit 1). Only the 3 leaking files changed (agentmail 13335→13251, foxreach 13565→13513, smartlead 18043→18168; skyp/maildoso untouched — correct). Reworded to "our own internal buyer-agent research run (blind shopper, 2026-07)" at all 5 sites (agentmail:57/:122, foxreach:130, smartlead:85/:137). Reads as honest first-party attribution — "our own internal" keeps it unambiguously first-party, and "blind shopper" accurately characterizes the buyer-panel run (run file confirmed `coldrig`=0 hits, a genuine blind discovery). Not a fabricated-external-source dodge.

**N1 — RESOLVED.** smartlead:114 now shows the full correct chain: `8 × $29 = $232 → $174 + $232 = $406/mo before mailboxes, + $199.50–$225 (50 mbx) = ≈$605–$631`. Recomputes exact.

**N2 — RESOLVED.** smartlead:117 now states the exact fixed **$892/mo** (`8 × $49 + 50 × $10 = $392 + $500`), with distribution-invariance explicitly stated. Higher and exact vs the old vague $650–$900 range — a more honest concession.

**N3 — RESOLVED (clean trim).** smartlead:85 reliability enumeration ("send failures, warmup pausing, slow support") removed; quote trimmed to the attributed-reported SmartSenders support-ticket gate only; explicit clause added: "(A separate reliability claim … not repeated here because we could not preserve a checkable primary source for it.)" Bottom-line (smartlead:121) repointed from "reliability caveats" → "SmartSenders access-gate caveat." Orphaned-reference grep (`send failures|warmup pausing|slow support|reliability issue|G2/Reddit|reliability caveat`) → none. The remaining support-ticket-gate claim keeps its honest "reported … not independently re-verified … not asserted as fact" framing.

**Regression ring (3 edited files):** JSON-LD parses VALID (TechArticle) on all 3; tags balanced (agentmail table 2/2, ul 5/5, em 2/2; foxreach & smartlead table 2/2, ul 6/6, em 1/1; main 1/1 each). Removing the path from agentmail:57 left the sentence grammatical. No new claim, no broken link, nothing introduced.

**Final: SHIP.**
