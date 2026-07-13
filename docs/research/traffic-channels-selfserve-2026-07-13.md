# ColdStart — Self-Serve Discoverability Channels (zero-founder-touch, executable by agent alone)

Deep-research run 2026-07-13. Extends `traffic-channels-2026-07-12.md` (18 channel families, mostly founder/identity-gated) with channels executable using ONLY: site content/deploy (Cloudflare Pages) + the already-authed GitHub org. Method: 5-angle search fan-out → 15-source fetch → 3-vote adversarial verification per claim → gap-closing re-verification (run partially interrupted by a usage-limit reset; verification gaps closed by a follow-up worker same day). Frozen record — do not update; supersede with a new dated file.

## TIER 1 — fully verified, fully zero-touch, do immediately

### 1. IndexNow (search-index acceleration)
- VERIFIED (8+ independent adversarial passes; live unauthenticated POST to api.indexnow.org returned HTTP 202).
- Mechanism: self-generate an 8–128 char key → host `{key}.txt` at site root → unauthenticated GET/POST to any one participating endpoint (`api.indexnow.org/IndexNow`, JSON `{host, key, keyLocation, urlList}`, up to 10,000 URLs/request). One submission propagates to all participating engines.
- NO account anywhere in the flow — Bing Webmaster Tools is optional post-hoc monitoring only (blogs claiming it's required were checked and refuted against the primary spec).
- Surface: Bing, Yandex, Naver, Seznam.cz, Yep, Amazon — NOT Google. Bing feeds Copilot + several agent web-search backends.
- Effort: trivial. NOTE: key file must be LIVE on the domain before pinging → sequence after site deploy.
- Sources: indexnow.org/documentation · indexnow.org/faq · bing.com/indexnow/getstarted

### 2. GitHub repo metadata optimization (About / topics / README query-tuning)
- Actions verified zero-cost/zero-risk; exact ranking weights are practitioner reverse-engineering, not GitHub-documented.
- GitHub's own code index covers public repos near-universally and fast, independent of stars (GitHub search engineer, HN) — this is the surface `gh search code` and Claude Code/Codex/Cursor hit FIRST, before popularity-gated mirrors.
- Keyword-dense About <120 chars; up to 20 exact-match topics (single-word rank best); README headings phrased as target queries. Google is GitHub's top external referrer → LLM-answer visibility flows through too.
- Sources: markepear.dev/blog/github-search-engine-optimization · nakora.ai/blog/github-seo · news.ycombinator.com/item?id=34698368

### 3. grep.app on-demand indexing + its public MCP server
- VERIFIED via Vercel changelog: grep.app now searches ANY public GitHub repo on demand — visiting `grep.app/<owner>/<repo>` IS the indexing trigger; no form, no account.
- Agents connect directly: `claude mcp add --transport http grep https://mcp.grep.app` (Cursor same URL) and autonomously invoke it mid-task → passive discovery channel inside the agent's own workflow.
- Effort: one curl per repo (+ optional README link).
- Sources: vercel.com/changelog/search-any-public-github-repo-with-grep · vercel.com/blog/grep-a-million-github-repositories-via-mcp

### 4. DeepWiki / uithub / gitingest URL-swap mirrors
- VERIFIED for DeepWiki (official MCP server in Docker MCP catalog; visiting `deepwiki.com/<owner>/<repo>` triggers AI-navigable wiki generation, no account). uithub/gitingest same mechanic, single-source/medium confidence.
- Optional README badge (as Google/HF projects do) seeds human clicks + crawler visibility.
- Source: cognition.com/blog/deepwiki

## TIER 2 — ship as cheap insurance, uncertain payoff timing

### 5. `.well-known` MCP/agent discovery files (ship all variants; they don't conflict)
- Status 2026-07-13: NOT ratified. SEP-2127 still an open PR (moved to Extensions Track; shape may shift). Claims that Claude Desktop/Cursor already ship "server-card support" are UNCONFIRMED against the official repo. One corroborated real-world consumer (Pipeworx, 811-entry catalog).
- Variants: `/.well-known/mcp/server-card.json` (SEP-1649 — we already ship this), `/.well-known/mcp` / `mcp.json` (SEP-1960), `/.well-known/mcp-server` (IETF draft-serra-mcp-discovery-uri-01, expires Sept 2026), `/.well-known/agents.json`, `/.well-known/agent-card.json` (A2A), `/.well-known/ai-catalog.json`.
- Forward-positioning; ~1 hour total. Sources: modelcontextprotocol PR #2127 · issue #1649 · datatracker.ietf.org draft-serra-mcp-discovery-uri-01 · ext-apps discussion #606

### 6. Sourcegraph public index — VERIFIED alive 2026; fully passive (auto-ingests public GitHub repos, no submission path exists). The 2023/24 "sunsetting" was product-licensing, NOT the public index. Action: none — just don't waste effort "submitting."

### 7. apis.guru OpenAPI directory
- VERIFIED path: apis.guru/add-api web form → files a GitHub issue (direct PRs rejected). Needs only a stable URL to our self-hosted OpenAPI spec; auto-updates from our domain. No login stated in flow.
- Caveats: "Public, Persistent, Useful" reviewer judgment + ~1,551 open issues → months-long backlog. Downstream: consumed by ~20 tools (Speakeasy, ReDoc, Kiota, ReadMe.io).

### 8. public-apis/public-apis PR
- VERIFIED alive (449k stars, "Add X API" merges as recent as 2026-06-30; ~1,525 open PRs → slow). One PR, fixed table format, no CLA.
- ⚠️ Explicit gate: "not a marketing tool" + genuine free tier required — entry must be neutral developer-resource copy or it gets rejected.

### 9. Wayback Save Page Now — anonymous path only
- VERIFIED: `web.archive.org/save/<url>` (or the form) is anonymous, instant permanent URL. The BULK API is NOT zero-account (archive.org account + S3 keys) — out of scope.
- Only archives the single page (no outlink crawl, no recurring crawl). Use as permanence/citation backstop per key URL, post-deploy.

### 10. llms.txt — calibrate expectations DOWN
- Single conflicted source (515M bot events): GPTBot/ClaudeBot/PerplexityBot almost never fetch it; Google says not needed. BUT coding assistants (Cursor, Copilot) reportedly DO use it — exactly our target. ~10% adoption, no measured citation correlation (SE Ranking, 300k domains).
- We already ship it; keep it current, don't over-invest.

## TIER 3 — defer
- **11. MCP ext-apps JSON-LD (`mcp:MCPApp`)** — discussion-only; maintainer pushback (prefers pointing at .well-known); the "92% of crawlers" stat traces to an uncorroborated report. Skip unless bundling with #5.
- **12. Wikidata software entity** — mechanically possible, HIGH rejection risk (self-published refs don't count; COI/self-promotion norms). Defer until third-party coverage exists.

## DROPPED (refuted)
- **deno.land/x webhook publishing** — dead; live-tested: add-module flow 301-redirects to jsr.io/new. All Deno publishing now routes through JSR (own account).
- **Common Crawl submission** — no submission mechanism exists; CCBot picks URLs by web-graph centrality. Inclusion is EARNED via inbound links (downstream effect of #7/#8), not actionable directly.
- **GitHub Packages npm registry as discovery** — even public packages require an auth token to install (3+yr unresolved complaint). GHCR containers + `github:owner/repo#tag` installs work anonymously but aren't discovery surfaces.
- **JSR tokenless publishing** — publish-only OIDC is real, but scope/package creation needs ONE interactive JSR login (GitHub OAuth) to mint the first token. Flag as "one cheap unlock" when a browser session is authorized; not zero-touch today.
- **Postman API Network MCP showcase** — free and on-target but requires a new Postman account; revisit when the no-new-accounts constraint relaxes.

## Honest-participation flags
- public-apis + apis.guru: neutral factual listings only — explicit anti-marketing gates.
- Wikidata: COI norms — defer rather than word around.
- Everything else (IndexNow, .well-known, repo metadata, grep.app/DeepWiki/Sourcegraph, Wayback, llms.txt) = standard self-serve control of own domain/repo; no disclosure issue.

## Execution recommendation
Ship #1–4 immediately (verified, zero-touch, near-zero effort) · #5–7 same sprint as insurance · #8–10 opportunistically · defer #11–12 · don't chase the dropped four. Sequencing constraint: IndexNow ping + Wayback snapshots only AFTER the site deploy (key file + current content must be live); grep.app/DeepWiki seeding only AFTER push (they index the GitHub repo).
