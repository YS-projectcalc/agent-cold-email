---
name: sandbox-port-masks-real-server-contract
description: ColdStart — an in-process sandbox VendorPort hands the engine conveniences a real SMTP/IMAP server never will; validate against a real server before freezing the port.
metadata:
  type: project
---

An in-process sandbox port (ColdStart `SandboxEmailPort`) gives the engine four conveniences a real SMTP/IMAP server (proven via the A5 GreenMail spike, `spikes/a5-engine-imap/`) does NOT, each masking a real contract obligation:

1. **Pre-tagged `threadId` on polled events.** Real IMAP replies/bounces carry only `In-Reply-To`/`References`; the adapter must reconstruct `threadId` (validated recoverable). `PolledReply.threadId` etc. (`vendor-ports.ts:85-122`).
2. **Invented `messageId`.** Sandbox generates an opaque `msg_<uuid>` inside `send()`; the real adapter must SET a valid RFC 5322 `<..@domain>` Message-ID on the outbound send AND store the same value in `scheduled_sends.message_id` (`tick.ts:181`) for the reverse thread lookup to work.
3. **`poll()` "returns and clears"** (`vendor-ports.ts:126`) has no IMAP equivalent — needs a durable per-mailbox UID high-water mark. And because `events` INSERTs are NOT idempotent (no dedupe key on `message_id`, `schema.ts:114-122`; `reply-processor.ts` inserts a fresh `newId("evt")`), an at-least-once re-poll DOUBLE-INSERTS reply/bounce/complaint events. The sandbox can never return the same event twice, so this is invisible in test mode.
4. **Only hard-bounce-shaped bounces.** `PolledBounce` has no hard/soft field (`vendor-ports.ts:95-103`), and `processBounce` suppresses on EVERY bounce — a real soft (4.x.x) bounce would be wrongly permanent-suppressed.

Also: `SendEmailInput` (`vendor-ports.ts:71-78`) has no header field, so RFC 8058 `List-Unsubscribe` (required by SPEC §0.8) cannot be expressed through the port at all — the server round-trips the headers fine; the interface can't set them.

**Why:** the entire pipe was only ever proven against the sandbox before A5. **How to apply:** before freezing ANY vendor port, run a real-server spike; a fault-injecting sandbox still can't reproduce header shape, at-least-once redelivery, or transient-vs-permanent failure taxonomy. GreenMail (full SMTP+IMAP, real inter-mailbox delivery) beats Mailpit (SMTP sink, no IMAP) for the IMAP contract.
