import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  domainIntentKey,
  domainIntentOrdinal,
  mailboxIntentKey,
  replacementDomainIntentKey,
} from "../src/engine/provision-intents.js";
import { api, mintTenant, tenantStub } from "./helpers.js";

// ══ THE C1 GUARD ═════════════════════════════════════════════════════════════
//
// C1 (ROADMAP.md, the 2026-08-13 P0): *a durable key's DERIVATION changed with
// no migration.* `85f48af` moved the domain buy-intent key from
// `${setupKey ?? `tenant:${tenantId}`}#${ordinal}` to
// `tenant:${tenantId}#${ordinal}`. Rows written under the old shape became
// unreadable, an unreadable buy-intent re-enters the "never bought" branch, and
// a customer's retry bought a second domain. The suite was green through all of
// it, because every fixture seeds state through the CURRENT derivation — both
// sides of the comparison move together.
//
// THIS FILE PINS THE DERIVATIONS TO LITERALS. Any edit to one of the functions
// below fails here, at BUILD time, with this instruction:
//
//   ▸ You have changed a PERSISTED key derivation. Rows already written under
//     the old shape will not be read by the new one. Before updating the
//     literal: add a dated one-shot backfill (the 2026-08-13 precedent is
//     src/engine/legacy-domain-intent-keys.ts, wired into the TenantDO
//     constructor) and a fixture that seeds the PREVIOUS derivation BY LITERAL
//     (test/legacy-domain-intent-key.test.ts).
//
// WHY A TEST AND NOT A VERSION STAMP ON THE ROWS. A `key_version` column
// asserted at read fails in PRODUCTION, after the deploy that broke it — the
// exact too-late failure this class is about. Worse, it cannot classify the
// rows that matter: every row predating the column defaults to the same
// version whether it was written under the old derivation or the new one, so
// on the live customer's own data (a NEW-key intent and an OLD-key intent
// side by side, both pre-column) the stamp is a false discriminator. The
// derivation's own output is the only honest signal, and comparing it to a
// frozen literal is what makes a change impossible to ship unnoticed.
//
// ── THE INVENTORY (sweep, 2026-08-13) ───────────────────────────────────────
// PINNED HERE — a key whose orphaning costs a VENDOR PURCHASE:
//   • domainIntentKey            -> domain_intents.key        (money: a domain)
//   • replacementDomainIntentKey -> domain_intents.key        (money: a domain)
//       the deliverability loop's burn replacement — a SECOND writer of the
//       same table, which is why "not the setup shape" can never alone mean
//       "orphaned" (engine/legacy-domain-intent-keys.ts depends on this).
//   • mailboxIntentKey           -> mailbox_intents.key,      (money: a mailbox)
//                                   mailbox_buy_dispatches.intent_key,
//                                   request_idempotency.key via `provision:`
//       VERIFIED UNCHANGED since it was introduced (00a6230) — it is the
//       shape domainIntentKey was moved TO, not one that moved.
// PINNED BY BEHAVIOUR BELOW — the request_idempotency namespaces
// (`setup_infrastructure:`, `launch_campaign:`, `reply:`, `remove_mailboxes:`,
// `provision:`). Orphaning one costs a REPLAY, not a purchase: the re-run's
// spend is gated by the intent rows above. `setup_infrastructure:` is asserted
// through the real route because it is the one that interacts with them.
// DELIBERATELY NOT PINNED — keys handed to a vendor port
// (`buy:`/`dns:`/`warmup:`/`send:`/`liability:`/`mbxqty:`). No local read
// resolves a row BY these; the InboxKit ports ignore them outright
// (vendors/real/inboxkit-domain-port.ts's `_idempotencyKey`). Changing one
// cannot orphan a lookup, so it is not in this class.
// ═════════════════════════════════════════════════════════════════════════════

const TENANT = "ten_91aab24a";

describe("persisted key derivations are frozen", () => {
  it("domain_intents keys — both writers — derive exactly these strings", () => {
    expect(domainIntentKey(TENANT, 0)).toBe("tenant:ten_91aab24a#0");
    expect(domainIntentKey(TENANT, 7)).toBe("tenant:ten_91aab24a#7");
    expect(replacementDomainIntentKey(TENANT, "burned.com", 3)).toBe("replace:ten_91aab24a:burned.com#3");
  });

  it("mailbox_intents keys derive exactly this string", () => {
    expect(mailboxIntentKey(TENANT, "sender11@golookalike.com")).toBe("mbx:ten_91aab24a:sender11@golookalike.com");
  });

  it("the pre-85f48af domain-intent derivation is recorded, and only its KEYED form differs", () => {
    // The historical shape, kept as executable documentation rather than prose:
    // engine/legacy-domain-intent-keys.ts only rebinds rows the KEYED form
    // produced, and this is why that is sufficient. A caller who sent no
    // idempotency key got a string byte-identical to today's, so those rows
    // were never orphaned and need no migration.
    const legacy = (setupKey: string | undefined, ordinal: number) =>
      `${setupKey ?? `tenant:${TENANT}`}#${ordinal}`;

    expect(legacy("apd-setup-a-2mbx", 0)).toBe("apd-setup-a-2mbx#0"); // the live orphan, verbatim
    expect(legacy(undefined, 0)).toBe(domainIntentKey(TENANT, 0)); // unkeyed: no change, no orphan
    expect(legacy("apd-setup-a-2mbx", 0)).not.toBe(domainIntentKey(TENANT, 0));
  });

  it("domainIntentOrdinal is the exact inverse of domainIntentKey", () => {
    for (const ordinal of [0, 1, 9, 10, 4096]) {
      expect(domainIntentOrdinal(TENANT, domainIntentKey(TENANT, ordinal))).toBe(ordinal);
    }
  });

  it("domainIntentOrdinal rejects every key domainIntentKey could not have written", () => {
    // Each of these would, under a lenient parse, report an ordinal as OCCUPIED
    // on the strength of a row nothing ever reads back — which would push a
    // rebound orphan to a higher ordinal for no reason, or (for the replacement
    // key) silently claim a slot the setup path owns.
    for (const key of [
      "tenant:ten_91aab24a#01", // non-canonical: domainIntentKey(…, 1) writes `#1`
      "tenant:ten_91aab24a# 1",
      "tenant:ten_91aab24a#-1",
      "tenant:ten_91aab24a#1.0",
      "tenant:ten_91aab24a#",
      "tenant:ten_91aab24a",
      "apd-setup-a-2mbx#0", // the legacy shape
      "tenant:ten_other#0", // another tenant's ordinal is not this tenant's
      replacementDomainIntentKey(TENANT, "burned.com", 0), // the sibling writer
    ]) {
      expect(domainIntentOrdinal(TENANT, key)).toBeUndefined();
    }
  });

  it("the request-idempotency namespace for setup_infrastructure is what the route actually writes", async () => {
    // Asserted through the real route rather than by reading the source: the
    // claim row is what a retry resolves against, so the namespace only matters
    // as the string that lands in the table. `quoteOnly` returns before any
    // vendor call, so this exercises the wrapper and nothing else.
    const { token, tenantId } = await mintTenant("Derivation Co", "demo");
    const res = await api("/setup-infrastructure", {
      method: "POST",
      token,
      headers: { "idempotency-key": "abc-123" },
      body: JSON.stringify({
        brand: "Derivation Co",
        primaryDomain: "derivation.test",
        domains: 1,
        inboxesEach: 1,
        persona: "Sender",
        physicalAddress: "1 Main St",
        senderIdentity: "Derivation Co <hello@derivation.test>",
        quoteOnly: true,
      }),
    });
    expect(res.status).toBe(200);

    const keys = await runInDurableObject(tenantStub(tenantId), (_i, s) =>
      s.storage.sql.exec<{ key: string }>(`SELECT key FROM request_idempotency`).toArray(),
    );
    expect(keys).toEqual([{ key: "setup_infrastructure:abc-123" }]);
  });
});
