---
name: declared-content-length-cap-is-opt-out
description: "CLASS: a request-body cap that reads the DECLARED Content-Length is opt-out — a chunked/streamed request sends no such header, so Number(undefined) is NaN, Number.isFinite is false and the cap is skipped while the body is parsed anyway. Fix at the ONE reader; a source-text tripwire must strip comments or it fires on prose."
metadata:
  type: project
---

CLASS (ColdStart, audit finding 7 + the follow-on class sweep 2026-08-06). Every
body-size cap in the app was `Number(c.req.header("content-length")) > MAX`. A
chunked/streamed request carries no `Content-Length`, so `Number(undefined)` is
`NaN`, `Number.isFinite` is `false`, and the cap is skipped entirely — the full
body is then materialised and parsed. **The guard only ever stopped honest
clients**, and it had spread by copy to every body-reading site: `validate.ts`'s
`parseJsonBody` (25 call sites incl. unauthenticated `/signup`, `/api/waitlist`),
`routes/webhooks.ts`, `routes/lifecycle.ts`, `routes/mcp.ts`,
`routes/admin-sdn-ingest.ts` — plus `routes/demo.ts`, which read a body under NO
cap at all (found only by grepping for body READS rather than for caps).

**Fix shape.** One `readTextBodyWithCap(c, maxBytes)` in validate.ts: read
`c.req.raw.body` chunk by chunk, count bytes, `reader.cancel()` at the ceiling,
decode ONCE over the joined bytes (a multi-byte UTF-8 char can straddle a chunk,
and the string must equal what a signature was computed over). Return
`string | null`, NOT a ready-made 413 `Response` — `/mcp` answers over-cap in a
JSON-RPC envelope (`error.code -32600`) and `/unsubscribe` in plain text, so the
response body belongs to the caller. Keep the declared check as a named
`declaresOverCap()` fast path: it rejects an honest oversized client without
touching the stream. Fixing `parseJsonBody` alone closes 25 sites at once.

**Reasoned exception:** a route that NEVER READS its body (`/unsubscribe` — RFC
8058 one-click, the credential is the signed query token) must NOT adopt the
capped read: measuring costs a read it otherwise never performs. Not reading
beats capping. State the verdict in the code and in the tripwire.

**Tripwire (and the trap in it).** Ban the accessors instead of trying to prove a
cap sits near each read: no source may call
`c.req.(text|json|parseBody|arrayBuffer|blob|formData)()` and only validate.ts may
touch `c.req.raw.body`. ⚠️ Scanning raw source text FIRES ON COMMENTS — my first
run flagged login.ts, mcp.ts and validate.ts purely for the string `c.req.json()`
inside comments explaining why it is not used. Strip block comments, then strip
`//` to end-of-line with quote-state tracking (so a `https://` inside a string
survives). A tripwire with false positives gets weakened by the next person who
hits one. Add a not-vacuously-green assertion (glob found >15 route files).

Related: [[failing-by-construction-env-coverage-guard]] (same guard idiom),
[[polling-check-error-is-indistinguishable-from-negative]] (the other
"absence-shaped signal reads as OK" mechanism).
