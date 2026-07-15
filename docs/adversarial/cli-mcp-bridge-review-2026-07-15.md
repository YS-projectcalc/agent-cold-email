# Adversarial review — CLI stdio↔MCP bridge (`agent-cold-email mcp`)

- **Date:** 2026-07-15
- **Reviewer:** adversary (fresh context)
- **Grounding HEAD:** `9174dac7820a07c5eb352beac4107904c4323682` (branch `main`, uncommitted diff)
- **Scope:** the uncommitted diff — `packages/cli/src/commands/mcp.ts` (new), `packages/cli/src/index.ts`, `packages/cli/package.json`, `packages/cli/README.md`, `packages/cli/test/**` (new), root `server.json`, `llms-install.md`, `package-lock.json`, `ROADMAP.md`.
- **Method:** read + independent re-run of typecheck/build/test, custom stdio subprocess harnesses against the committed stub AND the live production Worker, byte-level tool-schema diff, npm pack dry-run, lockfile inspection.

## VERDICT (round 1): NO-SHIP — superseded by the fix-round addendum below (final: SHIP)

One BLOCKING finding survives self-refutation: the committed test lane — the builder's headline SHIP evidence — is flaky and fails intermittently. The live bridge itself is functional (initialize + 17 tools verified against production), and token hygiene / stdout contract / forwarding fidelity / metadata consistency / supply chain all HELD. The blocker is reliability of the shipped test lane + the connect-ordering fragility behind it, not a broken live product.

---

## Findings (most severe first)

### 1. BLOCKING — `npm test` is flaky (~40–50% intermittent failure); builder's "red-then-green (2)" is not reproducible. Lens 2 (RUN it) + lens 5 (fixture realism).

**Failure scenario:** `packages/cli/test/mcp.test.mjs` drives the built bridge as a subprocess and waits ≤5000ms per JSON-RPC request (`test/helpers/rpc-harness.mjs:29`, `timeoutMs = 5000`). The bridge does not answer the client's `initialize` until its **entire upstream connect completes**, and that latency empirically straddles the 5000ms ceiling.

**Root cause — `packages/cli/src/commands/mcp.ts:54` then `:70`:**
```
await upstream.connect(transport);          // full upstream MCP handshake (mcp.ts:54)
...                                          //   + heavy-SDK module load + GET-SSE negotiation
await server.connect(new StdioServerTransport());   // stdio server only NOW starts reading stdin (mcp.ts:70)
```
The local stdio server is deaf to the client's `initialize` for the whole upstream-connect window.

**Verification (measured, timestamps quoted):**
- `npm test` run x3 → `1 fail / 1 fail (different test) / 0 fail`. Failures reported `~5000ms` (hit the harness timeout).
- Isolated `initialize`-response latency, committed stub, 5 runs: **1819, 3737, 2644, 5001, 6846 ms** → 2/5 over 5000ms.
- Isolated `initialize`-response latency, **LIVE production endpoint**, 4 runs: **4487, 4485, 3984, 4797 ms** (one earlier single run was 1136ms) — all near the 5000ms ceiling.
- Long-timeout probe: initialize answered at **+3354ms**; the stdio server verifiably does not respond before `upstream.connect()` resolves.

**Self-refutation:** "It's just the loaded review machine (many concurrent agents)." Rejected: (a) the 3-run determinism test shows real flakiness now; (b) CI runners are typically slower/noisier than a dev box; (c) the harness timeout provides zero engineered margin over the observed 2–5s+ latency band; (d) live measurements clustered at 4–4.8s independent of the stub. Absolute numbers may be load-inflated, but "flaky as committed" is a load-independent fact. The minimal fix (raise harness timeout) is small but MASKS the ordering fragility; the robust fix restructures `runMcp` so the stdio server begins serving before/concurrently with the slow upstream connect (or lazily connects upstream on first request).

**Live-product note:** real MCP clients (Claude Desktop/Cursor) use generous init timeouts, so a 4–5s startup does not break them — the live bridge works (17 tools returned). The blocker is the unreliable committed test lane + the latent startup-latency fragility, both of which gate committing this as "green."

### 2. NON-BLOCKING — no clean shutdown on stdin EOF (orphan-process risk). Lens 2/design.

**Scenario:** closing the child's stdin (client disconnect via pipe close) leaves the bridge **alive 8s+ later** (measured). `runMcp` wires no `transport.onclose`/stdin-EOF → process-exit, and the upstream `Client` HTTP transport (with its SSE-GET reconnection loop, observed retrying in the instrumented stub) keeps the event loop alive. MCP stdio servers SHOULD exit on stdin close. `SIGINT`/`SIGTERM` DO exit cleanly (verified, 0 stdout bytes) — the common client-kill path — so severity is moderate. `mcp.ts:70`.

### 3. NON-BLOCKING — `server.json` `isRequired: true` for `AGENT_COLD_EMAIL_API_KEY` vs warn-not-die. Lens 4 (metadata truth).

The packages block marks the key `isRequired: true` / `isSecret: true`, but the CLI deliberately starts without it (warn-not-die) to keep keyless introspection alive. A strict registry checker honoring `isRequired` could refuse to start keyless, partially defeating the stated rationale. Defensible either way; note the tension. `server.json` packages block.

### 4. NON-BLOCKING — npm-publish ordering dependency. Lens 4.

`server.json` packages block claims npm `agent-cold-email@0.2.0`, but `README.md` says "Not yet published to npm." The MCP registry validates that the *published* npm package's `package.json` contains a matching `mcpName`. A registry update to 0.2.0 must not precede the 0.2.0 npm publish or validation fails. Not a code defect — a sequencing constraint for the owner-gated publish step.

### 5. NON-BLOCKING — `AGENT_COLD_EMAIL_BASE_URL` override has no scheme enforcement (cleartext-bearer). Lens 1.

`resolveMcpUrl()` (`mcp.ts:23`) accepts any scheme; a `http://` base sends the bearer in cleartext. Same-actor env control makes token-exfil-to-attacker-URL **acceptable-by-design** (standard self-hosting override pattern — ruled acceptable), but a fat-fingered/downgraded `http` base would transmit the token unencrypted. Minor.

### 6. NON-BLOCKING — SDK dependency weight. Lens 5 / dependency risk.

89 lockfile entries added, including a full server-side HTTP stack (`express@5`, `hono`, `jose`, `cors`, `express-rate-limit`) the bridge never uses (it uses only the client transport + stdio server). Supply chain is clean: **no install/postinstall scripts** (no `hasInstallScript`, no pre/post-install in the 89 entries), SDK integrity pinned. `^1.29.0` permits future minor drift on install. Acceptable (official SDK), but heavy for a formerly zero-runtime-dep CLI.

---

## Attacks that FAILED (held)

- **Token hygiene (lens 1):** `apiKey` read from env only (never argv → not exposed in `ps`), used ONLY in the `Authorization` header (`mcp.ts:50`), never passed to any `console.*` call (grep of src+dist clean); the warn message and the connect-error message (`err.message`, no creds in the URL) do not include it. No leak via stderr/stdout/argv/error frame.
- **stdout contract (lens 3):** warn→stderr; connect-failure→stderr + `exit(1)`; all JSON-RPC→stdout. Unknown trailing args (`mcp --bogus extra`) leak nothing to stdout. SIGINT run produced 0 stdout bytes. Every non-protocol path routes to stderr.
- **Forwarding fidelity (lens 2):** bridge `tools/list` vs direct `curl` `tools/list` — all **17 tools semantically identical**; the byte difference was SDK zod-round-trip key-reordering only, not content mangling.
- **Keyless auth interpretation (warn-not-die) — RULED CORRECT / APPROVE:** live endpoint serves `initialize`+`tools/list` keyless; `tools/call` returns a clean JSON-RPC error (missing-key test asserts `error.code` is a number AND the process answers a subsequent request → no crash/hang). Dying on missing key would break the registry-checker introspection use case. The interpretation is right.
- **Version/mcpName consistency (lens 4):** `package.json` 0.2.0 == `server.json` version 0.2.0 == `packages[0].version` 0.2.0; `package.json` `mcpName` `io.github.YS-projectcalc/agent-cold-email` == `server.json` `name`.
- **Supply chain (lens 5):** no install scripts across the 89 added lock entries; SDK pinned + integrity hash present.
- **npm pack (lens 4):** 14 files, `dist/commands/mcp.js` (3.5kB) present, `test/` NOT shipped, 8.3kB tarball — matches builder claim.
- **Doc claim-truth (lens 6):** README/llms-install keyless-behavior statements ("`initialize`/`tools/list` still work… `tools/call` fails with a JSON-RPC error") verified true against the live endpoint; "package's only runtime dependency" true (`dependencies` has only the SDK); Option B/C renumber in `llms-install.md` consistent. Pre-existing "not-yet-published `npx`" framing is covered by the README's standing "Not yet published to npm" caveat — no NEW falseness introduced.
- **Independent lanes:** `typecheck` exit 0; `build` exit 0; `npm pack` clean (above). (`npm test` covered under Finding 1.)

## UNVERIFIABLE

- **Concurrent in-flight `tools/call` id-matching under load:** not stress-tested. The design delegates id assignment/matching to the SDK `Client` (upstream) and SDK `Server` (stdio) — the standard pattern — but concurrent calls were not driven. Resolve with a concurrency stress test.
- **Upstream 5xx / timeout / mid-call disconnect (vs 401):** the 401 error path is proven clean; a true 5xx or a connection dropped mid-response during an in-flight `tools/call` was not injected (the stub models only 401). Low risk given the 401 path forwards cleanly. Resolve with a fault-injecting stub returning 5xx / dropping mid-stream.

## NEW (out-of-scope) observations

- None beyond the above.

---

# FIX-ROUND ADDENDUM — 2026-07-15 (same day, delta re-attack)

- **Grounding HEAD:** `9174dac` unchanged (delta is an in-place uncommitted edit; `git status` confirms `?? packages/cli/src/commands/mcp.ts` + `?? packages/cli/test/`, `M server.json`).
- **Delta:** `mcp.ts` restructured (stdio served first, upstream connect backgrounded as `upstreamReady`, tools handlers `await` it, EOF handler, http-cleartext warning); new `test/mcp-lifecycle.test.mjs`; `test/helpers/*` gain `initializeDelayMs` + `requestTimed` + 15s backstop timeout; `server.json` `isRequired: false` + expanded description.

## FINAL VERDICT: SHIP

The round-1 BLOCKER (finding #1, flaky lane from `await upstream.connect()` before serving stdio) is **RESOLVED**, and every fix-round attack I mounted FAILED. Round-1 NON-BLOCKING #2 (orphan), #3 (isRequired), #5 (cleartext) are also closed. No new blocker.

## How the blocker was closed (verified, not trusted)

- **Ordering fix — `mcp.ts:81`:** `const upstreamReady = upstream.connect(transport).catch(...)` runs the handshake in the background; `server.connect(new StdioServerTransport())` (`mcp.ts:109`) now starts serving immediately. `initialize`/`notifications/initialized` are answered locally by the SDK `Server` without touching `upstream`. Verified: against a stub with an **8000ms** upstream-init delay, the bridge's own `initialize` answered in **<4000ms** (the lifecycle test's assertion, `elapsedMs < SLOW_MS/2`) — a proper revert-fail bound (round-1 measured old-code `initialize` at 2–8s, which lands on the failing side of 4000ms).
- **Lane no longer flaky:** ran the full lane (both test files, 4 tests) **3×** → **4 pass / 0 fail every time**; `typecheck` 0; `build` 0; `npm pack` **14 files** unchanged (`dist/commands/mcp.js` present, now 5.7kB; `test/` not shipped).
- **Harness timeout 5000ms → 15000ms** (`rpc-harness.mjs`) is a backstop only; the real correctness signal is `mcp-lifecycle.test.mjs`'s measured-elapsed assertion, not the timeout.

## Fix-round attacks — all FAILED (held)

- **Background-connect-failure racing an in-flight `tools/call` (the flagged risk):** stub that delays 1500ms then 500s the `initialize` so `upstream.connect()` rejects while a `tools/call` sits at `await upstreamReady`. Result: **exit code 1** at +1997ms; **stdout = exactly one line, complete valid JSON** (the locally-answered `initialize` frame); the in-flight `tools/call` was silently dropped (process terminated before its handler resumed — no `upstream.callTool` on a dead client). **No `UnhandledPromiseRejection`, no stack trace on stderr** — only the intended `failed to connect to …` line. Microtask ordering holds: the `.catch(process.exit(1))` is attached directly to the connect promise, so it runs before the downstream `await upstreamReady` continuation can resume. **No half-written stdout frame.**
- **`exit(1)` mid-`initialize` half-frame:** cannot occur — `initialize` is local and written early (small ~150B frame, synchronous pipe write) well before any background-connect failure; confirmed the only stdout line on the failure path parses cleanly.
- **stdout contract on ALL new paths:** keyless-warn, http-cleartext-warn, connect-failure, and EOF each produced **0 stray stdout bytes** (every captured stdout line valid JSON). All diagnostics route to stderr.
- **http-cleartext warning matrix:** fires **only** for `http://` + non-loopback + key present; suppressed for no-key (→ keyless-warn instead), `http://127.0.0.1`, and `https://`. Warning text names the env var but **not** its value (no key leak). `new URL("http://[::1]/mcp").hostname === "[::1]"` (brackets retained) → IPv6 loopback correctly exempted, **no false-positive**.
- **EOF → clean shutdown:** `process.stdin.on("end", () => process.exit(0))` — lifecycle test asserts **exit 0 within 5s** of stdin EOF, green 3/3. Registering an `end` listener does not put stdin in flowing mode prematurely (only the transport's `data` listener does), so no ordering hazard.
- **Forwarding fidelity preserved:** handlers still return `upstream.listTools()` / `upstream.callTool(request.params)` verbatim (only prefixed with `await upstreamReady`); round-1's 17-tools-semantically-identical result stands.
- **Metadata:** `server.json` `AGENT_COLD_EMAIL_API_KEY` now `isRequired: false` (matches warn-not-die); round-1 NON-BLOCKING #3 closed.

## Carried NON-BLOCKING (unchanged, do not gate)

- **npm-publish ordering (round-1 #4):** `server.json` claims npm `agent-cold-email@0.2.0` while README says "not yet published" — the 0.2.0 npm publish must land before/with any MCP-registry update or `mcpName` validation fails. Owner sequencing note, not a code defect. (This is precisely the founder's two publish commands on SHIP.)
- **SDK weight (round-1 #6):** 89 lock entries incl. an unused server-side HTTP stack; no install scripts, integrity pinned. Acceptable.
- **Minor:** the slow-stub lifecycle test adds ~9s of wall-time to the lane (waits out the pending 8000ms stub connection during teardown) — reliable, just slow. The connect-failure stderr message echoes the unbounded upstream response body (stderr-only, user-chosen upstream) — cosmetic.

## UNVERIFIABLE (unchanged)

- High-concurrency in-flight `tools/call` id-matching (delegated to the SDK on both sides; not stress-driven).
- True upstream 5xx / mid-stream disconnect during an established (post-connect) `tools/call` — the pre-connect failure path is proven clean; the post-connect error path is proven only for 401.
