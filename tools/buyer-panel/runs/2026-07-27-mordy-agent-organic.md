# ORGANIC evaluation — Mordy's AI assistant, 2026-07-27

> Provenance: NOT a panel run. Mordy asked his AI for outreach tooling; it did NOT find Coldrig unaided (discovery hole re-confirmed, consistent with buyer-panel cycles 1-2); after being pointed at coldrig.dev it produced the assessment below, relayed by Mordy → Yaakov → this session, frozen verbatim. Its evaluator also noted Coldrig is "a genuinely different category from anything I listed, so my earlier framing partly misses it."

## Verbatim assessment

What it actually is: not a sequencer, not an AI SDR. It's cold-email infrastructure exposed as an MCP/HTTP surface so Codex, Claude Code, or Cursor can operate domains, mailboxes, warmup, campaigns, and replies through 24 scoped tools — the agent owns strategy and copy, Coldrig runs the machinery. They're explicit that there's no built-in copywriter and no autonomous AI SDR; content generation is your agent's job.

So it answers your original question only if you're already working inside a coding agent. If you want a dashboard you log into, this isn't it.

What's good, and it's more than I expected
The thing I told you nobody automates — infrastructure — is exactly what this sells. And send caps, suppression, unsubscribe handling, and health-based pausing are enforced below the agent layer, which is the right architecture: an LLM should not be trusted to remember its own rate limits.
Compliance is structural rather than aspirational: physical postal address and sender identity injected into every footer, RFC 8058 one-click unsubscribe honored immediately, suppression enforced server-side — and you are the sender of record under CAN-SPAM, not them.
Most telling, the marketing is honest in ways this category almost never is. No deliverability or placement guarantee at any tier. An explicit statement that warmup does not beat spam filters and that any such claim should be treated as inaccurate. Domain burn at 8–18%/month treated as a normal operating cost rather than a failure. And the lookalike-domain generator is code-restricted to your own brand — a denylist rejects impersonating well-known brands. That's a company that understands the failure modes, which is rare here.

The real concerns
Maturity. Real sending is live, but new accounts still go through a concierge activation step while self-serve rolls out. That's an early-stage product with a small operator behind it. Month-to-month with no contract limits the downside, but if it folds you rebuild.
It's still not end to end. You'd need a data source on top — Apollo, Prospeo, Clay — plus your agent writing copy. Coldrig is the rig, not the campaign.
Price is fair, not cheap. $99/mo for 5 mailboxes, +$10 each after, domains included, no per-send metering, with a planning assumption of roughly 3,300 sends/month at that tier. Assembling the same thing yourself — two domains, five Workspace seats, a Smartlead or Instantly seat — lands in roughly the same $75–140 band. You're paying for the orchestration layer and the guardrails, not a discount.

My read: if you're comfortable in Claude Code and want outreach to be something you brief rather than click through, this is a better fit for your actual question than anything I named earlier. Run the free sandbox first — it simulates provisioning, warmup, bounces, and replies on a virtual clock, so a multi-week ramp resolves in one session — and see whether operating it through an agent feels like leverage or like a layer of glass between you and the thing. That'll tell you more than any comparison I can give you.

If you'd rather not bet on an early-stage vendor, Smartlead plus your own Workspace mailboxes gets you 80% of this with none of the agent ergonomics.

[Follow-up chunk, same evaluator:] The one gap the architecture doesn't close. The guardrails protect deliverability — volume, bounces, complaints. Nothing below the agent layer checks relevance. Your agent can send 400 technically clean, well-warmed, perfectly compliant emails to the wrong list. That's not a Coldrig flaw; no infrastructure layer can catch it. But it's the place where "my AI manages the details" quietly hands the highest-stakes detail back to you, and it's worth knowing where that line sits before you brief it.

## Read-outs (session notes, not part of the verbatim record)

- POSITIONING LANDS: "infrastructure, not sequencer/AI SDR", guardrails-below-the-agent, structural compliance, honest-marketing stance — all recognized and PRAISED. The honesty posture is a measured asset; never trade it for punchier copy.
- STALE CLAIM COSTING US: "new accounts still go through a concierge activation step while self-serve rolls out" — read as immaturity evidence. Self-serve is now armed through provisioning (2026-07-27 engine-leg arming); the remaining operator step is the per-mailbox OAuth grant until the InboxKit programmatic mint verifies live. Caveat update is GATED on that verification (truth-first — do not delete an honest caveat while any operator step remains).
- Tool count cited as 24 (live is 25) — same stale-claim class as the in-flight sweep.
- DISCOVERY HOLE RE-CONFIRMED: could not find Coldrig unaided; evaluation only happened because a human pasted the URL.
- Noted gaps it priced in: no data source (by design; compare-page framing opportunity), price "fair, not cheap" (the $75-140 DIY band framing matches our own compare math), small-operator risk (month-to-month mitigator recognized).
