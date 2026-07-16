---
name: coldstart-mailcomposer-single-builder-for-transports
description: ColdStart engine — reuse nodemailer's MailComposer as the ONE message builder so SMTP + Gmail/Graph API transports carry compliance headers byte-identically.
metadata:
  type: reference
---

ColdStart engine (`apps/engine`) gained HTTPS/443 send transports (Gmail API,
MS Graph) alongside SMTP, to survive a host blocking outbound 465/587. The
compliance invariant (RFC 8058 List-Unsubscribe/-Post, CAN-SPAM footer in body,
real Message-ID, In-Reply-To) must be BYTE-IDENTICAL across every wire.

How: extract ONE builder (`src/message.ts`) — `buildMailOptions(input, messageId)`
returns the nodemailer mail-options; `buildRawMessage` runs those through
`nodemailer`'s own `MailComposer` (`.compile().build(cb)`) to get the exact raw
RFC822 bytes SMTP would send. SMTP calls `sendMail(buildMailOptions(...))`; the
API adapters base64(url)-encode `buildRawMessage(...)`. No second serializer to
drift.

Mechanics verified live here:
- Deep import `import MailComposer from "nodemailer/lib/mail-composer/index.js"`
  works at runtime (nodemailer has no exports-map to block it) AND `@types/
  nodemailer` ships `lib/mail-composer/index.d.ts`, so it typechecks under
  NodeNext + verbatimModuleSyntax. `ConstructorParameters<typeof MailComposer>[0]`
  IS `Mail.Options` — use it to type the shared builder without importing the
  Mail namespace.
- `MimeNode.build()` returns the Buffer via a callback (or a Promise if no cb);
  wrap the callback form in a Promise — don't trust the type's no-arg overload.
- Error mapping: map ALL API failures to the SAME `UpstreamTransientError` (503)
  the SMTP path throws, so the Worker's retry/bounce accounting is unchanged
  (spec: "shapes the SMTP path produces"). Refresh-on-401 + bounded backoff on
  429/5xx live INSIDE the adapter; whatever survives → transient.

See also [[dsn-arf-fields-live-in-mime-subparts]] (the poll-side MIME parser).
