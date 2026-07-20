# Adversarial review — claim-surface stale-claim class, round 2

- Date: 2026-07-20
- Reviewer: adversary (fresh context)
- Git HEAD at review: `ca7635a9b16fc5402a880d1c51e279ec687c0a98` (branch `main`, shared live worktree)
- Scope: uncommitted claim-copy edits in exactly 5 files — `server.json`, `llms-install.md`,
  `.claude-plugin/plugin.json`, `SECURITY.md`, `CONTRIBUTING.md` — the round-2 fix of the
  stale-claim-surface class (pre-reframe "early access / test mode / 17 tools" copy).
- Ground truth used: real sending IS live (gmail_api over HTTPS/443, proven 2026-07-19); MCP
  surface is 21 tools; $99/mo for 5 mailboxes + $10 additional published; activation is
  concierge-mediated with zero tenants currently activated; Stripe on TEST keys; NO SMTP egress.

## VERDICT: SHIP-after-fixes

The 5 scoped files are internally correct, honest, and consistent — they can ship. But the
round's stated purpose is closing the stale-claim-surface CLASS across the metadata files that
directories ingest, and one directory-ingest sibling explicitly named in the review brief still
carries a stale enumeration. One fix, on a sibling file (not on the 5 edited files).

## Findings

### F1 — BLOCKING (for class closure) · lens 1/3 · server-card enumerates 19 tools while claiming 21
- Surface: `site/.well-known/mcp/server-card.json` — the canonical machine-readable card that
  directories (Glama etc.) and buyer agents ingest. NOT one of the 5 edited files; pre-existing.
- Defect: `description` (line 6) says "21 focused tools"; `statusNote` and `pricing` reframed to
  live; but the `tools[]` array (lines ~35-55) lists only **19** entries — missing
  `get_byo_domains` and `configure_byo_domain` (the two byo-domain tools that the 19→21 bump
  added). Live `site/llms.txt:13` explicitly promises this card carries "all 21 tool names."
- Failure scenario: a buyer agent cross-checks the "21 tools" headline against the enumerated
  `tools[]` list (the exact tools/list ↔ card ↔ docs cross-check that has killed listings here
  before) and finds 19 named — a 2-tool discrepancy in the canonical card, contradicting the
  card's own description AND llms.txt's "all 21 tool names" pointer. This is the stale-listing
  kill class the whole reframe exists to prevent.
- Verification: parsed both the in-tree file (`python3 json.load` → array len 19) AND the LIVE
  deployed copy (`curl https://coldrig.dev/.well-known/mcp/server-card.json` → array len 19,
  description "21 focused"). Live `tools/list` POST to the Worker returns exactly 21. AGENTS.md
  tool table = 21 (includes byo). openapi.yaml has byo + webhook paths. Only the server-card
  array is stale.
- Self-refutation attempted: could the array be an intentional highlight subset? No — the
  description says "21 focused tools" and llms.txt says the card lists "all 21 tool names," so
  it is represented as exhaustive; `get_webhooks`/`configure_webhook` (equally "live" tools) ARE
  listed, so omitting the equally-live byo tools is staleness, not curation. Finding holds.
- Fix (one edit): add `get_byo_domains` and `configure_byo_domain` entries to
  `site/.well-known/mcp/server-card.json` `tools[]`, then redeploy the site so the live card matches.

## Attacks that failed (the 5 scoped files held)

- Lens 2 OVERCLAIM — real sending without concierge caveat: every one of the 5 files that
  asserts "real sending is live" carries the concierge-activation caveat in the same passage
  (plugin.json, server.json: "New accounts activate real sending via a short concierge step";
  CONTRIBUTING/SECURITY: "for activated tenants"; llms-install: "new accounts activate ... while
  self-serve activation rolls out"). No file implies live self-serve billing (llms-install and
  the sibling cli README say billing/self-serve is "rolling out"; Stripe test keys stated). Held.
- Lens 8/2 deleted honesty caveats: pre-edit llms-install carried "No deliverability guarantees,
  ever" → post-edit preserves "No inbox-placement or deliverability guarantees, ever." SECURITY.md
  ADDS "no established multi-year production track record yet." No caveat was dropped. Held.
- Lens 3 transport naming: all 5 files say "Gmail API (HTTPS/443)"; none claim SMTP. AGENTS.md's
  lone "SMTP" mention is the customer's own BYO connect-mailbox transport, explicitly disclaimed
  as "not this platform's own outbound send transport." Held.
- Lens 5 internal consistency: tool count = 21 in all 5 files + README + AGENTS.md + llms.txt +
  agent-evaluation.md + live tools/list; pricing $99/5 + $10 additional ($49 platform + $10/mbx,
  5-min) consistent; server.json version = 0.2.1 as expected. Held.
- Lens 1 underclaim survivals in the named siblings: glama.json/.mcp.json carry no claims;
  AGENTS.md, packages/cli/README.md, README.md, site/llms.txt, site/agent-evaluation.md all say
  21 / live-in-production / concierge — no "17 tools / early access / test mode / not yet active"
  survivals. Only server-card.json (F1) is stale. Held for the rest.

## UNVERIFIABLE

- None material. (MCP-registry publish mechanics of server.json 0.2.1 vs the registry's current
  0.2.0 listing were not tested — publish plumbing, not claim copy; out of scope.)

## NEW (out-of-scope) observations — no verdict weight

- `FINAL-REPORT.md` (repo root) prominently says "deployed and working right now in test mode
  (sandbox vendors, Stripe test keys, no real spend)" and `SPEC.md:13` says
  "early-access/waitlist framing until backend activates." These are dated internal
  report/architecture docs, not directory-ingest metadata surfaces, so outside this round's
  enumerated sibling set — but an agent browsing the repo could quote "test mode." Candidate for
  a future doc-sweep, not a blocker for this round.
- Version skew across artifacts: server.json = 0.2.1, but plugin.json / server-card.json / npm
  package = 0.2.0. Different artifacts, common skew, no claim-copy impact — noted only.
