// G1b — screens a tenant's currently-known identity fields against the active
// SDN list and PERSISTS the verdict on tenant_profile (design
// ga-gates-design-2026-07-22.md §G1, lines 38-65). This is the ONE place
// `screening_status`/`screening_list_version`/`screened_at` are written;
// `engine/activation.ts`'s `readActivationState` is the ONE place they're
// read — no caller of `isTenantActivated` changes (design line 38).
//
// Called at the checkout write sites (engine/billing.ts, both
// `completeSimulatedCheckout` and `applyStripeWebhookEvent`'s
// checkout.session.completed case) and at setup_infrastructure's brand
// rewrite (engine/provisioning.ts — NB-1 disposition, adversary round 1
// 2026-07-23: the operative brand is rewritten there and was never
// re-screened, an evasion vector this closes).
import { lookupTenantContactEmail } from "../db.js";
import { createOpsMailer, type OpsMailer } from "../ops-mail/ops-mailer.js";
import type { TenantContext } from "../tenant-context.js";
import { matchAgainstSdn, sdnLookupKeys, type MatchedSdnEntry, type ScreenCandidate } from "./match.js";
import { getActiveSdnListVersion, getSdnEntriesForLookup, sdnVersionHasEntries } from "./sdn-list.js";
import { alertScreeningHit, alertScreeningListUnavailable } from "./screening-alert.js";
import { upsertScreeningReview } from "../admin/db.js";

export type ScreeningStatus = "clear" | "review";

/**
 * Adversary N-OF-1 (OFAC build review, 2026-07-23): the old behavior — no
 * active SDN list yet -> persist 'clear' with a null list_version — is
 * fail-OPEN, the wrong direction for a sanctions gate (a checkout in the
 * post-deploy/pre-first-refresh window activated a paying stranger
 * unscreened, only audit-distinguishable via the null version). This sentinel
 * is now the list_version stamped instead: `screening_status` goes 'review'
 * (fail-CLOSED, blocks activation exactly like a real hit), and it is a
 * value that can NEVER collide with a real `sdn-${nowMs}` version tag
 * (sdn-list.ts), so a genuinely-screened tenant and a
 * screened-but-no-list-yet tenant are always distinguishable in the audit
 * trail and in the `screening_reviews` queue.
 */
export const LIST_UNAVAILABLE_VERSION = "list-unavailable";

export interface ScreenTenantOptions {
  trigger: "checkout" | "brand_change" | "list_unavailable_recovery";
  /**
   * Best-effort Stripe billing name (`customer_details.name`) — only ever
   * present on a REAL Stripe checkout.session.completed event that happened to
   * carry it. Design line 45: under the pilot's 100%-off +
   * `payment_method_collection:"if_required"` posture, no name is typically
   * collected — this is honestly best-effort, never assumed present.
   */
  billingName?: string | null;
  /**
   * The brand to screen, overriding the PERSISTED one. H8 (INCIDENT
   * 2026-08-05) moved setup_infrastructure's re-screen to BEFORE the
   * tenant_profile write, so the incoming brand is not on the row yet — without
   * this the screen would check the OLD brand and G1b's whole purpose (catch a
   * tenant who screens clean at checkout then sets a sanctioned brand here)
   * would silently evaporate. Absent, the persisted brand is screened, exactly
   * as every other trigger does.
   */
  brand?: string;
  /** Injectable (default a real/dark-per-env OpsMailer) — same pattern as
   * runSetupInfrastructure's/alertRegistrarUnarmed's `mailer` param, so a test
   * can assert the screening-hit alert content with a SandboxOpsMailer without
   * any production call site needing to change. */
  mailer?: OpsMailer;
}

export interface ScreenTenantResult {
  status: ScreeningStatus;
  listVersion: string | null;
  matches: MatchedSdnEntry[];
}

/**
 * NEVER auto-rejects (adversary NB-3 / Founder Q2, ADOPTED under the autonomy
 * grant): a hit sets `screening_status = 'review'` — which
 * `isTenantActivated` (engine/activation.ts) already reads as a blocking
 * conjunct, so this is the ONLY code that needs to change for the gate to
 * take effect — and records a review row + fires a founder-only ops alert
 * (never customer-visible "sanctions match" framing — see
 * docs/research/ofac-v1-honesty-statement-2026-07-23.md).
 */
export async function screenTenant(ctx: TenantContext, opts: ScreenTenantOptions): Promise<ScreenTenantResult> {
  const listVersion = await getActiveSdnListVersion(ctx.env);

  const persisted = ctx.sql.exec<{ brand: string }>(`SELECT brand FROM tenant_profile WHERE id = ?`, ctx.tenantId).one();
  // The INCOMING brand when the caller supplies one (see opts.brand) — a
  // pre-write screen must judge what is about to be persisted, not what is.
  const profile = { brand: opts.brand ?? persisted.brand };

  const screenedFields: Record<string, string | null> = { brand: profile.brand };
  const candidates: ScreenCandidate[] = [{ field: "brand", text: profile.brand }];

  let contactEmail: string | null = null;
  try {
    contactEmail = await lookupTenantContactEmail(ctx.env, ctx.tenantId);
  } catch (err) {
    console.error(`screening: contact-email lookup failed for tenant ${ctx.tenantId}`, err);
  }
  screenedFields.contactEmail = contactEmail;
  if (contactEmail) {
    // Screen the DOMAIN only (an organization/brand signal on an SDN list of
    // names/entities) — the mailbox local-part is a personal identifier this
    // v1 screen deliberately does not fingerprint.
    const domain = contactEmail.split("@")[1] ?? null;
    screenedFields.contactEmailDomain = domain;
    if (domain) candidates.push({ field: "contactEmailDomain", text: domain });
  }

  screenedFields.billingName = opts.billingName ?? null;
  if (opts.billingName) candidates.push({ field: "billingName", text: opts.billingName });

  // N-OF-1 FIX (adversary OFAC build review, 2026-07-23): no list built yet
  // (fresh env / pre-first-refresh, or a refresh outage) -> we CANNOT screen,
  // so we must not claim clear. Fail CLOSED: 'review' blocks activation
  // exactly like a real hit, tagged with a sentinel list_version so it is
  // honestly distinguishable from both a real 'clear' screen and a real
  // 'review' hit. Recorded to the SAME review queue + alert path as a real
  // hit (an admin can clear it manually), and self-heals once a real list
  // loads — src/ofac/screening-recovery.ts's cron sweep re-screens every
  // tenant still holding this exact sentinel.
  if (!listVersion) {
    return failClosedListUnavailable(
      ctx,
      opts,
      screenedFields,
      "no active SDN list was loaded at screening time — held fail-closed, not a name match",
    );
  }

  // S9 (docs/adversarial/scale-readiness-audit-2026-08-17.md): read the rows
  // that COULD match, not all ~17k. `sdnLookupKeys` derives the selection from
  // the match rules themselves and is a deliberate superset, so `matchAgainstSdn`
  // below still decides every verdict — see ofac/match.ts.
  const entries = await getSdnEntriesForLookup(ctx.env, listVersion, sdnLookupKeys(candidates));
  const matches = matchAgainstSdn(candidates, entries);

  // TOCTOU fail-open guard (adversary finding 1, docs/adversarial/
  // sdn-relay-review-2026-07-24.md): this function reads `listVersion` above
  // and the entries here in TWO SEPARATE awaits — a concurrent swapInSdnList
  // can flip `active_version` to a NEW version and run its post-flip cleanup
  // (`DELETE FROM sdn_entries WHERE list_version != <new>`, sdn-list.ts) in
  // between, deleting every row this now-stale `listVersion` pointed to. That
  // would return zero matches -> 'clear' — the OPPOSITE of the null-version
  // case above, and the wrong direction for a sanctions gate: a sanctioned
  // tenant could be cleared purely by racing a list swap.
  //
  // THE GUARD ASKS THE LIST, IT NO LONGER INFERS FROM THE RESULT. While the
  // read was a full scan, "zero rows" could only mean the version had been
  // deleted. Under S9's narrowing zero rows is the ORDINARY clean-tenant
  // answer, so keying the guard on emptiness would hold every clean signup for
  // review. It runs only when there is nothing to report — a hit is itself
  // proof the version was populated — so the common path costs one indexed
  // single-row probe, not a scan.
  if (matches.length === 0 && !(await sdnVersionHasEntries(ctx.env, listVersion))) {
    return failClosedListUnavailable(
      ctx,
      opts,
      screenedFields,
      `active list_version ${listVersion} holds zero entries — this can only mean a concurrent list swap raced this read (never a legitimate empty list); held fail-closed, not a name match`,
    );
  }

  if (matches.length === 0) {
    persistVerdict(ctx, "clear", listVersion);
    return { status: "clear", listVersion, matches: [] };
  }

  persistVerdict(ctx, "review", listVersion);
  await upsertScreeningReview(ctx.env, {
    tenantId: ctx.tenantId,
    matchedTerms: matches,
    screenedFields,
    listVersion,
    createdAt: ctx.clock.now(),
  });
  await alertScreeningHit(ctx, matches, opts.trigger, opts.mailer ?? createOpsMailer(ctx.env));
  return { status: "review", listVersion, matches };
}

/**
 * POST /admin/tenants/:id/screening `{decision:'clear'}` — an admin's
 * resolution of a pending review. Un-blocks `isTenantActivated`'s screening
 * conjunct on the tenant's OWN DO on the very next `buildAdapters()` (the
 * same fresh-SQL-read discipline `readActivationState` already guarantees for
 * a billing-state flip). Deliberately does NOT touch `screening_list_version`
 * — the tenant stays associated with whichever list version produced the
 * original verdict, for audit; only the status flips.
 */
export function clearScreeningStatus(ctx: TenantContext): void {
  ctx.sql.exec(`UPDATE tenant_profile SET screening_status = 'clear' WHERE id = ?`, ctx.tenantId);
}

/**
 * Shared by BOTH the "no list loaded yet" case and the TOCTOU race case
 * above (CLAUDE.md rule c) — fail CLOSED to the sentinel `review` verdict,
 * record a review row explaining why (never framed as a name match), alert
 * the founder, and let the SAME self-heal recovery sweep
 * (screening-recovery.ts) pick this tenant up again once a stable read
 * succeeds.
 */
async function failClosedListUnavailable(
  ctx: TenantContext,
  opts: ScreenTenantOptions,
  screenedFields: Record<string, string | null>,
  note: string,
): Promise<ScreenTenantResult> {
  persistVerdict(ctx, "review", LIST_UNAVAILABLE_VERSION);
  await upsertScreeningReview(ctx.env, {
    tenantId: ctx.tenantId,
    matchedTerms: [{ reason: "sdn_list_unavailable", note }],
    screenedFields,
    listVersion: LIST_UNAVAILABLE_VERSION,
    createdAt: ctx.clock.now(),
  });
  await alertScreeningListUnavailable(ctx, opts.trigger, opts.mailer ?? createOpsMailer(ctx.env));
  return { status: "review", listVersion: LIST_UNAVAILABLE_VERSION, matches: [] };
}

function persistVerdict(ctx: TenantContext, status: ScreeningStatus, listVersion: string | null): void {
  ctx.sql.exec(
    `UPDATE tenant_profile SET screening_status = ?, screening_list_version = ?, screened_at = ? WHERE id = ?`,
    status,
    listVersion,
    ctx.clock.now(),
    ctx.tenantId,
  );
}
