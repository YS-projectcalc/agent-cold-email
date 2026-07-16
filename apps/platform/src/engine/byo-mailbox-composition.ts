// SPEC.md §20.6 — BYO-mailbox composition: attaching mailboxes to an
// already-active BYO domain (byo-intake.ts owns getting the domain TO
// 'active'; this file owns what happens after). Two paths, the 2x2 from
// §20.6: (a) platform-provisioned mailboxes on a BYO domain (the founder-
// ruled PRIMARY build target) and (b) BYO-mailbox connect (the Mordy-pilot
// seam — OAuth/SMTP+IMAP, bypassing vendor provisioning entirely).

import { ValidationError, type ConnectByoMailboxInput, type RequestManagedByoMailboxesInput } from "@coldstart/shared";
import { newId } from "../schema.js";
import type { TenantContext } from "../tenant-context.js";
import { assertNotLifecycleFrozen } from "./billing-state.js";
import { requireByoDomainRow } from "./byo-intake.js";
import { provisionMailboxesForDomain, slugify } from "./provisioning.js";
import { ONE_DAY_MS, warmupDailyCap } from "./warmup.js";

export interface ManagedMailboxesResult {
  mailboxEmails: string[];
}

/**
 * SPEC.md §20.6 shape (a) — the founder-ruled PRIMARY build target: vendor
 * provisions PLATFORM-OWNED mailboxes on an already-active BYO domain. Reuses
 * the exact same vendor-call/warmup-bootstrap/metering sequence as the
 * existing lookalike flow (provisionMailboxesForDomain, CLAUDE.md rule c) —
 * the only difference is there is no domain.buy()/setDns() call, since we
 * don't own this domain.
 */
export async function requestManagedByoMailboxes(
  ctx: TenantContext,
  domainId: string,
  input: RequestManagedByoMailboxesInput,
): Promise<ManagedMailboxesResult> {
  assertNotLifecycleFrozen(ctx, "request_managed_byo_mailboxes");
  const row = requireByoDomainRow(ctx, domainId);
  if (row.byo_status !== "active") {
    throw new ValidationError(`domain ${row.domain} is not yet active (byo_status=${row.byo_status}) — mailboxes can only be attached to an active BYO domain`);
  }

  const personaSlug = slugify(input.personaSlug ?? row.domain);
  const mailboxEmails = await provisionMailboxesForDomain(ctx, {
    domainId,
    domain: row.domain,
    domainKey: `byo:${row.domain}#${domainId}`,
    domainOrdinal: 0,
    personaSlug,
    inboxesEach: input.count,
  });
  return { mailboxEmails };
}

export interface ConnectByoMailboxResult {
  mailboxId: string;
  email: string;
  transportKind: string;
}

/**
 * SPEC.md §20.6 — the Mordy-pilot BYO-mailbox seam: bypasses vendor
 * provisioning entirely, declaring an EXISTING OAuth/SMTP+IMAP connection the
 * customer already has in hand. Maps directly onto the engine's per-mailbox
 * transport discriminator (apps/engine/src/config.ts). SECURITY POSTURE
 * (residual, named plainly): `transport_json` stores the connection secret
 * (SMTP app password / OAuth refresh token / client secret) VERBATIM in this
 * tenant's own isolated DO SQLite — tenant-scoped and Cloudflare-encrypted-
 * at-rest, but NOT application-layer vaulted/encrypted, unlike
 * webhook_subscriptions.secret's "shown once, never re-read" pattern (a
 * webhook secret is SERVER-minted and only needs to prove authenticity later;
 * this secret must be read back VERBATIM to build the engine's
 * MAILBOX_CREDENTIALS, so "never re-expose" isn't available here). No read
 * path in this build ever selects/returns `transport_json` — deliberately,
 * so a compromised read-only surface (e.g. a future `list mailboxes` tool)
 * can't leak it, but the column itself is not hardened further. Flagged as a
 * follow-on hardening item, not fixed in this lane.
 */
export async function connectByoMailbox(
  ctx: TenantContext,
  domainId: string,
  input: ConnectByoMailboxInput,
): Promise<ConnectByoMailboxResult> {
  assertNotLifecycleFrozen(ctx, "connect_byo_mailbox");
  const row = requireByoDomainRow(ctx, domainId);
  if (row.byo_status !== "active") {
    throw new ValidationError(`domain ${row.domain} is not yet active (byo_status=${row.byo_status}) — a mailbox can only be connected to an active BYO domain`);
  }

  const now = ctx.clock.now();
  const mailboxId = newId("mbx");
  ctx.sql.exec(
    `INSERT INTO mailboxes
       (id, tenant_id, domain_id, domain, email, daily_cap, sent_today, sent_today_epoch_day, status, warmup_started_at, created_at, poll_cursor, source, transport_kind, transport_json)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, 'warming', ?, ?, -1, 'byo_connected', ?, ?)`,
    mailboxId,
    ctx.tenantId,
    domainId,
    row.domain,
    input.email,
    warmupDailyCap(1),
    Math.floor(now / ONE_DAY_MS),
    now,
    now,
    input.transport.kind,
    JSON.stringify(input.transport),
  );

  return { mailboxId, email: input.email, transportKind: input.transport.kind };
}
