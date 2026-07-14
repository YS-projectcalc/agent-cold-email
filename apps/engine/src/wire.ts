import { z } from "zod";
import type { SendEmailInput } from "@coldstart/shared";

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
  // strictly above it and holds no cursor of its own (see engine.ts). >= 0.
  sinceCursor: z.number().int().min(0),
});

export type SendRequest = z.infer<typeof sendRequestSchema>;
export type PollRequest = z.infer<typeof pollRequestSchema>;

// Compile-time drift guard: the validated request `input` MUST satisfy the
// frozen SendEmailInput. If a field is added/renamed/retyped on either side and
// not mirrored here, this line stops compiling.
type _AssertInputMatchesPort = z.infer<typeof sendEmailInputSchema> extends SendEmailInput ? true : never;
const _assertInputMatchesPort: _AssertInputMatchesPort = true;
void _assertInputMatchesPort;
