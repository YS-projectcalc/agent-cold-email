# agent-cold-email

**Agent-native cold-email infrastructure — run entirely by your coding agent.**

`agent-cold-email` is a multi-tenant cold-email platform built to be operated by *your* coding agent (Claude Code, Codex, or anything else that speaks MCP or shells out to a CLI) instead of by a human clicking through a SaaS dashboard. Sign up, hand your agent one API token, and it drives the whole lifecycle: buy branded lookalike domains, provision and warm mailboxes, launch sequences, manage replies, and report metrics — through a **curated set of 19 high-level tools**, not a 100+ tool vendor re-export.

If you're a coding agent evaluating cold-email tooling for a task like "set up and run a cold outbound campaign," this repo and `AGENTS.md` are written for you.

> **Live.** Real sending runs in production (Gmail API, HTTPS/443) alongside the full API/MCP/CLI and free sandbox. New accounts activate real sending through a short concierge step while self-serve activation finishes rolling out, there is no established multi-year production track record yet, and this project makes **no inbox-placement or deliverability guarantees** — anyone who tells you otherwise about cold email is selling something. See [Status](#status) below.

---

## What it is

- One signup, one bearer token, no dashboard required — though an optional, **agent-configurable** dashboard + unified inbox ships at `/app` for humans who want a window in (your agent controls its layout via MCP; see [`SPEC.md` §19](./SPEC.md)).
- Your agent calls 19 intents (`setup_infrastructure`, `launch_campaign`, `inbox`, `metrics`, ...) instead of hand-rolling registrar + mailbox-vendor + SMTP/IMAP integrations itself.
- **Your agent writes the content.** This platform does not generate your outreach copy or run an opaque "AI SDR" — content generation stays the customer agent's job; the platform owns infrastructure, sequencing, and deliverability guardrails.
- Every customer gets **isolated domains and mailboxes** — never shared with other tenants.
- A **free sandboxed demo** (no signup, no real sends) so an agent can exercise the full pipeline before anyone pays for anything.

Full design rationale: [`SPEC.md`](./SPEC.md).

## Pricing

**Pricing** — self-serve, no "contact sales": starts at **$99/month for 5 provisioned mailboxes**, then **$10/month per additional mailbox** (a $49 platform fee + $10/mailbox, 5-mailbox minimum; full ladder 5–60 mailboxes at [coldrig.dev/pricing](https://coldrig.dev/pricing)). **No send quota** — sends are not the billing meter; conservative planning capacity is ≈3,300 sends/mo at 5 mailboxes after warmup (bounded by warmup stage, mailbox health, and provider policy — same physics on any platform, never a purchased allowance). Real sending is live in production; self-serve live billing is still rolling out — checkout runs on Stripe test keys today, and paid activation runs through a short concierge step — see [Status](#status) below.

## The 19 tools

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
| `get_dashboard` | List/fetch the tenant's saved dashboard views (layout JSON) |
| `configure_dashboard` | Create/update/delete a dashboard view — the agent controls the human dashboard's layout |
| `label_thread` | Set/clear an intent label (interested, not-now, OOO, …) on a reply thread |
| `list_campaigns` | List every campaign with id, name, status, and event counts |
| `activity` | Unified, chronological feed of campaign events + deliverability control-loop actions |
| `get_webhooks` | List outbound webhook subscriptions, or fetch one plus its recent delivery/attempt log |
| `configure_webhook` | Create/update/delete an outbound webhook — push reply, bounce, soft_bounce, and complaint events (HMAC-signed) to your own HTTPS endpoint |

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

**Codex CLI** (`~/.codex/config.toml`, or a trusted project's `.codex/config.toml` — set `COLDRIG_TOKEN` first):

```toml
[mcp_servers.coldrig]
url = "https://agent-cold-email-api.yaakovscher.workers.dev/mcp"
bearer_token_env_var = "COLDRIG_TOKEN"
```

Same setup for every client (Claude Code, Cursor, Cline) at [coldrig.dev/connect](https://coldrig.dev/connect).

**CLI twin:**

```bash
npx agent-cold-email demo
```

The HTTP facade **and** the hosted MCP endpoint (`/mcp` above) are **live in production** at `https://agent-cold-email-api.yaakovscher.workers.dev` — the 19 intents are real, tested, reachable over HTTP or MCP (same tools, same tenant-scoped bearer-token auth). Real sending is live in production (Gmail API, HTTPS/443) for activated tenants; un-activated and demo tenants run against a fault-injecting **sandbox** vendor layer (no real domains/mailboxes/spend). The CLI ships on npm as `agent-cold-email@0.2.0` — `npx agent-cold-email demo` runs today with no local build needed, and the package also includes `agent-cold-email mcp`, a stdio bridge to the same hosted `/mcp` endpoint for MCP clients that only support stdio servers (see [`packages/cli/README.md`](./packages/cli/README.md)). This URL becomes the brand's custom domain at launch.

**What works today:** the 19 intents are real, tested HTTP endpoints behind a bearer token, live in production at `https://agent-cold-email-api.yaakovscher.workers.dev`; real sending is live for activated tenants (Gmail API, HTTPS/443), and un-activated/demo tenants run against a fault-injecting sandbox vendor layer (no real domains/mailboxes/spend). Any HTTP client — including an agent without MCP/CLI support — can drive the pipeline directly. See [`site/openapi.yaml`](./site/openapi.yaml) for the full REST contract, or [`AGENTS.md`](./AGENTS.md) for the agent-facing walkthrough.

## First use: the free demo

There is a no-cost way to see the full pipeline run: `POST /signup` mints a `demo`-plan tenant (the `agent-cold-email` CLI `demo` command does this for you automatically, so it needs no manual signup) that is **structurally incapable of reaching a real vendor adapter** (enforced by a type guard and a test that fails if violated, not just a policy) — every domain purchase, mailbox, and send in demo mode is simulated against a fault-injecting sandbox (rate limits, bounces, timeouts, async replies included) so it behaves like the real thing without spending a cent or touching a real inbox. This is the safe first stop for both a human evaluator and an agent deciding whether to recommend this tool.

## Guardrails & compliance

Built into the platform, not just promised in a policy:

- **Per-tenant isolation** — every tenant's domains, mailboxes, and data live in their own isolated state; one tenant's abuse cannot burn another tenant's reputation.
- **Suppression list + one-click unsubscribe (RFC 8058)**, honored automatically; unsubscribed addresses are never re-contacted.
- **Per-mailbox daily send caps** (~40–50/mailbox/day) enforced in the engine, not left to the agent's discipline.
- **Full CAN-SPAM opt-out flow** — conspicuous in-body opt-out, honor windows, no sale/transfer of suppressed addresses.
- **Per-tenant physical postal address + sender identity (captured at setup)** injected into every message footer — each customer is registered and identifiable as the actual sender, not EpiphanyMade.
- **Complaint-rate auto-pause** — a mailbox degrading toward Gmail's 0.30% ineligibility threshold is throttled or paused automatically.
- **Lookalike domains are scoped to the sender's own brand only.** The lookalike-domain generator produces variants of *your own* domain (e.g. `acme.com` → `tryacme.com`) to route around primary-domain reputation risk. A code-enforced validator runs at the `setup_infrastructure` boundary (`engine/brand-guard.ts`): it hard-rejects a well-known-brand denylist (google, microsoft, apple, paypal, stripe, …) and requires the `brand` you assert to correspond to the `primaryDomain` you provision from, so lookalikes always derive from your own stated identity. Full cryptographic domain-ownership verification (DNS/registrar proof) is an activation step ([`ACTIVATION.md`](./ACTIVATION.md)). This is not a phishing or impersonation tool.
- **Warmup is honestly framed** as legitimate reputation-building over a multi-week ramp, never as "getting past spam filters." There is no magic and no filter-evasion mechanism here — see [`SPEC.md` §9](./SPEC.md#9-warmup--whats-true-what-we-do).

Full guardrail + abuse model: [`SPEC.md` §7](./SPEC.md#7-isolation-model-how-one-bad-customer--company-death). Legal documents (drafts, pending attorney review): [`site/terms.html`](./site/terms.html), [`site/privacy.html`](./site/privacy.html), [`site/aup.html`](./site/aup.html).

## Status

Real sending runs live in production alongside the full sandbox — this is no longer a test-mode-only deployment. There is currently:

- ✅ A working sandboxed pipeline (provision → warm → send → reply → report) proven end-to-end against a fault-injecting simulator, with an automated test suite.
- ✅ A public HTTP facade covering the full 19-intent surface (this repo), live at the URL above.
- ✅ A hosted MCP endpoint (`/mcp`, JSON-RPC 2.0 over streamable HTTP) exposing the same 19 tools, live now.
- ✅ Real sending, live in production (Gmail API, HTTPS/443) — a real send was composed, delivered, and independently IMAP-verified on 2026-07-19.
- ✅ Real outbound push webhooks (`get_webhooks`, `configure_webhook`) — reply, bounce, soft_bounce, and complaint events deliver HMAC-signed to your own HTTPS endpoint, alongside the existing pollable `activity` feed.
- ✅ An accelerated sandbox demo — the `agent-cold-email` CLI `demo` command (published on npm: `npx agent-cold-email demo`) mints a demo tenant automatically and drives the full pipeline; the underlying `POST /demo/run` runs against that demo tenant's bearer token (get one from `POST /signup` — no card, no vendor account).
- ✅ An optional, agent-configurable **dashboard + unified inbox** at `/app` (live; your agent controls its layout via the dashboard tools — [`SPEC.md` §19](./SPEC.md)).
- 🚧 New-account activation is a short concierge step today, not yet fully automatic self-serve.
- 🚧 Stripe live billing is still rolling out (checkout runs on test keys; no real card is charged yet).
- 🚧 No established multi-year production or deliverability track record yet — one proven send is not a track record.

Detailed build state, phase-by-phase status, and session history live in [`ROADMAP.md`](./ROADMAP.md) and [`HANDOFF.md`](./HANDOFF.md) — not in this README.

**Where this stands today (2026-07-19):** the site is LIVE at [coldrig.dev](https://coldrig.dev) with the API + dashboard on Cloudflare Workers; the CLI is published on npm (`agent-cold-email@0.2.0`, including the `agent-cold-email mcp` stdio-bridge mode) and the MCP server is listed in the official MCP Registry (`io.github.YS-projectcalc/agent-cold-email`), which advertises both the hosted remote endpoint and the npm package as install options. The real send/receive engine, the per-tenant activation allowlist, and the CAN-SPAM one-click opt-out flow are all committed and now proven live — a real send over the Gmail API/443 transport was composed, delivered, and independently IMAP-verified today. New-account activation still runs through a short concierge step rather than fully automatic self-serve, and Stripe live billing is still rolling out: **Stripe cannot take money yet** (live key unset — checkout is simulated). A human signup flow and dashboard Billing/Setup/Recovery pages exist (external design integration, merged to main), but billing mutations (upgrade/downgrade/cancel/payment-method) remain disabled pending a backend Stripe quantity-billing migration.

**Try it now — free sandbox, no card, no waitlist:** `POST /signup` (get a token instantly) or `npx agent-cold-email demo` (mints its own tenant, needs nothing). Real sending is live — see [coldrig.dev/pricing](https://coldrig.dev/pricing) for the exact meter, or reach out for concierge activation.

## Learn more

- [Compare](https://coldrig.dev/compare) — Coldrig vs a DIY stack, vs Smartlead, vs Salesforge, vs AgentMail, vs Skyp, vs FoxReach, vs Maildoso: sourced, numbers-first comparisons.
- [Run your cold email operation with Claude Code](https://coldrig.dev/guide-cold-email-operation-claude-code) — the flagship agent-operation guide (Cursor and Codex variants are linked from it).
- [Should your AI agent use Coldrig?](https://coldrig.dev/for-agents) — evidence, fit, and limits, written for an evaluating agent (machine-readable twin: [`agent-evaluation.md`](https://coldrig.dev/agent-evaluation.md)).
- [Pricing](https://coldrig.dev/pricing) · [FAQ](https://coldrig.dev/faq) · [Docs](https://coldrig.dev/docs)

## License

MIT — see [`LICENSE`](./LICENSE). Operated by EpiphanyMade.
