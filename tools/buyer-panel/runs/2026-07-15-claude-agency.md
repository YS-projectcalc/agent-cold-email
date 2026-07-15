# Run record — 2026-07-15 / claude / agency

## Run metadata

- **Date:** 2026-07-15
- **Side:** claude
- **Brief:** agency (`../briefs/agency-scale.md`)
- **Engine/model:** sonnet general-purpose research agent (Claude Code Agent tool), live WebSearch + WebFetch
- **Run status:** ok (interrupted once by the 13:45 session usage limit, resumed 17:25 from its own transcript)

## 1. Queries run

25 queries listed verbatim in the agent's FORENSICS APPENDIX (see the full report preserved below in §10); trace cross-check: 26 actual WebSearch calls vs 25 listed (one retry, consistent with the limit interruption), 13 WebFetch vs 13 listed ✓. Discovery query that surfaced us: **#3 "AI agent native cold email API MCP mailbox provisioning"** — generic, unbranded. (Query #18 `"agent-cold-email" multi-tenant platform github coding agent` was a branded FOLLOW-UP after the organic surface, not the discovery.)

Pages fetched (13): smartlead.ai/pricing · mailforge.ai/pricing · infraforge.ai/pricing · instantly.ai/pricing · salesforge.ai/pricing · agentmail.to/pricing · help.salesforge.ai CLI article · help.instantly.ai MCP article · helpcenter.smartlead.ai MCP + API articles · saleshandy.com/agency · developer.saleshandy.com domain API · docs.saleshandy.com email-infrastructure.

## 2. Criteria the agent formed

Seven-point checklist, stated before scoring: full-lifecycle coverage · real agent-drivability (vendor-endorsed API/MCP, not read-only) · **true multi-tenant client isolation** (separate workspaces w/ own data+credentials, "not just permission tags") · scale fit at 50 mbx/10+ domains/multi-client (no per-seat or per-workspace-full-subscription multipliers) · deliverability competence · **production maturity** ("actually shipping and generally available, not pre-launch") · transparent computable pricing.

## 3. Kill-list

Ten eliminations (verbatim sentences in the preserved report, §10). The ones that matter most for us:

| vendor | verbatim disqualifying sentence |
|---|---|
| **agent-cold-email (coldrig)** | "Its own listing states the backend is 'in active build and is not yet available for real sending,' with no published pricing, which rules it out for a live agency operation today **despite matching the brief almost exactly on paper**." |
| Instantly | "Each client workspace on Instantly requires its own full separate paid subscription, so isolating 8-10 clients multiplies the ~$94-555/mo plan cost N times over instead of scaling with a flat per-workspace add-on." |
| Saleshandy | "Saleshandy's 'client management' turned out to be permission-based client tagging inside one shared account and API key, not separate isolated workspaces." |
| Skyp | "Seat/seller-based with a jump to $1,250/mo per seller at the done-for-you 'Growth' tier and no published multi-tenant client-workspace model." |

## 4. Survivors

Smartlead; Salesforge + Forge stack (runner-up — "achieves comparable infrastructure control only by stitching together three separate products... whose own CLI documentation admits it doesn't cover domain purchasing or reply automation").

## 5. Deciding sentence

> "Smartlead is the only researched candidate that combines genuinely isolated per-client workspaces (own billing, own reply queue, own API token) with a single documented API and MCP surface covering the full campaign-warmup-send-reply lifecycle from one vendor and one login, whereas its only real surviving competitor — the Salesforge/Forge stack — achieves comparable infrastructure control only by stitching together three separate products and subscriptions whose own CLI documentation admits it doesn't cover domain purchasing or reply automation."

## 6. Winner

- **Name:** Smartlead — Unlimited Smart tier ($174/mo) + 8 client workspaces × $29/mo + SmartSenders marketplace infra (~$150-175/mo)
- **Quoted price at this brief's scale:** ~$550-630/mo monthly billing (~$490-560 annual) — agent's computed estimate from published unit pricing, not a vendor quote.

## 7. ColdRig outcome

- [x] **SURFACED** — organic, via generic query #3 (grep: `coldrig` ×17, `agent-cold-email` ×41 in transcript)
- [x] **SHORTLISTED** — full candidate evaluation; the agent called it "conceptually the closest match to your entire brief"
- [ ] WON — killed on checklist row #6 (production maturity), same row as the same-day starter run.

**Grep verification:** transcript `agent-abuyer-run-agency-740bc1181c60ae72.jsonl` — coldrig 17 / agent-cold-email 41 / genuine product references (Glama listing content + agent's evaluation prose).

**Fidelity caveats (harness):** (1) late repo-context pickup — the agent read CHOICE-TREND.md/ROADMAP.md near the END of its run (first mention at transcript line 111 of 113, structurally corroborating its own "research completed before I saw that context" disclosure); verdict uncontaminated, but Claude-side shoppers share the repo cwd — fixed in `run-claude-side.md` preconditions (dispatch with a neutral cwd / no local reads). (2) Same operator-identity leak class as the starter run. ChatGPT-side runs remain the clean-room check.

## 8. What single change would most likely have flipped the choice

Same as the starter run — activation ("not yet available for real sending" is the kill's core) — PLUS a new agency-specific finding: even post-activation, our per-tenant pricing shape repeats the exact pattern this shopper used to kill Instantly (platform fee multiplying per client workspace: 8 clients × $99-min ≈ $800-950/mo vs the winner's $550-630 all-in) — an agency bundle (one platform fee + flat per-client-workspace add-on) is the evidence-backed fix candidate.

## 9. Diff vs prior run (same side + same brief)

First run of agency brief — no prior record. Same-day cross-brief: starter and agency both SURFACED+SHORTLISTED organically via Glama and died on the identical maturity row; canonical (run earliest in the day) never surfaced. Discovery is trending correctly within a single day; the kill is now concentrated on ONE row (real sending not armed) + one shopfront gap (listing carries no pricing, stale ~12-tool count vs actual 17).

## 10. Preserved agent report

The agent's full verbatim report (category map, full comparison, complete kill list, pricing math, harness bookkeeping note) is preserved in the session transcript at `agent-abuyer-run-agency-740bc1181c60ae72.jsonl`; the load-bearing extracts are quoted above. Notable source-hygiene behavior worth copying in future runs: it explicitly discounted vendor-authored "best of 2026" self-ranking blogs as marketing, and verified decision-hinging claims against vendors' own pricing/docs pages by direct fetch.
