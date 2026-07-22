import type { Env } from "../env.js";
import type { TenantContext } from "../tenant-context.js";
import type { EngineClientConfig } from "../vendors/real/email-port.js";
import { EngineMailboxClient, type EnginePushCredentials } from "./engine-mailbox-client.js";
import { type InboxKitMailboxCredentials, RealMailboxPort } from "../vendors/real/mailbox-port.js";
import { ManualOAuthMinter, type GmailGrant, type MailboxRef, type OAuthMinter } from "../vendors/real/oauth-mint.js";

/**
 * Self-serve activation I3 — the Worker provisioning PUSH (F6 partial-failure
 * ordering). After a mailbox is provisioned at the vendor (a BILLED slot), its
 * credentials must reach the engine (the push-to-droplet architecture: the
 * refresh token lands only on the firewalled daemon, never durably on this
 * Worker). F6 mandates the ordering so a billed mailbox is never silently lost:
 *
 *   1. RECORD the mailbox durably (`mailbox_cred_pushes`, status 'pending')
 *      BEFORE the push. If the push then fails — or the DO crashes mid-push —
 *      the row survives and the reconcile sweep retries it.
 *   2. PUSH (assemble IMAP creds + gmail_api OAuth grant -> engine upsert). The
 *      engine's write is idempotent (F4), so a retry is safe.
 *   3. On success mark 'pushed'; on failure leave 'pending' (+ last_error) — the
 *      push NEVER throws into the provisioning saga (a failed push must not fail
 *      or roll back a provision whose vendor spend already happened).
 *
 * Everything here is DARK until arming: the hook and reconcile are no-ops
 * unless BOTH the InboxKit vendor (INBOXKIT_*) AND the engine (ENGINE_*) are
 * configured (isCredentialPushConfigured). The default deployed build supplies
 * neither, so this is inert — byte-identical to pre-I3 behavior.
 */

/** Injected seam so the flow is fixture-testable without a live vendor/engine. */
export interface CredentialPushDeps {
  /** Fetch the mailbox's IMAP (+ optional SMTP) credentials from the vendor. */
  fetchCredentials(email: string): Promise<InboxKitMailboxCredentials>;
  /** Mint the gmail_api OAuth grant for the mailbox (manual or programmatic). */
  mintGrant(mailbox: MailboxRef): Promise<GmailGrant>;
  /** Authed client to the engine's POST /v1/mailboxes credential-push boundary. */
  push: EngineMailboxClient;
}

export interface PushOutcome {
  email: string;
  pushed: boolean;
  /** Present when pushed === false: why the push did not complete (row stays 'pending' for reconcile). */
  error?: string;
}

/** The credential push is reachable only when the vendor AND the engine are both armed. */
export function isCredentialPushConfigured(env: Env): boolean {
  return Boolean(env.INBOXKIT_API_KEY && env.INBOXKIT_WORKSPACE_ID && env.ENGINE_BASE_URL && env.ENGINE_AUTH_SECRET);
}

/**
 * Wires the real deps from env — DARK by default (returns undefined unless
 * armed). Manual OAuth grants (the proven pilot path) come from the optional
 * `GMAIL_OAUTH_GRANTS` secret; an absent/partial grant fails LOUD per-mailbox
 * at push time (the mailbox stays 'pending', reconcile retries once grants
 * land). The programmatic InboxKitOAuthMinter (fleet path) is a coded+tested
 * seam the arming session swaps in.
 */
export function buildCredentialPushDeps(env: Env): CredentialPushDeps | undefined {
  if (!isCredentialPushConfigured(env)) return undefined;
  const inboxKitConfig = { apiKey: env.INBOXKIT_API_KEY as string, workspaceId: env.INBOXKIT_WORKSPACE_ID as string };
  const engineConfig: EngineClientConfig = { baseUrl: env.ENGINE_BASE_URL as string, authSecret: env.ENGINE_AUTH_SECRET as string };
  const mailboxPort = new RealMailboxPort(inboxKitConfig);
  const minter: OAuthMinter = new ManualOAuthMinter(parseGrants(env.GMAIL_OAUTH_GRANTS));
  return {
    fetchCredentials: (email) => mailboxPort.showMailboxCredentials(email),
    mintGrant: (mailbox) => minter.mintGmailGrant(mailbox),
    push: new EngineMailboxClient(engineConfig),
  };
}

/** F6 step 1 — durable record BEFORE the push. INSERT OR IGNORE so a re-provision of the same mailbox doesn't reset a 'pushed' row. */
export function recordProvisionedMailboxForPush(ctx: TenantContext, email: string): void {
  const now = ctx.clock.now();
  ctx.sql.exec(
    `INSERT OR IGNORE INTO mailbox_cred_pushes (email, tenant_id, status, attempts, created_at, updated_at)
     VALUES (?, ?, 'pending', 0, ?, ?)`,
    email,
    ctx.tenantId,
    now,
    now,
  );
}

/** Assemble the engine credential shape: vendor IMAP endpoint + gmail_api OAuth grant. */
export async function assembleEngineCredentials(mailbox: MailboxRef, deps: CredentialPushDeps): Promise<EnginePushCredentials> {
  const vendorCreds = await deps.fetchCredentials(mailbox.email);
  const grant = await deps.mintGrant(mailbox);
  return {
    imap: vendorCreds.imap,
    send: { kind: "gmail_api", clientId: grant.clientId, clientSecret: grant.clientSecret, refreshToken: grant.refreshToken, user: mailbox.email },
    messageIdDomain: mailbox.domain,
  };
}

/**
 * F6 steps 2-3 — push a recorded mailbox, marking 'pushed' on success and
 * leaving it 'pending' (+ last_error) on failure. NEVER throws: a push failure
 * must not fail the caller (the vendor spend already happened; the row survives
 * for reconcile).
 */
export async function pushRecordedMailbox(ctx: TenantContext, mailbox: MailboxRef, deps: CredentialPushDeps): Promise<PushOutcome> {
  const idempotencyKey = `credpush:${ctx.tenantId}:${mailbox.email}`;
  try {
    const credentials = await assembleEngineCredentials(mailbox, deps);
    await deps.push.pushMailbox(mailbox.email, credentials, idempotencyKey);
    ctx.sql.exec(
      `UPDATE mailbox_cred_pushes SET status = 'pushed', attempts = attempts + 1, last_error = NULL, updated_at = ? WHERE email = ? AND tenant_id = ?`,
      ctx.clock.now(),
      mailbox.email,
      ctx.tenantId,
    );
    return { email: mailbox.email, pushed: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.sql.exec(
      `UPDATE mailbox_cred_pushes SET attempts = attempts + 1, last_error = ?, updated_at = ? WHERE email = ? AND tenant_id = ?`,
      message,
      ctx.clock.now(),
      mailbox.email,
      ctx.tenantId,
    );
    return { email: mailbox.email, pushed: false, error: message };
  }
}

/**
 * The provisioning HOOK (called from provisionMailboxesForDomain). Inert unless
 * armed AND the mailbox was really provisioned at the vendor (provider
 * 'google'/'microsoft', never a sandbox mailbox). Records-then-pushes; a push
 * failure is swallowed (the row is 'pending', reconcile retries).
 */
export async function maybePushProvisionedMailbox(
  ctx: TenantContext,
  mailbox: { email: string; provider: string },
  deps: CredentialPushDeps | undefined = buildCredentialPushDeps(ctx.env),
): Promise<PushOutcome | undefined> {
  if (!deps || mailbox.provider === "sandbox") return undefined;
  recordProvisionedMailboxForPush(ctx, mailbox.email);
  return pushRecordedMailbox(ctx, { email: mailbox.email, domain: domainOf(mailbox.email) }, deps);
}

export interface ReconcileSummary {
  attempted: number;
  pushed: number;
  stillPending: number;
}

/**
 * F6 reconcile PATH — retries every 'pending' push for this tenant. Called from
 * the per-tenant sweep (gated; inert unless armed). Idempotent: a 'pending' row
 * that turns out already-pushed vendor-side re-pushes safely (engine F4).
 */
export async function reconcileMailboxCredentialPushes(
  ctx: TenantContext,
  deps: CredentialPushDeps | undefined = buildCredentialPushDeps(ctx.env),
): Promise<ReconcileSummary> {
  if (!deps) return { attempted: 0, pushed: 0, stillPending: 0 };
  const pending = ctx.sql
    .exec<{ email: string }>(`SELECT email FROM mailbox_cred_pushes WHERE tenant_id = ? AND status = 'pending' ORDER BY created_at ASC`, ctx.tenantId)
    .toArray();
  let pushed = 0;
  for (const row of pending) {
    const outcome = await pushRecordedMailbox(ctx, { email: row.email, domain: domainOf(row.email) }, deps);
    if (outcome.pushed) pushed++;
  }
  return { attempted: pending.length, pushed, stillPending: pending.length - pushed };
}

function domainOf(email: string): string {
  return email.split("@")[1] ?? "";
}

function parseGrants(raw: string | undefined): Record<string, GmailGrant> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, GmailGrant> = {};
    for (const [email, g] of Object.entries(parsed as Record<string, unknown>)) {
      if (g && typeof g === "object") {
        const grant = g as Record<string, unknown>;
        if (typeof grant.clientId === "string" && typeof grant.clientSecret === "string" && typeof grant.refreshToken === "string") {
          out[email] = { clientId: grant.clientId, clientSecret: grant.clientSecret, refreshToken: grant.refreshToken };
        }
      }
    }
    return out;
  } catch {
    return {};
  }
}
