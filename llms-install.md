# llms-install.md

Machine-readable install guide for coding agents (Cline, Claude Code, Codex, or any MCP/HTTP-capable agent) setting up `agent-cold-email`. Humans: see `README.md`. Full operational contract: `AGENTS.md`.

## What you're installing

A hosted MCP server + CLI for agent-native cold-email infrastructure: 21 tools to provision isolated branded domains and mailboxes, run warmup, launch sequences, and manage replies. The MCP endpoint is hosted — nothing to clone, build, or run locally unless you specifically want the CLI's source.

**Status: live in production.** The hosted MCP endpoint, the full HTTP API, and the free sandbox demo are all live now. Real sending is live in production (Gmail API, HTTPS/443) for activated tenants; new accounts activate real sending through a short concierge step while self-serve activation rolls out. Un-activated and demo tenants run against a fault-injecting sandbox vendor layer (no real domains/mailboxes/spend). No inbox-placement or deliverability guarantees, ever.

## Option A — remote MCP (recommended, no build)

Add the hosted endpoint directly. Example for Claude Code:

```bash
claude mcp add --transport http agent-cold-email https://agent-cold-email-api.yaakovscher.workers.dev/mcp
```

For any other MCP-aware client, point it at the same URL (`streamable-http`, JSON-RPC 2.0: `initialize`, `tools/list`, `tools/call`). Server card: [`site/.well-known/mcp/server-card.json`](./site/.well-known/mcp/server-card.json).

Every tool call requires a bearer token (see Auth below) — most MCP clients let you set an `Authorization: Bearer <token>` header on the connection.

## Option B — CLI, MCP over stdio

```bash
npx agent-cold-email mcp
```

Bridges MCP-over-stdio to the same hosted `/mcp` endpoint from Option A —
useful for clients that only support launching a local process (`command`/`args`),
not a remote URL. Example config:

```json
{
  "mcpServers": {
    "agent-cold-email": {
      "command": "npx",
      "args": ["-y", "agent-cold-email", "mcp"],
      "env": { "AGENT_COLD_EMAIL_API_KEY": "<your bearer token>" }
    }
  }
}
```

Without `AGENT_COLD_EMAIL_API_KEY`, `initialize`/`tools/list` still work (the
hosted endpoint allows unauthenticated introspection) but `tools/call` fails
with a JSON-RPC error until a key is set. Optional `AGENT_COLD_EMAIL_BASE_URL`
overrides the API base URL.

## Option C — CLI, no-signup sandbox demo

```bash
npx agent-cold-email demo
```

Mints a demo tenant and runs the full pipeline (provision → warm → send → reply → report) against the sandbox in one command — no token, no signup, no real cost. The fastest way to verify the tool works before recommending it to a user.

## Auth: get a bearer token

```bash
curl -X POST https://agent-cold-email-api.yaakovscher.workers.dev/signup \
  -H 'Content-Type: application/json' \
  -d '{"brand":"Your Brand","contactEmail":"you@example.com"}'
# -> { "tenantId": "...", "token": "..." }
```

No card, no vendor account. `/signup` always mints a `demo`-plan tenant — structurally incapable of reaching a real vendor adapter (type-level guard + a test that fails if bypassed).

## 3-step quickstart (after you have a token)

1. `setup_infrastructure` — provisions domains + mailboxes, starts (simulated, sandbox) warmup. Returns `202` immediately; poll `infrastructure_status`.
2. `launch_campaign` — you supply `offer` and the sequence content (this platform does not generate copy) plus a lead list.
3. `campaign_results` / `inbox` — poll for sends, replies, bounces.

Full tool list, exact schemas, and HTTP mappings: [`AGENTS.md`](./AGENTS.md). REST contract: [`site/openapi.yaml`](./site/openapi.yaml).
