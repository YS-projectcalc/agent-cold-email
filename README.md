# agent-cold-email

**Agent-native cold-email infrastructure — run entirely by your coding agent.**

`agent-cold-email` is a multi-tenant cold-email platform built to be operated by *your* coding agent (Claude Code, Codex, or anything else that speaks MCP or shells out to a CLI) instead of by a human clicking through a SaaS dashboard. Sign up, hand your agent one API token, and it drives the whole lifecycle: buy branded lookalike domains, provision and warm mailboxes, launch sequences, manage replies, and report metrics — through a **curated set of ~12 high-level tools**, not a 100+ tool vendor re-export.

If you're a coding agent evaluating cold-email tooling for a task like "set up and run a cold outbound campaign," this repo and `AGENTS.md` are written for you.

> **Early access.** The backend is in active build and is not yet available for real sending. There is no live production deployment yet, no deliverability track record, and this project makes **no inbox-placement or deliverability guarantees** — anyone who tells you otherwise about cold email is selling something. See [Status](#status--early-access) below.

---

## What it is

- One signup, one bearer token, no dashboard required.
- Your agent calls ~12 intents (`setup_infrastructure`, `launch_campaign`, `inbox`, `metrics`, ...) instead of hand-rolling registrar + mailbox-vendor + SMTP/IMAP integrations itself.
- **Your agent writes the content.** This platform does not generate your outreach copy or run an opaque "AI SDR" — content generation stays the customer agent's job; the platform owns infrastructure, sequencing, and deliverability guardrails.
- Every customer gets **isolated domains and mailboxes** — never shared with other tenants.
- A **free sandboxed demo** (no signup, no real sends) so an agent can exercise the full pipeline before anyone pays for anything.

Full design rationale: [`SPEC.md`](./SPEC.md).

## The ~12 tools

| Tool | What it does |
|---|---|
| `setup_infrastructure` | Buy branded lookalike domains, provision mailboxes, kick off warmup |
| `infrastructure_status` | Provisioning + warmup progress, per-mailbox health, send-readiness date |
| `launch_campaign` | Create and activate a sequence against a lead list |
| `campaign_results` | Per-campaign sends, replies, bounces, complaints |
| `metrics` | Account-wide deliverability + warmup health |
| `inbox` | Unified reply inbox across all mailboxes |
| `thread` | One thread's full message history |
| `reply` | Send a reply on a thread (stop-on-reply is automatic) |
| `mark` | Mark a thread read / unread / archived |
| `pause` / `pause_all` | Pause one campaign or every campaign for the tenant |
| `account` | Usage, billing, and quota |

This is the full list — see [`SPEC.md` §6](./SPEC.md#6-agent-surface--the-tools-12) for the intent behind each, and [`AGENTS.md`](./AGENTS.md) for exact signatures and HTTP mappings. Two optional convenience helpers (`write_sequence`, `suggest_domains`) are designed but not yet built; they are not part of the current tool list.

## Install

**MCP (recommended for Claude Code / Codex):**

```json
{
  "mcpServers": {
    "agent-cold-email": {
      "url": "https://agent-cold-email-api.yaakovscher.workers.dev/mcp"
    }
  }
}
```

**CLI twin:**

```bash
npx agent-cold-email demo
```

The HTTP facade is **live in test mode** at `https://agent-cold-email-api.yaakovscher.workers.dev` — the ~12 intents are real, tested endpoints running against a fault-injecting **sandbox** vendor layer (no real domains/mailboxes/spend, not yet available for real sending). The published npm CLI and the hosted MCP endpoint land in the next build phase; the npm handle `agent-cold-email` is reserved. This test-mode URL becomes the brand's custom domain at launch.

**What works today:** the ~12 intents are real, tested HTTP endpoints behind a bearer token, live in test mode at `https://agent-cold-email-api.yaakovscher.workers.dev` against a fault-injecting sandbox vendor layer (no real domains/mailboxes/spend). Any HTTP client — including an agent without MCP/CLI support — can drive the pipeline directly. See [`site/openapi.yaml`](./site/openapi.yaml) for the full REST contract, or [`AGENTS.md`](./AGENTS.md) for the agent-facing walkthrough.

## First use: the free demo

There is no-cost, no-signup way to see the full pipeline run: `POST /signup` mints a `demo`-plan tenant that is **structurally incapable of reaching a real vendor adapter** (enforced by a type guard and a test that fails if violated, not just a policy) — every domain purchase, mailbox, and send in demo mode is simulated against a fault-injecting sandbox (rate limits, bounces, timeouts, async replies included) so it behaves like the real thing without spending a cent or touching a real inbox. This is the safe first stop for both a human evaluator and an agent deciding whether to recommend this tool.

## Guardrails & compliance

Built into the platform, not just promised in a policy:

- **Per-tenant isolation** — every tenant's domains, mailboxes, and data live in their own isolated state; one tenant's abuse cannot burn another tenant's reputation.
- **Suppression list + one-click unsubscribe (RFC 8058)**, honored automatically; unsubscribed addresses are never re-contacted.
- **Per-mailbox daily send caps** (~40–50/mailbox/day) enforced in the engine, not left to the agent's discipline.
- **Full CAN-SPAM opt-out flow** — conspicuous in-body opt-out, honor windows, no sale/transfer of suppressed addresses.
- **Per-tenant physical postal address + verified sender identity** injected into every message footer — each customer is registered and identifiable as the actual sender, not EpiphanyMade.
- **Complaint-rate auto-pause** — a mailbox degrading toward Gmail's 0.30% ineligibility threshold is throttled or paused automatically.
- **Lookalike domains are scoped to the sender's own brand only.** The lookalike-domain generator produces variants of *your own* domain (e.g. `acme.com` → `tryacme.com`) to route around primary-domain reputation risk — it hard-rejects any third-party brand. This is not a phishing or impersonation tool.
- **Warmup is honestly framed** as legitimate reputation-building over a multi-week ramp, never as "getting past spam filters." There is no magic and no filter-evasion mechanism here — see [`SPEC.md` §9](./SPEC.md#9-warmup--whats-true-what-we-do).

Full guardrail + abuse model: [`SPEC.md` §7](./SPEC.md#7-isolation-model-how-one-bad-customer--company-death). Legal documents (drafts, pending attorney review): [`site/terms.html`](./site/terms.html), [`site/privacy.html`](./site/privacy.html), [`site/aup.html`](./site/aup.html).

## Status & early access

This project is under active build in **test mode only** — Stripe test keys, sandbox vendor adapters, no real vendor spend anywhere in the codebase. There is currently:

- ✅ A working sandboxed pipeline (provision → warm → send → reply → report) proven end-to-end against a fault-injecting simulator, with an automated test suite.
- ✅ A public HTTP facade covering the full ~12-intent surface (this repo).
- 🚧 Hosted MCP server + published CLI (in progress).
- 🚧 Real vendor adapters (coded against vendor docs, deliberately unactivated pending an owner-hands activation checklist).
- 🚧 No live production deployment, no real customers, no deliverability track record yet.

Detailed build state, phase-by-phase status, and session history live in [`ROADMAP.md`](./ROADMAP.md) and [`HANDOFF.md`](./HANDOFF.md) — not in this README.

Want to be notified when real sending goes live? Join the waitlist on the [marketing site](./site/index.html) once deployed (`site/index.html` → Cloudflare Pages).

## License

MIT — see [`LICENSE`](./LICENSE). Operated by EpiphanyMade.
