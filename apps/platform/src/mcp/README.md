# src/mcp

The hosted MCP surface (B5 brief) — a direct JSON-RPC 2.0 handler over
streamable HTTP, mounted at `POST /mcp` (`../routes/mcp.ts`). Deliberately
NOT the Agents SDK `McpAgent`: the facade is ~12 tools with no resources,
prompts, sampling, or SSE streaming, so a thin hand-rolled handler keeps the
surface small and auditable (ARCHITECTURE.md #7 called for `McpAgent`
specifically; this brief's "our facade is thin" instruction supersedes that
for the transport implementation — the tool list/contract is unchanged).

- `tools.ts` — the 12 `McpTool` definitions (name, description, zod
  `schema`, and a `call(stub, args)` that dispatches to the SAME `TenantDO`
  method the equivalent HTTP route in `../routes/*.ts` calls). This is the
  single source of truth for what a tool does — never a parallel
  reimplementation of the facade (CLAUDE.md rule c).
- `schemas.ts` — zod schemas for MCP tool arguments: reuses the
  `@coldstart/shared` intent schemas for tools whose HTTP body IS the
  argument object, and adds small schemas for the tools whose HTTP shape is
  `id-in-URL + body` (MCP tools have no URL, so the id becomes an argument
  field, e.g. `{ threadId, body }` for `reply`).
- `handler.ts` — `handleMcpRequest(env, authHeader, raw)`: parses/dispatches
  `initialize`, `notifications/initialized`, `tools/list`, `tools/call`.
  `tools/list` returns each tool's `inputSchema` via zod v4's native
  `z.toJSONSchema()` (no extra dependency). `tools/call` is the only method
  that touches tenant data, and is the one place auth happens.

## Auth model (critical — read before touching this file)

`tools/call` resolves the tenant **fresh, on every single call**, via
`resolveTenantFromToken(env, authHeader)` (`../require-auth.ts` — the exact
same resolver the HTTP facade's `requireAuth` middleware uses). Nothing in
`handler.ts` or `tools.ts` caches a tenant/stub across requests: `MCP_TOOLS`
holds no per-request state, and `handleMcpRequest` takes the env + header on
every call. Two different bearer tokens hitting `/mcp` back-to-back get
their own, correctly isolated tenant every time — proven by
`test/mcp.test.ts`'s two-token isolation test.

`initialize` / `tools/list` require no auth (protocol discovery only, no
tenant data). A missing/invalid token on `tools/call` returns a top-level
JSON-RPC error (code `-32001`, HTTP 401) — never a partial/degraded
"anonymous" result.

## How to run

Part of `apps/platform`; exercised by `apps/platform/test/mcp.test.ts`.
