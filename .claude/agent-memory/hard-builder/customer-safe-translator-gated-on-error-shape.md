---
name: customer-safe-translator-gated-on-error-shape
description: CLASS - a customer-safe error translator reached only when the throw LOOKS like an Error; a non-Error throw (or an Error with a blanked name) skips it and hits a raw String(err) fallthrough that leaks vendor identity
metadata:
  type: project
---

CLASS: a sanitizing error translator that is invoked behind a predicate about
the throw's SHAPE, with a raw-passthrough fallthrough for everything else. The
fallthrough is the leak the translator exists to prevent.

Instance (ColdStart `src/mcp/handler.ts`, tools/call catch):

```ts
const name = err instanceof Error ? err.name : "";
if (name !== "") { /* toErrorResponse -> customer-safe */ }
const message = err instanceof Error ? err.message : String(err);
return result(id, { content: [{ type: "text", text: message }], isError: true });
```

A NON-Error throw (a string/object from a vendor SDK or a hand-rolled reject)
has no `name`, so it skipped the translator and was returned to the tenant
verbatim; an `Error` whose `name` was blanked did the same. Proven live: a
thrown string containing the vendor name, an internal URL, a private IP, an
env-var name and a token came back in the tool response unchanged.

**Fix shape:** delete the gate, not add a second scrubber. `toErrorResponse`
already takes `unknown` and grades a non-Error as the generic `internal` 500, so
routing EVERY throw through it needs no branch (CLAUDE.md rule f — root cause,
not a patch on a patch). Keep a control test asserting a NAMED class still gets
its own mapped body, else "make it all safe" quietly flattens every error to
`internal` and destroys the actionable signal.

**How to apply:** whenever a sanitizer sits behind `if (err instanceof X)` /
`if (name !== "")` / `if (err.code)`, the else-branch is a customer surface —
grep the catch blocks on every transport (REST onError AND MCP AND webhooks) for
`String(err)` / `err.message` reached without the translator. Note this survived
because it sat immediately BELOW a comment claiming the leak was already closed;
the comment described the guarded branch only.

Related: [[merge-of-prerefactor-lane-reverts-sibling-fix]].
