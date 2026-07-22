import { NotActivatedError, VendorError } from "@coldstart/shared";
import { type EngineClientConfig, isSecureEngineUrl } from "../vendors/real/email-port.js";

/**
 * Authed client for the engine's I3 credential-push boundary (POST/DELETE
 * /v1/mailboxes, apps/engine router.ts). Mirrors RealEmailPort's engine `call`
 * — same bearer secret (ENGINE_AUTH_SECRET), same https-required guard, same
 * transient-vs-permanent grading — but for pushing/revoking pushed mailbox
 * credentials rather than sending mail. Dark until `ENGINE_BASE_URL` +
 * `ENGINE_AUTH_SECRET` are configured (NotActivatedError otherwise), so the
 * deployed default never reaches the droplet.
 */

// Credential shape the engine validates on receipt (apps/engine config.ts's
// mailboxCredentialsSchema). Built Worker-side and pushed; the engine's zod
// rejects a bad shape as a 400 (permanent), so a drift fails loud at push time.
export interface EnginePushEndpoint {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
}
export interface EnginePushGmailTransport {
  kind: "gmail_api";
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  user?: string;
}
export interface EnginePushCredentials {
  imap: EnginePushEndpoint;
  smtp?: EnginePushEndpoint;
  send?: EnginePushGmailTransport | { kind: "smtp" };
  messageIdDomain?: string;
}

export interface PushResult {
  email: string;
  outcome: string;
  contentHash: string;
}

// A push is bounded so a stalled droplet can't hang the provisioning saga; an
// aborted fetch surfaces as a RETRYABLE VendorError the reconcile loop retries.
const PUSH_TIMEOUT_MS = 30_000;

export class EngineMailboxClient {
  constructor(private readonly config?: EngineClientConfig) {}

  get isConfigured(): boolean {
    return Boolean(this.config?.baseUrl && this.config?.authSecret);
  }

  /** POST /v1/mailboxes — idempotent credential upsert (the engine owns F4 replay-safety). */
  async pushMailbox(email: string, credentials: EnginePushCredentials, idempotencyKey: string): Promise<PushResult> {
    const body = await this.call("POST", { email, credentials, idempotencyKey });
    if (typeof body.email !== "string" || typeof body.outcome !== "string" || typeof body.contentHash !== "string") {
      throw new VendorError("engine POST /v1/mailboxes returned a malformed UpsertResult", false);
    }
    return { email: body.email, outcome: body.outcome, contentHash: body.contentHash };
  }

  /** DELETE /v1/mailboxes — revoke a pushed mailbox (cancel/teardown). Naturally idempotent engine-side. */
  async removeMailbox(email: string, idempotencyKey: string): Promise<{ email: string; removed: boolean }> {
    const body = await this.call("DELETE", { email, idempotencyKey });
    return { email: typeof body.email === "string" ? body.email : email, removed: body.removed === true };
  }

  private async call(method: "POST" | "DELETE", payload: unknown): Promise<{ [k: string]: unknown }> {
    if (!this.config?.baseUrl || !this.config?.authSecret) {
      throw new NotActivatedError("cold-engine", "mailboxes");
    }
    // The bearer secret must never cross a cleartext link (localhost exempt for
    // a tunnel-terminated bootstrap) — permanent failure, a plaintext URL can't
    // be fixed by retrying. Mirrors RealEmailPort.call.
    if (!isSecureEngineUrl(this.config.baseUrl)) {
      throw new VendorError(`ENGINE_BASE_URL must be https (or localhost): ${this.config.baseUrl}`, false);
    }
    let res: Response;
    try {
      res = await fetch(`${this.config.baseUrl}/v1/mailboxes`, {
        method,
        headers: { "content-type": "application/json", authorization: `Bearer ${this.config.authSecret}` },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
      });
    } catch (err) {
      // Network/timeout — transient; the reconcile loop retries.
      throw new VendorError(`engine /v1/mailboxes unreachable: ${err instanceof Error ? err.message : String(err)}`, true, { cause: err });
    }
    if (res.ok) return (await res.json()) as { [k: string]: unknown };
    const detail = await res.text().catch(() => "");
    // 5xx transient (retry); 4xx permanent (a bad credential/auth won't self-heal).
    throw new VendorError(`engine /v1/mailboxes -> HTTP ${res.status}: ${detail}`, res.status >= 500);
  }
}
