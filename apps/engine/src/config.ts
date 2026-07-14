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

/** Per-mailbox SMTP + IMAP credentials, keyed by the mailbox's email address. */
export const mailboxCredentialsSchema = z.object({
  smtp: endpointSchema,
  imap: endpointSchema,
  /**
   * Domain used to mint the outbound RFC 5322 Message-ID (`<uuid@domain>`).
   * Optional — defaults to the domain of the sending address. Set it when the
   * envelope domain must differ from the Message-ID domain (e.g. a subdomain
   * sending identity), per SendEmailResult's real-Message-ID contract.
   */
  messageIdDomain: z.string().min(1).optional(),
});

export type Endpoint = z.infer<typeof endpointSchema>;
export type MailboxCredentials = z.infer<typeof mailboxCredentialsSchema>;

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
