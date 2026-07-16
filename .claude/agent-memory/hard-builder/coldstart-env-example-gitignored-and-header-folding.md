---
name: coldstart-env-example-gitignored-and-header-folding
description: ColdStart gotchas — `.env.example` is gitignored by the `.env.*` glob (docs must go in README), and long MIME headers fold across lines (don't assert single-line).
metadata:
  type: reference
---

Two small traps hit while building the engine's HTTPS/443 transports:

1. `apps/engine/.env.example` is GITIGNORED — the repo `.gitignore` has `.env.*`
   which also catches `.env.example`. So edits there are on-disk only, never
   committed. Put durable founder-facing schema/runbooks in `README.md` (tracked),
   not `.env.example`. (An `!.env.example` un-ignore would fix it, but that's a
   repo-hygiene call for the owner.)

2. A long `List-Unsubscribe` value (mailto + https forms) gets RFC 5322
   header-FOLDED across two lines in the raw MIME MailComposer emits:
   `List-Unsubscribe: <mailto:...>,\r\n <https://...>`. This is correct and
   semantically transparent. A test asserting the single-line joined form FAILS
   even though the header is compliant — assert the header name + each token
   present, fold-tolerantly. (This was a too-strict TEST, not a code bug.)
