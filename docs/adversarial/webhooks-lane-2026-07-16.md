# Adversarial review — per-tenant outbound webhooks lane

- **Date:** 2026-07-16
- **Reviewer:** adversary (fresh context)
- **Base ref:** working tree vs HEAD `bf3a927e2869d038f201b315de146735e477708f`
- **Scope:** webhook hunks in `apps/platform/**` + `packages/shared/src/webhooks.ts` (+ shared index export). Poll-fix hunks (apps/engine, provisioning.ts, idempotency.test.ts, poll_cursor lines) OWNED BY A SEPARATE ADVERSARY — excluded.
- **VERDICT: SHIP.** No BLOCKING finding survives self-refutation. Four NON-BLOCKING findings; one UNVERIFIABLE reachability item (SSRF residual on Cloudflare Workers egress).

## Verification (re-run by reviewer, not trusted from builder)

- `npx vitest run` (apps/platform): **407 passed / 62 files** — matches the claimed 407.
- `npm run typecheck` (`tsc --noEmit -p tsconfig.json`): clean.
- `npm run build` (`wrangler deploy --dry-run --outdir dist`): clean, bindings resolve.
- SSRF validator logic executed against the real WHATWG `new URL` parser (Node/Ada, WHATWG-compliant like Workers) over a 23-URL bypass table — see Findings 1.

## Findings (most severe first)

### NB-1 · Lens 1/2 · NON-BLOCKING · SSRF validator gaps on exotic IPv6 embeddings + trailing-dot localhost
`assertSafeWebhookUrl` (`apps/platform/src/engine/webhook-security.ts:51`) is **strong on every documented encoding** — I ran hex `0x7f000001`, decimal `2130706433`, octal `0177.0.0.1`, 2-part `0x7f.1`, trailing-dot `127.0.0.1.`, integer `2852039166` (=169.254.169.254), and IPv4-mapped `[::ffff:169.254.169.254]`/`[::ffff:7f00:1]` — **all BLOCKED** by WHATWG normalization + the dotted-quad/mapped decoders. But four inputs slip through:

- `https://[64:ff9b::a9fe:a9fe]/` — NAT64 well-known prefix embedding **169.254.169.254** → **ALLOWED**.
- `https://[64:ff9b::7f00:1]/` — NAT64 embedding **127.0.0.1** → **ALLOWED**.
- `https://[::127.0.0.1]/` (serializes to `::7f00:1`, deprecated IPv4-compatible IPv6, loopback) → **ALLOWED**.
- `https://localhost./` — trailing-dot FQDN form of localhost → **ALLOWED** (the explicit `hostname === "localhost"` check at `webhook-security.ts:87` misses it; the `.includes(".")` FQDN branch lets it pass).

Root cause: `embeddedIpv4FromIpv6` (`webhook-security.ts:130`) only decodes the `::ffff:` IPv4-mapped form and dotted `::`/`::ffff:` forms — it does not decode the NAT64 `64:ff9b::/96` prefix or the deprecated IPv4-compatible `::x.x.x.x` prefix. The `localhost` check is literal-string, not shape-normalized.
**Why NON-BLOCKING, not BLOCKING:** reachability is unproven (see UNVERIFIABLE-1). These all target loopback/link-local via mechanisms that are non-routable (IPv4-compatible is deprecated/unrouted), translator-dependent (NAT64 needs a gateway on the egress path), or DNS-dependent (`localhost.` — the disclosed DNS residual); and there is no cloud-metadata service at 169.254.169.254 in the Workers runtime. The primary encoding-evasion class (the headline attack) is CLOSED.
**Honesty note:** the module comment (`webhook-security.ts:9-15`) claims it "rejects every private/reserved IP LITERAL (in any encoding the WHATWG URL parser normalizes)." `::127.0.0.1` IS a form the parser normalizes (→`::7f00:1`) that embeds a reserved literal and is NOT rejected — so that sentence slightly overstates coverage. Recommend closing the three gaps and softening the claim.
**Verification:** ran the exact validator functions against `new URL` in a scratch harness; outputs above are literal.

### NB-2 · Lens 5 · NON-BLOCKING · SSRF test table does not cover the NB-1 residuals
`apps/platform/test/webhook-subscriptions-security.test.ts:15-37` asserts rejection for the documented encodings but has no case for NAT64 / IPv4-compatible / trailing-dot-localhost — so the suite would stay green even if those became reachable. If NB-1 is closed, add these to the REJECTED table (they'd fail today = a proper revert-fail test).
**Verification:** read the full test file; the four NB-1 inputs are absent.

### NB-3 · Lens 5 · NON-BLOCKING · unbounded serial per-sweep work → cross-tenant delivery starvation at scale
`runWebhookDeliveriesAllTenants` (`apps/platform/src/admin/ops-sweep.ts`) iterates every tenant **sequentially** with no per-tenant time budget; each tenant's `pumpWebhookDeliveries` can process `PUMP_BATCH = 50` deliveries each with a `WEBHOOK_DELIVERY_TIMEOUT_MS = 10s` timeout = up to ~500s of wall-clock in one DO invocation. With many tenants or many timing-out endpoints, later tenants' deliveries starve within a 5-min cron tick and the sweep can exceed Worker limits, dropping the tail (retried next tick).
**Why NON-BLOCKING:** identical pattern to the existing `runDeliverabilitySweepAllTenants`; self-healing across ticks; a fairness/liveness concern, not a correctness/isolation/security breach; latent at current (early-access, real-sending-not-armed) scale.
**Verification:** traced the loop; no concurrency cap or time budget; PUMP_BATCH/timeout constants read from `webhook-delivery.ts:18-25`.

### NB-4 · Lens 8 · NON-BLOCKING · secret rotation signs already-queued deliveries with the NEW secret
The pump reads `sub.secret` fresh at delivery time (`webhook-delivery.ts:104-110`), while the body is frozen at enqueue. A delivery queued before a `PUT`-rotation is signed with the post-rotation secret. This is arguably CORRECT (the consumer verifies with its current secret), but a consumer that hasn't yet updated its verifier will 401 in-flight deliveries until it does (they retry per the backoff ladder). Informational — no secret exposure, no security hole.
**Verification:** traced enqueue (body frozen, `webhook-enqueue.ts:42`) vs pump (secret read live).

## Attacks that FAILED (why the PASS is meaningful)

- **Lens 1 — SSRF headline (primary encodings).** Ran hex/decimal/octal/2-part/integer/trailing-dot IPv4 + IPv4-mapped-IPv6 through the real `new URL` + validator: every one normalizes to dotted-quad and is caught by `disallowedIpv4Reason`, or (mapped) decoded by `embeddedIpv4FromIpv6` and caught. Integer forms without dots also caught by the single-label guard even if normalization failed. `example.com@169.254.169.254` → rejected on the userinfo check before the host check. HELD (except NB-1 residuals).
- **Lens 2 — SSRF re-validation at delivery.** `realWebhookDeliverer` re-calls `assertSafeWebhookUrl` before fetch and returns `url_rejected` without calling fetch (proven by the DNS-rebinding-posture test, `webhook-subscriptions-security.test.ts:119`). `redirect: "manual"` → a 3xx is graded `redirect_not_followed`, never followed (tested). `AbortSignal.timeout(10s)` enforced; response snippet capped at 512 (tested). HELD.
- **Lens 8 — tenant isolation.** Both transports resolve the tenant DO from the auth credential (`require-auth.ts:60`/`stubFor`; MCP handler resolves fresh per JSON-RPC call, no caching). `ctx.tenantId` is the DO's OWN identity (`tenant-context.ts:103/209`), never client input. Every webhook query is `WHERE tenant_id = ?` scoped, and `getWebhook`/`requireSubscription` scope the id lookup by tenant → a cross-tenant id yields `NotFoundError` (404). The isolation test (`webhook-subscriptions.test.ts:104`) proves B's list is empty, B→A's id 404s on GET and DELETE, and A still owns the row (so the 404 isn't a broken read). Payload data is the tenant's OWN event metadata pushed to the tenant's OWN endpoint — no cross-tenant leak. HELD.
- **Lens 3/6 — event-recording integrity.** Enqueue sits at the single `recordEventIfNew` choke point AFTER the event INSERT commits, wrapped in try/catch that logs and swallows (`reply-processor.ts:97-125`) → a webhook failure can NEVER roll back or block event recording/suppression/stop-on-reply. A re-polled duplicate returns `false` at `rowsWritten === 0` BEFORE enqueue → no double-enqueue; and `INSERT OR IGNORE` + `UNIQUE(subscription_id, event_id)` (`schema.ts`) makes fan-out idempotent even if it were re-entered. HELD.
- **Lens 6 — auth routing edge (both directions).** `/webhook-subscriptions` + `/webhook-subscriptions/*` are in `AUTHED_PATH_PATTERNS` and mounted in the `authed` sub-app → requireAuth + csrfGuard on all five CRUD routes (isolation test drives them with tokens). No bare `/webhooks` or `/webhooks/*` pattern exists, so `/webhooks/stripe` (mounted unauth at `index.ts:44`) is untouched and still signature-gated (`webhook-security.test.ts`, green in the 407). HELD.
- **Lens 1 (prior-blocker class) — MCP annotation honesty.** `get_webhooks` `readOnlyHint:true`: handler dispatches `stub.webhooks()` (pure SELECT) / `stub.webhook(id)` (three pure SELECTs, no `ensure*/seed*/refresh*` first-call) — HONEST, no lazy-write. Covered by the write-detecting spy (`mcp-tool-annotations.test.ts:143`, list path). `configure_webhook` `destructiveHint:true` flagged for its worst-case delete. HELD.
- **Lens 7 (regression ring) — reset-before-signal on the auto-disable tally.** `consecutive_failures` increments only on TERMINAL delivery failure and resets only on a successful delivery, both synchronous in the pump loop — unlike the historical soft-bounce class (send-resets / poll-increments across turns), there is no async-signal-vs-trigger mismatch. Threshold 5 is reachable. HELD.
- **Lens 8 — HMAC/secret handling.** HMAC-SHA256 over the RAW frozen body (`webhook-security.ts:201`); secret returned ONCE on create/rotate, never on reads (`WebhookSummary` has no secret field); never logged (error tags are `url_rejected`/`http_NNN`/name only). No inbound self-signature-verification path exists (outbound-only), so timing-safe compare is the consumer's concern. HELD.

## UNVERIFIABLE

- **UNVERIFIABLE-1 · Cloudflare Workers egress reachability of the NB-1 residuals.** Whether `fetch()` from the deployed Worker to `https://[64:ff9b::a9fe:a9fe]/` (NAT64→169.254.169.254) or `https://[::7f00:1]/` actually connects to a sensitive target depends on Cloudflare egress routing (NAT64 gateway presence, deprecated-address routing) and the absence of a colocated metadata service — none testable from this read-only local review without a deployed endpoint. **If Cloudflare egress performs NAT64 translation on the well-known prefix, NB-1 escalates to BLOCKING; if egress cannot route RFC1918/link-local (the builder's documented backstop), all NB-1 residuals stay contained.** Resolves via: a one-off live Worker `fetch` to those literals observing connect-vs-refuse, or Cloudflare egress documentation confirming private/NAT64 routing behavior.

## NEW (out-of-scope) observations — no verdict weight

- Write-spy exercises `get_webhooks` only on the LIST path (`i.webhooks()`), not the detail path `i.webhook(id)`. Detail is trace-confirmed pure SELECT, so no defect — but the spy wouldn't catch a future lazy-write introduced on the detail path. (Same residual pattern noted for the dashboard tools in a prior round.)

---

# ADDENDUM — SSRF parser fix re-attack (2026-07-16)

- **Base ref:** working tree vs HEAD `3d7d27d7524c5a90404b4a59186646af1bdb79f4` (webhook lane uncommitted).
- **Scope:** `apps/platform/src/engine/webhook-security.ts` + `test/webhook-subscriptions-security.test.ts` ONLY (rest of the lane already SHIPPED in the original review above).
- **Trigger:** the four NB-1 residuals (NAT64, IPv4-compatible, trailing-dot localhost) + 6to4 were remediated by replacing the string-regex IPv6 handler with a real IPv6→16-byte parser (`parseIpv6ToBytes`/`ipv6HalfToBytes`) that extracts any embedded v4 and runs it through the FULL `disallowedIpv4Reason` set.
- **RE-VERDICT: SHIP.** The fix closes the class at the root; no fail-open path; no over-rejection regression. Two residuals remain, both strictly inside the already-disclosed DNS/egress-residual class — NON-BLOCKING.

## What I re-attacked (all PROVEN by running the fixed validator against the real WHATWG `new URL`)

- **The 4 original bypasses + 6to4 now REJECT.** `[64:ff9b::7f00:1]`→"IPv4-embedded IPv6 loopback", `[64:ff9b::a9fe:a9fe]`→"...link-local/metadata", `[::127.0.0.1]`(→`::7f00:1`)→"IPv4-embedded loopback", `localhost.`→"localhost", `[2002:7f00:1::]`→"6to4-embedded loopback", `[2002:a9fe:a9fe::]`→"6to4-embedded metadata", `[2002:c0a8:101::]`→"6to4-embedded private 192.168". Documented set (v4 hex/decimal/octal/integer, `[::1]`, fe80/fc00/fd.., `[::ffff:*]`) still REJECT. 25/25 must-reject inputs blocked.
- **Byte-parser fails CLOSED, never open.** Malformed IPv6 (`[fe80::1%25eth0]` zone-id, `[12345::1]` over-long group, `[:::]` triple-colon) dies at `new URL` → `ValidationError` → reject. A syntactically-valid IPv6 `new URL` accepts always parses (parser handles single `::` + trailing dotted-quad group); an unexpected miss returns null → `disallowedIpv6Reason` returns `"unparseable IPv6 literal"` → reject (`webhook-security.ts:129`). `parseIpv6ToBytes` guarantees a 16-length array on success (1-half case checks `length===16`; 2-half case constructs `head+fill+tail=16` or returns null on `fill<0`), so every `bytes[i]` access is in-bounds — no throw. Even a hypothetical throw from `disallowedHostReason` fails closed: create/update call `assertSafeWebhookUrl` BEFORE the SQL write (a throw aborts pre-write → Hono onError 500, no row), and `realWebhookDeliverer` wraps it in try/catch → `url_rejected`, no fetch (`webhook-security.ts:256`). No probe produced a non-ValidationError throw.
- **No over-rejection regression.** Public IPv6 `[2606:4700::1111]`, public 6to4 `[2002:808:808::]`(=8.8.8.8), mapped-public `[::ffff:8.8.8.8]`, global `[2001:db8::7f00:1]` (low bytes look like 127.0.0.1 but it is NOT a transition prefix, so correctly NOT extracted), public v4 `1.1.1.1`, and trailing-dot public FQDN all ALLOW. 0 false-positives across the allow set.
- **Test asserts behavior, not presence.** `webhook-subscriptions-security.test.ts:53` = `expect(() => assertSafeWebhookUrl(url)).toThrow()` over a 30-row REJECTED table that now includes the NAT64/IPv4-compat/6to4/trailing-dot cases, plus an ALLOWED public-IPv6 over-rejection guard. Security file: 42/42.

## Verification (re-run by reviewer)

- Security file in isolation: **42 passed**. Full platform suite: **418 passed / 62 files**. `tsc --noEmit`: clean. (Ran the fixed validator logic against real `new URL` over a 44-case reject/allow/probe harness: 0 failures on the graded sets.)

## Residuals (NON-BLOCKING — same DNS/egress class already disclosed, NOT newly reachable)

- **R1 · `localhost..` (double trailing dot) slips past the single-dot strip.** `disallowedHostReason` does `.replace(/\.$/, "")` (strips ONE dot) → `localhost.` → not `=== "localhost"`, `.includes(".")` true → ALLOWED. But `localhost..` is a malformed FQDN with an empty label — resolvers reject it, so it won't resolve to loopback, and the runtime egress backstop applies regardless. Strictly less severe than the original `localhost.` NB. Recommend `.replace(/\.+$/, "")` (or full label-normalization) to close it cleanly. Verification: ran `new URL("https://localhost../")` → hostname `localhost..` → validator returns ALLOWED.
- **R2 · Non-well-known NAT64 (`64:ff9b:1::/48` RFC 8215 local-use) + non-transition IPv6 embeddings not decoded.** `[64:ff9b:1::7f00:1]` ALLOWs (byte[5]=01 ≠ the well-known /96 → correctly not treated as the well-known translator prefix). Reachable only via an operator-specific NAT64 gateway for the local-use prefix — the same egress-routing-dependent, UNVERIFIABLE-contained class as the original NAT64 item; the fix scopes to the well-known prefix, which is the honest and correct boundary. Verification: harness `[64:ff9b:1::7f00:1]` → ALLOWED, `[::ffff:ffff:127.0.0.1]` → ALLOWED (genuinely a non-transition address, does not route to 127.0.0.1).

## Prior UNVERIFIABLE-1 status
Unchanged in kind but narrowed: even IF Cloudflare egress performs NAT64 on the **well-known** `64:ff9b::/96`, that vector is now CLOSED at the validator (rejected pre-fetch). The residual UNVERIFIABLE is now only the operator-specific local-use `64:ff9b:1::/48` (R2) and the pure-hostname DNS-rebinding case — both still backstopped by "public egress cannot route to RFC1918/link-local."
