import {
  CapacityPendingError,
  isPaidPlan,
  RegistrarUnarmedError,
  ValidationError,
  VendorError,
  type LookalikeCandidate,
  type OwnedDomain,
  type PurchasedDomain,
  type SetupInfrastructureInput,
} from "@coldstart/shared";
import { newId } from "../schema.js";
import { logAction } from "./deliverability-actions.js";
import { createOpsMailer, type OpsMailer } from "../ops-mail/ops-mailer.js";
import type { TenantContext } from "../tenant-context.js";
import { customerSafeVendorDetail, customerSafeVendorFailure, logVendorFailure } from "../vendor-failure.js";
import { buildMailboxBilling, syncMailboxQuantity, type MailboxBilling } from "./billing.js";
import { assertNotLifecycleFrozen } from "./billing-state.js";
import { assertBrandOwnership } from "./brand-guard.js";
import { setDnsWithRetry } from "./domain-dns.js";
import { provisionMailboxesForDomain } from "./mailbox-provisioning.js";
import { markDomainIntent, recordDomainIntent } from "./provision-intents.js";
import { assertWithinProvisioningCap } from "./quota.js";
import { screenTenant } from "../ofac/screening.js";
import { alertRegistrarUnarmed } from "./registrar-alert.js";
import { retrySetupMessageBody } from "./retry-setup-message.js";
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

export function slugify(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 20) || "hello";
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
    // The raw failure goes to the Worker log (operators only); the activity row
    // a customer can read back carries the ABSTRACT step + retryability instead
    // of the adapter's text, which names the provider and its endpoints.
    logVendorFailure(`listOwnedDomains ${candidate}`, err);
    logAction(
      ctx,
      "DOMAIN_ADOPT_LOOKUP_FAILED",
      candidate,
      customerSafeVendorDetail(err, "could not check existing domains — continuing with a new domain purchase"),
    );
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

  // Wire point A (system->agent message channel, increment 1) — tracks which
  // domain the loop below was working on when it threw, so the catch can name
  // it in the retry_setup message without needing the error itself to carry
  // structured detail.
  let inFlightDomain: string | undefined;
  try {
    const personaSlug = slugify(input.persona);

    for (let domainIndex = 0; domainIndex < input.domains; domainIndex++) {
      const candidate = usable[domainIndex];
      if (!candidate) continue;
      inFlightDomain = candidate.domain;
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
        // N2 (gate 2026-08-05, F1) — `candidate.domain` above is only a correct
        // guess for a FIRST attempt. On a resume, provisionDomainWithMailboxes
        // actually operates on the intent-resolved domain, which can differ
        // from this call's fresh `usable[domainIndex]` candidate (the prior
        // candidate is now excluded from `usable` because it's already owned).
        // This callback corrects `inFlightDomain` to the real one the instant
        // it's known, before the catch below ever names it in a customer message.
        onDomainResolved: (domain) => {
          inFlightDomain = domain;
        },
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
        dedupKey: inFlightDomain ?? `tenant:${ctx.tenantId}`,
      });
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
