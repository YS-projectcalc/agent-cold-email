---
name: bookkeeping-write-outside-try-fails-the-call
description: An observability/bookkeeping write added to a request path becomes a hard dependency of that request unless it is wrapped best-effort — a liveness stamp at the MCP handler would have failed every tool call.
metadata:
  type: project
---

Adding `await stub.recordAgentActivity()` to `mcp/handler.ts`'s `tools/call` — outside the
existing try — made a LIVENESS STAMP a precondition of every one of the 28 MCP tools: a wedged DO
or a transient RPC error on the stamp takes the whole call down, and it also escapes the catch
that makes throws customer-safe. Caught only by the FULL suite
(`mcp-non-error-throw-leak.test.ts`, which swaps in a stub exposing one method); the targeted
tests and tsc were both green.

**Why:** bookkeeping is strictly less important than the work it observes, and the codebase
already states this posture for its other side channels — `alertRegistrarUnarmed`: "an unsendable
alert must NEVER fail the request that triggered it".

**How to apply:** any write added to a request path for OBSERVATION (liveness stamps, activity
logs, alert sends, metrics) gets its own `try { … } catch { console.error(…) }`, never bare
`await`. Then sweep the CLASS, not the instance: the pre-existing sibling at
`routes/infrastructure.ts` had the same bare stamp and got the same guard. Related:
[[fail-loud-throw-after-billed-vendor-call]] is the inverse case — there the new throw is on the
MONEY path and the fix is ordering, not swallowing.
