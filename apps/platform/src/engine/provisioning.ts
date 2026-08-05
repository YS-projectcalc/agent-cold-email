import {
  CapacityPendingError,
  isPaidPlan,
  NotActivatedError,
  RegistrarUnarmedError,
  VendorError,
  ValidationError,
  type LookalikeCandidate,
  type MailboxHealth,
  type OwnedDomain,
  type PurchasedDomain,
  type SetupInfrastructureInput,
} from "@coldstart/shared";
import { newId } from "../schema.js";
import { logAction } from "./deliverability-actions.js";
import { createOpsMailer, type OpsMailer } from "../ops-mail/ops-mailer.js";
import type { TenantContext } from "../tenant-context.js";
import { buildMailboxBilling, syncMailboxQuantity, type MailboxBilling } from "./billing.js";
import { assertNotLifecycleFrozen } from "./billing-state.js";
import { assertBrandOwnership } from "./brand-guard.js";
import { gatherMailboxHealth } from "./deliverability.js";
import { withRequestIdempotency } from "./idempotency.js";
import { maybePushProvisionedMailbox } from "./mailbox-credential-push.js";
import { computeMailboxWarmupSnapshot } from "./mailbox-state.js";
import { assertWithinProvisioningCap } from "./quota.js";
import { screenTenant } from "../ofac/screening.js";
import { alertRegistrarUnarmed } from "./registrar-alert.js";
import { withSpendCeiling } from "./spend-ceiling.js";
import { RealInboxKitDomainPort } from "../vendors/real/inboxkit-domain-port.js";
import { assertCompleteRegistrant, readRegistrarOptInState } from "../vendors/registrar-arming.js";
import { computeWarmupDay, epochDay, warmupDailyCap, warmupStatus } from "./warmup.js";

// Per-mailbox/mo metering fee (SPEC.md §18 ballpark fully-loaded cost) —
// paid tiers only. Demo/free is structurally 0-real-spend (ARCHITECTURE.md
// #8); sandbox mailboxes are still provisioned there for exploration, but no
// fee accrues (see e2e.test.ts's demo-tenant usageCents assertion).
const MAILBOX_MONTHLY_FEE_CENTS = 600;

// Extra candidates requested beyond what a call needs, so the not-owned +
// available filters have room to discard. Matches pickReplacementDomain's own
// `owned.size + 4` shape.
const CANDIDATE_BUFFER = 4;

/** Lowercased domains this tenant already has a row for — the dedupe set (H3b). */
function ownedDomainNames(ctx: TenantContext): Set<string> {
  return new Set(
    ctx.sql
      .exec<{ domain: string }>(`SELECT domain FROM domains WHERE tenant_id = ?`, ctx.tenantId)
      .toArray()
      .map((r) => r.domain.toLowerCase()),
  );
}

export function slugify(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 20) || "hello";
}

/**
 * Provisions `inboxesEach` PLATFORM-OWNED mailboxes on an ALREADY-OWNED
 * domain row (vendor provision + startWarmup + insert mailbox row +
 * per-mailbox/mo metering on paid tiers). Extracted from
 * `provisionDomainWithMailboxes` (CLAUDE.md rule c — no duplicated logic) so
 * SPEC.md §20.6's shape (a) — a managed mailbox provisioned on a BYO domain
 * (`engine/byo-intake.ts`'s `requestManagedByoMailboxes`) — reuses the exact
 * same vendor-call + warmup-bootstrap + metering sequence as the existing
 * lookalike-domain flow and REPLACE_DOMAIN, instead of a parallel
 * implementation. `domainKey` namespaces idempotency keys (distinct domains
 * never collide); `domainOrdinal` only affects the generated local-part
 * numbering (cosmetic — uniqueness only requires the local part be unique
 * WITHIN this one domain, which the mailboxIndex loop already guarantees).
 */
export async function provisionMailboxesForDomain(
  ctx: TenantContext,
  opts: { domainId: string; domain: string; domainKey: string; domainOrdinal: number; personaSlug: string; inboxesEach: number },
): Promise<string[]> {
  const now = ctx.clock.now();
  const mailboxEmails: string[] = [];

  for (let mailboxIndex = 0; mailboxIndex < opts.inboxesEach; mailboxIndex++) {
    const localPart = `${opts.personaSlug}${opts.domainOrdinal + 1}${mailboxIndex + 1}`;
    const provisionIdempotencyKey = `mbx:${ctx.tenantId}:${opts.domainKey}:${localPart}`;
    // Gate (c) — provision idempotency via the repo's own withRequestIdempotency
    // (adversary inboxkit-adapters-2026-07-20 finding 3). InboxKit's
    // /mailboxes/buy has no idempotency-key primitive, so a redelivered
    // setup_infrastructure (its outer request-idempotency claim expired mid-run,
    // or the response was lost) would re-buy — a DOUBLE CHARGE on a paid slot.
    // Wrapping the vendor call in withRequestIdempotency keyed by the
    // DETERMINISTIC per-mailbox key makes a re-run return the recorded
    // ProvisionedMailbox WITHOUT a second buy. This is the durable local record
    // that REPLACES the fragile /already exists/i message-substring hack the
    // adapter used to lean on (mailbox-port.ts provision()).
    // G2 money-out site #1 (design §0 inventory) — the mailbox slot buy. The
    // spend reserve composes INSIDE withRequestIdempotency (design §G2 collision
    // note): a replayed provision returns the RECORDED mailbox without re-buying,
    // so it never re-enters withSpendCeiling and never double-reserves — only a
    // true first execution reserves. 'mailbox' consumes one InboxKit plan slot
    // (G4).
    // H4 (INCIDENT 2026-08-05): the recorded unit spans the WHOLE per-mailbox
    // effect — buy AND startWarmup AND the row insert — not just the buy. When
    // only the buy was recorded, a replay returned the cached mailbox and then
    // re-ran startWarmup (a SECOND $3/mo subscription) and re-INSERTed the row
    // (a phantom mailbox that syncMailboxQuantity then BILLED the customer for).
    // Everything with a side effect now lives inside fn, so a replay returns the
    // recorded outcome and re-runs none of it.
    const provisioned = await withRequestIdempotency(ctx, `provision:${provisionIdempotencyKey}`, async () => {
      const bought = await withSpendCeiling(ctx, "mailbox", () =>
        ctx.adapters.mailbox.provision(opts.domain, localPart, provisionIdempotencyKey),
      );
      // G2 money-out site #2 — the warmup add-on. Its cost is already priced into
      // COST_MAILBOX_CENTS at the provision reserve above (spendCostCents's 'warmup'
      // branch reserves 0), so this wrap is for choke-point completeness (no
      // money-out vendor call escapes the enumerated inventory), not a second charge.
      const warmup = await withSpendCeiling(ctx, "warmup", () =>
        ctx.adapters.mailbox.startWarmup(bought.email, `warmup:${ctx.tenantId}:${bought.email}`),
      );
      return { email: bought.email, provider: bought.provider, provisionedAt: bought.provisionedAt, warmupStartedAt: warmup.startedAt };
    });
    mailboxEmails.push(provisioned.email);
    // The row INSERT stays OUTSIDE the recorded unit, unlike the two vendor
    // calls above. Putting it inside looked tidier but broke legitimate
    // re-provisioning: a claim outlives a cancel, so a replay after teardown
    // returned the recorded mailbox and inserted NOTHING, leaving a
    // re-subscribed tenant with zero mailboxes. Idempotence here comes from the
    // PARTIAL unique index on (tenant_id, email) WHERE released_at IS NULL
    // (tenant-do.ts) instead: a replay while the mailbox is live is ignored (no
    // phantom row for syncMailboxQuantity to bill), while a genuine
    // re-provision after release — where no live row exists — inserts normally.
    //
    // N4 correction (gate 2026-08-05): that re-provision inserts a BILLABLE row
    // without a vendor mailbox behind it, because the per-mailbox provision
    // claim outlives the teardown and the replay skips the vendor buy. This
    // comment previously implied the re-insert was simply correct. It is not —
    // it is a PRE-EXISTING divergence (it predates the recorded-unit change,
    // which only made it visible), deferred to the class wave. Do not read the
    // paragraph above as a claim that the resulting row is backed by anything.
    insertProvisionedMailbox(ctx, opts, provisioned.email, provisioned.warmupStartedAt, now);

    // Per-mailbox/mo INTERNAL COGS metering — paid plan only (see
    // MAILBOX_MONTHLY_FEE_CENTS comment above). The local ledger 'usage' write
    // stays as the founder's internal cost tracking (account().usageCents);
    // it is NOT the customer's bill. The customer is billed by the licensed
    // Stripe QUANTITY (syncMailboxQuantity, design §2) — the former per-mailbox
    // Stripe usage report was DELETED with the migration: that endpoint only
    // accepts metered items, but checkout creates a LICENSED item (a latent 400
    // if ever armed), and keeping both would double-count the per-mailbox charge.
    // Reuses the SAME idempotency key as mailbox.provision() as the ledger's
    // source_send_id so a retried provision can never double-count.
    if (isPaidPlan(ctx.plan)) {
      // H5 (INCIDENT 2026-08-05) — this call sits AFTER the money already moved,
      // and the real billing port throws NotActivatedError unconditionally
      // (vendors/real/billing-port.ts): it was the guaranteed NEXT 500 once the
      // domain legs were fixed, failing a provision whose vendor spend had
      // already happened. The metering is INTERNAL COGS tracking, not the
      // customer's bill (they are billed by Stripe quantity), so an unarmed
      // usage reporter must not destroy a successful provision. Narrow by
      // design: only NotActivatedError is absorbed — a genuine billing failure
      // still propagates.
      try {
        await ctx.adapters.billing.recordUsage(
          ctx.tenantId,
          "mailbox provisioned (mo)",
          MAILBOX_MONTHLY_FEE_CENTS,
          provisionIdempotencyKey,
        );
      } catch (err) {
        if (!(err instanceof NotActivatedError)) throw err;
        logAction(ctx, "USAGE_METERING_SKIPPED", provisioned.email, {
          reason: "billing usage reporter is not activated — local ledger entry still recorded",
        });
      }
      ctx.sql.exec(
        `INSERT OR IGNORE INTO ledger_entries (id, tenant_id, kind, amount_cents, description, ts, source_send_id)
         VALUES (?, ?, 'usage', ?, 'mailbox provisioned (mo)', ?, ?)`,
        newId("ledg"),
        ctx.tenantId,
        MAILBOX_MONTHLY_FEE_CENTS,
        now,
        provisionIdempotencyKey,
      );
    }

    // Self-serve I3 credential push (F6): record-then-push the just-provisioned
    // mailbox's credentials to the engine. INERT unless the vendor+engine are
    // armed AND this is a real vendor mailbox (never sandbox) — so it is a no-op
    // in the default build and every existing test. A push failure is swallowed
    // (the mailbox is durably recorded 'pending'; the reconcile sweep retries),
    // so it can never fail a provision whose vendor spend already happened.
    await maybePushProvisionedMailbox(ctx, provisioned);
  }

  return mailboxEmails;
}

/**
 * The `mailboxes` row for a just-provisioned mailbox. Extracted so it can live
 * INSIDE the per-mailbox recorded unit (H4) — a replay must not re-insert it.
 * The unique index on (tenant_id, email) is the backstop if it ever does.
 */
function insertProvisionedMailbox(
  ctx: TenantContext,
  opts: { domainId: string; domain: string },
  email: string,
  warmupStartedAt: number,
  now: number,
): void {
  const day = computeWarmupDay(warmupStartedAt, now);
  ctx.sql.exec(
    // poll_cursor starts at -1 (never-polled sentinel, engine.ts's
    // first-contact branch) so runPollInbox's first poll for a brand-new
    // mailbox initializes the cursor at the mailbox's current high-water
    // WITHOUT fetching history, instead of the column's own DEFAULT 0 (an
    // ordinary incremental cursor since the round-2 fix, not a sentinel).
    //
    // OR IGNORE against idx_mailboxes_tenant_email (H4 backstop): if a replay
    // ever reaches here anyway, a duplicate row would be BILLED by
    // syncMailboxQuantity, so the index — not just the recorded unit — is what
    // makes double-billing structurally impossible.
    `INSERT OR IGNORE INTO mailboxes
       (id, tenant_id, domain_id, domain, email, daily_cap, sent_today, sent_today_epoch_day, status, warmup_started_at, created_at, poll_cursor, slot_counted)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, -1, ?)`,
    newId("mbx"),
    ctx.tenantId,
    opts.domainId,
    opts.domain,
    email,
    warmupDailyCap(day),
    epochDay(now),
    warmupStatus(day),
    warmupStartedAt,
    now,
    // G4 — record whether this consumed a REAL InboxKit plan slot (the
    // withSpendCeiling reserve above incremented vendor_slot_state iff the
    // bundle is real). Read at teardown to decrement the slot counter precisely.
    ctx.adapters.kind === "real" ? 1 : 0,
  );
}

export interface DomainIntentRow {
  key: string;
  candidate_domain: string;
  status: string;
  [column: string]: SqlStorageValue;
}

/**
 * H1 — the durable buy-intent record. Idempotent by construction: a retry
 * re-reads the EXISTING row (keeping the candidate name the first attempt
 * resolved) rather than overwriting it, which is what makes the retry converge
 * on the same domain instead of generating a fresh one. Tenant-scoped on read
 * (CLAUDE.md rule h) even though the key already embeds the tenant.
 */
export function recordDomainIntent(ctx: TenantContext, key: string, candidateDomain: string): DomainIntentRow {
  const now = ctx.clock.now();
  ctx.sql.exec(
    `INSERT OR IGNORE INTO domain_intents (key, tenant_id, candidate_domain, status, created_at, updated_at)
     VALUES (?, ?, ?, 'intent', ?, ?)`,
    key,
    ctx.tenantId,
    candidateDomain,
    now,
    now,
  );
  return ctx.sql
    .exec<DomainIntentRow>(
      `SELECT key, candidate_domain, status FROM domain_intents WHERE key = ? AND tenant_id = ?`,
      key,
      ctx.tenantId,
    )
    .one();
}

/**
 * Advances an intent's status, optionally correcting the domain it names.
 * NEVER deletes — see the table's schema comment.
 *
 * `actualDomain` (N1) is the resource genuinely acquired. The recorded name is
 * a claim about what we may own, so it has to match reality at commit time: a
 * fall-through buy acquires THIS call's candidate, which is not necessarily the
 * name the first attempt under this key resolved to.
 */
export function markDomainIntent(
  ctx: TenantContext,
  key: string,
  status: "intent" | "committed" | "dangling",
  actualDomain?: string,
): void {
  if (actualDomain === undefined) {
    ctx.sql.exec(
      `UPDATE domain_intents SET status = ?, updated_at = ? WHERE key = ? AND tenant_id = ?`,
      status,
      ctx.clock.now(),
      key,
      ctx.tenantId,
    );
    return;
  }
  ctx.sql.exec(
    `UPDATE domain_intents SET status = ?, candidate_domain = ?, updated_at = ? WHERE key = ? AND tenant_id = ?`,
    status,
    actualDomain,
    ctx.clock.now(),
    key,
    ctx.tenantId,
  );
}

/**
 * H3 — is this candidate already ours to adopt? Adoptable means the vendor
 * account owns it, it is ACTIVE, it has NO mailboxes attached, and no live
 * `domains` row already claims it for this tenant.
 *
 * A listing failure is swallowed to `null` (fall through to the ordinary buy):
 * the adopt path is a RECOVERY, and a vendor hiccup while asking must not turn
 * a first-time provision into a hard failure. The cost of that fallthrough is
 * bounded — a repeat buy the vendor itself rejects, which is exactly the state
 * we were already in — whereas failing closed would block every provision
 * whenever /domains/list is unhealthy.
 */
export async function findAdoptableDomain(ctx: TenantContext, candidate: string): Promise<OwnedDomain | null> {
  const alreadyRecorded = ctx.sql
    .exec<{ n: number }>(
      `SELECT COUNT(*) as n FROM domains WHERE tenant_id = ? AND domain = ? AND status != 'released'`,
      ctx.tenantId,
      candidate,
    )
    .one().n;
  if (alreadyRecorded > 0) return null; // we already track it — nothing to adopt

  let owned: OwnedDomain[];
  try {
    owned = await ctx.adapters.domain.listOwnedDomains();
  } catch (err) {
    logAction(ctx, "DOMAIN_ADOPT_LOOKUP_FAILED", candidate, {
      reason: err instanceof Error ? err.message : String(err),
      note: "falling through to the ordinary buy path",
    });
    return null;
  }

  const match = owned.find((d) => d.domain.toLowerCase() === candidate.toLowerCase());
  if (!match) return null;
  if (match.status !== "active" || match.assignedMailboxes > 0) {
    logAction(ctx, "DOMAIN_ADOPT_SKIPPED", candidate, {
      reason: `owned but not adoptable (status=${match.status}, assignedMailboxes=${match.assignedMailboxes})`,
    });
    return null;
  }
  return match;
}

// H2 — the async-registration race window. InboxKit took ~32s to complete the
// registration that stranded the incident domain, while our nameservers call
// went out milliseconds after the order was accepted, so a bare first attempt
// is expected to lose the race.
//
// Deliberately SHORT (one quick re-attempt, ~2s) rather than long enough to
// bridge the full ~32s. Parking a Durable Object for half a minute to wait out
// a vendor's async pipeline is the wrong place to spend that time: it burns
// wall-clock budget, blocks the input gate, and would still be a guess about
// the vendor's timing. The SAFETY comes from H2's persist-before-DNS ordering,
// not from winning the race — the domain is already recorded, so the honest
// outcome is dns_status 'pending' plus a RETRYABLE error, and the caller's
// retry (which now adopts rather than re-buys) finishes the job.
const SET_DNS_BACKOFF_MS = [2_000];

/**
 * H2 — runs setDns as a recoverable follow-up. The domain row already exists,
 * so every outcome here is non-destructive: success flips `dns_status` to
 * 'ready', exhaustion leaves it 'pending' with an ops-visible action row and a
 * RETRYABLE VendorError for the caller. Never throws a non-retryable error and
 * never deletes the domain.
 */
export async function setDnsWithRetry(
  ctx: TenantContext,
  domain: string,
  idempotencyKey: string,
  domainId: string,
  // Injectable so tests exercise the retry LOGIC without paying its wall-clock.
  // Production always uses the module default.
  backoffMs: number[] = SET_DNS_BACKOFF_MS,
): Promise<void> {
  const attempts = backoffMs.length + 1;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await ctx.adapters.domain.setDns(domain, idempotencyKey);
      ctx.sql.exec(`UPDATE domains SET dns_status = 'ready' WHERE id = ? AND tenant_id = ?`, domainId, ctx.tenantId);
      return;
    } catch (err) {
      lastError = err;
      const backoff = backoffMs[attempt - 1];
      if (backoff !== undefined && backoff > 0) {
        await new Promise((resolve) => setTimeout(resolve, backoff));
      }
    }
  }

  const reason = lastError instanceof Error ? lastError.message : String(lastError);
  logAction(ctx, "DOMAIN_DNS_PENDING", domain, { reason, attempts });
  throw new VendorError(
    `domain ${domain} is registered and recorded, but its DNS setup has not completed yet (${reason}). Nothing was lost — retry to finish it.`,
    true,
  );
}

/**
 * Provisions ONE domain + its mailboxes: buy → DNS → insert domain row → for
 * each mailbox provision + startWarmup + insert mailbox row (+ per-mailbox/mo
 * metering on paid tiers). The single implementation shared by
 * setup_infrastructure (initial provisioning) and the deliverability control
 * loop's REPLACE_DOMAIN (burn replacement) — CLAUDE.md rule c (no duplicated
 * logic). Idempotency keys are namespaced by `domainKey` (`domain#index`) so
 * distinct domains never collide.
 */
export async function provisionDomainWithMailboxes(
  ctx: TenantContext,
  opts: { domain: string; domainIndex: number; personaSlug: string; inboxesEach: number; intentKey: string },
): Promise<{ domainId: string; domain: string; mailboxEmails: string[] }> {
  const domainKey = `${opts.domain}#${opts.domainIndex}`;

  // G5 gate (a) follow-up (2026-07-27) — BEFORE any spend reservation or
  // vendor call: a tenant who cleared BOTH registrar-arming legs (env armed +
  // opted in — vendors/factory.ts's three-way branch) but whose CAN-SPAM
  // profile can't source a complete InboxKit registrant fails loud here,
  // naming exactly which fields are missing, instead of reserving spend for a
  // buy that would either silently send a partial contact_details payload or
  // waste a real vendor round trip. Detected via `instanceof` rather than a
  // duplicated armed/optIn check — the factory is the single source of truth
  // for THAT decision; this only re-derives the registrant (same tenant_profile
  // source) to validate completeness at the point of actual spend.
  if (ctx.adapters.domain instanceof RealInboxKitDomainPort) {
    assertCompleteRegistrant(readRegistrarOptInState(ctx.sql, ctx.tenantId).registrant);
  }

  // H1 — record the INTENT to buy before the buy. Written with the RESOLVED
  // candidate name, keyed stably so a retry lands on the same row, and never
  // deleted: a 'dangling' row is the only durable evidence that we may already
  // own a domain the buy leg failed to report.
  const intent = recordDomainIntent(ctx, opts.intentKey, opts.domain);

  // This ORDINAL is already done. Reached when a caller repeats a setup call
  // WITHOUT an idempotency key: the intent key falls back to tenant+ordinal, so
  // the repeat resolves to the intent the first call committed. A keyless
  // identical call is indistinguishable from a retry, so it must CONVERGE —
  // return the domain we already have rather than buy another one. (H3b's
  // dedupe hands us a fresh candidate by then, which is why this check is on
  // the INTENT's recorded name, not on `opts.domain`.) A caller who genuinely
  // wants a second domain sends a distinct Idempotency-Key, which mints a
  // distinct intent and falls through to the normal buy below.
  const existing = ctx.sql
    .exec<{ id: string; domain: string; dns_status: string }>(
      `SELECT id, domain, dns_status FROM domains WHERE tenant_id = ? AND domain = ? AND status != 'released' LIMIT 1`,
      ctx.tenantId,
      intent.candidate_domain,
    )
    .toArray()[0];
  if (intent.status === "committed" && existing) {
    // B1 (gate 2026-08-05) — RE-DRIVE DNS BEFORE PROVISIONING ANYTHING.
    // H2's error text promises "retry to finish it", and this branch is the
    // retry — but it used to return without ever calling setDnsWithRetry again
    // (setDns lives below this early return). A domain left dns_status
    // 'pending' therefore got billable mailboxes provisioned onto nameservers
    // that were never pointed at the vendor, under a 202. That is strictly
    // worse than the incident: it fails SILENTLY and bills monthly.
    //
    // If DNS still cannot complete, setDnsWithRetry throws RETRYABLE and we let
    // it propagate — deliberately BEFORE any mailbox spend. A domain with no
    // working nameservers must never carry paid mailboxes; the domain row and
    // the intent both survive, so the next retry resumes from here.
    if (existing.dns_status !== "ready") {
      await setDnsWithRetry(ctx, existing.domain, `dns:${ctx.tenantId}:${existing.domain}#${opts.domainIndex}`, existing.id);
    }
    const mailboxEmails = await provisionMailboxesForDomain(ctx, {
      domainId: existing.id,
      domain: existing.domain,
      domainKey: `${existing.domain}#${opts.domainIndex}`,
      domainOrdinal: opts.domainIndex,
      personaSlug: opts.personaSlug,
      inboxesEach: opts.inboxesEach,
    });
    return { domainId: existing.id, domain: existing.domain, mailboxEmails };
  }

  // H3 — ADOPT BEFORE BUY. A prior attempt may have completed vendor-side and
  // died before we recorded it (the live incident); the vendor answers a repeat
  // buy with "already owned by your team", which we must never parse. Ask what
  // the account owns instead. Only an ACTIVE domain with NO mailboxes attached
  // is adoptable — an assigned one belongs to some other flow and taking it
  // over would silently re-home someone's mailboxes.
  // Two names can be adoptable here and they are NOT the same:
  //   intent.candidate_domain — what a PRIOR attempt under this key resolved to
  //                             (the retry case; may be stranded vendor-side).
  //   opts.domain             — what THIS call resolved to, which for a first
  //                             attempt on a live orphan IS the orphan (B2).
  // The intent's name wins when both adopt, since converging on the earlier
  // attempt's resource is what makes a retry idempotent.
  const adopted =
    (await findAdoptableDomain(ctx, intent.candidate_domain)) ??
    (intent.candidate_domain === opts.domain ? null : await findAdoptableDomain(ctx, opts.domain));

  // G2 money-out site #3 (design §0 inventory) — the registrar domain purchase.
  // Skipped entirely on the adopt path: the money already moved on the attempt
  // that stranded it, so reserving again would double-count. setDns below is
  // config-only (not spend), so it stays unwrapped. When the registrar is
  // unarmed (G5 gate (a)), domain.buy throws RegistrarUnarmedError INSIDE the
  // wrapper → withSpendCeiling releases the reservation and re-throws, so an
  // unarmed registrar never leaks a reservation.
  let purchased: PurchasedDomain;
  if (adopted) {
    purchased = { domain: adopted.domain, purchasedAt: ctx.clock.now(), registrar: "adopted" };
    logAction(ctx, "DOMAIN_ADOPTED", adopted.domain, {
      reason: "already owned by the vendor account with no mailboxes attached — recovered instead of re-bought",
      intentKey: opts.intentKey,
      priorStatus: intent.status,
    });
  } else {
    try {
      purchased = await withSpendCeiling(ctx, "domain", () =>
        ctx.adapters.domain.buy(opts.domain, `buy:${ctx.tenantId}:${domainKey}`),
      );
    } catch (err) {
      // The buy leg failed and we CANNOT know whether the vendor completed it
      // (the incident's exact ambiguity). Leave the intent 'dangling' so the
      // next attempt reaches the adopt path above instead of regenerating a
      // candidate and re-buying.
      markDomainIntent(ctx, opts.intentKey, "dangling");
      throw err;
    }
  }

  // H2 — PERSIST THE INSTANT IT IS OURS, before any DNS work. This INSERT used
  // to sit AFTER setDns, so a setDns throw discarded a domain we had already
  // paid for. dns_status starts 'pending' and is flipped below.
  const domainId = newId("dom");
  ctx.sql.exec(
    `INSERT INTO domains (id, tenant_id, domain, status, purchased_at, dns_status) VALUES (?, ?, ?, 'active', ?, 'pending')`,
    domainId,
    ctx.tenantId,
    purchased.domain,
    purchased.purchasedAt,
  );
  // N1 (gate 2026-08-05) — the intent must name the resource ACTUALLY acquired.
  // A fall-through buy purchases `opts.domain` (this call's fresh candidate)
  // while the intent still recorded the FIRST-resolved name, so the durable
  // record misnamed what we own — worst case two real charges under one key,
  // with the intent pointing at neither correctly.
  markDomainIntent(ctx, opts.intentKey, "committed", purchased.domain);

  // H2 — DNS is now a FOLLOW-UP. The vendor's registration is ASYNC (measured
  // ~32s on the incident), and we called nameservers milliseconds after it
  // accepted the order, so the race is expected rather than exceptional: retry
  // it briefly in-call. If it still fails the domain stays recorded with
  // dns_status 'pending' and the failure is surfaced as retryable — never a
  // strand, and never a silent "ready".
  await setDnsWithRetry(ctx, purchased.domain, `dns:${ctx.tenantId}:${domainKey}`, domainId);

  const mailboxEmails = await provisionMailboxesForDomain(ctx, {
    domainId,
    domain: purchased.domain,
    domainKey,
    domainOrdinal: opts.domainIndex,
    personaSlug: opts.personaSlug,
    inboxesEach: opts.inboxesEach,
  });

  return { domainId, domain: purchased.domain, mailboxEmails };
}

/**
 * setup_infrastructure — SPEC.md §6 / brief signature. Buys N lookalike
 * domains, DNS them, provisions `inboxesEach` mailboxes per domain, starts
 * warmup. Runs synchronously under the hood in B0 (the sandbox vendor calls
 * are in-memory and instant); the async resumable saga (DO alarms, retries)
 * is B2 scope. The returned jobId reflects the intent's async shape without
 * yet being backed by a tracked job record.
 */
export async function runSetupInfrastructure(
  ctx: TenantContext,
  input: SetupInfrastructureInput,
  // Injectable (default a real/dark-per-env OpsMailer) — same pattern as
  // admin/ops-sweep.ts's runDunningSweep / deliverability-actions.ts's
  // runDeliverabilitySweep, so a test can assert the gate (a) alert content
  // with a SandboxOpsMailer without any production call site needing to change.
  mailer: OpsMailer = createOpsMailer(ctx.env),
  // H1 — the caller's request idempotency key, threaded in solely to seed
  // STABLE domain-intent keys. Optional: without one, intents key off the
  // tenant + ordinal, which still converges for the single-tenant retry that
  // matters (a caller who omits the key gets less protection, exactly as with
  // request idempotency itself).
  setupKey?: string,
): Promise<{ jobId: string; billing: MailboxBilling } | { quoteOnly: true; billing: MailboxBilling }> {
  // Lifecycle freeze — BEFORE any spend. A suspended/disputed/canceled tenant
  // must not provision fresh infra (real registrar/mailbox spend at activation
  // on an account we deliberately froze — adversarial panel-03 finding #5).
  assertNotLifecycleFrozen(ctx, "setup_infrastructure");

  // Lookalike third-party-brand hard-reject — BEFORE any searchLookalikes/buy
  // (ARCHITECTURE.md #8 "enforced in code"). Throws ValidationError -> HTTP 400.
  assertBrandOwnership({ brand: input.brand, primaryDomain: input.primaryDomain });

  // Plan quota / provisioning-cap guard (B1 brief) — BEFORE any spend.
  assertWithinProvisioningCap(ctx, { domains: input.domains, mailboxes: input.domains * input.inboxesEach });

  // The live provisioned mailbox count (the billing meter) — read for the
  // in-response billing projection (SPEC §18 "no silent capacity addition").
  const liveProvisioned = (): number =>
    ctx.sql.exec<{ n: number }>(`SELECT COUNT(*) as n FROM mailboxes WHERE tenant_id = ? AND released_at IS NULL`, ctx.tenantId).one().n;

  // Quote-before-add PREVIEW (design §2): return the PROJECTED new count +
  // monthly WITHOUT provisioning or mutating the profile — the request is fully
  // validated above so the projection reflects a genuinely-acceptable request.
  if (input.quoteOnly) {
    return { quoteOnly: true, billing: buildMailboxBilling(ctx, liveProvisioned() + input.domains * input.inboxesEach) };
  }

  // H8, asymmetric by risk. Deferring the whole profile write past the reads
  // would also defer an opt-OUT, so a candidate-search failure would silently
  // preserve a standing money authorization the tenant just tried to revoke —
  // strictly worse than the half-write H8 exists to prevent. Revocation is
  // never risky to persist, so it lands IMMEDIATELY and unconditionally; only
  // the authorization direction waits for the reads to succeed. (The full write
  // below re-writes this same 0 on the success path — harmless and keeps the
  // two columns written together as their comment requires.)
  // Both columns move TOGETHER, never just one — the pairing invariant the
  // full write below documents (they must not drift apart from each other).
  // H8b: only an EXPLICIT false revokes. Absent means "no opinion this call",
  // which must leave the persisted consent exactly as it was.
  if (input.registerDomains === false) {
    ctx.sql.exec(
      `UPDATE tenant_profile SET register_domains = 0, registrant_json = ? WHERE id = ?`,
      input.registrant ? JSON.stringify(input.registrant) : null,
      ctx.tenantId,
    );
  }

  // H8 (INCIDENT 2026-08-05) — both READS run BEFORE the profile write. The
  // half-write is what left Mordy's tenant carrying brand + register_domains=1 +
  // registrant_json (a standing authorization for real money) while showing 0
  // domains and 0 mailboxes. Screening and candidate generation can both fail,
  // and neither has any reason to persist a spend authorization first. This is
  // the cheap 80%: full saga rows for the remaining window are the class wave.
  //
  // The G5 gate-(a) try/catch still wraps the candidate search, since an unarmed
  // registrar surfaces on that first vendor touch and needs its founder alert.
  let candidates: LookalikeCandidate[];
  try {
    if (isPaidPlan(ctx.plan)) {
      // G1b re-screen (NB-1 disposition, adversary round 1 2026-07-23): the
      // operative sending brand is REWRITTEN by this call and was never
      // re-screened — a tenant could screen-clean at checkout, then set a
      // sanctioned brand here and evade G1 entirely. Scoped to paid tiers:
      // demo/free can never activate regardless of screening_status. Now runs
      // against `input.brand` BEFORE the write rather than after it, so a
      // sanctioned brand never lands in tenant_profile at all.
      await screenTenant(ctx, { trigger: "brand_change", brand: input.brand });
    }
    // H3b (pipeline F1+F3) — ask for enough candidates to survive BOTH filters
    // below. The generator is stateless and deterministic, so requesting exactly
    // `input.domains` guaranteed that a second call regenerated the domain the
    // first call already bought (Mordy's call 2, a certain failure). Same
    // over-request the burn-replacement picker already does
    // (deliverability-actions.ts's pickReplacementDomain) — this path simply
    // never had it.
    candidates = await ctx.adapters.domain.searchLookalikes(
      input.brand,
      input.primaryDomain,
      input.domains + ownedDomainNames(ctx).size + CANDIDATE_BUFFER,
    );
  } catch (err) {
    if (err instanceof RegistrarUnarmedError) {
      await alertRegistrarUnarmed(ctx, input.primaryDomain, err, mailer);
    }
    throw err;
  }

  // H8b — the CAN-SPAM capture always reflects this call; the registrar consent
  // pair is only touched when this call actually expressed one. Split into two
  // statements rather than one, because there is no SQL expression for "leave
  // these two columns alone" that also keeps them written together.
  ctx.sql.exec(
    `UPDATE tenant_profile SET brand = ?, primary_domain = ?, physical_address = ?, sender_identity = ? WHERE id = ?`,
    input.brand,
    input.primaryDomain,
    input.physicalAddress,
    input.senderIdentity,
    ctx.tenantId,
  );
  // Absent (`undefined`) leaves the tenant's standing consent and the registrant
  // it was captured with UNTOUCHED — the F2 fix. The previous unconditional
  // write zeroed both columns for any caller that merely omitted the fields.
  if (input.registerDomains !== undefined) {
    ctx.sql.exec(
      `UPDATE tenant_profile SET register_domains = ?, registrant_json = ? WHERE id = ?`,
      // G5 gate (a) follow-up — the tenant's PER-TENANT, PERSISTED consent to
      // real domain purchases (founder ruling 2026-07-21: "per-tenant opt-in
      // only, never a default"). Governs the deliverability control loop's
      // REPLACE_DOMAIN burn-replacement buys too (vendors/registrar-arming.ts).
      input.registerDomains ? 1 : 0,
      // Registrar-arming follow-up (2026-07-28) — the structured registrant-of-
      // record. zod (SetupInfrastructureInput's refinement) guarantees
      // `input.registrant` is present + complete whenever `registerDomains` is
      // true, so this write is never partial for a call that opts in THIS time.
      // Written alongside register_domains so the two can never drift apart.
      input.registrant ? JSON.stringify(input.registrant) : null,
      ctx.tenantId,
    );
  }

  // H3b — the usable set: not already ours, and the vendor says it can be
  // registered. `available` was fetched at one real API round trip PER
  // candidate and then read by nobody, so an unavailable name (the common case
  // for any real business slug) was bought anyway, turning a customer's FIRST
  // provisioning into a hard vendor error. Both filters applied once, here.
  const owned = ownedDomainNames(ctx);

  // B2 (gate 2026-08-05) — ADOPT IS CONSULTED BEFORE THE AVAILABILITY FILTER.
  // A domain the vendor account already owns is, by definition, NOT available:
  // the real port sets `available` from GET /domains/available, so every
  // adoptable candidate was discarded before findAdoptableDomain could see it,
  // and adopt-before-buy could never fire for the one domain it was written to
  // recover. Checking adoptability first is what makes the live orphan
  // recoverable BY NAME — no seeded intent row required, which matters because
  // domain_intents did not exist when the stranding call ran.
  const adoptable = new Map<string, OwnedDomain>();
  for (const candidate of candidates) {
    if (owned.has(candidate.domain.toLowerCase())) continue; // already ours locally
    const match = await findAdoptableDomain(ctx, candidate.domain);
    if (match) adoptable.set(candidate.domain.toLowerCase(), match);
  }

  // Usable = adoptable (recover it, zero spend) OR genuinely buyable (available
  // and not already ours). Adoptable names are rescued from the filter that
  // would otherwise drop them for being unavailable.
  const usable = candidates.filter(
    (c) =>
      adoptable.has(c.domain.toLowerCase()) ||
      (c.available !== false && !owned.has(c.domain.toLowerCase())),
  );
  if (usable.length < input.domains) {
    // Deliberately a hard, structured stop rather than the old positional
    // `candidates[i % candidates.length]` wraparound, which silently bought the
    // SAME domain repeatedly within one call at domains >= 6.
    throw new ValidationError(
      `could not find ${input.domains} available lookalike domain(s) for "${input.brand}" that this account does not already own (found ${usable.length}). Try a different brand/primary domain, or request fewer domains.`,
    );
  }

  try {
    const personaSlug = slugify(input.persona);

    for (let domainIndex = 0; domainIndex < input.domains; domainIndex++) {
      const candidate = usable[domainIndex];
      if (!candidate) continue;
      await provisionDomainWithMailboxes(ctx, {
        domain: candidate.domain,
        domainIndex,
        personaSlug,
        inboxesEach: input.inboxesEach,
        // H1 — the intent key. Derived from the caller's setup idempotency key
        // (falling back to the tenant when none was supplied) plus the ordinal,
        // NEVER from the candidate name: a retry has to resolve to the same
        // intent row even if candidate generation ever changes, which is the
        // whole point of recording the resolved name rather than deriving it.
        intentKey: `${setupKey ?? `tenant:${ctx.tenantId}`}#${domainIndex}`,
      });
    }
  } catch (err) {
    if (err instanceof CapacityPendingError) {
      // G2/G4 graceful back-pressure — NOT a failure. withSpendCeiling already
      // set the tenant's capacity_pending marker, released the reservation, and
      // fired the one-shot founder alert. Return the job normally (never a 500):
      // the account surfaces capacity_pending via G3, and a later provision
      // retries once the founder raises the ceiling / upgrades the plan. Any
      // domains/mailboxes provisioned before the gate stay provisioned.
      // Sync the meter to the rows that actually landed (design §7 N1 — a
      // partially-failed batch bills only what came up, floored at 5). The
      // billing projection reflects REALITY (what landed), not the ask.
      await syncMailboxQuantity(ctx);
      return { jobId: newId("job"), billing: buildMailboxBilling(ctx, liveProvisioned()) };
    }
    if (err instanceof RegistrarUnarmedError) {
      await alertRegistrarUnarmed(ctx, input.primaryDomain, err, mailer);
    }
    throw err;
  }

  // Mirror the Stripe mailbox quantity to the now-higher provisioned count
  // (design §2/§9 — a provision raises the count, increases prorate). No-op
  // unless active with a real Stripe subscription (syncMailboxQuantity guards).
  await syncMailboxQuantity(ctx);
  // SPEC §18 — return the new count + projected monthly on the add (no silent
  // capacity addition); computed from the REAL post-provision count.
  return { jobId: newId("job"), billing: buildMailboxBilling(ctx, liveProvisioned()) };
}

export interface MailboxHealthReport {
  email: string;
  domain: string;
  status: string;
  warmupDay: number;
  dailyCap: number;
  sentToday: number;
  sendReady: boolean;
  // B6 deliverability signals surfaced so the customer's agent can see the
  // control loop working: our own throttle/pause state + observed first-party
  // rates (fractions, 0-1) + the vendor-reported reputation/placement.
  delivStatus: string;
  sends: number;
  complaintRate: number;
  bounceRate: number;
  /** Soft (transient 4.x.x) bounce fraction — visible here but never triggers pause/burn (A3). */
  softBounceRate: number;
  // Gate (d) — display honesty (adversary inboxkit-adapters-2026-07-20 finding
  // 4): these are VENDOR-REPORTED approximations (InboxKit's coarse
  // health_status enum -> a 0-100 score, and the bounce-rate complement as a
  // placement PROXY — NOT a real inbox-placement test), never first-party
  // measurements. The control loop's burn/pause decisions use local counts
  // ONLY; these two are display-only. The `vendor*` prefix carries that
  // provenance so a consuming agent never treats them as measured (the pre-fix
  // `reputationScore`/`placementRate` names read as first-party truth).
  /** H-status (pipeline F4) — 'ok' when the vendor health lookup succeeded,
   * 'unknown' when it failed for THIS mailbox. The two `vendor*` numbers below
   * are 0 and meaningless when this is 'unknown'; previously that case took the
   * whole endpoint down with a 500 instead. */
  vendorHealth: "ok" | "unknown";
  /** Why the lookup failed, for the operator. null when `vendorHealth` is 'ok'. */
  vendorHealthError: string | null;
  vendorReputationScore: number;
  vendorPlacementRate: number;
  /** SPEC.md §19.2/§19.6 [F7] — last time runPollInbox() polled this mailbox (engine/reply-processor.ts); null before the first poll. Backs the Settings→Mailboxes "last polled" UI claim. */
  lastPolledAt: number | null;
}

export interface InfrastructureStatus {
  domains: number;
  mailboxes: number;
  mailboxHealth: MailboxHealthReport[];
  sendReady: boolean;
}

export async function getInfrastructureStatus(ctx: TenantContext): Promise<InfrastructureStatus> {
  // Read-only: computes the same live warmup dailyCap/sentToday the tick
  // would persist, WITHOUT writing (MCP readOnlyHint: true — see
  // mailbox-state.ts's computeMailboxWarmupSnapshot doc). `s.warmupStatus`
  // below is already freshly computed by gatherMailboxHealth (never read
  // from the possibly-stale DB `status` column), so only dailyCap/sentToday
  // need overriding from the snapshot.
  const warmupSnapshot = computeMailboxWarmupSnapshot(ctx);
  const domainCount = ctx.sql
    .exec<{ n: number }>(`SELECT COUNT(*) as n FROM domains WHERE tenant_id = ?`, ctx.tenantId)
    .one().n;

  const signals = gatherMailboxHealth(ctx);
  const mailboxHealth: MailboxHealthReport[] = await Promise.all(
    signals.map(async (s) => {
      // Vendor-reported reputation/placement (SPEC.md §10 raw signal, Inboxkit
      // in the real adapter) — display-only, surfaced under `vendor*` names
      // (gate (d)). On-demand here, NOT on the hot tick path.
      // H-status (INCIDENT 2026-08-05, pipeline F4) — PER-MAILBOX isolation.
      // This fan-out was an unguarded Promise.all, so ONE rejection blanked the
      // whole response into a 500. `resolveMailboxUid` throws a PERMANENT
      // VendorError when the vendor has no matching mailbox — exactly what a
      // half-failed saga leaves behind — which bricked `infrastructure_status`
      // forever for that tenant, with no API path to repair it. It is the one
      // endpoint the tool description tells the agent to poll, so it must
      // degrade, never disappear: the mailbox reports vendorHealth 'unknown'
      // and the rest of the response (including every OTHER mailbox) survives.
      let vendor: MailboxHealth | null = null;
      let vendorHealthError: string | null = null;
      try {
        vendor = await ctx.adapters.mailbox.getHealth(s.email);
      } catch (err) {
        vendorHealthError = err instanceof Error ? err.message : String(err);
      }
      const snapshot = warmupSnapshot.get(s.mailboxId);
      return {
        email: s.email,
        domain: s.domain,
        status: s.warmupStatus,
        warmupDay: s.warmupDay,
        dailyCap: snapshot?.dailyCap ?? s.dailyCap,
        sentToday: snapshot?.sentToday ?? s.sentToday,
        sendReady: s.sendReady,
        delivStatus: s.delivStatus,
        sends: s.sends,
        complaintRate: s.complaintRate,
        bounceRate: s.bounceRate,
        softBounceRate: s.softBounceRate,
        // 'ok' | 'unknown' — whether the VENDOR-reported pair below could be
        // fetched at all. Distinguishes "the vendor says 0" from "we could not
        // ask", which the previous 0-or-500 shape could not express.
        vendorHealth: vendor ? ("ok" as const) : ("unknown" as const),
        vendorHealthError,
        vendorReputationScore: vendor?.reputationScore ?? 0,
        vendorPlacementRate: vendor?.placementRate ?? 0,
        lastPolledAt: s.lastPolledAt,
      };
    }),
  );
  // Operator-visible, once per degraded mailbox per call: a permanently-failing
  // health lookup usually means a local row with no vendor counterpart, which
  // is a saga remnant someone has to reconcile.
  for (const report of mailboxHealth) {
    if (report.vendorHealth === "unknown") {
      logAction(ctx, "MAILBOX_HEALTH_UNAVAILABLE", report.email, { reason: report.vendorHealthError });
    }
  }

  return {
    domains: domainCount,
    mailboxes: mailboxHealth.length,
    mailboxHealth,
    // Send-readiness ignores paused/throttled state (it's a warmup concept);
    // a paused mailbox still counts as warmed. delivStatus surfaces the pause.
    sendReady: mailboxHealth.length > 0 && mailboxHealth.every((m) => m.sendReady),
  };
}
