---
name: coldstart-sqlstorage-row-typing-and-schema-template-literal
description: two TS/schema gotchas specific to apps/platform's SqlStorage row types and schema.ts's giant template literal — both cost a real red typecheck cycle in the message-channel Increment 1 build (2026-08-05)
metadata:
  type: project
---

Two non-obvious defects hit while adding a new engine module + a new `schema.ts` table:

1. **A named `interface XRow { ... }` used with `ctx.sql.exec<XRow>(...)` fails typecheck** (`TS2344: does not satisfy the constraint 'Record<string, SqlStorageValue>'`) UNLESS it carries an explicit trailing `[column: string]: SqlStorageValue;` index signature. An INLINE object type literal at the call site (`.exec<{ id: string; ... }>(...)`) does NOT need this — only named interfaces do (a TS generic-constraint quirk). The codebase convention already does this correctly in `engine/deliverability.ts`'s `MailboxRow` and `engine/dashboard-views.ts`'s `ViewRow` — grep for `[column: string]: SqlStorageValue` before writing a new named row interface, and copy the tail line.

2. **`schema.ts`'s `TENANT_DO_SCHEMA` is ONE giant backtick template literal.** A backtick ANYWHERE inside a `--` SQL comment inside it (e.g. writing `` `messages` field `` in prose, intending Markdown-style code-formatting) silently terminates the JS string early. The resulting error surfaces as a confusing oxc/vite `PARSE_ERROR` pointing at an unrelated-looking line number, not at the backtick itself — the fix is to grep your own new comment block for backticks and remove them (plain quotes or no quoting) before assuming the error is anywhere else.

**Why:** both were caught only by actually running the typecheck/test lane, not by reading the diff — reinforces running the real verification battery even on "just a comment" or "just a type" edits.

**How to apply:** when adding a new `ctx.sql.exec<T>()` row type in `apps/platform/src/engine/*.ts`, default to appending the index signature. When editing `schema.ts`'s SQL comments, never use a backtick.
