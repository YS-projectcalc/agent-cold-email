# agent-cold-email (CLI)

The `agent-cold-email` command-line client for the agent-cold-email cold-email
infrastructure API (see the repo root `README.md` / `AGENTS.md` for what the
platform is). Thin wrappers over the HTTP facade — no logic here beyond
argument parsing and printing; every command hits
`https://agent-cold-email-api.yaakovscher.workers.dev` (or `$AGENT_COLD_EMAIL_API`)
directly.

**Not yet published to npm** — this package ships in the repo ahead of the
`npx agent-cold-email` distribution flip, which is an owner-hands activation
step (`ACTIVATION.md`). Until then, run it from a local build (see below).

## Install (once published)

```
npx agent-cold-email demo
```

## The demo (no signup required)

```
node dist/index.js demo
```

Mints a disposable demo tenant, provisions sample branded domains and
mailboxes, and runs the accelerated sandbox pipeline end to end: warmup,
sends respecting per-mailbox caps, replies, bounces, and a stop-on-reply
proof — all against a fault-injecting simulator, never a real domain,
mailbox, or inbox. Ends with an honest line: this ran in a sandbox, no real
emails were sent, real sending is early-access.

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

Every authed command needs a token: pass `--token <token>` or set
`AGENT_COLD_EMAIL_TOKEN` (`demo` and `signup` are the only exceptions — they
mint their own tenant).

## Env vars

- `AGENT_COLD_EMAIL_API` — API base URL. Default: `https://agent-cold-email-api.yaakovscher.workers.dev`.
- `AGENT_COLD_EMAIL_TOKEN` — bearer token, used when `--token` isn't passed.

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
- `src/commands/*.ts` — one file per command group, each a thin `request()` wrapper.
- `src/index.ts` — the `#!/usr/bin/env node` bin entry; dispatches `process.argv` to a command.

## Depends on

Nothing at runtime beyond Node's built-in `fetch`/`fs` (Node >=18). No
`@coldstart/*` workspace dependency — the CLI only ever talks HTTP, matching
the "one bearer token, no vendor SDKs" pitch in `AGENTS.md`.
