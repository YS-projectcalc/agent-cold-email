# Adversarial review — three new "operation" guide pages (2026-07-15)

**Reviewer:** adversary (fresh context) · **Ground:** `git rev-parse HEAD` = `c0b9e1f128abe29ad7265b0c572b8881d6ea77c2`, branch `main` (read-only).
**Scope (untracked/modified):**
- NEW `site/guide-cold-email-operation-claude-code.html` (flagship)
- NEW `site/guide-cold-email-operation-codex.html`
- NEW `site/guide-cold-email-operation-cursor.html`
- MOD `site/guide-cold-email-with-ai-agent.html`, `site/guide-mcp-cold-email.html` (related-links only), `site/llms.txt`, `site/sitemap.xml`

## VERDICT: **SHIP** — zero blocking defects survived self-refutation.

Every capability claim is grounded against source and, where a buyer agent would literally test it, against the LIVE endpoint. The honest sandbox-first posture is maintained without a single real-sending overclaim. Nits + one out-of-scope pre-existing tension below; none block commit/redeploy.

---

## Per-attack results (CONFIRMED = attack landed / REFUTED = claim held)

| # | Attack class | Result | Evidence |
|---|---|---|---|
| 1 | Real-sending overclaim | REFUTED | Draft-stamp + callout on all 3 (`claude-code:56,60-63`); lede scopes "not yet ... sends real email today" (`:58`); `#cant:161`, `#cost:157`, `#demo:169`. Step table verbs are present-tense but line `:86` frames the whole table "a real MCP tool call against the live sandbox — not aspirational." No sentence implies real sends today. |
| 2 | Webhooks/push | REFUTED | Aggressively disclaimed: `claude-code:102-108` ("no push webhook subscription in the current public API", "Coldrig doesn't push to you"), `#cant:162`; codex `:97`; cursor `:116`; HowTo step 6 JSON-LD. Confirmed against `mcp/tools.ts` — no webhook/subscription tool exists; `activity`/`inbox` are pull only. |
| 3 | AI-support claim | REFUTED | Absent on all 3. Only AI mentions are `AI-drafted replies → Not provided` (`claude-code:109`) and "no built-in autoresponder or AI SDR." No support-triage-is-AI claim. |
| 4 | Deliverability guarantee | REFUTED | `claude-code:112,164`; footer on all 3; Skill/Rules bodies all disclaim inbox placement/deliverability. |
| 5 | Pricing | REFUTED | `$99`-first everywhere with $49+$10 only as under-the-hood explanation (`claude-code:147`, codex `:100`, cursor `:119`). Table math exact: 5→99, 10→149, 15→199, 20→249 = 49+10·mbx. "Sends are not separately metered" **matches the live pricing page** (`pricing.html:61,65,139,188`). Capacity never contractual. |
| 6 | "No paywalled API" (hard) | REFUTED (claim TRUE) | `mcp/handler.ts:103-161` `tools/call` dispatches to any tool with only `resolveTenantFromToken`; `require-auth.ts:60-69` has **no plan gate** (only token validity + `status==='active'`). Only plan gates in the tree are `demoRun`/`advanceClock` (`tenant-do.ts:461,502`) — sandbox controls gated to demo/free (the *inverse* of a paywall) and NOT part of the 17-tool surface. **LIVE:** unauthenticated `tools/list` on the hosted `/mcp` returns all 17 tools → the page's "verifiable directly against the live endpoint" is literally true. Sandbox tenants get a *wider* surface, never narrower. |
| 7 | RFC 8058 / unsubscribe | REFUTED (built) | `tick.ts:342-365` emits BOTH `List-Unsubscribe` forms + `List-Unsubscribe-Post=One-Click` + in-body footer (sender identity + physical address + opt-out link) on engine sequence sends; hosted one-click POST endpoint `routes/unsubscribe.ts:72`; suppression checked at send time `tick.ts:224,244`; per-mailbox caps `tick.ts:256-267`. `claude-code:67` claim ("suppression, full RFC 8058 one-click unsubscribe, per-mailbox send caps enforced server-side") is accurate. No blanket "every email" overclaim; reply-path (footerless/transactional) not asserted otherwise. |
| 8 | Setup-config accuracy | REFUTED (matches repo + live) | Hosted URL `agent-cold-email-api.yaakovscher.workers.dev` + `/signup` + `/mcp` match `.mcp.json`/`server.json`. Claude Code `claude mcp add --transport http ... --header ... --scope user`, Codex `[mcp_servers.coldrig]`+`url`+`bearer_token_env_var`, Cursor `mcp.json` `${env:COLDRIG_TOKEN}` are **byte-identical to the already-shipped, previously-reviewed `connect.html`**. Signup curl `{"brand","contactEmail"}` → `{tenantId,token}` matches `routes/signup.ts` (LIVE: returns `ten_`-prefixed id, no card). External Codex/Cursor convention correctness → UNVERIFIABLE (see below). |
| 9 | Slop / thin duplication | REFUTED | Codex (TOML + native AGENTS.md) and Cursor (JSON + Rules) are genuine delta pages with distinct client-specific content, each explicitly delegating the shared lifecycle to the flagship. Not find-replace twins. |
| 10 | Mechanical | REFUTED | All 3 JSON-LD blocks parse (HowTo / TechArticle ×2). Tag balance clean (table/pre/code/ul/li/h2/main). Anchors resolve: `#tools` → `guide-mcp-cold-email.html:75`, `#replies` → `claude-code:101`. All pretty-URL internal links map to real `site/*.html` (CF Pages convention). sitemap + llms.txt point at the 3 real new paths. GitHub AGENTS.md blob URL (codex `:80`) → LIVE HTTP 200. |

---

## Live verification receipts
- `POST /mcp {tools/list}` (unauthenticated) → **17 tools**, names identical to `mcp/tools.ts`.
- `POST /signup {brand,contactEmail}` → `{tenantId:"ten_…", token:"…"}`, no card.
- `GET raw.githubusercontent.com/YS-projectcalc/agent-cold-email/main/AGENTS.md` → **HTTP 200**.

## Non-blocking nits
1. `claude-code:83` — "see the full connect reference for that [stdio-bridge] config shape" but `connect.html` only shows remote-HTTP configs (no `command`/`args` stdio bridge block). The `agent-cold-email mcp` bridge is real (`packages/cli/src/commands/mcp.ts`, env `AGENT_COLD_EMAIL_API_KEY`) and self-documented in the CLI README, so no copy-paste breakage — just a slightly over-promised pointer.
2. Title "…Fully Autonomous — No Paywalled API" (`claude-code:6`): "Fully Autonomous" is a product-model descriptor scoped in-body by the lede/callout, not an unverifiable credibility claim. A title-only SERP scan could over-read it; the body inoculates. Watch-item only.
3. Env var `COLDRIG_TOKEN` in the guide/connect configs vs repo `AGENT_COLD_EMAIL_API_KEY` in `.mcp.json`/`server.json`/CLI bridge — NOT a defect: `COLDRIG_TOKEN` is a user-chosen shell/env var for the *direct remote-HTTP* path and is consistent with the shipped `connect.html`; the CLI-bridge var is a different path the pages correctly defer.
4. Nav `aria-current="page"` on "Guides" (→ general guide) while on a specific guide page — matches the existing site pattern; cosmetic a11y.

## UNVERIFIABLE (could not fully ground; would resolve as noted)
- **Codex `bearer_token_env_var` and Cursor `${env:COLDRIG_TOKEN}` external-convention correctness.** No live Codex/Cursor here to drive `tools/list`. Mitigations: both are byte-identical to the already-shipped `connect.html` (so NO new risk is introduced by these pages), and the Cursor page explicitly hedges ("header behavior has varied by release — verify tools/list on your exact version"). Resolves by driving each client once on a current release.

## NEW / out-of-scope (no verdict weight)
- **Internal 2-cent `SEND_USAGE_FEE_CENTS` per send (`tick.ts:30`, `reportUsageToStripeIfConfigured`) vs the site's "$0 per-send fees" promise.** The guide pages themselves are consistent with `pricing.html`, and the usage record is inert without `STRIPE_SECRET_KEY` (no customer billed per-send today). This is a pre-existing code/pricing question for ACTIVATION time (is the 2-cent record internal cost-accounting or a customer meter?), not introduced by this diff. Flagged for the activation checklist, not for this commit.
