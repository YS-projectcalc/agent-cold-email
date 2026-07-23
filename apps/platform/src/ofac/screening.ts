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
import { matchAgainstSdn, type MatchedSdnEntry, type ScreenCandidate } from "./match.js";
import { getActiveSdnEntries, getActiveSdnListVersion } from "./sdn-list.js";
import { alertScreeningHit } from "./screening-alert.js";
import { upsertScreeningReview } from "../admin/db.js";

export type ScreeningStatus = "clear" | "review";

export interface ScreenTenantOptions {
  trigger: "checkout" | "brand_change";
  /**
   * Best-effort Stripe billing name (`customer_details.name`) — only ever
   * present on a REAL Stripe checkout.session.completed event that happened to
   * carry it. Design line 45: under the pilot's 100%-off +
   * `payment_method_collection:"if_required"` posture, no name is typically
   * collected — this is honestly best-effort, never assumed present.
   */
  billingName?: string | null;
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

  const profile = ctx.sql.exec<{ brand: string }>(`SELECT brand FROM tenant_profile WHERE id = ?`, ctx.tenantId).one();

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

  // No list built yet (fresh env / pre-first-refresh — an arming-time gap, not
  // a runtime error) -> nothing to match against. Persist 'clear' but with a
  // NULL list_version so it stays honestly distinguishable from a real screen
  // (never silently claim a check ran when it didn't).
  if (!listVersion) {
    persistVerdict(ctx, "clear", null);
    return { status: "clear", listVersion: null, matches: [] };
  }

  const entries = await getActiveSdnEntries(ctx.env, listVersion);
  const matches = matchAgainstSdn(candidates, entries);

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

function persistVerdict(ctx: TenantContext, status: ScreeningStatus, listVersion: string | null): void {
  ctx.sql.exec(
    `UPDATE tenant_profile SET screening_status = ?, screening_list_version = ?, screened_at = ? WHERE id = ?`,
    status,
    listVersion,
    ctx.clock.now(),
    ctx.tenantId,
  );
}
