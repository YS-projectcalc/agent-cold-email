import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { NextStep, NextSteps } from "@coldstart/shared";
import { deriveNextSteps, owedSignals } from "../src/engine/next-steps.js";
import { DEFAULT_PROVISIONING_ORPHAN_GRACE_MS } from "../src/engine/ops-summary.js";
import { managedMailboxAddress } from "../src/engine/mailbox-provisioning.js";
import { domainIntentKey } from "../src/engine/provision-intents.js";
import { activatePaidPlan, mintTenant, seedBenignSdnList, tenantStub, withTenantContext } from "./helpers.js";

// I6 — ALL GATING LIVES IN THE PRIMITIVE (design §7.4, §7.17.2, §7.18).
//
// THE STANDING RULE THIS FILE ENFORCES: every suppression, skip and exclusion
// in this wave goes in `deriveNextSteps`. A consumer needing its own filter is
// the signal that the primitive is under-specified.
//
// It is a rule because the same class has now been found on this project three
// times — a caveat attached to ONE consumer of a shared primitive rather than
// to the primitive. The N2 instance below is the sharpest: the nudge's own
// `tenant_messages` row, if it becomes a `message_action_required` owed step,
// sustains the very check that fires the nudge, so the episode's onset never
// advances and EVERY FUTURE STALL for that tenant is silently un-nudged —
// worse than a storm, because the un-nudged population is exactly the target
// one (an agent that is not acting is also not calling ack_message).

interface Ordinal {
  domain: string;
  liveMailboxes: number;
  /** 'committed' (default), or 'intent'/'dangling' for a requested-but-incomplete ordinal. */
  status?: string;
  /** Omit the `domains` row — with a non-committed status this is the ordinal_incomplete shape. */
  noDomainRow?: boolean;
  /** `domain_intents.updated_at`; defaults to "long past the grace bound". */
  updatedAt?: number;
  /** 'provisioned' (default) | 'byo'. */
  source?: string;
  byoStatus?: string;
}

interface Seed {
  ordinals?: Ordinal[];
  persona?: string;
  billedQuantity?: number;
  registerDomains?: 0 | 1;
  status?: string;
  billingState?: string;
  provisioningState?: string;
  messages?: { kind: string; severity: string; createdAt?: number }[];
}

let seq = 0;

async function seedTenant(seed: Seed): Promise<string> {
  const persona = seed.persona ?? "sender";
  const { tenantId } = await mintTenant(`Gating Co ${++seq}`, "managed");
  await seedBenignSdnList();
  await activatePaidPlan(tenantId, "managed");
  const now = Date.now();
  await runInDurableObject(tenantStub(tenantId), (_instance, state) => {
    const sql = state.storage.sql;
    sql.exec(
      `UPDATE tenant_profile
          SET primary_domain = ?, physical_address = ?, sender_identity = ?,
              mailbox_qty_synced = ?, register_domains = ?, status = ?, billing_state = ?, provisioning_state = ?
        WHERE id = ?`,
      "gatingco.com",
      "1 Main St, Testville, CA 94000",
      "Gating Co <hello@gatingco.com>",
      seed.billedQuantity ?? 5,
      seed.registerDomains ?? 1,
      seed.status ?? "active",
      seed.billingState ?? "active",
      seed.provisioningState ?? "ok",
      tenantId,
    );
    (seed.ordinals ?? []).forEach((ord, ordinal) => {
      sql.exec(
        `INSERT INTO domain_intents (key, tenant_id, candidate_domain, status, persona_slug, inboxes_each, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        domainIntentKey(tenantId, ordinal),
        tenantId,
        ord.domain,
        ord.status ?? "committed",
        persona,
        Math.max(1, ord.liveMailboxes),
        1000,
        ord.updatedAt ?? now - DEFAULT_PROVISIONING_ORPHAN_GRACE_MS * 10,
      );
      if (ord.noDomainRow) return;
      const domainId = `dom_${ordinal}_${tenantId}`;
      sql.exec(
        `INSERT INTO domains (id, tenant_id, domain, status, purchased_at, dns_status, source, byo_status)
         VALUES (?, ?, ?, 'active', ?, 'ready', ?, ?)`,
        domainId,
        tenantId,
        ord.domain,
        1000,
        ord.source ?? "provisioned",
        ord.byoStatus ?? "active",
      );
      for (let slot = 0; slot < ord.liveMailboxes; slot++) {
        const email = managedMailboxAddress(persona, ord.domain, ordinal, slot);
        sql.exec(
          `INSERT INTO mailboxes (id, tenant_id, domain_id, domain, email, daily_cap, warmup_started_at, created_at, provider, source)
           VALUES (?, ?, ?, ?, ?, 5, 1000, 1000, 'google', ?)`,
          `mbx_${email}`,
          tenantId,
          domainId,
          ord.domain,
          email,
          ord.source ?? "provisioned",
        );
      }
    });
    (seed.messages ?? []).forEach((msg, i) => {
      sql.exec(
        `INSERT INTO tenant_messages (id, tenant_id, kind, severity, body, source, created_at)
         VALUES (?, ?, ?, ?, ?, 'system', ?)`,
        `msg_${tenantId}_${i}`,
        tenantId,
        msg.kind,
        msg.severity,
        "a customer-safe sentence composed by the platform",
        msg.createdAt ?? now - 60_000,
      );
    });
  });
  return tenantId;
}

function derive(tenantId: string): Promise<NextSteps> {
  return withTenantContext(tenantId, (ctx) => deriveNextSteps(ctx));
}

function stepFor(steps: NextStep[], reason: string): NextStep | undefined {
  return steps.find((s) => s.reason === reason);
}

describe("I6 — the lifecycle gate lives in the PRIMITIVE, not in each consumer", () => {
  // The REAL predicate, read from engine/billing-state.ts rather than
  // hand-listed. v1's list named `terminated`, which is never a billing_state,
  // and omitted `status='suspended'`, which is half the real predicate.
  for (const billingState of ["disputed", "canceling", "canceled"]) {
    it(`billing_state '${billingState}' yields none_owed + a single account_frozen step`, async () => {
      const tenantId = await seedTenant({ ordinals: [], billedQuantity: 5, billingState });
      const derived = await derive(tenantId);
      expect(derived.status).toBe("none_owed");
      expect(derived.steps.map((s) => s.reason)).toEqual(["account_frozen"]);
      const step = derived.steps[0] as NextStep;
      expect(step.waitingOn).toBe("customer_billing");
      expect(step.action.via).toBe("http");
      if (step.action.via !== "http") throw new Error("unreachable");
      expect(step.action.method).toBe("POST");
      expect(step.action.path).toBe("/checkout");
    });
  }

  it("status 'suspended' is HALF the real predicate and is covered too", async () => {
    const tenantId = await seedTenant({ ordinals: [], billedQuantity: 5, status: "suspended" });
    const derived = await derive(tenantId);
    expect(derived.steps.map((s) => s.reason)).toEqual(["account_frozen"]);
  });

  it("'past_due' is NOT frozen — dunning keeps the account in scope", async () => {
    const tenantId = await seedTenant({ ordinals: [], billedQuantity: 5, billingState: "past_due" });
    const derived = await derive(tenantId);
    expect(stepFor(derived.steps, "account_frozen")).toBeUndefined();
    expect(stepFor(derived.steps, "paid_seats_unprovisioned")).toBeDefined();
  });
});

describe("I6 — a tenant who pays nothing is never told what they are billed", () => {
  it("mailbox_qty_synced = 0 (demo / free / simulated) yields none_owed with no steps", async () => {
    const tenantId = await seedTenant({ ordinals: [], billedQuantity: 0 });
    const derived = await derive(tenantId);
    expect(derived.status).toBe("none_owed");
    expect(derived.steps).toEqual([]);
  });

  it("the `max(5,0) - 0 = 5` false billing sentence can never reach them", async () => {
    const tenantId = await seedTenant({ ordinals: [{ domain: "demo.com", liveMailboxes: 2 }], billedQuantity: 0 });
    const derived = await derive(tenantId);
    for (const step of derived.steps) {
      expect(step.reason).not.toBe("seat_headroom_free");
      expect(step.reason).not.toBe("paid_seats_unprovisioned");
    }
  });
});

describe("I6 — N1: the drift arm inherits the sync's OWN eligibility conjunct", () => {
  // `syncMailboxQuantity` returns early on `billing_state !== 'active'` WITHOUT
  // advancing `mailbox_qty_synced`. A `past_due` tenant is not lifecycle-frozen,
  // so it stays in scope; grading drift `waitingOn:'operator'` routes it to the
  // EMAIL channel, and a past_due tenant whose domain burns has no path to
  // clear for the whole dunning window — a daily founder email for documented,
  // correct behaviour.
  //
  // A check that reports "a push is overdue" must carry the same eligibility
  // predicate as the push.
  it("a past_due tenant with a quantity gap does NOT get billed_quantity_drift", async () => {
    const tenantId = await seedTenant({
      ordinals: [
        { domain: "n1a.com", liveMailboxes: 3 },
        { domain: "n1b.com", liveMailboxes: 2 },
      ],
      billedQuantity: 6,
      billingState: "past_due",
    });
    const derived = await derive(tenantId);
    expect(stepFor(derived.steps, "billed_quantity_drift")).toBeUndefined();
  });

  it("the SAME gap on an ACTIVE tenant does", async () => {
    const tenantId = await seedTenant({
      ordinals: [
        { domain: "n1c.com", liveMailboxes: 3 },
        { domain: "n1d.com", liveMailboxes: 2 },
      ],
      billedQuantity: 6,
      billingState: "active",
    });
    const derived = await derive(tenantId);
    expect(stepFor(derived.steps, "billed_quantity_drift")?.waitingOn).toBe("operator");
  });
});

describe("I6 — N2: the continuity_nudge exclusion lives HERE", () => {
  it("a tenant whose ONLY unacked message is a continuity_nudge derives owedCount === 0", async () => {
    const tenantId = await seedTenant({
      ordinals: [
        { domain: "n2a.com", liveMailboxes: 3 },
        { domain: "n2b.com", liveMailboxes: 2 },
      ],
      billedQuantity: 5,
      messages: [{ kind: "continuity_nudge", severity: "action_required" }],
    });
    const derived = await derive(tenantId);
    expect(owedSignals(derived).owedCount).toBe(0);
    expect(stepFor(derived.steps, "message_action_required")).toBeUndefined();
    expect(derived.status).toBe("none_owed");
  });

  it("any OTHER action_required message still counts — the exclusion is by KIND, not a blanket mute", async () => {
    const tenantId = await seedTenant({
      ordinals: [
        { domain: "n2c.com", liveMailboxes: 3 },
        { domain: "n2d.com", liveMailboxes: 2 },
      ],
      billedQuantity: 5,
      // `send_blocked`, not `retry_setup`: this assertion is about the KIND
      // exclusion not being a blanket mute, and `retry_setup` acquired its own
      // re-derivation rule (BLOCKING-2, build gate 2026-08-19) — on a fleet
      // whose setup family is empty it is a RESOLVED row by construction, so it
      // would no longer be a fair stand-in for "any other action item".
      messages: [{ kind: "send_blocked", severity: "action_required" }],
    });
    const derived = await derive(tenantId);
    expect(owedSignals(derived).owedCount).toBeGreaterThan(0);
    expect(stepFor(derived.steps, "message_action_required")).toBeDefined();
  });

  it("a nudge alongside a real action item does not mask the real one", async () => {
    const tenantId = await seedTenant({
      ordinals: [
        { domain: "n2e.com", liveMailboxes: 3 },
        { domain: "n2f.com", liveMailboxes: 2 },
      ],
      billedQuantity: 5,
      messages: [
        { kind: "continuity_nudge", severity: "action_required" },
        // See the note above: a kind with no re-derivation rule of its own, so
        // this stays a test of the nudge exclusion and nothing else.
        { kind: "send_blocked", severity: "action_required" },
      ],
    });
    const derived = await derive(tenantId);
    const step = stepFor(derived.steps, "message_action_required");
    expect(step).toBeDefined();
    // ONE unacked item, not two — the nudge is invisible to the count.
    expect(step?.why).toContain("1 unread message");
  });
});

describe("I6 — §7.18.2's eleventh reason: ordinal_incomplete", () => {
  const requestedButIncomplete: Ordinal = { domain: "orph.com", liveMailboxes: 0, status: "intent", noDomainRow: true };

  it("an 'intent' row with no live domain, past grace, is an OWED step", async () => {
    const tenantId = await seedTenant({
      ordinals: [{ domain: "ord0.com", liveMailboxes: 2 }, requestedButIncomplete],
      billedQuantity: 5,
    });
    const derived = await derive(tenantId);
    const step = stepFor(derived.steps, "ordinal_incomplete");
    expect(step?.kind).toBe("owed");
    expect(step?.action.via).toBe("mcp_tool");
    expect(step?.sinceMs).toBeGreaterThan(DEFAULT_PROVISIONING_ORPHAN_GRACE_MS);
  });

  it("a 'dangling' row (the buy leg threw — we MAY own it) counts too", async () => {
    const tenantId = await seedTenant({
      ordinals: [{ domain: "ord1.com", liveMailboxes: 2 }, { ...requestedButIncomplete, status: "dangling" }],
      billedQuantity: 5,
    });
    expect(stepFor((await derive(tenantId)).steps, "ordinal_incomplete")).toBeDefined();
  });

  it("inside the grace window it does NOT fire — a purchase legitimately sits mid-saga", async () => {
    const tenantId = await seedTenant({
      ordinals: [{ domain: "ord2.com", liveMailboxes: 2 }, { ...requestedButIncomplete, updatedAt: Date.now() - 1000 }],
      billedQuantity: 5,
    });
    expect(stepFor((await derive(tenantId)).steps, "ordinal_incomplete")).toBeUndefined();
  });

  it("a HEALED ordinal yields none — the predicate is STATE, never the log row", async () => {
    const tenantId = await seedTenant({
      ordinals: [{ domain: "ord3.com", liveMailboxes: 2 }, { domain: "healed.com", liveMailboxes: 1 }],
      billedQuantity: 5,
    });
    // The DOMAIN_ORDINAL_FAILED activity row from the failed attempt survives a
    // retry that succeeded — a log row is not state, and predicating on one
    // would pin a healed tenant as broken forever.
    await withTenantContext(tenantId, (ctx) => {
      ctx.sql.exec(
        `INSERT INTO deliverability_actions (id, tenant_id, action, target, detail_json, ts)
         VALUES (?, ?, 'DOMAIN_ORDINAL_FAILED', 'healed.com', '{}', ?)`,
        `act_${ctx.tenantId}`,
        ctx.tenantId,
        1000,
      );
    });
    expect(stepFor((await derive(tenantId)).steps, "ordinal_incomplete")).toBeUndefined();
  });

  // §7.19, on the anchor this reason ages from. `domain_intents.updated_at` is
  // stamped from `ctx.clock` and is NOT in the clock migration's shift list, so
  // a tenant that provisioned on the demo VirtualClock and later upgraded
  // carries a FUTURE-dated value.
  //
  // UNCLAMPED that value makes `now - updated_at` NEGATIVE, permanently below
  // any grace bound, so this reason silently never fires FOR THAT TENANT no
  // matter how much real time passes — on precisely the population most likely
  // to be carrying a half-finished setup.
  //
  // CLAMPED it reads as age 0 and then GROWS with real wall-clock, so the
  // reason fires once the grace bound genuinely elapses. The clamp understates
  // age, which delays a report and can never produce one early — the correct
  // direction. What the two tests below pin is that the age is never negative
  // and the tenant is never permanently excluded; test/clamped-age.test.ts
  // proves the arithmetic and the no-raw-subtraction tripwire.
  it("a FUTURE-DATED anchor reads as age 0 rather than negative, so it is only DELAYED, never disabled", async () => {
    const tenantId = await seedTenant({
      ordinals: [
        { domain: "ord4.com", liveMailboxes: 2 },
        { ...requestedButIncomplete, updatedAt: Date.now() + 365 * 24 * 60 * 60 * 1000 },
      ],
      billedQuantity: 5,
    });
    const derived = await derive(tenantId);
    // Not yet: clamped age is 0, which is inside the grace window.
    expect(stepFor(derived.steps, "ordinal_incomplete")).toBeUndefined();
    // And NO step anywhere reports a negative age — a negative `sinceMs` is the
    // observable signature of the raw subtraction this rule exists to forbid.
    for (const step of derived.steps) {
      if (step.sinceMs !== null) expect(step.sinceMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("a future-dated DNS anchor reports sinceMs 0, never a negative age", async () => {
    const tenantId = await seedTenant({ ordinals: [{ domain: "futuredns.com", liveMailboxes: 2 }], billedQuantity: 5 });
    await withTenantContext(tenantId, (ctx) => {
      ctx.sql.exec(
        `UPDATE domains SET dns_status = 'pending', dns_first_checked_at = ? WHERE tenant_id = ?`,
        Date.now() + 365 * 24 * 60 * 60 * 1000,
        ctx.tenantId,
      );
    });
    const step = stepFor((await derive(tenantId)).steps, "domain_dns_incomplete");
    expect(step).toBeDefined();
    expect(step?.sinceMs).toBe(0);
  });
});

describe("I6 — E2: suppress the ACTION, never the FACT (the BYO composition table)", () => {
  it("a BYO-ONLY tenant at the floor RECEIVES seat_headroom_free, with a BYO action", async () => {
    const tenantId = await seedTenant({
      ordinals: [{ domain: "byoonly.com", liveMailboxes: 2, source: "byo", byoStatus: "active" }],
      billedQuantity: 5,
    });
    const step = stepFor((await derive(tenantId)).steps, "seat_headroom_free");
    expect(step?.kind).toBe("available");
    expect(step?.action.via).toBe("mcp_tool");
    if (step?.action.via !== "mcp_tool") throw new Error("unreachable");
    expect(step.action.tool).toBe("configure_byo_domain");
    expect(step.action.params.action).toBe("request_managed_mailboxes");
    expect(step.action.params.count).toBe(3);
    expect(step.action.params.id).toBeTruthy();
  });

  it("a BYO-only tenant with NO active domain still hears the FACT, with via:'none'", async () => {
    const tenantId = await seedTenant({
      ordinals: [{ domain: "byopending.com", liveMailboxes: 2, source: "byo", byoStatus: "pending_dns" }],
      billedQuantity: 5,
    });
    const step = stepFor((await derive(tenantId)).steps, "seat_headroom_free");
    expect(step).toBeDefined();
    expect(step?.action.via).toBe("none");
  });

  // THE HALF E2 FLAGS AS A LIVE DEFECT: a single `source='byo'` row suppressing
  // the managed side entirely for a tenant running BOTH.
  it("a MIXED tenant gets the MANAGED action — they already run that path, so it is proven for them", async () => {
    const tenantId = await seedTenant({
      ordinals: [
        { domain: "mixedmanaged.com", liveMailboxes: 1, source: "provisioned" },
        { domain: "mixedbyo.com", liveMailboxes: 1, source: "byo", byoStatus: "active" },
      ],
      billedQuantity: 5,
    });
    const step = stepFor((await derive(tenantId)).steps, "seat_headroom_free");
    expect(step).toBeDefined();
    if (step?.action.via !== "mcp_tool") throw new Error("expected an mcp_tool action");
    expect(step.action.tool).toBe("setup_infrastructure");
  });

  it("a BYO-only tenant is never told to buy a managed lookalike domain", async () => {
    const tenantId = await seedTenant({
      ordinals: [{ domain: "byonone.com", liveMailboxes: 0, source: "byo", byoStatus: "active" }],
      billedQuantity: 5,
    });
    for (const step of (await derive(tenantId)).steps) {
      if (step.action.via !== "mcp_tool") continue;
      expect(step.action.tool).not.toBe("setup_infrastructure");
    }
  });
});

describe("I6 — E1: seat_headroom_free is emitted ONLY when nothing is owed", () => {
  // `seat_headroom_free` covers the whole band 0 < billable < 5, and that band
  // includes a tenant whose remaining ordinals HARD-FAILED. Telling them "the
  // remaining 2 add $0 to your bill" is the platform's most confident-sounding
  // sentence delivered on its least healthy state, to an unattended agent.
  //
  // The predicate is deliberately NOT a fix that depends on having enumerated
  // every gap in the reason list: if ANYTHING is owed, the free-headroom line is
  // noise at best and misdirection at worst.
  it("an owed reason present in the band SUPPRESSES it", async () => {
    const tenantId = await seedTenant({
      ordinals: [
        { domain: "e1a.com", liveMailboxes: 2 },
        { domain: "e1b.com", liveMailboxes: 0, status: "intent", noDomainRow: true },
      ],
      billedQuantity: 5,
    });
    const derived = await derive(tenantId);
    expect(stepFor(derived.steps, "ordinal_incomplete")).toBeDefined();
    expect(stepFor(derived.steps, "seat_headroom_free")).toBeUndefined();
  });

  it("the same band with NOTHING owed emits it", async () => {
    const tenantId = await seedTenant({ ordinals: [{ domain: "e1c.com", liveMailboxes: 2 }], billedQuantity: 5 });
    const derived = await derive(tenantId);
    expect(owedSignals(derived).owedCount).toBe(0);
    expect(stepFor(derived.steps, "seat_headroom_free")).toBeDefined();
  });

  it("it stays suppressed by an owed reason from a DIFFERENT family — the predicate is owedCount, not a gap list", async () => {
    const tenantId = await seedTenant({
      ordinals: [{ domain: "e1d.com", liveMailboxes: 2 }],
      billedQuantity: 5,
      messages: [{ kind: "setup_failed", severity: "operator_pending" }],
    });
    const derived = await derive(tenantId);
    expect(stepFor(derived.steps, "setup_operator_blocked")).toBeDefined();
    expect(stepFor(derived.steps, "seat_headroom_free")).toBeUndefined();
  });
});

describe("I6 — E3: the founder ruling was 'emit, AND NOTHING CHASES THEM'", () => {
  // Four assertions rather than one, because each link is separately breakable
  // by an ordinary derivation edit — and because this guard is enforcing a
  // FOUNDER RULING, not a design preference. A later change flipping `kind` to
  // 'owed' would put it into owedCount, which sustains the stuck-customer
  // check, which alerts and eventually nudges: B5's permanent cry-wolf
  // re-created on a signal ratified as SILENT, for every paying customer under
  // five mailboxes.
  const matrix: Seed[] = [
    { ordinals: [{ domain: "e3a.com", liveMailboxes: 1 }], billedQuantity: 5 },
    { ordinals: [{ domain: "e3b.com", liveMailboxes: 2 }], billedQuantity: 5 },
    { ordinals: [{ domain: "e3c.com", liveMailboxes: 3 }], billedQuantity: 5 },
    { ordinals: [{ domain: "e3d.com", liveMailboxes: 3 }, { domain: "e3e.com", liveMailboxes: 1 }], billedQuantity: 5 },
    { ordinals: [{ domain: "e3f.com", liveMailboxes: 2, source: "byo", byoStatus: "active" }], billedQuantity: 5 },
    { ordinals: [{ domain: "e3g.com", liveMailboxes: 2, source: "byo", byoStatus: "pending_dns" }], billedQuantity: 5 },
    { ordinals: [{ domain: "e3h.com", liveMailboxes: 2 }], billedQuantity: 5, registerDomains: 0 },
    { ordinals: [{ domain: "e3i.com", liveMailboxes: 2 }], billedQuantity: 3 },
  ];

  it("over the whole fixture matrix, seat_headroom_free never chases anyone", async () => {
    let seen = 0;
    for (const seed of matrix) {
      const derived = await derive(await seedTenant(seed));
      const step = stepFor(derived.steps, "seat_headroom_free");
      if (!step) continue;
      seen++;
      // (1) never `owed`.
      expect(step.kind).toBe("available");
      const signals = owedSignals(derived);
      // (2) never in owedReasons, never contributes to owedCount.
      expect(signals.owedReasons).not.toContain("seat_headroom_free");
      // (3) the stuck-customer check is named off `owedCount > 0`, so a run
      // whose ONLY step is this one must leave the count at zero.
      if (derived.steps.length === 1) expect(signals.owedCount).toBe(0);
      // (4) the nudge fires off that same check, so the same zero disarms it.
      expect(derived.status === "owed" && signals.owedCount === 0).toBe(false);
      expect(step.waitingOn).toBeNull();
    }
    // The guard must actually have seen the signal it is guarding.
    expect(seen).toBeGreaterThanOrEqual(6);
  });
});

describe("I6 — owedSignals is the projection the RPC payload carries", () => {
  it("carries reasons, a count and the oldest owed anchor — never full step prose", async () => {
    const tenantId = await seedTenant({
      ordinals: [{ domain: "sig0.com", liveMailboxes: 2 }, { domain: "sig1.com", liveMailboxes: 0, status: "intent", noDomainRow: true }],
      billedQuantity: 5,
    });
    const signals = owedSignals(await derive(tenantId));
    expect(signals.owedCount).toBeGreaterThan(0);
    expect(signals.owedReasons).toContain("ordinal_incomplete");
    expect(signals.oldestOwedSinceMs).toBeGreaterThan(0);
    expect(Object.keys(signals).sort()).toEqual(["anyOwedWaitingOnOperator", "oldestOwedSinceMs", "owedCount", "owedReasons"]);
  });

  it("a tenant with nothing owed reports a null oldest anchor, not a zero", async () => {
    const tenantId = await seedTenant({ ordinals: [{ domain: "sig2.com", liveMailboxes: 2 }], billedQuantity: 5 });
    const signals = owedSignals(await derive(tenantId));
    expect(signals.owedCount).toBe(0);
    expect(signals.oldestOwedSinceMs).toBeNull();
  });
});
