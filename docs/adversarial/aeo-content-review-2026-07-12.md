# Adversarial Review — SEO/AEO Content Batch (FROZEN record, 2026-07-12)

> Frozen adversarial record. Reviewer: fresh-context opus adversary agent. Target: the uncommitted SEO/AEO backlog build (items 1/2/3/4/6 of `docs/research/aeo-backlog-2026-07-12.md`): 4 new pages + `site/assets/domain-calculator.js` + 5 retargeted pages + sitemap/llms.txt/style/README. Ground ref at review time: HEAD `d4937ce` on main, work in the uncommitted working tree.

## VERDICT: SHIP-WITH-FIXES — 0 blocking, 5 non-blocking

All fixes prescribed were applied by the orchestrator on 2026-07-12 immediately after the verdict (see Resolution below).

## Grounding sweep (all GROUNDED)

Every competitor-specific claim traced to a frozen research doc, attributed, non-disparaging:
- Tool counts (Smartlead 116+/113-142, Instantly 31-38) → `agent-search-queries-2026-07-12.md:24,25,111,112,194,198`.
- Deliverability figures on compare-vs-smartlead-instantly.html:77 → agent-search-queries:26,110,196; framed "reported by others (not our benchmark)".
- LeadMagic repo "archived Feb 2026" → agent-search-queries:82,165,194; framed as caveat.
- Woodpecker $20/mo MCP add-on (guide-mcp-tool-count.html:53) → `pricing-landscape-2026-07-12.md:20,45` (primary source woodpecker.co/pricing, fetched 07-12). The apparent conflict with agent-search-queries:143 ("no MCP/agent-grade API") is a probe's shortlist judgment superseded by the dedicated pricing research.
- Mailforge 63%/Inboxkit competitor-authored figure: appears NOWHERE in site/ (grepped). Held.
- Coined brand words (coldrig/coldpipe/coldloop) + tier prices ($99/$299/$799): CLEAN across all new pages + calc JS.

## Ruling: calculator 30 sends/mbx/day vs SPEC §18 ~40–50

NOT a site self-contradiction: SPEC's 40–50/day never appears on a public page; the public deliverability guide states 25–40/day (week-4 warmup endpoint) and the calculator's 30/day ties to that. 30/day is conservative (over-provisions mailboxes vs SPEC's cap basis). **Orchestrator decision 2026-07-12: keep 30/day deliberately** — conservative is the safe direction for deliverability planning.

## Findings + resolution

- **F1** guide-domains-inboxes-warmup-compliance.html:57 + domain-calculator.js:5-6 — "matching this platform's own Growth/Scale tier ratios" was FALSE (both tiers are 3.33 mbx/domain, not 3; at 20 mbx the calc says 7 domains vs Growth's 6 bundled). **FIXED**: tier claim dropped; basis now cited to the researched "2-3 mailboxes per domain" figure (agent-search-queries:54).
- **F2** same files — "the midpoint of the 25-40/day range" was arithmetically wrong (midpoint is 32.5). **FIXED**: reworded to "a conservative figure within the 25-40/day range" (both places).
- **F3** 30/day vs SPEC divergence — ruled non-blocking; resolved by deliberate decision above (keep 30).
- **F4** guide-mcp-tool-count.html:48 — the "one-tool-per-CRUD-verb" decomposition of Smartlead's 116 tools is an unverified inference (research lists categories, never enumerates). Hedged and softened on the page; ACCEPTED as editorial argument, no change. Load-bearing claim — revisit if Smartlead publishes a tool list.
- **F5** guide-infrastructure-vs-sending-platform.html:55 — "paired with a poorly-matched sending setup" causation was added beyond the source (agent-search-queries:113 says only "bought 30 accounts, all went to spam"). **FIXED**: tightened to the source.

## Attacks that failed (meaningful passes)

Calculator math exact vs worked examples (100→4/2, 500→17/6, 2000→67/23) + edge-case guards hold; GDPR gap honestly disclosed; all 12 MCP tools real, unbuilt ones labeled; JSON-LD parses (Article/TechArticle/FAQPage/HowTo); all internal links/anchors resolve; sitemap+llms.txt match real files; retargeted titles embed verbatim panel queries.

## UNVERIFIABLE pre-publish (carry to post-deploy)

- Live-surface drive: calc render/submit in a real browser, brand.js runtime swap, Cloudflare extensionless routing for the 4 new URLs — run a Playwright pass once published. (Local static-serve screenshots taken pre-commit by the orchestrator; extensionless routing remains deploy-only.)

## Out-of-scope cautions (no verdict weight)

- `pricing-landscape-2026-07-12.md:20` flags Woodpecker's ANNUAL-DISCOUNT figure "suspect — reverify" before any future page cites Woodpecker base/annual pricing (the $20 add-on figure is solid).
- New page `<title>`s hardcode the `agent-cold-email` slug rather than the `{{BRAND}}` token brand.js swaps — correct today; decide at activation whether SEO pages adopt the display brand in titles.

---

## ROUND 2 — diff-scoped re-attack after the extractability fix pass (same day, 2026-07-12)

After an AEO best-practices audit, an extractability fix pass restructured the 4 pages (front-loaded 134-167w answer blocks, question-shaped H2s, 3 comparison tables, named attributions, Organization/WebSite entity JSON-LD on index.html). A fresh-context adversary re-attacked the diff only.

**VERDICT: SHIP-WITH-FIXES — 1 blocking, 0 non-blocking. Fix applied + verified same day; package cleared.**

- **BLOCKING F1 (RESOLVED): "RFC 8058 one-click unsubscribe enforced server-side" was FALSE.** Code truth: `engine/tick.ts` emits only the mailto `List-Unsubscribe` form (RFC 2369); the https form + `List-Unsubscribe-Post` header — the actual RFC 8058 one-click mechanism — is the documented TODO(B4). Class swept site-wide: **11 instances across 8 files** (guide-domains ×3 incl. FAQPage JSON-LD, faq.html ×2 incl. JSON-LD, pricing.html, aup.html [legal draft], compare-vs-diy.html, guide-cold-email-with-ai-agent.html ×2). All rewritten to the honest form — "suppression list + List-Unsubscribe header on every applicable message; full RFC 8058 one-click ships with the hosted unsubscribe endpoint (on the roadmap)" — with the AUP's prohibition preserved mechanism-neutral. `guide-cold-email-deliverability.html:84` correctly KEPT: it is an educational statement of Google's bulk-sender requirements, not an enforcement claim. Orchestrator verified every instance on disk post-fix. **RESTORE ITEM: when B4 ships the hosted unsubscribe endpoint + List-Unsubscribe-Post emission, these claims may be restored (re-sweep the same grep: `8058|one-click`).**
- Attributions ALL HELD (verified source↔exact-figure in the frozen research): digitalpatron.in + growth.cx ↔ 87%/4.8% vs 82%/3.2%; moderninbound.com + leadriver.io (citing Sanebox) ↔ 91%/89%; Mailscale/InboxKit 50-inbox stack; Smartlead/Apollo.io/Maildoso three-vendor stack; LeadMagic archived-repo caveat; Apollo official MCP; Composio Instantly toolkit. "Zapier" removed as ungrounded — confirmed absent.
- Answer-block numbers exact; tables grounded (mcp competitor column = frozen category names only; worked examples match calculator ceil-math); index.html entity JSON-LD clean (Org name = visible footer, sameAs curls 200, @id resolution consistent); all prior fixes intact; no broken anchors.
- NEW activation-checklist item: WebSite schema name + page `<title>`s hardcode the slug — the activation-rebrand sweep must include JSON-LD, not just titles.
