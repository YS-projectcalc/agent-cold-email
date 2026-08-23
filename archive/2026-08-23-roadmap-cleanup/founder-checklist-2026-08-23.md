# Founder sitting — checklist compiled 2026-08-23 (session f6d82067)

Everything below needs you present (account, card, OAuth, or an external send the classifier won't let me do alone). Ordered by leverage. Estimated total: ~45 min.

## A. Unblocks revenue / the paying customer (do first)
1. **Gmail OAuth grants for Mordy's 4 mailboxes** — `pendingCredentialPushes: 4` live; the platform has NEVER completed a credential push or real send. Must be done before his warmup ripens ~Sep 14-15. ~10 min/mailbox, manual by vendor policy (`ROADMAP.md:52`). Runbook: scratchpad `dogfood-tenant-runbook.md` §2 step 4 (commands staged).
2. **InboxKit auto-topup is ON** (`<10 credits → +25` to the card, no prompt). Wallet = 40 credits; Mordy draws ≈26/mo. Decide: keep (and expect a charge within ~a month) or turn off + manual top-ups.

## B. Dogfood tenant #1 (order 2) — only if you want the 3-email campaign to run through the product
3. Stripe (live): create a 100%-off `duration: forever` coupon for the internal tenant — else checkout = $99/mo self-charge. (MORDYPILOT is exhausted/inactive.)
4. Signup + checkout with a card (I can drive everything except the card entry and the coupon write).
5. Setup over HTTP/MCP: `domains:1, inboxesEach:2, registerDomains:true` ≈ 25.5 credits (fits the 40; the 5-mailbox shape does NOT). Then **2 more OAuth grants** (same sitting as item 1).
6. Approve the 3 editorial sends (Fastio `help@`, Crustdata `info@`, Noded `hello@` — the only email-able targets; the rest are forms/PRs). Copy = Wave-1 drafts in `docs/research/backlink-outreach-targets-2026-08-17.md` + credibility gate (site fixes merging today).
   Reframe per the runbook: the value is exercising OAuth→first-send on OUR tenant before a customer does; the 3 emails are the payload.

## C. Directory submissions prepared, one word each ("go salestools", "go mcp.directory", …)
7. Salestools Club form — field values in scratchpad `dirs/send-ledger.md`.
8. MCP.Directory `/submit` (auto-pulls GitHub, publishes ≤24h) — values in the ledger. Also `/submit-skill` after the skill is live.
9. Oryndex `https://oryndex.co/submit-a-tool` (fields not yet reconned).
10. Skill hubs after the skill lands on main: cursor.directory repo-scan (`https://cursor.directory/plugins/new?type=mcp_server`, no login), claudeskills.info `/submit/`, mcpservers.org Agent Skills, mcp.directory `/submit-skill`.

## D. Needs an account you own
11. Directory for AI — "Continue with Google" (account creation) then submit-tool.
12. Glama — claim `https://glama.ai/mcp/servers/YS-projectcalc/agent-cold-email` (GitHub login); refresh the stale "~12 tools" blurb; profile completion is 83% → complete it.
13. PulseMCP — bot-walled; email `hello@pulsemcp.com` (or add to the campaign).
14. Product Hunt launch; SaaSHub free listing (verified URL in the Wave 3 table).

## E. Trust floor (order 4 — "when I come back")
15. GitHub stars: curated lists gate on them — best-of-mcp-servers closed PR #366 for "<50 stars". Ask Mordy for a star + a 2-line testimonial; Show HN from your account; disclosed posts in r/coldemail / r/ClaudeAI / r/cursor. Repo currently 1 star, 0 forks.
16. G2 / Capterra free listings (Capterra's vendor page leans paid — verify free tier first).

## F. Standing items (unchanged)
17. GitHub 2FA on YS-projectcalc by **2026-08-28**.
18. RATIFY §9.13 alert ceiling · ack spend-ceiling $150→$180 · Gmail /mcp auth · CF Web Analytics toggle (kept on the roadmap — needed to measure referral traffic from all of the above).
19. `! npm login` (npm token expired) — only needed if we cut a new CLI version (not needed for this wave).

## Done today without you (for context)
- mcpservers.org submitted (covers wong2's list) · YuzeHao2023/Awesome-MCP-Servers PR #433 opened · punkpeye PR #10106 nudged (Glama score now 83%/A — the maintainer's stated blocker) · Wave 3+ research (30 targets) appended · roadmap cleanup executing · skill/plugin + site fixes built on lane branches (gate → merge → deploy in progress) · registry-republish workflow (OIDC) added · watch cron re-armed.
