---
name: backtick-inside-template-literal-sql
description: A backtick inside a backtick-delimited template literal (e.g. an SQL schema string with a `word` in a comment) silently ends the literal → misleading TS1005 "',' expected" errors far from the real spot.
metadata:
  type: feedback
---

When editing a large SQL string stored as a JS backtick template literal (ColdStart's `TENANT_DO_SCHEMA` in `apps/platform/src/schema.ts`), do NOT put backticks inside it — even inside a `--` SQL comment. A stray backtick terminates the template literal mid-string, and TypeScript then parses the rest of the SQL as code, emitting `error TS1005: ',' expected` at the line/column of the backtick, which reads like an unrelated syntax error.

**Why:** cost a debugging cycle here — a comment `NOT the warmup \`status\` column` broke the schema literal; the fix was dropping the backticks.

**How to apply:** in any backtick template literal, quote identifiers in prose with plain quotes or nothing (`warmup status`, `'status'`), never backticks. If a typecheck throws TS1005 inside a known-good template-literal string, suspect a rogue backtick before anything else.

**Sibling delimiter trap — `*/` inside a BLOCK COMMENT (hit twice in one session,
2026-08-06):** writing env-var globs in a JSDoc as `ENGINE_*/INBOXKIT_*` closes the
comment at the `*/`, and the rest of the prose is then parsed as code. Vite/oxc reports
`[PARSE_ERROR] Expected a semicolon ... Try inserting a semicolon here` pointing at the
PROSE, with no mention of comments. Write `ENGINE_ / INBOXKIT_` or "neither ENGINE_ nor
INBOXKIT_". Note `//` line comments and string literals are unaffected — only block
comments — so a repo-wide `grep '\*/[A-Za-z]'` needs its hits triaged, not blanket-fixed.
