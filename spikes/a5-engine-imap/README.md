# A5 — Local-mailserver engine spike (IMAP contract)

> ROADMAP A5. Validates the `EmailPort` send/reply/bounce/thread/unsub contract
> (`packages/shared/src/vendor-ports.ts`) against a **real local SMTP + IMAP
> server** before the `VendorPort` interface freezes. Additive only — touches no
> production code, sits outside the workspace globs, `$0`, local Docker only.

## Why this exists

The whole pipe has only ever been proven against the in-process sandbox
`VendorPort` (`apps/platform/src/vendors/sandbox/email-port.ts`), which hands the
engine conveniences a real server never will: it invents the `messageId`, tags
each polled event with a `threadId`, "returns and clears" new events, and only
ever emits hard-bounce-shaped bounces. This spike stress-tests those assumptions
against **GreenMail**, a real SMTP+IMAP server, so the real `EmailPort` adapter's
obligations are known *before* the port is frozen.

## Why GreenMail (not Mailpit)

The contract's hard part is **IMAP** — reply detection, threading from headers,
and DSN parsing. Mailpit is an SMTP *sink* (HTTP API + POP3, **no IMAP**, no real
inter-mailbox delivery, no threading between two mailboxes). GreenMail is a full
SMTP+IMAP server with real per-user mailbox delivery, so `sender@` can actually
send to `lead@`, the lead can reply, and each side reads its own INBOX over IMAP
— which is exactly the contract under test.

## How to run

Prereqs: Docker running, Node ≥ 24.

```bash
# 1. Start the server (SMTP 3025, IMAP 3143, auth disabled, mailboxes auto-created)
docker run -d --name coldstart-a5-greenmail -p 3025:3025 -p 3143:3143 \
  -e GREENMAIL_OPTS="-Dgreenmail.setup.test.smtp -Dgreenmail.setup.test.imap -Dgreenmail.hostname=0.0.0.0 -Dgreenmail.auth.disabled" \
  greenmail/standalone:2.1.3

# 2. Install deps (isolated — this package is NOT in the root workspace)
cd spikes/a5-engine-imap && npm install

# 3. Run the validation
npm run validate          # or: node validate.mjs

# 4. Tear down when done
docker rm -f coldstart-a5-greenmail
```

The script matches each message by the `Message-ID` it generated, so it re-runs
against a dirty inbox without a restart. For a pristine run, `docker rm -f` +
re-`run` the container first.

## What it does (each of the 5 contract behaviors)

1. **SMTP send** — sends `sender@ -> lead@` with an explicit RFC 5322 `Message-ID`,
   asserts the server accepts (250) and the id is readable back over IMAP.
2. **IMAP reply detection** — the lead replies; the sender's INBOX is polled over
   real IMAP and the reply is found.
3. **Threading** — asserts the reply's `In-Reply-To` / `References` resolve to the
   original send's `Message-ID` (the chain a real adapter uses to reconstruct the
   `threadId` the sandbox supplies for free).
4. **Bounce classification** — delivers a real RFC 3464 `multipart/report`
   delivery-status notification, fetches it over IMAP, parses `Status: 5.1.1` ->
   HARD, and recovers the original `Message-ID` from the returned headers.
5. **List-Unsubscribe** — sends RFC 8058 `List-Unsubscribe` +
   `List-Unsubscribe-Post: List-Unsubscribe=One-Click` headers and asserts they
   round-trip verbatim over SMTP->IMAP.

## What it proved

All 5 behaviors are satisfiable against a real server (full run in the commit /
task report). The spike also surfaced **four contract findings to resolve before
the `VendorPort` freeze** — see the task report; headline ones:

- `SendEmailInput` (`vendor-ports.ts:71-78`) has **no header field**, so
  `List-Unsubscribe` / RFC 8058 (required by SPEC §0.8, ARCHITECTURE #8, B4)
  **cannot be expressed through the port today** — the server round-trips the
  headers fine; the interface has no way to set them.
- `PolledBounce` (`vendor-ports.ts:95-103`) carries **no hard/soft flag**, yet
  `reply-processor.ts` (`processBounce`) suppresses the address on *every*
  bounce — a real **soft** (4.x.x) bounce would be wrongly permanent-suppressed.

## Files

- `validate.mjs` — the runnable validation (SMTP via nodemailer, IMAP via
  imapflow, DSN parse via mailparser + raw RFC 5322 header extraction).
- `package.json` — isolated deps; not part of the root npm workspace.
