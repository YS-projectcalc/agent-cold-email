/**
 * `deriveNextSteps` — ONE derivation, THREE consumers (design §2.1, §7.2).
 *
 * Terminal responses embed it, the stuck-customer check counts its `owed`
 * steps, and the nudge renders from it. Single-sourcing is the whole answer to
 * "how does it stay TRUE by construction": there is no second copy to drift.
 *
 * THE ANTI-DRIFT RULE, and the load-bearing one: A RECOMMENDATION IS A DRY RUN,
 * NOT A SENTENCE. The `setup_infrastructure` step does not DESCRIBE what a call
 * would do — it runs the actual planner (`engine/provisioning-plan.ts`, the
 * same `planFor` the saga calls) against candidate params and reports what the
 * planner said. A recommended call the planner says buys nothing is not
 * emitted. That is what makes the claim structurally unable to lie.
 *
 * INVARIANTS THIS FILE MUST NOT LOSE (§7.16, each proven by an attack that
 * PASSED the design gate):
 *
 *   1. SYNCHRONOUS. No `await`, here or in anything this calls. DO SQLite is
 *      synchronous and the input gate opens at every await; the derivation's
 *      non-interleaving with a live saga depends on it.
 *   2. NO `ctx.sql.exec` INSIDE A CANDIDATE LOOP. Snapshot once, evaluate in
 *      memory. Also what keeps test/loop-isolation-coverage.test.ts green.
 *   3. PURE. Reads only. A dry run cannot trip or mutate a guard.
 *   4. REAL WALL-CLOCK for every bound, never `ctx.clock` (a demo tenant's
 *      VirtualClock runs up to 1440x accelerated), and every aged anchor goes
 *      through `clampedAge` (§7.19).
 *
 * AND THE SUPPRESSION RULE (§7.17.2), which is why this file is long: EVERY
 * suppression, skip and exclusion in this wave lives HERE, in the primitive
 * that feeds all three consumers. A consumer needing its own filter is the
 * signal that this file is under-specified — fix it here. That rule exists
 * because the same class has now been found on this project three times: a
 * caveat attached to one consumer of a shared primitive rather than to the
 * primitive.
 */

import {
  MAILBOXES_PER_DOMAIN,
  MAX_SELF_SERVE_MAILBOXES,
  MINIMUM_BILLABLE_MAILBOXES,
  type MailboxBilling,
  type NextStep,
  type NextStepAction,
  type NextSteps,
} from "@coldstart/shared";
import type { TenantContext } from "../tenant-context.js";
import { buildMailboxBilling } from "./billing.js";
import { isLifecycleFrozen } from "./billing-state.js";
import { clampedAge, realNowMs } from "./clamped-age.js";
import { provisioningOrphanGraceMs } from "./ops-summary.js";
import { planFor, readProvisioningSnapshot, type ProvisioningSnapshot } from "./provisioning-plan.js";

/**
 * How long a caller should wait before repeating a step's call. A DNS wait is
 * the vendor's ~32s async registration plus propagation, so the cadence is
 * minutes rather than a tight loop; everything else is actionable now.
 */
const DNS_RETRY_CADENCE_MS = 5 * 60 * 1000;

/**
 * The one message kind this wave WRITES, and therefore the one kind that must
 * never sustain the check that produces it (§7.12's R2 loop, §7.17.2's N2).
 *
 * The nudge writes a `tenant_messages` row; if that row became a
 * `message_action_required` owed step, `owedCount` would stay above zero, the
 * check would stay unhealthy, `AlertState.sinceTs` would never advance, and
 * `sinceTs > continuity_nudge_episode_ts` would never be true again — so EVERY
 * FUTURE STALL for that tenant is silently un-nudged. Worse than a storm,
 * because the un-nudged population is exactly the target one.
 *
 * The exclusion lives HERE rather than on any one consumer, because this is
 * where `owedCount` is actually sourced.
 */
const SELF_WRITTEN_MESSAGE_KINDS = new Set(["continuity_nudge"]);

/**
 * The message kinds this platform writes ABOUT PROVISIONING STATE, and can
 * therefore RE-DERIVE (BLOCKING-2, build gate 2026-08-19).
 *
 * `read_at` has exactly one writer — `ackMessage`, the CUSTOMER's call — so a
 * `retry_setup` row about a domain whose setup later FINISHED had no path to
 * stop being owed. On the one live paying tenant that made `status: "owed"`
 * permanent, suppressed `seat_headroom_free` through the E1 predicate, took the
 * stuck-customer check unhealthy on the 48h owed-age bound, and pointed the
 * one-shot nudge at a customer to say their account "has not progressed in over
 * a day" — about work that completed.
 *
 * These two kinds are the ones whose condition this same derivation ALREADY
 * computes from state, in the setup family below. Nothing else is re-derivable
 * here: an operator's reply, a credential notice or a `send_blocked` notice are
 * not things `deriveNextSteps` can check, so they keep counting until acked.
 *
 * `setup_failed` is listed for the family, not because it is reachable today:
 * `provisioning.ts` writes it at `operator_pending` or `terminal`, and the rule
 * below deliberately applies to `action_required` ONLY. It takes effect only if
 * that kind is ever written at that severity.
 */
const RE_DERIVABLE_SETUP_MESSAGE_KINDS = new Set(["retry_setup", "setup_failed"]);

/**
 * The reasons that ARE the condition those messages describe: "this account's
 * provisioning is not finished". Read off the steps the derivation already
 * built rather than re-deriving the predicate a second way — a second copy is
 * how the two come to disagree, and this file exists because that keeps
 * happening (§7.17.2).
 *
 * `billed_quantity_drift` is deliberately NOT a member: it is a Stripe push
 * that did not land, not unfinished provisioning, and a retry_setup row says
 * nothing about it.
 */
const SETUP_FAMILY_REASONS = new Set<NextStep["reason"]>([
  "paid_seats_unprovisioned",
  "ordinal_incomplete",
  "domain_dns_incomplete",
  "setup_capacity_held",
]);

/** The profile fields a `setup_infrastructure` call needs, and where each comes from. */
interface ProfileSnapshot {
  brand: string;
  primaryDomain: string;
  physicalAddress: string;
  senderIdentity: string;
  registerDomains: boolean;
  billedQuantity: number;
  provisioningState: string;
  status: string;
  billingState: string;
  /** §7.17.4 — the money-event stamp, clamped at write time (tenant-do.ts's
   *  `backfillFirstPaidAt` / billing.ts's go-forward write). NULL for a
   *  tenant that has never paid. */
  firstPaidAt: number | null;
}

interface DomainRow {
  id: string;
  domain: string;
  dnsStatus: string;
  source: string;
  byoStatus: string;
  dnsFirstCheckedAt: number | null;
}

interface MessageRow {
  id: string;
  kind: string;
  severity: string;
  createdAt: number;
}

/**
 * ONE read of each table. Every SQL statement the derivation issues is in this
 * function, so the per-reason builders below are pure functions over memory
 * (invariant 2) and a caller evaluating candidate targets never touches the DB.
 */
interface NextStepsSnapshot {
  profile: ProfileSnapshot;
  provisioning: ProvisioningSnapshot;
  domains: DomainRow[];
  billableMailboxes: number;
  messages: MessageRow[];
  pendingCredentialPushes: number;
  campaigns: number;
  realNow: number;
  orphanGraceMs: number;
  /** What the tenant HOLDS, never "does any BYO row exist" — the mixed case turns on it. */
  composition: { managedDomains: number; byoDomains: number; activeByoDomain: DomainRow | null };
}

function readNextStepsSnapshot(ctx: TenantContext): NextStepsSnapshot {
  const realNow = realNowMs();
  const profileRow = ctx.sql
    .exec<{
      brand: string;
      primary_domain: string;
      physical_address: string;
      sender_identity: string;
      register_domains: number;
      mailbox_qty_synced: number;
      provisioning_state: string;
      status: string;
      billing_state: string;
      first_paid_at: number | null;
    }>(
      `SELECT brand, primary_domain, physical_address, sender_identity, register_domains, mailbox_qty_synced,
              provisioning_state, status, billing_state, first_paid_at
       FROM tenant_profile WHERE id = ?`,
      ctx.tenantId,
    )
    .one();

  const domains = ctx.sql
    .exec<{
      id: string;
      domain: string;
      dns_status: string;
      source: string;
      byo_status: string;
      dns_first_checked_at: number | null;
    }>(
      `SELECT id, domain, dns_status, source, byo_status, dns_first_checked_at
       FROM domains WHERE tenant_id = ? AND status != 'released' ORDER BY rowid`,
      ctx.tenantId,
    )
    .toArray()
    .map((r) => ({
      id: r.id,
      domain: r.domain,
      dnsStatus: r.dns_status,
      source: r.source,
      byoStatus: r.byo_status,
      dnsFirstCheckedAt: r.dns_first_checked_at,
    }));

  const messages = ctx.sql
    .exec<{ id: string; kind: string; severity: string; created_at: number }>(
      // EXPIRY IS PART OF "UNREAD" EVERYWHERE ELSE — listSurfacedTenantMessages,
      // listMessagesPage and emitTenantMessage's dedup all carry this clause.
      // Without it here, `owedCount` counted a row no agent-facing surface
      // shows, so an operator expiring a resolved message (the gate's own
      // "cheap resolution") changed nothing about owed-ness, and the durable
      // expiry below would have been inert.
      `SELECT id, kind, severity, created_at FROM tenant_messages
       WHERE tenant_id = ? AND read_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY created_at DESC, rowid DESC`,
      ctx.tenantId,
      realNow,
    )
    .toArray()
    .map((r) => ({ id: r.id, kind: r.kind, severity: r.severity, createdAt: r.created_at }))
    // THE N2 EXCLUSION, at the one site where `owedCount` is sourced.
    .filter((m) => !SELF_WRITTEN_MESSAGE_KINDS.has(m.kind));

  const managedDomains = domains.filter((d) => d.source !== "byo");
  const byoDomains = domains.filter((d) => d.source === "byo");

  return {
    profile: {
      brand: profileRow.brand,
      primaryDomain: profileRow.primary_domain,
      physicalAddress: profileRow.physical_address,
      senderIdentity: profileRow.sender_identity,
      registerDomains: profileRow.register_domains === 1,
      billedQuantity: profileRow.mailbox_qty_synced,
      provisioningState: profileRow.provisioning_state,
      status: profileRow.status,
      billingState: profileRow.billing_state,
      firstPaidAt: profileRow.first_paid_at,
    },
    provisioning: readProvisioningSnapshot(ctx),
    domains,
    // The billing meter itself — `COUNT(*) WHERE released_at IS NULL`, the same
    // predicate engine/lifecycle.ts's billableMailboxCount uses.
    billableMailboxes: ctx.sql
      .exec<{ n: number }>(`SELECT COUNT(*) as n FROM mailboxes WHERE tenant_id = ? AND released_at IS NULL`, ctx.tenantId)
      .one().n,
    messages,
    pendingCredentialPushes: ctx.sql
      .exec<{ n: number }>(
        `SELECT COUNT(*) as n FROM mailbox_cred_pushes WHERE tenant_id = ? AND status = 'pending'`,
        ctx.tenantId,
      )
      .one().n,
    campaigns: ctx.sql.exec<{ n: number }>(`SELECT COUNT(*) as n FROM campaigns WHERE tenant_id = ?`, ctx.tenantId).one().n,
    realNow,
    orphanGraceMs: provisioningOrphanGraceMs(ctx),
    composition: {
      managedDomains: managedDomains.length,
      byoDomains: byoDomains.length,
      activeByoDomain: byoDomains.find((d) => d.byoStatus === "active") ?? null,
    },
  };
}

// ── The `setup_infrastructure` recommendation ────────────────────────────────

/**
 * The distribution that fills a tenant to `target` mailboxes, packing existing
 * ordinals to the platform's own bundling ratio before opening new ones.
 *
 * Packing existing ordinals FIRST is what makes the recommendation an exact fit
 * rather than an overshoot: a tenant billed for 5 with 2 mailboxes on ordinal 0
 * gets `[3, 2]` — ordinal 0 topped to its ratio and one new domain carrying the
 * remainder — which is 5, not the 6 that `{domains:2, inboxesEach:3}` bills.
 */
function fillDistribution(snap: ProvisioningSnapshot, target: number): number[] {
  const existingOrdinals = snap.intentsByOrdinal.size;
  const distribution: number[] = [];
  let remaining = target;
  for (let ordinal = 0; ordinal < existingOrdinals && remaining > 0; ordinal++) {
    const slots = Math.min(MAILBOXES_PER_DOMAIN, remaining);
    distribution.push(slots);
    remaining -= slots;
  }
  while (remaining > 0 && distribution.length < Math.ceil(MAX_SELF_SERVE_MAILBOXES / MAILBOXES_PER_DOMAIN)) {
    const slots = Math.min(MAILBOXES_PER_DOMAIN, remaining);
    distribution.push(slots);
    remaining -= slots;
  }
  return distribution;
}

/**
 * `paramsToSupply`, computed PER FIELD by emptiness (§7.17.6).
 *
 * NEVER by a "this tenant has never provisioned" population test: `brand` is
 * captured at SIGNUP and is `NOT NULL`, so a population test would ask an agent
 * to re-supply something the platform already holds — the mirror image of the
 * defect this wave exists to fix.
 */
interface SetupParams {
  params: Record<string, unknown>;
  paramsToSupply: string[];
}

function setupParamsFor(snap: NextStepsSnapshot, distribution: number[], includeConsent: boolean): SetupParams {
  const params: Record<string, unknown> = {};
  const paramsToSupply: string[] = [];
  const field = (name: string, value: string): void => {
    if (value.trim().length > 0) params[name] = value;
    else paramsToSupply.push(name);
  };
  field("brand", snap.profile.brand);
  field("primaryDomain", snap.profile.primaryDomain);
  params.domains = distribution.length;
  params.distribution = distribution;
  // Persona has no column of its own — `domain_intents.persona_slug` is the
  // only persistence anywhere in the schema, and it holds the SLUGIFIED form,
  // which is address-equivalent.
  //
  // It is absent in exactly two cases, and the difference is the whole of
  // BLOCKING-1. A tenant that has never provisioned genuinely never had one.
  // A tenant that provisioned BEFORE the column existed has one in every
  // mailbox address it owns — and `engine/persona-backfill.ts` recovers that at
  // DO construction, by inverting the address. So by the time this reads NULL,
  // the platform has already tried and failed to know: what is left is
  // genuinely unknowable, and asking for it is honest rather than the mirror-
  // image defect of §7.17.6.
  field("persona", snap.provisioning.personaSlug ?? "");
  field("physicalAddress", snap.profile.physicalAddress);
  field("senderIdentity", snap.profile.senderIdentity);
  if (includeConsent) {
    if (snap.profile.registerDomains) {
      // A RE-AFFIRMATION of consent the tenant already gave, which is what
      // makes emitting it safe. Omitting it is what 503s a buy-bearing call:
      // the read path is `optIn: input.registerDomains ?? false`, so absent
      // means NOT opted in FOR THIS REQUEST regardless of what is persisted.
      params.registerDomains = true;
    } else {
      // NEVER auto-emit `true` (gate L1). That would manufacture consent to
      // real money spend inside a recommendation an unattended agent executes
      // verbatim. Consent is the customer's to give; the platform's job is to
      // say exactly what giving it requires.
      paramsToSupply.push("registerDomains", "registrant");
    }
  }
  return { params, paramsToSupply };
}

/**
 * What the dry run can say about one candidate distribution.
 *
 * THREE-VALUED, because two of the three used to be one `null` and the third
 * did not exist. `buys_nothing` suppresses the recommendation (a call the
 * planner says acquires nothing is not worth emitting); `unpriceable` still
 * emits the step, because the WORK is real even when the platform cannot put a
 * number on it — it only withholds the `effect`. Collapsing them would either
 * hide an owed step or price it dishonestly, and this wave has now been bitten
 * by the second.
 */
type Recommendation =
  | { status: "planned"; newMailboxes: number; provisionedAfter: number }
  | { status: "buys_nothing" }
  | { status: "unpriceable" };

/**
 * Does this target reach an ordinal that already holds a live domain?
 *
 * That is exactly the condition under which `planFor` derives ADDRESSES
 * (`managedMailboxAddress(personaSlug, …)`) to decide which slots are already
 * filled. An ordinal with no live domain contributes `slots` new mailboxes
 * whatever the persona is, so a target that reaches none of them has a
 * persona-INDEPENDENT answer and stays priced.
 */
function targetsLiveOrdinal(snap: ProvisioningSnapshot, distribution: number[]): boolean {
  for (let ordinal = 0; ordinal < distribution.length; ordinal++) {
    if (snap.intentsByOrdinal.get(ordinal)?.live) return true;
  }
  return false;
}

/** Would this recommendation actually acquire anything, does it fit the plan cap, and can it be priced honestly? */
function planRecommendation(snap: NextStepsSnapshot, distribution: number[]): Recommendation {
  if (distribution.length === 0) return { status: "buys_nothing" };
  if (distribution.length > Math.ceil(MAX_SELF_SERVE_MAILBOXES / MAILBOXES_PER_DOMAIN)) return { status: "buys_nothing" };
  const total = distribution.reduce((a, b) => a + b, 0);
  // BLOCKING-1's second half — ABSTAIN rather than plan against a persona the
  // platform does not have. `slugify` ends `|| "hello"`, so passing `""` here
  // does not fail: it silently plans against `hello11@…`, matches none of the
  // tenant's real mailboxes, counts every slot as NEW, and prices a bill
  // increase inside a step whose prose says the bill is unchanged.
  //
  // Scoped to the case where the answer actually DEPENDS on the persona (a
  // targeted ordinal is live), which is also what makes the `?? ""` below
  // safe rather than merely lucky: past this guard, `planFor` provably never
  // constructs an address. The reconciler reached the same posture for the
  // same NULL — "not safely completable, abstain"
  // (provisioning-reconcile.ts's `skippedNoSpec`) — and this is the
  // customer-facing reader of it.
  if (snap.provisioning.personaSlug === null && targetsLiveOrdinal(snap.provisioning, distribution)) {
    return { status: "unpriceable" };
  }
  // Cap-checked IN MEMORY before emitting (non-blocking 6), so "the planner
  // says this call succeeds as written" is proven near the ceiling rather than
  // assumed. `assertWithinProvisioningCap` sizes against the SHORTFALL, so this
  // mirrors it: existing live + what the call adds.
  const plan = planFor(snap.provisioning, {
    // The persona the recommendation ECHOES is the one the addresses were
    // derived from, so the plan counts the same filled slots the saga would.
    persona: snap.provisioning.personaSlug ?? "",
    distribution,
  });
  if (plan.newMailboxes === 0) return { status: "buys_nothing" };
  if (snap.billableMailboxes + plan.newMailboxes > MAX_SELF_SERVE_MAILBOXES) return { status: "buys_nothing" };
  if (total > MAX_SELF_SERVE_MAILBOXES) return { status: "buys_nothing" };
  return { status: "planned", newMailboxes: plan.newMailboxes, provisionedAfter: snap.billableMailboxes + plan.newMailboxes };
}

/**
 * The one sentence a step appends when the platform cannot price its own
 * recommendation. Said out loud rather than left as a bare `effect: null`,
 * which an agent cannot tell from "this step changes no billable count".
 */
const PERSONA_UNKNOWN_SENTENCE =
  " The mailbox naming persona this account provisioned under is not on record and cannot be recovered from the mailboxes it " +
  "currently has, so the platform will not project a mailbox count or a price for this call — supply `persona` and the next " +
  "response carries both.";

function billingEffect(ctx: TenantContext, provisionedAfter: number): MailboxBilling {
  // The SAME projection the response's own `billing` field carries, so a step's
  // claim about the bill IS the bill.
  return buildMailboxBilling(ctx, provisionedAfter);
}

// ── The reasons ──────────────────────────────────────────────────────────────

/**
 * THE COMPOSITION TABLE (§7.18.3's E2), over what the tenant HOLDS.
 *
 * E2's rule: suppress the ACTION, never the FACT. BYO tenants are the likeliest
 * population to sit under five seats — someone connecting two of their own
 * mailboxes while paying the five-seat floor has the MOST free headroom — and
 * the version that suppressed both seat reasons for them told them least about
 * it.
 *
 * The test is over composition, never "does any BYO row exist": a single
 * `source='byo'` row suppressing the managed side entirely for a tenant running
 * BOTH is the live defect E2 flagged. A mixed tenant gets the managed action,
 * because they already run that path, so it is proven for them.
 */
function seatFillAction(snap: NextStepsSnapshot, distribution: number[], fillCount: number): NextStepAction {
  const managedOnly = snap.composition.byoDomains === 0;
  const mixed = snap.composition.byoDomains > 0 && snap.composition.managedDomains > 0;
  if (managedOnly || mixed) {
    const { params, paramsToSupply } = setupParamsFor(snap, distribution, true);
    return { via: "mcp_tool", tool: "setup_infrastructure", params, paramsToSupply, idempotencyKey: null };
  }
  // BYO-ONLY. Recommending a managed lookalike purchase here is the wrong
  // product, so the managed action is suppressed — but the FACT is not.
  const active = snap.composition.activeByoDomain;
  if (active) {
    return {
      via: "mcp_tool",
      tool: "configure_byo_domain",
      // Platform-provisioned mailboxes on an already-ACTIVE BYO domain — the
      // §20.6 shape (a) path, which carries the same `billing` projection.
      params: { action: "request_managed_mailboxes", id: active.id, count: fillCount },
      paramsToSupply: [],
      idempotencyKey: null,
    };
  }
  return {
    via: "none",
    note: "The headroom is real, but the fill waits on one of your own domains finishing intake. Poll get_byo_domains for its status; once a domain is active, configure_byo_domain can attach the free mailboxes.",
  };
}

function seatSteps(ctx: TenantContext, snap: NextStepsSnapshot): NextStep[] {
  const billable = snap.billableMailboxes;
  const billed = snap.profile.billedQuantity;
  const distribution = fillDistribution(snap.provisioning, Math.max(billed, MINIMUM_BILLABLE_MAILBOXES));
  const planned = planRecommendation(snap, distribution);
  const byoOnly = snap.composition.byoDomains > 0 && snap.composition.managedDomains === 0;

  // (1) Paying and NOTHING provisioned — unambiguous, and OWED.
  if (billable === 0 && billed > 0) {
    // The recommendation must buy something to be worth emitting. A BYO-only
    // tenant has no managed plan to run, so the dry run is not the gate for
    // them — the FACT still holds and the action is theirs. An UNPRICEABLE plan
    // is not the same as one that buys nothing: the work is real, so the step
    // is emitted and only its `effect` is withheld.
    if (planned.status === "buys_nothing" && !byoOnly) return [];
    const action = seatFillAction(snap, distribution, MINIMUM_BILLABLE_MAILBOXES);
    return [
      {
        reason: "paid_seats_unprovisioned",
        kind: "owed",
        why:
          `You are billed for ${billed} mailboxes and none are provisioned. ` +
          (byoOnly
            ? `Your domains are your own, so the fill runs through configure_byo_domain rather than a managed domain purchase.`
            : `This call buys the domains and creates the mailboxes; \`domains\` and \`distribution\` are the ` +
              `infrastructure you want to HAVE, not an amount to add, so repeating it never buys twice.` +
              consentSentence(snap, action)) +
          (planned.status === "unpriceable" ? PERSONA_UNKNOWN_SENTENCE : ""),
        action,
        waitingOn: null,
        notBeforeMs: 0,
        effect: planned.status === "planned" ? billingEffect(ctx, planned.provisionedAfter) : null,
        // §7.17.4 — `first_paid_at` is the money-event stamp, clamped at
        // write time; NULL only for a tenant this backfill/go-forward pair
        // has not reached yet (unreachable here in practice — this branch
        // requires `billed > 0`, which implies a real checkout occurred).
        sinceMs: clampedAge(snap.profile.firstPaidAt, snap.realNow),
      },
    ];
  }

  // (3) OUR Stripe push did not land. The documented failure window
  // (engine/billing.ts's syncMailboxQuantity) — never the customer's bug, and
  // nothing they can do about it.
  //
  // N1 — THE ARM CARRIES THE SYNC'S OWN ELIGIBILITY CONJUNCT. `syncMailboxQuantity`
  // returns early on `billing_state !== 'active'` WITHOUT advancing
  // `mailbox_qty_synced`, and a `past_due` tenant is NOT lifecycle-frozen, so it
  // stays in scope for the stuck-customer check — where this reason's
  // `waitingOn:'operator'` routes it to the EMAIL channel. Without the conjunct,
  // a past_due tenant whose domain burns emails the founder daily, for the whole
  // dunning window, about documented correct behaviour with no path to clear.
  //
  // The principle generalises: a check that reports "a push is overdue" must
  // carry the same eligibility predicate as the push.
  if (
    snap.profile.billingState === "active" &&
    billable >= MINIMUM_BILLABLE_MAILBOXES &&
    billed > billable
  ) {
    return [
      {
        reason: "billed_quantity_drift",
        kind: "owed",
        why:
          `Your subscription is still billing for ${billed} mailboxes while ${billable} are provisioned. ` +
          `That gap is ours to close, not yours — no call of yours changes it and nothing further is charged ` +
          `for the difference once it is corrected.`,
        action: {
          via: "none",
          note: "An operator reconciles the billed quantity with the provisioned count. No action is required from you.",
        },
        waitingOn: "operator",
        notBeforeMs: 0,
        effect: null,
        sinceMs: null,
      },
    ];
  }

  return [];
}

/**
 * THE FLOOR GAP, and the LAST reason computed (E1, §7.18.1).
 *
 * `billableMailboxes` floors at five, so a tenant at two pays exactly what a
 * tenant at five pays — the remaining mailboxes are genuinely free, and this is
 * the only place the platform tells a customer they are leaving paid-for
 * capacity on the table. `effect.projectedMonthlyCents` proves the $0 claim
 * IN-PAYLOAD rather than asserting it in prose.
 *
 * TWO PROPERTIES, both ratified rather than chosen:
 *
 *   `owedCount === 0` — the band 0 < billable < 5 includes a tenant whose
 *   remaining ordinals HARD-FAILED, and telling them "the remaining 2 add $0 to
 *   your bill" is the platform's most confident-sounding sentence delivered on
 *   its least healthy state, to an unattended agent. Deliberately NOT a fix
 *   that depends on having enumerated every gap in the reason list: if ANYTHING
 *   is owed, this line is noise at best. It stays correct as the list grows.
 *
 *   ALWAYS `available`, NEVER `owed` — the ruling was "emit, AND NOTHING CHASES
 *   THEM", which holds only while `kind` stays `available`. `kind` is
 *   load-bearing for two independent suppressions (no alert via `owedCount`, no
 *   nudge), so test/next-steps-gating.test.ts asserts the whole chain rather
 *   than the field.
 */
function seatHeadroomStep(ctx: TenantContext, snap: NextStepsSnapshot, owedCount: number): NextStep[] {
  const billable = snap.billableMailboxes;
  if (owedCount > 0) return [];
  if (snap.profile.billedQuantity === 0) return [];
  if (billable <= 0 || billable >= MINIMUM_BILLABLE_MAILBOXES) return [];

  const distribution = fillDistribution(
    snap.provisioning,
    Math.max(snap.profile.billedQuantity, MINIMUM_BILLABLE_MAILBOXES),
  );
  const planned = planRecommendation(snap, distribution);
  const byoOnly = snap.composition.byoDomains > 0 && snap.composition.managedDomains === 0;
  if (planned.status === "buys_nothing" && !byoOnly) return [];

  const free = MINIMUM_BILLABLE_MAILBOXES - billable;
  const action = seatFillAction(snap, distribution, free);
  return [
    {
      reason: "seat_headroom_free",
      kind: "available",
      why:
        `You are billed for a ${MINIMUM_BILLABLE_MAILBOXES}-mailbox minimum and ${billable} ` +
        `${billable === 1 ? "is" : "are"} provisioned, so ${free} more ` +
        `${free === 1 ? "mailbox costs" : "mailboxes cost"} nothing — your bill is unchanged. ` +
        `Nothing is blocked and nothing is required; this is only worth doing if you want the extra sending capacity.` +
        consentSentence(snap, action) +
        // The $0 claim is floor arithmetic and stays true; what an unknown
        // persona costs is the IN-PAYLOAD proof of it (§7.18.4's 3960 -> 3960),
        // so the step says the number is missing instead of implying none exists.
        (planned.status === "unpriceable" ? PERSONA_UNKNOWN_SENTENCE : ""),
      action,
      waitingOn: null,
      notBeforeMs: 0,
      effect: planned.status === "planned" ? billingEffect(ctx, planned.provisionedAfter) : null,
      sinceMs: null,
    },
  ];
}

/** The one sentence that explains a consent decision, appended only when there is one to make. */
function consentSentence(snap: NextStepsSnapshot, action: NextStepAction): string {
  if (action.via !== "mcp_tool" || action.tool !== "setup_infrastructure") return "";
  if (!action.paramsToSupply.includes("registerDomains")) {
    return snap.profile.registerDomains
      ? " Your account already consents to domain registration, so `registerDomains: true` re-states it — omitting it means NOT opted in for this request and the call is refused before anything is bought."
      : "";
  }
  return (
    " This account has not opted in to domain registration, so the call needs `registerDomains: true` and a " +
    "`registrant` (the legal contact filed with the registrar). That consent is yours to give — the platform will " +
    "not assume it."
  );
}

/**
 * §7.18.2's ELEVENTH REASON — a requested-but-incomplete ordinal.
 *
 * `forEachIsolated` completes a setup call after logging `DOMAIN_ORDINAL_FAILED`
 * per failed ordinal, and that log row is ALL it writes: no `tenant_messages`
 * row, no watchtower check, and — if the failure landed before the buy — no
 * `domains` row either, so `domain_dns_incomplete` does not fire in its place.
 * A tenant who asked for two domains and lost one sat with NO reason describing
 * the failure.
 *
 * DERIVED FROM STATE, NEVER FROM THE LOG. A retry that succeeds does not delete
 * the `DOMAIN_ORDINAL_FAILED` row, so predicating on the row would pin a healed
 * tenant as broken forever. The log supplies customer-safe `why` detail; it
 * never supplies the predicate.
 *
 * It composes with the vendor-truth wave rather than duplicating it:
 * `domain_orphan:` covers `status='committed'` with no `domains` row, and this
 * covers the two EARLIER statuses, which nothing reads today.
 */
function ordinalIncompleteSteps(snap: NextStepsSnapshot): NextStep[] {
  const stalled: number[] = [];
  let oldest: number | null = null;
  for (const [ordinal, intent] of snap.provisioning.intentsByOrdinal) {
    if (intent.status !== "intent" && intent.status !== "dangling") continue;
    if (intent.live !== null) continue;
    // §7.19 — the anchor is `domain_intents.updated_at`, stamped from
    // `ctx.clock` and NOT in the clock migration's shift list. A tenant that
    // provisioned on the demo VirtualClock and later upgraded carries a
    // FUTURE-dated value, so a raw subtraction goes negative, the grace bound is
    // never crossed, and this reason SILENTLY NEVER FIRES — on precisely the
    // population most likely to be carrying a half-finished setup.
    const age = clampedAge(intent.updatedAt, snap.realNow);
    if (age === null || age < snap.orphanGraceMs) continue;
    stalled.push(ordinal);
    if (oldest === null || age > oldest) oldest = age;
  }
  if (stalled.length === 0) return [];

  const distribution = fillDistribution(
    snap.provisioning,
    Math.max(snap.profile.billedQuantity, MINIMUM_BILLABLE_MAILBOXES),
  );
  const { params, paramsToSupply } = setupParamsFor(snap, distribution, true);
  const action: NextStepAction = {
    via: "mcp_tool",
    tool: "setup_infrastructure",
    params,
    paramsToSupply,
    idempotencyKey: null,
  };
  return [
    {
      reason: "ordinal_incomplete",
      kind: "owed",
      why:
        `${stalled.length} domain slot${stalled.length === 1 ? "" : "s"} ` +
        `(${stalled.join(", ")}) ${stalled.length === 1 ? "was" : "were"} requested and never completed — the ` +
        `request is recorded but no live domain landed there. Ordinals complete independently, so repeating the ` +
        `setup call resumes exactly the unfinished ${stalled.length === 1 ? "one" : "ones"} and buys nothing twice.` +
        consentSentence(snap, action),
      action,
      waitingOn: null,
      notBeforeMs: 0,
      effect: null,
      sinceMs: oldest,
    },
  ];
}

function domainDnsSteps(ctx: TenantContext, snap: NextStepsSnapshot): NextStep[] {
  const pending = snap.domains.filter((d) => d.source === "provisioned" && d.dnsStatus !== "ready");
  if (pending.length === 0) return [];
  const oldest = pending.reduce<number | null>((acc, d) => {
    const age = clampedAge(d.dnsFirstCheckedAt, snap.realNow);
    if (age === null) return acc;
    return acc === null || age > acc ? age : acc;
  }, null);
  const distribution = fillDistribution(snap.provisioning, Math.max(snap.profile.billedQuantity, MINIMUM_BILLABLE_MAILBOXES));
  const { params, paramsToSupply } = setupParamsFor(snap, distribution, true);
  return [
    {
      reason: "domain_dns_incomplete",
      kind: "owed",
      why:
        `${pending.length} of your domains ${pending.length === 1 ? "has" : "have"} not finished mail DNS setup, so ` +
        `${pending.length === 1 ? "it cannot" : "they cannot"} carry mailboxes yet. Registration is asynchronous at ` +
        `the registrar; repeating the same setup call finishes it once the nameservers have propagated. The platform ` +
        `does not retry this for you — completing it is the caller's job.`,
      action: { via: "mcp_tool", tool: "setup_infrastructure", params, paramsToSupply, idempotencyKey: null },
      waitingOn: null,
      notBeforeMs: DNS_RETRY_CADENCE_MS,
      effect: null,
      sinceMs: oldest,
    },
  ];
}

function capacitySteps(snap: NextStepsSnapshot): NextStep[] {
  if (snap.profile.provisioningState !== "capacity_pending") return [];
  return [
    {
      reason: "setup_capacity_held",
      kind: "owed",
      // NOT operator-BLOCKED: nothing failed and nothing was charged. A hold is
      // a different fact from a failure, and collapsing the two is what makes a
      // caller either give up or poll forever.
      why:
        "Provisioning is held at a capacity limit on the platform's side. Nothing failed and nothing was charged. " +
        "Polling will not progress it — an operator raises the limit, and then repeating your last call with the " +
        "SAME idempotency key completes it.",
      action: {
        via: "mcp_tool",
        tool: "contact_operator",
        params: { urgency: "needs_human" },
        // The platform will not compose a customer's own support message.
        paramsToSupply: ["body"],
        idempotencyKey: null,
      },
      waitingOn: "operator",
      notBeforeMs: 0,
      effect: null,
      sinceMs: null,
    },
  ];
}

/**
 * The owed steps that come from `tenant_messages`, plus the rows this pass
 * decided are RESOLVED (BLOCKING-2).
 *
 * `setupFamilyOwed` is computed by the caller from the steps it already built,
 * never re-derived here: when nothing in the setup family is owed, a
 * `retry_setup` / `setup_failed` row is describing a condition that no longer
 * exists, so it stops counting — and its id is returned so a WRITE-capable
 * caller can expire it durably. This function stays PURE (invariant 3): it
 * decides, it does not write.
 */
function messageSteps(snap: NextStepsSnapshot, setupFamilyOwed: boolean): { steps: NextStep[]; resolvedIds: string[] } {
  const steps: NextStep[] = [];
  const candidates = snap.messages.filter((m) => m.severity === "operator_pending" || m.severity === "action_required");
  // SCOPED TO `action_required`, deliberately. An `operator_pending` row is the
  // platform saying it has STOPPED on something only an operator can clear — a
  // held vendor wallet, say — and no state this derivation reads records that,
  // so it is NOT re-derivable and must keep counting until the operator clears
  // it. Widening this to every blocking severity silenced a live operator
  // blocker on a fleet whose domains happened to be complete.
  const resolved = setupFamilyOwed
    ? []
    : candidates.filter((m) => m.severity === "action_required" && RE_DERIVABLE_SETUP_MESSAGE_KINDS.has(m.kind));
  const resolvedIds = new Set(resolved.map((m) => m.id));
  const blocking = candidates.filter((m) => !resolvedIds.has(m.id));

  const operatorPending = blocking.filter((m) => m.severity === "operator_pending");
  if (operatorPending.length > 0) {
    const oldest = operatorPending.reduce<number | null>((acc, m) => {
      const age = clampedAge(m.createdAt, snap.realNow);
      if (age === null) return acc;
      return acc === null || age > acc ? age : acc;
    }, null);
    steps.push({
      reason: "setup_operator_blocked",
      kind: "owed",
      why:
        "The platform has stopped on a step only an operator can clear. Nothing was charged for the failed step and " +
        "your inputs are not the problem — do not change them. Once it is cleared, retrying the SAME call with the " +
        "SAME idempotency key completes it.",
      action: {
        via: "mcp_tool",
        tool: "contact_operator",
        params: { urgency: "needs_human" },
        paramsToSupply: ["body"],
        idempotencyKey: null,
      },
      waitingOn: "operator",
      notBeforeMs: 0,
      effect: null,
      sinceMs: oldest,
    });
  }

  const actionRequired = blocking.filter((m) => m.severity === "action_required");
  if (actionRequired.length > 0) {
    const newest = actionRequired[0] as MessageRow;
    const oldest = actionRequired.reduce<number | null>((acc, m) => {
      const age = clampedAge(m.createdAt, snap.realNow);
      if (age === null) return acc;
      return acc === null || age > acc ? age : acc;
    }, null);
    steps.push({
      reason: "message_action_required",
      kind: "owed",
      why:
        `${actionRequired.length} unread message${actionRequired.length === 1 ? "" : "s"} on this account ` +
        `${actionRequired.length === 1 ? "names an action" : "name actions"} nothing progresses without. Read ` +
        `${actionRequired.length === 1 ? "it" : "them"} via infrastructure_status or list_messages, follow the ` +
        `actionHint each carries, then acknowledge it so it stops being reported.`,
      action: {
        via: "mcp_tool",
        tool: "ack_message",
        params: { messageId: newest.id },
        paramsToSupply: [],
        idempotencyKey: null,
      },
      waitingOn: null,
      notBeforeMs: 0,
      effect: null,
      sinceMs: oldest,
    });
  }

  return { steps, resolvedIds: [...resolvedIds] };
}

function credentialSteps(snap: NextStepsSnapshot): NextStep[] {
  if (snap.pendingCredentialPushes === 0) return [];
  return [
    {
      reason: "mailbox_credentials_pending",
      kind: "available",
      why:
        `${snap.pendingCredentialPushes} provisioned mailbox${snap.pendingCredentialPushes === 1 ? "" : "es"} ` +
        `${snap.pendingCredentialPushes === 1 ? "has" : "have"} not finished handing credentials to the sending ` +
        `engine yet. This completes on its own; nothing is required of you and no send is lost.`,
      action: {
        via: "none",
        note: "The platform completes this itself. Poll infrastructure_status if you want to watch it land.",
      },
      waitingOn: null,
      notBeforeMs: 0,
      effect: null,
      sinceMs: null,
    },
  ];
}

function launchSteps(snap: NextStepsSnapshot): NextStep[] {
  if (snap.billableMailboxes === 0 || snap.campaigns > 0) return [];
  return [
    {
      reason: "ready_to_launch",
      kind: "available",
      why:
        "Your sending infrastructure exists and no campaign has been created yet. New mailboxes are ramp-limited " +
        "server-side, so a campaign launched now sends within today's cap rather than waiting for full warmup — " +
        "poll infrastructure_status for each mailbox's current dailyCap.",
      action: {
        via: "mcp_tool",
        tool: "launch_campaign",
        params: {},
        // The platform does not write copy, invent an offer, or hold a lead
        // list. Saying so beats emitting a call that 400s.
        paramsToSupply: ["name", "offer", "leads", "sequence"],
        idempotencyKey: null,
      },
      waitingOn: null,
      notBeforeMs: 0,
      effect: null,
      sinceMs: null,
    },
  ];
}

// ── The primitive ────────────────────────────────────────────────────────────

function finish(steps: NextStep[], computedAt: number): NextSteps {
  return {
    // EXPLICIT, never inferred from emptiness: `none_owed` is routinely emitted
    // WITH a non-empty `steps` array, and a shape-only classifier could not
    // tell that from "not computed".
    status: steps.some((s) => s.kind === "owed") ? "owed" : "none_owed",
    steps,
    computedAt,
  };
}

/**
 * What one derivation produced: the contract shape, plus the `tenant_messages`
 * rows this pass found RESOLVED (BLOCKING-2).
 *
 * The ids never leave the DO — §7.10.3 keeps the cross-DO projection minimized
 * to reasons and counts. They exist so the ONE caller that is already
 * re-deriving on a per-tenant cadence can bank the decision durably without a
 * second derivation or a second cross-DO RPC (§7.17.7's subrequest bound).
 */
export interface DerivedNextSteps {
  next: NextSteps;
  resolvedSystemMessageIds: string[];
}

export function deriveNextSteps(ctx: TenantContext): NextSteps {
  return deriveNextStepsWithResolved(ctx).next;
}

export function deriveNextStepsWithResolved(ctx: TenantContext): DerivedNextSteps {
  const snap = readNextStepsSnapshot(ctx);

  // ── GATE 1: LIFECYCLE FREEZE ───────────────────────────────────────────────
  // The REAL predicate, imported from engine/billing-state.ts rather than
  // hand-listed. A hand-list got this wrong in both directions: it named
  // `terminated`, which is never a `billing_state` (it is `suspend_reason` plus
  // a D1 status change), and it omitted `status='suspended'`, which is half the
  // real predicate.
  //
  // A frozen tenant is told the ONE thing that unfreezes them and nothing else.
  // Every other reason would be a call the lifecycle guard refuses anyway.
  if (isLifecycleFrozen(snap.profile.status, snap.profile.billingState)) {
    return unresolved(finish(
      [
        {
          reason: "account_frozen",
          kind: "available",
          why:
            "This account is frozen, so provisioning and sending are stopped. Re-subscribing through checkout " +
            "reactivates it, and your existing domains and mailboxes are unaffected in the meantime.",
          // There is no `checkout` MCP tool — verified against mcp/tools.ts —
          // which is exactly why the action union has a non-tool member rather
          // than forcing every step into a tool name that does not exist.
          action: {
            via: "http",
            method: "POST",
            path: "/checkout",
            note: "Re-subscribe to lift the freeze. Body: { mailboxes, interval }.",
          },
          waitingOn: "customer_billing",
          notBeforeMs: 0,
          effect: null,
          sinceMs: null,
        },
      ],
      snap.realNow,
    ));
  }

  // ── GATE 2: THE TENANT PAYS NOTHING ────────────────────────────────────────
  // Demo, free, and simulated-checkout tenants have `mailbox_qty_synced = 0`.
  // Without this gate the seat arithmetic reads `max(5, 0) - 0 = 5` and tells
  // someone who pays nothing that they are billed for five mailboxes.
  //
  // A tenant behind either gate reports NO resolved messages: neither gate
  // evaluated the setup family, so "the condition no longer holds" was never
  // established and nothing may be expired on the strength of it.
  if (snap.profile.billedQuantity === 0) return unresolved(finish([], snap.realNow));

  // Everything owed, computed BEFORE the one reason whose predicate is
  // "nothing is owed" (E1). The ordering is load-bearing, not stylistic.
  //
  // The state-derived families come first for a second reason now: whether the
  // SETUP family is owed is exactly the condition a `retry_setup` /
  // `setup_failed` message asserts, and `messageSteps` reads it off these steps
  // rather than computing it a second way (BLOCKING-2).
  const fromState: NextStep[] = [
    ...seatSteps(ctx, snap),
    ...ordinalIncompleteSteps(snap),
    ...domainDnsSteps(ctx, snap),
    ...capacitySteps(snap),
  ];
  const setupFamilyOwed = fromState.some((s) => s.kind === "owed" && SETUP_FAMILY_REASONS.has(s.reason));
  const messages = messageSteps(snap, setupFamilyOwed);
  const owedFirst: NextStep[] = [...fromState, ...messages.steps, ...credentialSteps(snap), ...launchSteps(snap)];
  const owedCount = owedFirst.filter((s) => s.kind === "owed").length;
  return {
    next: finish([...owedFirst, ...seatHeadroomStep(ctx, snap, owedCount)], snap.realNow),
    resolvedSystemMessageIds: messages.resolvedIds,
  };
}

/** A derivation that reached a terminal gate: a result, and nothing to expire. */
function unresolved(next: NextSteps): DerivedNextSteps {
  return { next, resolvedSystemMessageIds: [] };
}

/**
 * The MINIMISED projection every out-of-DO consumer gets (§7.10.3, non-blocking 2).
 *
 * Reasons, a count and the oldest owed anchor — never `NextStep[]`. Full `why`
 * prose and profile fields must not enter the RPC that feeds alert bodies and
 * the operator digest.
 */
export function owedSignals(next: NextSteps): {
  owedReasons: NextStep["reason"][];
  owedCount: number;
  oldestOwedSinceMs: number | null;
  /**
   * §7.11 — whether ANY owed step blames the operator, read from the real
   * `NextStep.waitingOn` field (never a reason-name classification table
   * re-deriving what this function already has in hand). The one signal the
   * stuck-customer check's blame-in-the-name rule needs, kept as a single
   * boolean rather than the per-step field — still the minimized projection
   * (§7.10.3): never `NextStep[]`.
   */
  anyOwedWaitingOnOperator: boolean;
} {
  const owed = next.steps.filter((s) => s.kind === "owed");
  const oldest = owed.reduce<number | null>((acc, s) => {
    if (s.sinceMs === null) return acc;
    return acc === null || s.sinceMs > acc ? s.sinceMs : acc;
  }, null);
  return {
    owedReasons: owed.map((s) => s.reason),
    owedCount: owed.length,
    oldestOwedSinceMs: oldest,
    anyOwedWaitingOnOperator: owed.some((s) => s.waitingOn === "operator"),
  };
}
