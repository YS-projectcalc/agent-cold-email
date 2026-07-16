import { readFileSync } from "node:fs";
import { z } from "zod";

// Engine configuration — ALL env-driven (CLAUDE.md rule g: no secret in code or
// git). The Worker↔engine shared secret and every per-mailbox SMTP/IMAP
// credential are injected at runtime, never committed.

const endpointSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().positive(),
  secure: z.boolean(),
  user: z.string().min(1),
  pass: z.string().min(1),
});

// Per-mailbox SEND transport discriminator (the HTTPS/443 lane that survives the
// SMTP-egress wall — see README transport matrix). `smtp` is the default and the
// only one that needs the `smtp` endpoint below; the API transports send over
// 443 with OAuth2 and need no SMTP creds. IMAP (reply reading) is ALWAYS on 993
// regardless of send transport, so `imap` stays required for every mailbox.

/** SMTP (default). Uses the mailbox's `smtp` endpoint; no extra fields. */
const smtpTransportSchema = z.object({ kind: z.literal("smtp") });

/**
 * Gmail API over HTTPS. Per-mailbox OAuth2 refresh-token grant (a Google Cloud
 * OAuth client + a one-time-consented refresh token — see README runbook). Send
 * hits gmail.googleapis.com with the raw base64url RFC822 message.
 */
const gmailTransportSchema = z.object({
  kind: z.literal("gmail_api"),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  refreshToken: z.string().min(1),
  /**
   * The Gmail address being sent as. Optional — the send endpoint is `/users/
   * me/...` (the token's own mailbox) and the From is carried on the message, so
   * this is informational; defaults to the mailbox key.
   */
  user: z.string().email().optional(),
});

/**
 * Microsoft Graph over HTTPS. Two auth modes:
 *   - `delegated`  — OAuth2 refresh-token grant (a user consented once).
 *   - `app_only`   — client-credentials grant (an admin-consented app sends AS a
 *                    mailbox; Graph has no `me`, so `user` is REQUIRED — the
 *                    endpoint is /users/{user}/sendMail).
 * Send preserves the raw MIME (base64) so every header survives.
 */
const graphTransportSchema = z.object({
  kind: z.literal("ms_graph"),
  mode: z.enum(["delegated", "app_only"]),
  tenantId: z.string().min(1),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  /** Required for `delegated`; ignored for `app_only` (validated below). */
  refreshToken: z.string().min(1).optional(),
  /** Required for `app_only` (the sending mailbox); defaults to the key for `delegated`. */
  user: z.string().email().optional(),
});

const sendTransportSchema = z.discriminatedUnion("kind", [
  smtpTransportSchema,
  gmailTransportSchema,
  graphTransportSchema,
]);

/** Per-mailbox SMTP/IMAP/API credentials, keyed by the mailbox's email address. */
export const mailboxCredentialsSchema = z
  .object({
    /**
     * SMTP endpoint. Required ONLY when the send transport is `smtp` (the
     * default). Optional for the API transports, which send over 443 instead.
     */
    smtp: endpointSchema.optional(),
    imap: endpointSchema,
    /**
     * Send transport. OMITTED means `smtp` (backward-compatible: an existing
     * app-password entry with just `{smtp, imap}` keeps working unchanged).
     */
    send: sendTransportSchema.optional(),
    /**
     * Domain used to mint the outbound RFC 5322 Message-ID (`<uuid@domain>`).
     * Optional — defaults to the domain of the sending address. Set it when the
     * envelope domain must differ from the Message-ID domain (e.g. a subdomain
     * sending identity), per SendEmailResult's real-Message-ID contract.
     */
    messageIdDomain: z.string().min(1).optional(),
  })
  .superRefine((val, ctx) => {
    const kind = val.send?.kind ?? "smtp";
    if (kind === "smtp" && !val.smtp) {
      ctx.addIssue({ code: "custom", path: ["smtp"], message: "smtp endpoint is required when the send transport is smtp (the default)" });
    }
    if (val.send?.kind === "ms_graph") {
      if (val.send.mode === "delegated" && !val.send.refreshToken) {
        ctx.addIssue({ code: "custom", path: ["send", "refreshToken"], message: "ms_graph delegated mode requires refreshToken" });
      }
      if (val.send.mode === "app_only" && !val.send.user) {
        ctx.addIssue({ code: "custom", path: ["send", "user"], message: "ms_graph app_only mode requires user (the mailbox to send from; Graph app-only has no `me`)" });
      }
    }
  });

export type Endpoint = z.infer<typeof endpointSchema>;
export type MailboxCredentials = z.infer<typeof mailboxCredentialsSchema>;
export type GmailTransport = z.infer<typeof gmailTransportSchema>;
export type GraphTransport = z.infer<typeof graphTransportSchema>;

const credentialsMapSchema = z.record(z.string().email(), mailboxCredentialsSchema);
export type CredentialsMap = z.infer<typeof credentialsMapSchema>;

export interface EngineConfig {
  authSecret: string;
  port: number;
  stateDir: string;
  credentials: CredentialsMap;
}

function readCredentials(env: NodeJS.ProcessEnv): CredentialsMap {
  const inline = env.MAILBOX_CREDENTIALS?.trim();
  const file = env.MAILBOX_CREDENTIALS_FILE?.trim();
  let raw: string;
  if (inline) {
    raw = inline;
  } else if (file) {
    raw = readFileSync(file, "utf8");
  } else {
    // No mailboxes provisioned yet is a valid state (the daemon can boot before
    // any BYO mailbox is wired); send/poll for an unknown address then fails as
    // a PERMANENT UnknownMailboxError, never a crash.
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`MAILBOX_CREDENTIALS is not valid JSON: ${(err as Error).message}`);
  }
  return credentialsMapSchema.parse(parsed);
}

/**
 * Loads + validates the engine config from the environment. Throws (fail-fast at
 * boot) on a missing/short auth secret or malformed credentials — a
 * misconfigured daemon must never start half-armed.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): EngineConfig {
  const authSecret = env.ENGINE_AUTH_SECRET?.trim();
  if (!authSecret || authSecret.length < 16) {
    throw new Error(
      "ENGINE_AUTH_SECRET must be set to a strong shared secret (>=16 chars) — it authenticates the Worker↔engine boundary.",
    );
  }
  const port = env.ENGINE_PORT ? Number(env.ENGINE_PORT) : 8080;
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`ENGINE_PORT must be a positive integer (got ${env.ENGINE_PORT}).`);
  }
  return {
    authSecret,
    port,
    stateDir: env.ENGINE_STATE_DIR?.trim() || "./state",
    credentials: readCredentials(env),
  };
}
