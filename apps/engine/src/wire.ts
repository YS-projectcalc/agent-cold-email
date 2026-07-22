import { z } from "zod";
import type { SendEmailInput } from "@coldstart/shared";
import { mailboxCredentialsSchema } from "./config.js";

// The Worker↔engine HTTP boundary contract. These zod schemas validate every
// inbound request at the boundary (CLAUDE.md rule h). The request `input` shape
// is a structural mirror of @coldstart/shared's SendEmailInput; the type
// assertion below fails the engine's typecheck if the two ever drift, so the
// boundary can't silently diverge from the frozen port.

export const sendEmailInputSchema = z.object({
  fromEmail: z.string().email(),
  toEmail: z.string().email(),
  subject: z.string(),
  body: z.string(),
  threadId: z.string().min(1),
  inReplyToMessageId: z.string().nullable(),
  listUnsubscribe: z.string().optional(),
  listUnsubscribePost: z.string().optional(),
});

export const sendRequestSchema = z.object({
  input: sendEmailInputSchema,
  idempotencyKey: z.string().min(1),
});

export const pollRequestSchema = z.object({
  mailboxEmail: z.string().email(),
  // The consumer's stored per-mailbox IMAP UID high-water. The engine fetches
  // strictly above it and holds no cursor of its own (see engine.ts).
  // -1 is the "never polled this mailbox before" sentinel (real IMAP UIDs
  // start at 1, so -1 is distinct from every legitimate cursor value,
  // INCLUDING 0 -- a genuinely empty mailbox's high-water is 0, which must be
  // treated as an ordinary incremental cursor on the next poll, not
  // re-interpreted as "never polled" (adversary poll-bounded-fetch-2026-07-16
  // finding 1: overloading 0 as both meanings permanently lost the first
  // inbound on every empty mailbox).
  sinceCursor: z.number().int().min(-1),
});

// Self-serve activation I3 — the authed mailbox credential-push boundary
// (POST /v1/mailboxes upsert, DELETE /v1/mailboxes revoke). `credentials` is
// validated against the SAME schema the engine's static config uses, so a
// pushed mailbox can never carry a shape the send/poll path can't resolve.
// `idempotencyKey` is optional (content-hash replay-safety is the primary
// mechanism, MailboxCredentialStore) — when present it makes a replayed push
// return the recorded outcome and rejects key reuse with a different payload.
export const mailboxWriteRequestSchema = z.object({
  email: z.string().email(),
  credentials: mailboxCredentialsSchema,
  idempotencyKey: z.string().min(1).optional(),
});

export const mailboxRemoveRequestSchema = z.object({
  email: z.string().email(),
  idempotencyKey: z.string().min(1).optional(),
});

export type SendRequest = z.infer<typeof sendRequestSchema>;
export type PollRequest = z.infer<typeof pollRequestSchema>;
export type MailboxWriteRequest = z.infer<typeof mailboxWriteRequestSchema>;
export type MailboxRemoveRequest = z.infer<typeof mailboxRemoveRequestSchema>;

// Compile-time drift guard: the validated request `input` MUST satisfy the
// frozen SendEmailInput. If a field is added/renamed/retyped on either side and
// not mirrored here, this line stops compiling.
type _AssertInputMatchesPort = z.infer<typeof sendEmailInputSchema> extends SendEmailInput ? true : never;
const _assertInputMatchesPort: _AssertInputMatchesPort = true;
void _assertInputMatchesPort;
