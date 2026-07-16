# apps/engine/scripts

Founder/operator one-time helpers. Not part of the daemon runtime — they mint the
BYO credentials the HTTPS/443 send transports need (see the engine README's
"Minting BYO send credentials" runbook).

## `mint-gmail-token.mjs`

Mints a Gmail **send-only** OAuth2 refresh token for one BYO mailbox via the
loopback (installed-app) flow, using Node built-ins only (no deps, no SDK).

```bash
node apps/engine/scripts/mint-gmail-token.mjs <client_id> <client_secret>
```

It starts a localhost listener (`127.0.0.1:42813`, override with `MINT_PORT`),
prints a Google consent URL, catches the redirect, exchanges the code, and prints
the `refresh_token`. Run it as the mailbox owner; drop the token into
`MAILBOX_CREDENTIALS_FILE` under that mailbox's `send` block. **Never commit the
output** (CLAUDE.md rule g).

Prereqs: a Google Cloud project with the Gmail API enabled and a **Desktop**-type
OAuth client, with the mailbox added as a test user on the consent screen.

> Makes a live call to Google's token endpoint when the owner runs it — it is NOT
> exercised by `npm test` (the test suite makes no network calls).

The MS Graph delegated/app-only equivalents are documented in the engine README;
a dedicated Graph helper is future work.
