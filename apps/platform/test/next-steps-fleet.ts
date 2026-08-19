import { runInDurableObject } from "cloudflare:test";
import { managedMailboxAddress } from "../src/engine/mailbox-provisioning.js";
import { DEFAULT_PROVISIONING_ORPHAN_GRACE_MS } from "../src/engine/ops-summary.js";
import { domainIntentKey } from "../src/engine/provision-intents.js";
import { activatePaidPlan, mintTenant, seedBenignSdnList, tenantStub } from "./helpers.js";

/**
 * The provisioning fleets `deriveNextSteps` is tested against, in ONE seeder.
 *
 * Lives beside the tests rather than inside one of them because the billing
 * -effect class guard (test/next-steps-billing-effect-guard.test.ts) has to run
 * over the SAME fixtures the per-reason tests use — a guard with its own private
 * fleet shapes proves the invariant only on the states its author thought of,
 * which is the failure mode it exists to prevent.
 */
export interface Ordinal {
  domain: string;
  /** Slots this ordinal ACTUALLY holds (contiguous from 0). */
  liveMailboxes: number;
  /** `domain_intents.inboxes_each` — what the provisioning call ASKED for. Defaults to `liveMailboxes` (a finished ordinal). */
  requestedSlots?: number | null;
  status?: string;
  noDomainRow?: boolean;
  dnsReady?: boolean;
  source?: string;
  updatedAt?: number;
  /** `domains.status`. 'active' unless a burn / retirement is being modelled. */
  domainStatus?: string;
  /**
   * Slot indexes that WERE created and were later released — the durable
   * "this address really existed" record every removal path leaves behind
   * (`releaseMailboxes` marks `released_at`; nothing deletes a mailbox row).
   */
  releasedSlots?: number[];
  /** `domain_intents.persona_slug`. Differs from the live addresses' persona in the drift case. */
  persona?: string;
  /** LIVE mailboxes on this domain addressed under a DIFFERENT persona than the intent's. */
  driftedSlots?: { persona: string; slot: number }[];
  /** `mailboxes.created_at` for this ordinal's rows — the shortfall's own onset anchor. */
  mailboxCreatedAt?: number;
}

export interface Seed {
  ordinals: Ordinal[];
  billedQuantity?: number;
}

export const PERSONA = "mordytee";

let seq = 0;

export async function seedTenant(seed: Seed): Promise<string> {
  const { tenantId } = await mintTenant(`Slot Shortfall Co ${++seq}`, "managed");
  await seedBenignSdnList();
  await activatePaidPlan(tenantId, "managed");
  const now = Date.now();
  await runInDurableObject(tenantStub(tenantId), (_instance, state) => {
    const sql = state.storage.sql;
    sql.exec(
      `UPDATE tenant_profile
          SET primary_domain = ?, physical_address = ?, sender_identity = ?, mailbox_qty_synced = ?, register_domains = 1
        WHERE id = ?`,
      "authorpitchdesk.com",
      "1 Press Way, Testville, CA 94000",
      "Press Outreach <hello@authorpitchdesk.com>",
      seed.billedQuantity ?? 5,
      tenantId,
    );
    seed.ordinals.forEach((ord, ordinal) => {
      const requested = ord.requestedSlots === undefined ? Math.max(1, ord.liveMailboxes) : ord.requestedSlots;
      const persona = ord.persona ?? PERSONA;
      sql.exec(
        `INSERT INTO domain_intents (key, tenant_id, candidate_domain, status, persona_slug, inboxes_each, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        domainIntentKey(tenantId, ordinal),
        tenantId,
        ord.domain,
        ord.status ?? "committed",
        requested === null ? null : persona,
        requested,
        1000,
        ord.updatedAt ?? now - DEFAULT_PROVISIONING_ORPHAN_GRACE_MS * 10,
      );
      if (ord.noDomainRow) return;
      const domainId = `dom_${ordinal}_${tenantId}`;
      sql.exec(
        `INSERT INTO domains (id, tenant_id, domain, status, purchased_at, dns_status, source)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        domainId,
        tenantId,
        ord.domain,
        ord.domainStatus ?? "active",
        1000,
        ord.dnsReady === false ? "pending" : "ready",
        ord.source ?? "provisioned",
      );
      const insertMailbox = (email: string, releasedAt: number | null): void => {
        sql.exec(
          `INSERT INTO mailboxes (id, tenant_id, domain_id, domain, email, daily_cap, warmup_started_at, created_at, provider, released_at)
           VALUES (?, ?, ?, ?, ?, 5, 1000, ?, 'google', ?)`,
          `mbx_${email}${releasedAt === null ? "" : "_rel"}`,
          tenantId,
          domainId,
          ord.domain,
          email,
          ord.mailboxCreatedAt ?? 1000,
          releasedAt,
        );
      };
      for (let slot = 0; slot < ord.liveMailboxes; slot++) {
        insertMailbox(managedMailboxAddress(persona, ord.domain, ordinal, slot), null);
      }
      for (const slot of ord.releasedSlots ?? []) {
        insertMailbox(managedMailboxAddress(persona, ord.domain, ordinal, slot), now - 1000);
      }
      for (const drifted of ord.driftedSlots ?? []) {
        insertMailbox(managedMailboxAddress(drifted.persona, ord.domain, ordinal, drifted.slot), null);
      }
    });
  });
  return tenantId;
}
