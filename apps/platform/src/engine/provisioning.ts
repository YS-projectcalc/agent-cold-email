import {
  CapacityPendingError,
  isPaidPlan,
  RegistrarUnarmedError,
  resolveDistribution,
  ValidationError,
  VendorError,
  type LookalikeCandidate,
  type OwnedDomain,
  type PurchasedDomain,
  type NextSteps,
  type SetupInfrastructureInput,
} from "@coldstart/shared";
import { newId } from "../schema.js";
import { domainOrdinalFailedCheckName } from "../admin/watchtower.js";
import { logAction } from "./deliverability-actions.js";
import { alertIsolatedFailures } from "./isolated-failure-alerts.js";
import { createOpsMailer, type OpsMailer } from "../ops-mail/ops-mailer.js";
import type { TenantContext } from "../tenant-context.js";
import { customerSafeVendorDetail, customerSafeVendorFailure, logVendorFailure } from "../vendor-failure.js";
import { buildMailboxBilling, syncMailboxQuantity, type MailboxBilling } from "./billing.js";
import { assertNotLifecycleFrozen } from "./billing-state.js";
import { assertBrandOwnership } from "./brand-guard.js";
import { DomainPropagationPendingError, setDnsWithRetry } from "./domain-dns.js";
import { forEachIsolated } from "../isolated-loop.js";
import { provisionMailboxesForDomain } from "./mailbox-provisioning.js";
import { deriveNextSteps } from "./next-steps.js";
import { planFor, readProvisioningSnapshot, slugify } from "./provisioning-plan.js";
import { domainIntentKey, markDomainIntent, recordDomainIntent, type DomainIntentRow } from "./provision-intents.js";
import { assertWithinProvisioningCap } from "./quota.js";
import { screenTenant } from "../ofac/screening.js";
import { alertRegistrarUnarmed } from "./registrar-alert.js";
import { retrySetupMessageBody, setupFailedMessageBody, setupHeldMessageBody } from "./retry-setup-message.js";
import { withSpendCeiling } from "./spend-ceiling.js";
import { emitTenantMessage } from "./tenant-messages.js";
import { RealInboxKitDomainPort } from "../vendors/real/inboxkit-domain-port.js";
import { assertCompleteRegistrant, readRegistrarOptInState } from "../vendors/registrar-arming.js";

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

/**
 * The live domain a COMMITTED intent already resolved to, or undefined.
 *
 * The SAGA's own resume check, deliberately not the planner's: it needs
 * `dns_status` to decide whether the resume still owes a nameserver re-drive,
 * which is a per-ordinal fact about work in flight rather than part of the
 * read-once planning snapshot (engine/provisioning-plan.ts).
 */
function liveDomainForIntent(
  ctx: TenantContext,
  intent: DomainIntentRow,
): { id: string; domain: string; dns_status: string } | undefined {
  if (intent.status !== "committed") return undefined;
  return ctx.sql
    .exec<{ id: string; domain: string; dns_status: string }>(
      `SELECT id, domain, dns_status FROM domains WHERE tenant_id = ? AND domain = ? AND status != 'released' LIMIT 1`,
      ctx.tenantId,
      intent.candidate_domain,
    )
    .toArray()[0];
}

/**
 * H3 — is this candidate already ours to adopt? Adoptable means the vendor
 * account owns it, it is ACTIVE, it has NO mailboxes attached, and no live
 * `domains` row already claims it for this tenant.
 *
 * A LISTING FAILURE THROWS. It used to be swallowed to `null`, on the argument
 * that a vendor hiccup while asking must not fail a first-time provision and
 * that the cost was "a repeat buy the vendor itself rejects". Both halves are
 * wrong (class E member E4, docs/adversarial/
 * class-sweep-vendor-truth-2026-08-18.md): `null` means "nothing to adopt", and
 * the caller reads that as authorization to proceed to `domain.buy` — a
 * registrar purchase. A pre-check that COULD NOT COMPLETE was authorizing the
 * billed effect it exists to prevent. And the vendor's response to a duplicate
 * registration is not known to be a rejection; if it is, the cost is a permanent
 * failure at a worse moment, and if it is not, it is a second $12.50 domain.
 *
 * Two sibling paths already refuse exactly this fold and say so: the mailbox
 * warmup lookup ("`inconclusive` is deliberately NOT folded into `absent`") and
 * `confirmVendorOwnership` ("it cannot be asked -> retry later, spend nothing").
 * This is the third. The error keeps the ADAPTER's own grade rather than being
 * re-graded here — `/domains/list`'s body-level failure is already retryable and
 * its page-ceiling failure already permanent — the same discipline
 * `searchLookalikes` follows when it re-throws its first failure.
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
    // The raw failure goes to the Worker log (operators only); the activity row
    // a customer can read back carries the ABSTRACT step + retryability instead
    // of the adapter's text, which names the provider and its endpoints.
    logVendorFailure(`listOwnedDomains ${candidate}`, err);
    logAction(
      ctx,
      "DOMAIN_ADOPT_LOOKUP_FAILED",
      candidate,
      customerSafeVendorDetail(err, "could not check which domains this account already holds — NO purchase was attempted"),
    );
    throw err;
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

/**
 * Provisions ONE domain + its mailboxes: buy → DNS → insert domain row → for
 * each mailbox provision + startWarmup + insert mailbox row (+ per-mailbox/mo
 * metering on paid tiers). The single implementation shared by
 * setup_infrastructure (initial provisioning) and the deliverability control
 * loop's REPLACE_DOMAIN (burn replacement) — CLAUDE.md rule c (no duplicated
 * logic). The DOMAIN-leg idempotency keys are namespaced by `domainKey`
 * (`domain#index`) so distinct domains never collide; the per-mailbox keys are
 * address-derived (engine/mailbox-provisioning.ts).
 */
export async function provisionDomainWithMailboxes(
  ctx: TenantContext,
  opts: {
    domain: string;
    domainIndex: number;
    personaSlug: string;
    inboxesEach: number;
    intentKey: string;
    // N2 (gate 2026-08-05, wire-A F1 fix) — fired the instant the domain THIS
    // call is actually going to operate on is known (the resume branch's
    // `existing.domain`, or the buy/adopt branch's `purchased.domain`), before
    // any operation past that point can throw. Lets the caller's wire-A
    // catch name the REAL domain instead of `opts.domain` — which, on a
    // resume, is a fresh unrelated candidate this call never touches.
    onDomainResolved?: (domain: string) => void;
  },
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
  //
  // C3 part d — the desired provisioning spec (persona + mailbox count) rides
  // along, INSERT-only, so the out-of-band reconcile sweep can finish this
  // ordinal with the SAME persona/count this call used. Both setup and the
  // REPLACE_DOMAIN burn path reach here with their own opts, so both stamp their
  // spec; the reconcile keys off the ordinal derivation and never touches a
  // `replace:` row.
  const intent = recordDomainIntent(ctx, opts.intentKey, opts.domain, {
    personaSlug: opts.personaSlug,
    inboxesEach: opts.inboxesEach,
  });

  // This ORDINAL is already done. The intent key is the tenant + ordinal
  // (provision-intents.ts's domainIntentKey), so ANY repeat of a setup call —
  // keyed, unkeyed, or re-keyed — resolves to the intent the first call
  // committed. A repeat is indistinguishable from a retry, so it must CONVERGE:
  // return the domain we already have rather than buy another one. (H3b's
  // dedupe hands us a fresh candidate by then, which is why this check is on
  // the INTENT's recorded name, not on `opts.domain`.) A caller who genuinely
  // wants a second domain raises `domains`, which reaches a HIGHER ordinal with
  // no committed intent and falls through to the normal buy below.
  const existing = liveDomainForIntent(ctx, intent);
  if (existing) {
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
    // N2 — this call operates on `existing.domain` (the intent-resolved name),
    // NEVER on `opts.domain` (this call's fresh candidate) — report it before
    // the one operation below that can throw retryably.
    opts.onDomainResolved?.(existing.domain);
    if (existing.dns_status !== "ready") {
      await setDnsWithRetry(ctx, existing.domain, `dns:${ctx.tenantId}:${existing.domain}#${opts.domainIndex}`, existing.id);
    }
    const mailboxEmails = await provisionMailboxesForDomain(ctx, {
      domainId: existing.id,
      domain: existing.domain,
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
    // The adopted domain's connection type comes from the VENDOR's own listing —
    // the discriminator that decides which DNS operation applies to it. An
    // adopted domain is the one case where it is genuinely not implied by how we
    // acquired it, which is exactly why it has to be carried rather than assumed.
    purchased = {
      domain: adopted.domain,
      purchasedAt: ctx.clock.now(),
      registrar: "adopted",
      connectionType: adopted.connectionType,
    };
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

  // N2 — `purchased.domain` is now the resource genuinely acquired this call
  // (bought or adopted); report it before setDnsWithRetry below, the next
  // operation that can throw retryably.
  opts.onDomainResolved?.(purchased.domain);

  // H2 — PERSIST THE INSTANT IT IS OURS, before any DNS work. This INSERT used
  // to sit AFTER setDns, so a setDns throw discarded a domain we had already
  // paid for. dns_status starts 'pending' and is flipped below.
  const domainId = newId("dom");
  ctx.sql.exec(
    // connection_type is recorded HERE, at the moment of acquisition, because it
    // is the only moment we know it for free — and without it in the row, even
    // fixed adapter code has nothing to branch on when a later retry re-drives
    // DNS (INCIDENT 2026-08-05, the enabler half of the root cause).
    `INSERT INTO domains (id, tenant_id, domain, status, purchased_at, dns_status, connection_type)
     VALUES (?, ?, ?, 'active', ?, 'pending', ?)`,
    domainId,
    ctx.tenantId,
    purchased.domain,
    purchased.purchasedAt,
    purchased.connectionType,
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
    domainOrdinal: opts.domainIndex,
    personaSlug: opts.personaSlug,
    inboxesEach: opts.inboxesEach,
  });

  return { domainId, domain: purchased.domain, mailboxEmails };
}

/**
 * `provisioning` NAMES A STATE THAT STILL OWES WORK, and it exists for no other
 * reason (docs/adversarial/class-sweep-cached-terminal-2026-08-17.md member 3).
 * A completed provision omits it; every value it can take means "returned, not
 * finished". That is what lets `isSetupProvisioningIncomplete` below test for
 * the field's PRESENCE rather than enumerate values — a future non-terminal
 * outcome is covered the moment it is added to this union, which is the
 * opposite of the hardcoded-allowlist failure the sweeps keep finding. A future
 * TERMINAL outcome must therefore not be spelled here.
 *
 * `capacity_pending` was the class's worst payload precisely because it was
 * absent: the back-pressure return handed back the FULL-SUCCESS shape
 * `{jobId, billing}` with no discriminator at all, so neither the customer nor
 * the replay layer could tell a held provision from a completed one.
 */
export type SetupInfrastructureRunResult =
  | {
      jobId: string;
      billing: MailboxBilling;
      provisioning?: "pending" | "capacity_pending";
      pendingDomain?: string;
      /**
       * ORTHOGONAL METADATA, present on terminal and non-terminal outcomes
       * alike, and deliberately NOT spelled into the `provisioning` union above:
       * `isSetupProvisioningIncomplete` tests that field's PRESENCE, so a
       * terminal response carrying `nextSteps` must still classify complete
       * (test/next-steps-surfaces.test.ts pins it).
       */
      nextSteps?: NextSteps;
    }
  | { quoteOnly: true; billing: MailboxBilling; nextSteps?: NextSteps };

/**
 * Does a RECORDED `runSetupInfrastructure` outcome still owe work?
 *
 * Used by engine/setup-terminality.ts to classify this saga's outcome for the
 * request-replay layer — see that file and `withRequestIdempotency`'s class doc
 * for why recording an unfinished outcome as replayable was F1.
 *
 * It lives HERE, next to the branches that produce the shapes, on purpose: a
 * predicate parked at the call site would silently go stale the day this saga
 * grows another "accepted, not finished" return. Total by construction — it is
 * also handed a `JSON.parse` of a row that may predate the current result type.
 */
export function isSetupProvisioningIncomplete(result: SetupInfrastructureRunResult): boolean {
  return (
    typeof result === "object" &&
    result !== null &&
    "provisioning" in result &&
    result.provisioning !== undefined
  );
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
  // The caller's request idempotency key. It governs RESPONSE REPLAY only
  // (TenantDO.setupInfrastructure's withRequestIdempotency) and is threaded in
  // here solely so a retry_setup message can tell the agent which key to resend.
  // It deliberately has NO say in what gets bought — see domainIntentKey.
  setupKey?: string,
): Promise<SetupInfrastructureRunResult> {
  // Lifecycle freeze — BEFORE any spend. A suspended/disputed/canceled tenant
  // must not provision fresh infra (real registrar/mailbox spend at activation
  // on an account we deliberately froze — adversarial panel-03 finding #5).
  assertNotLifecycleFrozen(ctx, "setup_infrastructure");

  // Lookalike third-party-brand hard-reject — BEFORE any searchLookalikes/buy
  // (ARCHITECTURE.md #8 "enforced in code"). Throws ValidationError -> HTTP 400.
  assertBrandOwnership({ brand: input.brand, primaryDomain: input.primaryDomain });

  // What this call would actually acquire, given the ordinals already committed.
  // Every guard below is sized against THIS, not the raw ask, so a retry — which
  // acquires nothing — passes them all. The SAME planner the recommendation
  // dry-runs (engine/provisioning-plan.ts), so a suggested call and the call
  // that executes it can never disagree about what it buys.
  const distribution = resolveDistribution(input);
  const plan = planFor(readProvisioningSnapshot(ctx), { persona: input.persona, distribution });

  // Plan quota / provisioning-cap guard (B1 brief) — BEFORE any spend.
  assertWithinProvisioningCap(ctx, { domains: plan.newDomains, mailboxes: plan.newMailboxes });

  // The live provisioned mailbox count (the billing meter) — read for the
  // in-response billing projection (SPEC §18 "no silent capacity addition").
  const liveProvisioned = (): number =>
    ctx.sql.exec<{ n: number }>(`SELECT COUNT(*) as n FROM mailboxes WHERE tenant_id = ? AND released_at IS NULL`, ctx.tenantId).one().n;

  // Quote-before-add PREVIEW (design §2): return the PROJECTED new count +
  // monthly WITHOUT provisioning or mutating the profile — the request is fully
  // validated above so the projection reflects a genuinely-acceptable request.
  if (input.quoteOnly) {
    return {
      quoteOnly: true,
      billing: buildMailboxBilling(ctx, liveProvisioned() + plan.newMailboxes),
      nextSteps: deriveNextSteps(ctx),
    };
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
    // the domain count guaranteed that a second call regenerated the domain the
    // first call already bought (Mordy's call 2, a certain failure). Same
    // over-request the burn-replacement picker already does
    // (deliverability-actions.ts's pickReplacementDomain) — this path simply
    // never had it.
    candidates = await ctx.adapters.domain.searchLookalikes(
      input.brand,
      input.primaryDomain,
      distribution.length + ownedDomainNames(ctx).size + CANDIDATE_BUFFER,
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
    if (input.registerDomains && input.registrant === undefined) {
      // OPTING IN WITHOUT RE-SENDING THE REGISTRANT (the §7.8 relaxation). The
      // call expressed an opinion about CONSENT and none about the registrant,
      // so only consent moves — H8b's own reasoning, one field over. Writing
      // NULL here would erase the registrant this call is relying on the engine
      // to re-derive, and the very next `assertCompleteRegistrant` would 400 on
      // a tenant whose registrant is on file. The pairing invariant survives:
      // the two columns can only drift apart in the direction "consent given,
      // registrant already on file", which is exactly the state the buy-site
      // completeness check exists to validate.
      ctx.sql.exec(`UPDATE tenant_profile SET register_domains = 1 WHERE id = ?`, ctx.tenantId);
    } else {
      ctx.sql.exec(
        `UPDATE tenant_profile SET register_domains = ?, registrant_json = ? WHERE id = ?`,
        // G5 gate (a) follow-up — the tenant's PER-TENANT, PERSISTED consent to
        // real domain purchases (founder ruling 2026-07-21: "per-tenant opt-in
        // only, never a default"). Governs the deliverability control loop's
        // REPLACE_DOMAIN burn-replacement buys too (vendors/registrar-arming.ts).
        input.registerDomains ? 1 : 0,
        // The structured registrant-of-record, written alongside the consent it
        // was captured with. A revocation still clears it, unchanged.
        input.registrant ? JSON.stringify(input.registrant) : null,
        ctx.tenantId,
      );
    }
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
  // Candidates whose adopt check could not COMPLETE (E4). Kept apart from both
  // answers on purpose: "we could not learn whether we already own this name" is
  // neither "adoptable" nor "safe to buy", and collapsing it into the latter is
  // the defect — the filter below would pass it straight to `domain.buy`.
  const unclassified = new Map<string, unknown>();
  for (const candidate of candidates) {
    if (owned.has(candidate.domain.toLowerCase())) continue; // already ours locally
    try {
      const match = await findAdoptableDomain(ctx, candidate.domain);
      if (match) adoptable.set(candidate.domain.toLowerCase(), match);
    } catch (err) {
      // Per-candidate, NOT per-call. Failing the whole plan here would stop a
      // call that needs to buy NOTHING — a tenant whose domains are already
      // provisioned and only needs its DNS leg finished — every time
      // /domains/list has a bad minute. The name is dropped from the usable set
      // instead, so it can never be bought unchecked, and the error is re-raised
      // below only if the plan actually comes up short without it.
      unclassified.set(candidate.domain.toLowerCase(), err);
    }
  }

  // Usable = adoptable (recover it, zero spend) OR genuinely buyable (available,
  // not already ours, AND classifiable). Adoptable names are rescued from the
  // filter that would otherwise drop them for being unavailable.
  const usable = candidates.filter(
    (c) =>
      adoptable.has(c.domain.toLowerCase()) ||
      (c.available !== false && !owned.has(c.domain.toLowerCase()) && !unclassified.has(c.domain.toLowerCase())),
  );
  // Only the SHORTFALL needs a fresh name. Requiring `input.domains` of them
  // made a retry depend on the vendor still having lookalikes to sell for
  // domains the tenant already owns — so a converging call that needed to buy
  // nothing could still 400 (BLOCKING-1's second half).
  const fresh = usable.map((c) => c.domain);
  const noCandidates = (): never => {
    // The shortfall is unmet BECAUSE we could not ask the vendor, not because
    // the names were unsuitable (E4). Re-throw the lookup failure so it keeps
    // its own grade and its own truth — a retryable "we could not check" instead
    // of a ValidationError blaming the customer's brand for our vendor's outage.
    // Same discipline as searchLookalikes' every-probe-failed re-throw.
    const firstUnclassified = unclassified.values().next();
    if (!firstUnclassified.done) throw firstUnclassified.value;
    // Deliberately a hard, structured stop rather than the old positional
    // `candidates[i % candidates.length]` wraparound, which silently bought the
    // SAME domain repeatedly within one call at domains >= 6.
    throw new ValidationError(
      `could not find ${plan.newDomains} available lookalike domain(s) for "${input.brand}" that this account does not already own (found ${fresh.length}). Try a different brand/primary domain, or request fewer domains.`,
    );
  };
  if (fresh.length < plan.newDomains) noCandidates();

  const personaSlug = slugify(input.persona);

  // Each ordinal's target domain, resolved BEFORE the loop. A satisfied ordinal
  // names the domain it already resolved to; every other one consumes the next
  // fresh candidate. Indexing `usable` by the ordinal instead would skip a buy
  // whenever an earlier ordinal was already satisfied — a silent partial
  // provision under a 202.
  //
  // Resolved out here, not inside the isolated body below, because running out
  // of candidates is a condition of the CALL (nothing left to hand any ordinal),
  // not a failure of one ordinal — so it propagates exactly as it always did.
  const ordinals: { domainIndex: number; domain: string; inboxesEach: number }[] = [];
  for (let domainIndex = 0; domainIndex < distribution.length; domainIndex++) {
    ordinals.push({
      domainIndex,
      domain: plan.satisfied.get(domainIndex)?.domain ?? fresh.shift() ?? noCandidates(),
      // Per-ordinal, from the resolved distribution — a uniform `inboxesEach`
      // is simply the distribution every element of which is equal.
      inboxesEach: distribution[domainIndex] as number,
    });
  }

  // Wire point A (system->agent message channel, increment 1) + N2 (gate
  // 2026-08-05, F1) — the domain each ordinal ACTUALLY operated on, so a failure
  // report names the real resource. A fresh candidate is only a correct guess
  // for an ordinal nothing has committed yet: on a resume,
  // provisionDomainWithMailboxes works on the intent-resolved domain, which can
  // differ from whatever name was passed in, and `onDomainResolved` corrects
  // this map the instant the real one is known.
  const inFlightByOrdinal = new Map<number, string>();

  // HEAD-OF-LINE BLOCKING (class sweep 2026-08-17, IN-1 — the confirmed
  // instance). This loop had no per-item isolation, and its item list is
  // re-derived identically on every call (domainIntentKey is tenant + ordinal),
  // so ONE permanently-dead ordinal did not merely fail itself: it denied
  // service to every ordinal behind it on every retry, forever, while the tenant
  // paid the platform fee and the minimum-5 mailbox floor for zero working
  // mailboxes. The ordinals are INDEPENDENTLY COMPLETABLE — separate domains,
  // separate intents, separate spend — so nothing but the loop shape ever tied
  // them together.
  const outcome = await forEachIsolated(
    ordinals,
    async ({ domainIndex, domain, inboxesEach }) => {
      inFlightByOrdinal.set(domainIndex, domain);
      await provisionDomainWithMailboxes(ctx, {
        domain,
        domainIndex,
        personaSlug,
        inboxesEach,
        // The intent key — tenant + ordinal, never the caller's key and never
        // the candidate name: a retry has to resolve to the same intent row even
        // if candidate generation changes, which is the whole point of recording
        // the resolved name rather than deriving it. See domainIntentKey.
        intentKey: domainIntentKey(ctx.tenantId, domainIndex),
        onDomainResolved: (resolved) => inFlightByOrdinal.set(domainIndex, resolved),
      });
    },
    {
      onItemError: ({ item, error }) => {
        // The raw failure goes to the Worker log (operators only); the activity
        // row a customer can read back carries the ABSTRACT step instead. This
        // row is what makes the isolation itself legible: without it a reader
        // sees one ordinal's failure and another's success and cannot tell
        // whether the call gave up at the first or carried on past it.
        logVendorFailure(`setup ordinal ${item.domainIndex}`, error);
        logAction(
          ctx,
          "DOMAIN_ORDINAL_FAILED",
          inFlightByOrdinal.get(item.domainIndex) ?? item.domain,
          customerSafeVendorDetail(error, "this domain could not be completed — the remaining domains were still attempted", {
            ordinal: item.domainIndex,
          }),
        );
      },
      // TENANT-GLOBAL conditions, not this ordinal's fault: the spend ceiling
      // and an unarmed registrar reject every remaining ordinal identically, so
      // continuing would only burn reservations and re-fire one-shot alerts.
      abortOn: (err) => err instanceof CapacityPendingError || err instanceof RegistrarUnarmedError,
    },
  );

  // The meter reflects what ACTUALLY landed, on every path — a partially-failed
  // batch bills only what came up (design §7 N1). Before isolation this only
  // mattered for the CapacityPending branch, because a throw meant nothing after
  // the failing ordinal existed; now a failed call can leave real mailboxes
  // behind, so the sync has to happen before we report the failure. Its own
  // failure must never REPLACE the vendor error the caller needs to see.
  try {
    await syncMailboxQuantity(ctx);
  } catch (syncErr) {
    console.error(`setup_infrastructure: mailbox quantity sync failed for tenant ${ctx.tenantId}`, syncErr);
  }

  // THE OPS-SIDE PATH (wave-1-2 integration gate §6). Exactly one of these
  // failures reaches the caller below; every other isolated ordinal was
  // previously recorded in the customer's activity feed and nowhere an operator
  // reads. A half-completed ordinal is a PAID domain with no working mail
  // infrastructure on it. The aborting failure is skipped by
  // `alertIsolatedFailures` — a spend-ceiling breach and an unarmed registrar
  // are tenant-global and already have their own one-shot alerts.
  await alertIsolatedFailures(ctx, outcome, {
    checkName: (item) => domainOrdinalFailedCheckName(inFlightByOrdinal.get(item.domainIndex) ?? item.domain),
    // A domain NAME on record for this ordinal means it was actually bought, so
    // the money is out and nothing is behind it — a replacement job for a human.
    // Without one the setup threw before buying anything, which a retry fixes.
    materiality: ({ item }) => (inFlightByOrdinal.has(item.domainIndex) ? "paid_no_infra" : "setup_threw"),
    detail: (item) =>
      `domain setup for ordinal ${item.domainIndex} (${inFlightByOrdinal.get(item.domainIndex) ?? item.domain}) could not be completed. ` +
      `The other ordinals were still attempted. If the domain was already bought, it is paid for with no working mail on it until this is finished by hand.`,
  });

  // Report the ABORT CAUSE over an earlier ordinal's ordinary failure
  // (2026-08-18 fix, symmetric with mailbox-provisioning.ts's per-slot loop —
  // see its doc comment). A spend-ceiling/registrar-unarmed breach (abortOn)
  // is TENANT-GLOBAL and must never be eclipsed by an earlier ordinal's
  // unrelated failure just because that one happened first in `failures`.
  const reportedFailure = outcome.abortedAt ?? outcome.failures[0];
  if (reportedFailure) {
    // Absent an abort, the FIRST failure in ordinal order is what the call
    // reports — deterministic, and it is the head item the class is named
    // for. A later ordinal's failure surfaces on the retry that clears this
    // one.
    const err = reportedFailure.error;
    const inFlightDomain = inFlightByOrdinal.get(reportedFailure.item.domainIndex);
    if (err instanceof CapacityPendingError) {
      // G2/G4 graceful back-pressure — NOT a failure. withSpendCeiling already
      // set the tenant's capacity_pending marker, released the reservation, and
      // fired the one-shot founder alert. Return the job normally (never a 500):
      // the account surfaces capacity_pending via G3, and a later provision
      // retries once the founder raises the ceiling / upgrades the plan. Any
      // domains/mailboxes provisioned before the gate stay provisioned. The
      // meter was already synced to the rows that actually landed above (design
      // §7 N1 — a partially-failed batch bills only what came up, floored at 5),
      // so the billing projection reflects REALITY (what landed), not the ask.
      //
      // `provisioning: "capacity_pending"` is what makes this outcome legible —
      // to the agent AND to the replay layer (cached-terminal member 3). Without
      // it this returned the same `{jobId, billing}` a completed provision does,
      // so the recorded response was frozen as an ordinary success: the founder
      // raised the ceiling, the agent retried with its key, and the stale
      // success replayed while nothing provisioned. spend-ceiling.ts's own
      // docblock asserted the opposite ("a retry after the founder raises the
      // ceiling re-runs cleanly") — true for the inner per-mailbox wrapper it
      // was written about, false for this outer one, which caught the throw.
      return {
        jobId: newId("job"),
        billing: buildMailboxBilling(ctx, liveProvisioned()),
        provisioning: "capacity_pending",
        nextSteps: deriveNextSteps(ctx),
      };
    }
    if (err instanceof RegistrarUnarmedError) {
      await alertRegistrarUnarmed(ctx, input.primaryDomain, err, mailer);
    }
    // C3 part b — SUCCESS-PENDING, not an error. The ONLY thing this call still
    // owes is freshly-bought purchased domains finishing their ~32s async DNS
    // registration (DomainPropagationPendingError, engine/domain-dns.ts) — so
    // every other ordinal fully provisioned and nothing but propagation remains.
    // Those domains are bought, recorded, and heal on their own; a retry
    // (informational, below) or the provisioning-reconcile sweep completes the
    // mailboxes. Returning the job (202, async-in-progress) rather than throwing
    // is the async-request-reply contract: "in progress" must never read to the
    // agent as a failure.
    //
    // THE DISCRIMINATOR CHANGED WITH ISOLATION, and had to. It used to be "the
    // failing ordinal is the LAST one", which was a proxy for "nothing else is
    // outstanding" that only held because the loop aborted at the first failure
    // (every ordinal before it had necessarily succeeded, and the ones after it
    // did not exist yet). Now that later ordinals are genuinely attempted, that
    // proxy is false in both directions, so the condition says what it always
    // meant: EVERY outstanding item is a benign propagation wait. A pending wait
    // alongside any other kind of failure still falls through to the retryable
    // path below — the agent genuinely has to retry.
    if (outcome.failures.every((f) => f.error instanceof DomainPropagationPendingError)) {
      const { step } = customerSafeVendorFailure(err);
      // The SAME retry_setup channel, but INFORMATIONAL: nothing is required of
      // the agent (the wait completes automatically), so the message is a status
      // note, not an action item. Its body still names a same-key retry as the
      // manual way to finish, for an agent that would rather not wait — but the
      // severity says it need not.
      emitTenantMessage(ctx, {
        kind: "retry_setup",
        severity: "info",
        body: retrySetupMessageBody(inFlightDomain, step),
        actionHint: { tool: "setup_infrastructure", idempotencyKey: setupKey ?? null },
        // OUTCOME-SCOPED, not just domain-scoped (docs/adversarial/
        // class-sweep-dedup-semantics-2026-08-17.md IN-6). Both retry_setup
        // emits used to key on the bare domain, so this INFORMATIONAL note
        // overwrote an unread 'action_required' one IN PLACE — same row, same
        // kind, severity silently downgraded, body replaced. An agent polling
        // messages[] then read "nothing needed" where an action item had
        // stood. Two different outcomes are two different conditions and get
        // two different rows; each still refreshes its own on re-trigger, so
        // the no-spam guarantee is unchanged.
        dedupKey: `pending:${inFlightDomain ?? `tenant:${ctx.tenantId}`}`,
      });
      return {
        jobId: newId("job"),
        billing: buildMailboxBilling(ctx, liveProvisioned()),
        provisioning: "pending",
        pendingDomain: inFlightDomain ?? "",
        nextSteps: deriveNextSteps(ctx),
      };
    }
    // Wire point A — a RETRYABLE VendorError here is H2's exact shape
    // (setDnsWithRetry / awaitMailboxReady exhausted its in-call backoff):
    // the domain is bought and recorded, nothing was lost, and the caller's
    // OWN error text already says so — but until now that only reached a
    // human via a relayed alert. Surface it directly to the agent instead.
    // Deliberately composed prose, never `err.message` (GUARDRAIL B — the
    // vendor error can carry upstream detail this message must not repeat).
    //
    // Gate finding #2 (docs/adversarial/wave-integration-gate-2026-08-05.md):
    // more than one leg inside the try above can throw a retryable
    // VendorError (DNS, mailbox purchase), so the prose must be STEP-AWARE —
    // derived from the SAME `customerSafeVendorFailure` classification the
    // REST error body (error-response.ts) uses, so the two customer surfaces
    // can never disagree on which step failed.
    if (err instanceof VendorError && err.retryable) {
      const { step } = customerSafeVendorFailure(err);
      emitTenantMessage(ctx, {
        kind: "retry_setup",
        severity: "action_required",
        body: retrySetupMessageBody(inFlightDomain, step),
        actionHint: { tool: "setup_infrastructure", idempotencyKey: setupKey ?? null },
        // See the sibling emit above: the outcome is part of the row's
        // identity, so an informational propagation note can never overwrite
        // this action item in place.
        dedupKey: `retry:${inFlightDomain ?? `tenant:${ctx.tenantId}`}`,
      });
    } else if (err instanceof VendorError) {
      // F3 (docs/adversarial/agent-channel-product-audit-2026-08-17.md) — the
      // give-up was the ONE outcome with no durable signal. The retryable
      // branch above emitted, the 202 branch above emitted, and the single
      // outcome that actually REQUIRES a human reached the agent only as the
      // HTTP body of the one call that produced it: an agent that had already
      // stopped polling, or whose session ended, never learned its paid domain
      // was dead. Non-retryable is exactly the case that must survive the
      // response.
      //
      // Scoped to VendorError (not every throw) deliberately: a ValidationError
      // is the caller's own input and is answered by the 400 it gets, while a
      // non-retryable VendorError means WE stopped — a dead registration
      // (domain-dns.ts's failTerminal), a permanently rejected DNS setup, an
      // unarmed registrar. All of them share one recovery, and it is not a
      // retry. Composed prose only, never `err.message` (GUARDRAIL B): these
      // errors carry registrar/env detail no customer surface may repeat.
      const { step } = customerSafeVendorFailure(err);
      // OPERATOR-CLEARABLE vs GENUINELY DEAD (class A, docs/adversarial/
      // class-sweep-vendor-truth-2026-08-18.md). Both stop the saga, and until
      // now both wrote the same 'terminal' row — so an empty provider wallet,
      // which a top-up clears in a minute, was recorded and reported exactly
      // like a dead paid domain that no retry will ever revive. The agent that
      // read it did the right thing with the wrong fact and stopped for good.
      //
      // Same `kind` and same `dedupKey` on both branches, deliberately: they
      // are two states of ONE condition (this domain's setup stopped), so the
      // emit helper REFRESHES the single row in place when the outcome changes
      // — a held setup that later dies replaces its own message rather than
      // leaving an agent holding two contradictory ones.
      const operatorActionable = err.operatorActionable === true;
      emitTenantMessage(ctx, {
        kind: "setup_failed",
        // 'terminal', not 'action_required' (signal-inversion guard A2). The
        // emit alone was not the fix: with only two rungs, the one message
        // that means "we have stopped, retrying will never work" was
        // byte-indistinguishable to a branching agent from "retry and it will".
        severity: operatorActionable ? "operator_pending" : "terminal",
        body: operatorActionable ? setupHeldMessageBody(inFlightDomain, step) : setupFailedMessageBody(inFlightDomain, step),
        // The held branch names contact_operator FIRST (that is the channel
        // that reaches the human who can clear it) and carries the retry the
        // agent should make afterwards — with the SAME key, which is safe
        // because a throw records no outcome (idempotency.ts's Settled
        // contract). No claim is made that anyone HAS been notified: nothing on
        // this path notifies (signal-inversion guard A1).
        actionHint: operatorActionable
          ? { tool: "contact_operator", retryTool: "setup_infrastructure", idempotencyKey: setupKey ?? null }
          : { tool: "contact_operator" },
        dedupKey: `failed:${inFlightDomain ?? `tenant:${ctx.tenantId}`}`,
      });
    }
    throw err;
  }

  // SPEC §18 — return the new count + projected monthly on the add (no silent
  // capacity addition); computed from the REAL post-provision count. The Stripe
  // mailbox quantity was already mirrored to it above (design §2/§9 — a provision
  // raises the count, increases prorate).
  return { jobId: newId("job"), billing: buildMailboxBilling(ctx, liveProvisioned()), nextSteps: deriveNextSteps(ctx) };
}
