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
  const mailboxPort = new RealMailboxPort(inboxKitConfig);
  const minter: OAuthMinter = new ManualOAuthMinter(parseGrants(env.GMAIL_OAUTH_GRANTS));
  return {
    fetchCredentials: (email) => mailboxPort.showMailboxCredentials(email),
    mintGrant: (mailbox) => minter.mintGmailGrant(mailbox),
    push: new EngineMailboxClient(engineConfigFromEnv(env)),
  };
}

/** Shared ENGINE_* config lookup (independent of the InboxKit vendor fields) — used by the push path (gated behind isCredentialPushConfigured) AND the revoke path (gated only on the engine itself, see revokePushedMailboxCredentials). */
export function engineConfigFromEnv(env: Env): EngineClientConfig | undefined {
  return env.ENGINE_BASE_URL && env.ENGINE_AUTH_SECRET ? { baseUrl: env.ENGINE_BASE_URL, authSecret: env.ENGINE_AUTH_SECRET } : undefined;
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
  try {
    const credentials = await assembleEngineCredentials(mailbox, deps);
    // NO idempotency key: the store's content-hash replay-safety (F4) already
    // makes a same-content retry a no-op and a differing-content retry a
    // first-class rotation ('replaced') — mailbox-store.ts. A deterministic
    // key here would instead REJECT any retry whose re-minted content differs
    // (BadRequestError), which is exactly what a lost-response retry or a
    // fresh OAuth re-mint (InboxKitOAuthMinter mints a NEW refresh token on
    // every call) produces — permanently stranding the row 'pending'
    // (adversary i3i4-build-review-2026-07-23 finding 1).
    await deps.push.pushMailbox(mailbox.email, credentials);
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

/**
 * The credential REVOKE path (self-serve I3 lifecycle, wired into
 * lifecycle.ts's teardownTenant for cancel/abuse-terminate). Best-effort: a
 * released vendor mailbox's pushed credentials — including its gmail_api
 * refresh token — must stop resolving on the engine, but a revoke failure
 * must NEVER block or fail the teardown itself (the vendor slot is already
 * released; cancellation must complete regardless). Naturally idempotent
 * (MailboxCredentialStore.remove is a no-op on an unknown/already-removed
 * email), so a retried teardown is safe. Dark unless the engine is configured
 * — `client.isConfigured` is false in the default (unarmed) build, so a
 * teardown never attempts the call there (matches the deployed-default-is-
 * inert guarantee every other I3 seam here holds).
 */
export async function revokePushedMailboxCredentials(
  ctx: TenantContext,
  email: string,
  client: EngineMailboxClient = new EngineMailboxClient(engineConfigFromEnv(ctx.env)),
): Promise<void> {
  if (!client.isConfigured) return;
  try {
    await client.removeMailbox(email);
  } catch (err) {
    // Best-effort — log + ops-alert only; NEVER throw into cancel/teardown.
    console.error(`credential revoke: engine DELETE /v1/mailboxes failed for ${email} (best-effort, teardown continues)`, err);
  }
}

function domainOf(email: string): string {
  return email.split("@")[1] ?? "";
}

function parseGrants(raw: string | undefined): Record<string, GmailGrant> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logMalformedGrants(`invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    logMalformedGrants(`expected a JSON object keyed by mailbox email, got ${Array.isArray(parsed) ? "an array" : typeof parsed}`);
    return {};
  }
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
}

/**
 * F5-equivalent loud-corrupt convention (store.ts's loadJsonStateFile): a
 * malformed GMAIL_OAUTH_GRANTS secret must NOT be silently treated as "no
 * grants" — the downstream already fails closed per-mailbox
 * (ManualOAuthMinter throws "no manually-minted grant supplied"), but that
 * per-mailbox error hides the ROOT CAUSE (the secret itself is broken). Log
 * loud so an operator sees the real defect instead of chasing per-mailbox
 * symptoms. Does NOT throw: aborting mid-parse would propagate out of
 * maybePushProvisionedMailbox's/reconcileMailboxCredentialPushes' default-param
 * evaluation (uncaught at provisioning.ts:119) and fail an ALREADY-BILLED
 * provisioning saga — violating the F6 invariant that a credential-push
 * failure must never fail the provision (adversary i3i4-build-review-2026-07-23
 * finding 3).
 */
function logMalformedGrants(reason: string): void {
  console.error(`GMAIL_OAUTH_GRANTS is malformed — treating as no manual grants (${reason}); every mailbox push will fail loud at mint time until this operator secret is fixed.`);
}
