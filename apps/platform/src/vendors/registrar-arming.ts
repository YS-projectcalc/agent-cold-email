// G5 gate (a) follow-up — InboxKit-as-registrar arming (founder ruling
// 2026-07-21: "InboxKit-as-registrar is per-tenant opt-in only, never a
// default"; 2026-07-27: "domain-port arming uses its OWN config, distinct
// from inboxKitConfig"). Two independent legs must BOTH be true before
// `vendors/factory.ts` ever wires `RealInboxKitDomainPort` for `domain`:
//   1. `armed`  — the env switch, REGISTRAR_PROVIDER === "inboxkit" (env.ts).
//   2. `optIn`  — the TENANT's persisted consent
//                 (SetupInfrastructureInput.registerDomains, captured at
//                 provisioning.ts's runSetupInfrastructure onto
//                 tenant_profile.register_domains).
// Neither leg alone can ever reach a real domain port — mirrors the existing
// INBOXKIT_* + `activated` conjunct discipline (factory.ts) and the
// `isRealSpendArmed` OR-in discipline (engine/billing.ts).

import { IncompleteRegistrantError } from "@coldstart/shared";
import type { Env } from "../env.js";
import type { InboxKitDomainRegistrant } from "./real/inboxkit-domain-port.js";

/** Leg 1 — the env-level arming switch. Its only recognized value is "inboxkit" (env.ts). */
export function isInboxKitRegistrarArmed(env: Env): boolean {
  return env.REGISTRAR_PROVIDER === "inboxkit";
}

export interface TenantContactFields {
  readonly brand: string;
  readonly physicalAddress: string;
  readonly senderIdentity: string;
  /**
   * The tenant's structured registrant-of-record, persisted verbatim as JSON
   * (`SetupInfrastructureInput.registrant`, `tenant_profile.registrant_json` —
   * provisioning.ts's runSetupInfrastructure). NULL when never captured (every
   * pre-existing tenant, and any tenant that has only ever called
   * setup_infrastructure with registerDomains:false).
   */
  readonly registrantJson: string | null;
}

/**
 * Parses the persisted `registrant_json` column. Returns null on either
 * absence or a parse failure — the latter should never happen (this
 * platform is the only writer, via JSON.stringify of a zod-validated
 * `Registrant`), but falling back to null (rather than throwing here) keeps
 * this a non-throwing best-effort read; `assertCompleteRegistrant` below is
 * the one fail-loud boundary.
 */
function parseRegistrantJson(json: string | null): Partial<InboxKitDomainRegistrant> | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as Partial<InboxKitDomainRegistrant>;
  } catch {
    return null;
  }
}

/**
 * Best-effort InboxKit domain registrant. PREFERS the tenant's own
 * structured `registrant_json` capture (SetupInfrastructureInput.registrant
 * — the only source with firstName/lastName/email/phone/city/state/country/
 * postalCode); falls back to the ORIGINAL brand/physicalAddress-derived
 * partial (organization <- brand, addressLine1 <- physicalAddress) when no
 * structured registrant was ever captured, so a tenant who opted in before
 * this capture existed still gets the same partial object as before (rather
 * than an empty one) — `assertCompleteRegistrant`'s fail-loud boundary
 * either way names whatever remains missing. `senderIdentity` is a free-text
 * signature line appended to outbound emails (engine/tick.ts's compliance
 * footer — e.g. "Sales Team" or a person's name), NOT a structured registrant
 * name, so it is deliberately never split into firstName/lastName: doing so
 * would INVENT structure the tenant never actually provided. Returns a
 * POSSIBLY-INCOMPLETE object on purpose — this function never throws, so an
 * incomplete profile never bricks adapter construction (mailbox/email/billing
 * stay reachable); `assertCompleteRegistrant` below is the fail-loud
 * boundary, enforced at the actual domain-buy call site.
 */
export function deriveInboxKitRegistrant(profile: TenantContactFields): Partial<InboxKitDomainRegistrant> {
  const structured = parseRegistrantJson(profile.registrantJson);
  if (structured) {
    // `organization` is the ONE field Registrant leaves optional (it may
    // default from brand — a 1:1 mapping, not invention, see intents.ts's
    // Registrant doc comment) — so it still gets the same brand fallback here.
    return { ...structured, organization: structured.organization || profile.brand || undefined };
  }
  return {
    organization: profile.brand || undefined,
    addressLine1: profile.physicalAddress || undefined,
  };
}

const REQUIRED_REGISTRANT_FIELDS: Array<keyof InboxKitDomainRegistrant> = [
  "firstName",
  "lastName",
  "email",
  "phone",
  "organization",
  "addressLine1",
  "city",
  "state",
  "country",
  "postalCode",
];

/**
 * The fail-loud boundary ("fail loud naming missing fields; never invent
 * values"). Called at the ACTUAL domain-buy call site
 * (provisioning.ts's provisionDomainWithMailboxes), never at adapter-
 * construction time, so an incomplete registrant never bricks unrelated
 * intents (inbox/campaigns/etc) for a tenant who opted in with a thin
 * profile — only the one call that would actually spend real money on a
 * domain purchase. Throws BEFORE any real vendor call (searchLookalikes) and
 * BEFORE the withSpendCeiling reservation, so no reservation is ever leaked
 * and no partially-blank contact_details payload is ever sent to InboxKit.
 */
export function assertCompleteRegistrant(candidate: Partial<InboxKitDomainRegistrant>): InboxKitDomainRegistrant {
  const missing = REQUIRED_REGISTRANT_FIELDS.filter((field) => !candidate[field]);
  if (missing.length > 0) {
    throw new IncompleteRegistrantError(
      `InboxKit domain registration requires registrant contact fields this platform hasn't captured yet: ${missing.join(", ")} ` +
        `(the structured registrant captured via setup_infrastructure's registrant field is missing these — never invented). ` +
        `registerDomains cannot proceed until these are captured.`,
      missing,
    );
  }
  return candidate as InboxKitDomainRegistrant;
}

export interface RegistrarOptInState {
  readonly optIn: boolean;
  readonly registrant: Partial<InboxKitDomainRegistrant>;
}

/**
 * Leg 2 — a FRESH per-tenant read (mirrors engine/activation.ts's
 * readActivationState discipline: no caller may cache this across a
 * setup_infrastructure call that flips the opt-in). `register_domains` is the
 * tenant's persisted, informed consent — PER-TENANT, so it also governs the
 * deliverability control loop's REPLACE_DOMAIN burn-replacement buys, which
 * never go through setup_infrastructure's request body directly.
 */
export function readRegistrarOptInState(sql: SqlStorage, tenantId: string): RegistrarOptInState {
  const row = sql
    .exec<{
      register_domains: number;
      brand: string;
      physical_address: string;
      sender_identity: string;
      registrant_json: string | null;
    }>(
      `SELECT register_domains, brand, physical_address, sender_identity, registrant_json FROM tenant_profile WHERE id = ?`,
      tenantId,
    )
    .toArray()[0];
  if (!row) return { optIn: false, registrant: {} };
  return {
    optIn: row.register_domains === 1,
    registrant: deriveInboxKitRegistrant({
      brand: row.brand,
      physicalAddress: row.physical_address,
      senderIdentity: row.sender_identity,
      registrantJson: row.registrant_json,
    }),
  };
}

export interface RegistrarArmingInput {
  readonly armed: boolean;
  readonly optIn: boolean;
  readonly registrant: Partial<InboxKitDomainRegistrant>;
}

/** Combines both legs — the single call `tenant-do.ts`'s buildAdapters() needs. */
export function readRegistrarArming(env: Env, sql: SqlStorage, tenantId: string): RegistrarArmingInput {
  const { optIn, registrant } = readRegistrarOptInState(sql, tenantId);
  return { armed: isInboxKitRegistrarArmed(env), optIn, registrant };
}
