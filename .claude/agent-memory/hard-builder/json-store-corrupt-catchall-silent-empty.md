---
name: json-store-corrupt-catchall-silent-empty
description: A JSON-file durable store whose loader catches ALL read/parse errors and returns empty silently drops state on corruption AND overwrites the only copy on the next flush — split MISSING (empty OK) from CORRUPT (fail loud).
metadata:
  type: project
---

FAILURE CLASS (ColdStart engine, F5, 2026-07-22): a JSON-file-backed durable
store loads with a catch-all `try { JSON.parse(readFileSync(...)) } catch { return EMPTY }`.
That conflates two very different cases:
- **MISSING file** — a normal first boot; empty is correct.
- **CORRUPT file** (exists but truncated/invalid-JSON/wrong-shape) — the daemon
  silently boots with a BLANK store, and the very next atomic write-temp+rename
  flush OVERWRITES the corrupt file, destroying the only copy of the real state.
  For `engine-state.json` that's re-sending already-sent leads + losing every
  Message-ID→thread map; for a credential store it's dropping OAuth refresh tokens.

FIX: a shared `loadJsonStateFile(path, empty, label, project)` that distinguishes
by errno — `ENOENT` ⇒ `structuredClone(empty)` (first boot); any other read error,
`JSON.parse` throw, or non-object parse ⇒ THROW (refuse to boot). The daemon then
fails loud so an operator repairs/quarantines the file instead of it silently
self-erasing. RED-proof: revert to the catch-all ⇒ a corrupt-file test that
`expect(() => new Store(dir)).toThrow(/corrupt/i)` fails (returns undefined, no throw).

HOW TO APPLY: any file-backed durable store (creds, cursors, ledgers). A loader
that treats "can't read it" the same as "it isn't there" is the tell. Missing = empty
is fine; corrupt = loud. Cousin of [[persist-before-confirm-cross-boundary]]
(both are "durable state silently diverges from reality").
