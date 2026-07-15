# Buyer-CHOICE panel — trend table

One row per completed (non-void) run. See `README.md` for the run procedure and `runs/README.md` for the frozen run-record format this table summarizes.

| date | side | brief | surfaced? | shortlisted? | won? | killer sentence | fix-list items filed |
|---|---|---|---|---|---|---|---|
| 2026-07-15 | claude | canonical | NO (grep-verified) | — | — (winner: Salesforge/Forge stack, ~$102-120/mo all-in) | n/a — never surfaced; nearest kill precedent: FoxReach killed solely for zero G2/Trustpilot evidence, an absence ColdRig shares | 3 → ROADMAP ## Open 2026-07-15 [IDEA] ×3 (review-site presence, reply auto-classification, canonical-scale price band); record: `runs/2026-07-15-claude-canonical.md` |
| 2026-07-15 | claude | starter | **YES — organic, via Glama listing** (grep: coldrig×15) | **YES** — evaluated as a full candidate, killed at checklist row "live, proven product" | — (winner: Smartlead Base + SmartSenders, ~$62-65/mo) | "Early access, explicitly 'no real sending' enabled, no published pricing — not usable today." (kill sourced from the GLAMA listing's content; shopper never fetched coldrig.dev) | 2 → ROADMAP 2026-07-15 (Glama-shopfront refresh ORDER; activation-kill evidence noted on Mordy-pilot lane); record: `runs/2026-07-15-claude-starter.md` |
| 2026-07-15 | claude | agency | **YES — organic, generic query #3** (grep: coldrig×17) | **YES** — "conceptually the closest match to your entire brief," killed at "production maturity" | — (winner: Smartlead Unlimited Smart + workspaces + SmartSenders, ~$550-630/mo) | "…'in active build and is not yet available for real sending,' with no published pricing… despite matching the brief almost exactly on paper." | 2 → ROADMAP 2026-07-15 (agency pricing-shape [IDEA] — platform fee multiplies per client, the exact Instantly kill; shopfront stale-tool-count note); record: `runs/2026-07-15-claude-agency.md` |

## Why there's no baseline row

`tools/aeo-panel/runs/TREND.md` seeded its baseline row from the frozen 2026-07-12 agent-search-queries doc because that doc's 46 queries ARE `panel.v1.json`, byte-for-byte — a genuine zero-cost baseline for that instrument.

The buyer-CHOICE equivalent, `docs/research/agent-buyer-research-forensics-2026-07-14.md`, is not eligible for the same treatment: its buying task was open-ended ("what service can I get?", no scale specified), not run against any of `briefs/starter-scale.md` / `canonical-scale.md` / `agency-scale.md` verbatim. Backfilling a row from it would report a run that never actually executed against this panel's frozen instrument — exactly the fabrication this harness is built to avoid. Row 1 opens on the first real run of any brief, on either side.

That doc remains essential prior-art grounding for this harness's design (see `README.md`'s "Method template" section) — just not a `CHOICE-TREND.md` row.
