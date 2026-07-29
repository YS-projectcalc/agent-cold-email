# Warmup posture research (2026-07-28)

> Answers the founder's "who generates the not-spam/reply signals?" question and sets the platform warmup posture + Fast-Start SKU framing. Sonnet research lane, verbatim-sourced. Feeds `ROADMAP.md` warmup + Fast-Start entries.

## The three models — who generates engagement signal

- **Ramp-only (our default):** the REAL recipients generate every signal. Genuine cold-start weakness — a fresh Google mailbox has "zero trust, no history, no engagement signals," and if the list/offer is weak the signal is near-zero exactly when it's needed. Not oversold; a real limitation.
- **Warmup networks:** a synthetic peer pool (other tenants' mailboxes) auto-opens/replies/marks-not-spam on a schedule, manufacturing signal before real sending. InboxKit sells "isolated" (non-shared-pool) warmup as a **$3/mailbox/mo add-on**.
- **Prewarmed inventory:** no ongoing signal generator — someone else's warmup already happened pre-resale; buyer inherits accumulated reputation.

## ⭐ LOAD-BEARING FINDING (correct the internal narrative)

**Google's own bulk-sender guidelines (support.google.com/a/answer/81126, fetched directly) say NOTHING about warmup networks, engagement pools, or artificial engagement — and do NOT prohibit or "hunt" them.** The "Google prohibits/hunts warmup networks" framing (including my own earlier "gray-zone" hedging) is **vendor narrative, not documented Google policy.** Google's only warmup guidance is qualitative: *"Start with a low sending volume to engaged users, and slowly increase the volume over time,"* *"Avoid introducing sudden volume spikes,"* plus hard thresholds (spam rate <0.30% / recommend <0.10%; SPF+DKIM+DMARC at 5,000+/day; one-click unsubscribe; DMARC alignment).

Counter-case is ALSO vendor-sourced (litemail.ai, selling an alternative): "most warmup services use shared warmup pools that email providers have largely identified and discounted" + a secondhand Reddit anecdote (dashboards green, real outreach still spam). Directionally plausible (identical small pools emailing each other at 100% open/reply/never-spam IS a detectable synthetic pattern) but **not independently verified** — no neutral/academic study exists; every pro-warmup source sells warmup, the anti source sells a different warmup product. **Treat both as marketing.**

## Incumbents (2025-2026, none dropped warmup)

Instantly / Smartlead bundle shared-pool warmup into platform pricing; Warmforge = combined warmup+placement-testing; Maildoso/Infraforge include it in base plans. InboxKit differentiates with "isolated" warmup ($3/mbx/mo add-on) + a **self-published, unaudited** 92%-isolated-vs-80-85%-shared-pool placement claim (their own comparison article — not third-party). Mailreach/Warmbox/lemwarm status NOT checked (budget).

## Ramp schedule numbers to encode (practitioner CONSENSUS, not a Google mandate)

Day 1 ~5/day · end of week 1 ~20/day · ~50/day by day 21 · 3-4 weeks to 20-30/day · steady-state 50-100/day warmed · **never +>20% day-over-day** · minimum 14-day warmup, 30-day "safe default." Consistent across Prospeo/Smartlead/PrimeForge/MailReach/SyncGTM 2026 guides. (Google's own text is qualitative only — present as "practitioner consensus.") Bulk-sender formal threshold = 5,000+/day to Gmail (domain-level aggregate can hit it even if single mailboxes don't).

## Recommended posture (fits the honest-no-guarantees brand)

1. **Default = ramp-only + technical hygiene** (SPF/DKIM/DMARC, spam-rate monitoring, gradual volume, list quality) — this IS what Google's primary-source guidance describes, so it's defensible as "we do what Google's own guidelines say," not "we rely on unverifiable pool claims."
2. **Offer warmup-network / isolated-warmup as an optional add-on**, framed honestly: "may accelerate reputation-building; effectiveness is contested industry-wide and NOT confirmed by Google policy; no inbox-placement guarantee." Consistent with no-guarantees brand.
3. **Do NOT frame warmup networks as "against Google's rules"** — no primary source supports that. Frame the risk as "effectiveness-uncertain / synthetic pattern may be discounted by spam filters," the honest version.

## Open / not researched (do not assume)
- No primary Google/Yahoo/MS statement prohibiting or detecting warmup networks.
- No neutral study quantifying warmup-network lift vs ramp-only placebo.
- Prewarmed/pre-aged INVENTORY SKU pricing (distinct from ongoing warmup add-ons) NOT found within budget — needs a targeted InboxKit pricing-page fetch for the Fast-Start SKU design.

Sources: support.google.com/a/answer/81126 (PRIMARY) · inboxkit.com/learn/best-cold-email-infrastructure-2026 (vendor, unaudited) · litemail.ai/blog/does-email-warmup-work-2026 (skeptic vendor) · warmy.io · prospeo.io · smartlead.ai · primeforge.ai · mailreach.co · warmforge.ai · maildeck.co (full URLs in the lane report).
