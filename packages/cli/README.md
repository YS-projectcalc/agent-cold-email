# agent-cold-email (CLI)

The `agent-cold-email` command-line client for the agent-cold-email cold-email
infrastructure API (see the repo root `README.md` / `AGENTS.md` for what the
platform is). Nine of the ten commands are thin wrappers over the HTTP
facade — no logic beyond argument parsing and printing; every one hits
`https://agent-cold-email-api.yaakovscher.workers.dev` (or `$AGENT_COLD_EMAIL_API`)
directly. The tenth, `mcp`, bridges MCP-over-stdio to the same hosted API's
`/mcp` endpoint — see below.

> **Early access.** Published on npm as `agent-cold-email@0.2.0`. The API it
> talks to runs in test mode today: sandbox vendor adapters, no real
> domains, mailboxes, or sends yet — see [Pricing](#pricing) below and the
> repo root `README.md` for full status.

## Install

```
npx agent-cold-email demo
```

## Pricing

The `demo` command above is free, today — no signup, no card, no waitlist.
Provisional early-access pricing for real sending once it activates: starts
at **$99/month for 5 provisioned mailboxes**, then **$10/month per
additional mailbox** (a $49 platform fee + $10/mailbox, 5-mailbox minimum).
**No send quota** — sends are not the billing meter. Full ladder and
calculator: [coldrig.dev/pricing](https://coldrig.dev/pricing).

## The demo (no signup required)

```
npx agent-cold-email demo
```

Mints a disposable demo tenant, provisions sample branded domains and
mailboxes, and runs the accelerated sandbox pipeline end to end: warmup,
sends respecting per-mailbox caps, replies, bounces, and a stop-on-reply
proof — all against a fault-injecting simulator, never a real domain,
mailbox, or inbox. Ends with an honest line: this ran in a sandbox, no real
emails were sent, real sending is early-access. Building from source instead
(e.g. to test an unreleased change)? Run `node dist/index.js demo` after
the build steps in [How to run](#how-to-run) below.

## Commands

| Command | What it does |
|---|---|
| `demo` | The hero command — see above. |
| `signup --brand <name> --email <email>` | `POST /signup`; prints the tenant id + bearer token. |
| `setup [--brand ...] [--domains N] [--inboxes-each N] ...` | `POST /setup-infrastructure`. |
| `status` | `GET /infrastructure-status`. |
| `campaign launch --file <campaign.json>` | `POST /campaigns` with the file as the request body. |
| `campaign results <campaignId>` | `GET /campaigns/{id}/results`. |
| `inbox` | `GET /inbox`. |
| `inbox thread <id>` | `GET /threads/{id}`. |
| `inbox reply <id> <body>` | `POST /threads/{id}/reply`. |
| `inbox mark <id> <read\|unread\|archived>` | `POST /threads/{id}/mark`. |
| `metrics` | `GET /metrics`. |
| `pause <campaignId>` / `pause --all` | `POST /campaigns/{id}/pause` / `POST /campaigns/pause-all`. |
| `account` | `GET /account`. |
| `mcp` | Serve MCP over stdio, bridged to the hosted endpoint — see below. |

Every authed command needs a token: pass `--token <token>` or set
`AGENT_COLD_EMAIL_TOKEN` (`demo` and `signup` are the only exceptions — they
mint their own tenant).

## `mcp` — stdio MCP server

`agent-cold-email mcp` serves MCP over stdio, bridged to the hosted
streamable-HTTP endpoint (the standard "mcp-remote" pattern, built on the
official `@modelcontextprotocol/sdk`). This is what makes the npm package
directly installable as an MCP server, per the [registry
quickstart](https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/quickstart.mdx),
as an alternative to pointing a client straight at the hosted remote (see
the repo root `llms-install.md`).

Client config (e.g. `claude_desktop_config.json` / `mcp.json`):

```json
{
  "mcpServers": {
    "agent-cold-email": {
      "command": "npx",
      "args": ["-y", "agent-cold-email", "mcp"],
      "env": {
        "AGENT_COLD_EMAIL_API_KEY": "<your bearer token>"
      }
    }
  }
}
```

Without a key, `initialize`/`tools/list` still work (the hosted endpoint
allows unauthenticated introspection) but `tools/call` fails with a
JSON-RPC error until one is set — get one with `signup` or `demo` above.

## Env vars

- `AGENT_COLD_EMAIL_API` — API base URL for the REST commands. Default: `https://agent-cold-email-api.yaakovscher.workers.dev`.
- `AGENT_COLD_EMAIL_TOKEN` — bearer token for the REST commands, used when `--token` isn't passed.
- `AGENT_COLD_EMAIL_API_KEY` — bearer token for `mcp` mode.
- `AGENT_COLD_EMAIL_BASE_URL` — API base URL override for `mcp` mode. Default: same as `AGENT_COLD_EMAIL_API`'s default.

## How to run

```
npm install                       # from repo root (npm workspaces)
npm run typecheck -w agent-cold-email
npm run build -w agent-cold-email  # emits dist/ (tsc, NodeNext ESM)
node packages/cli/dist/index.js demo
```

## Layout

- `src/client.ts` — the one HTTP client (`request()`, `pollUntil()`, token/base-URL resolution).
- `src/flags.ts` — a minimal dependency-free `--flag value` / positional-arg parser.
- `src/commands/*.ts` — one file per command group, each a thin `request()` wrapper (except `mcp.ts`, the stdio↔streamable-HTTP bridge).
- `src/index.ts` — the `#!/usr/bin/env node` bin entry; dispatches `process.argv` to a command.
- `test/` — behavior tests for `mcp` mode (`node --test`); the nine REST commands have no test lane yet (thin wrappers, covered indirectly by the platform's own HTTP tests).

## Depends on

The nine REST commands: nothing beyond Node's built-in `fetch`/`fs` (Node
>=18). No `@coldstart/*` workspace dependency — they only ever talk HTTP,
matching the "one bearer token, no vendor SDKs" pitch in `AGENTS.md`.

`mcp` mode is the one exception: it depends on the official
`@modelcontextprotocol/sdk` to speak stdio↔streamable-HTTP MCP correctly
(hand-rolling that framing would be exactly the kind of protocol
reimplementation the SDK exists to avoid). This is the package's only
runtime dependency.
