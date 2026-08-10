import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  api,
  mintTenant,
  postDisputeWebhook,
  postWebhook,
  seedBenignSdnList,
  tenantStub,
  TEST_STRIPE_WEBHOOK_SECRET,
} from "./helpers.js";
import {
  checkoutSessionCompleted,
  disputeClosed,
  disputeCreated,
  invoicePaymentFailed,
  stripeCustomerIdFor,
  subscriptionDeleted,
  subscriptionUpdated,
} from "./stripe-fixtures.js";

// Full-boundary fixes for docs/adversarial/audit-stripe-webhook-2026-08-06.md
// (findings 1, 2, 3, 4, 5, 8). Every payload here is a REAL Stripe object shape
// (test/stripe-fixtures.ts) — the audit's central lesson is that fixtures which
// hand-decorate an Invoice or Dispute with `metadata.tenantId` retire the exact
// attack that would have caught the bug, and this suite was 1271 tests green
// while two whole billing lanes were inert in production.

const T0 = 1_786_000_000;

/** Signs a body with an EXPLICIT timestamp + secret, for the tolerance and
 *  multi-signature cases (helpers.ts's signer always uses "now"). */
async function signWith(payload: string, timestamp: number | string, secret: string = TEST_STRIPE_WEBHOOK_SECRET): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sigBuf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${payload}`));
  return [...new Uint8Array(sigBuf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function postSigned<T = unknown>(event: unknown, header: string): Promise<{ status: number; body: T }> {
  return api<T>("/webhooks/stripe", { method: "POST", headers: { "stripe-signature": header }, body: JSON.stringify(event) });
}

interface WebhookResponse {
  received: boolean;
  applied: boolean;
  duplicate?: boolean;
  stale?: boolean;
  completed?: boolean;
  reason?: string;
  frozen?: boolean;
}

// A `type` alias, not an `interface` — only the former satisfies
// `Record<string, SqlStorageValue>` (interfaces get no implicit index
// signature), which is why every other row shape in this suite is written
// this way too.
type ProfileRow = {
  billing_state: string;
  plan: string;
  screening_status: string;
  screened_at: number | null;
  stripe_mailbox_item_id: string | null;
};

function readProfile(tenantId: string): Promise<ProfileRow> {
  return runInDurableObject(tenantStub(tenantId), async (_i, state) =>
    state.storage.sql
      .exec<ProfileRow>(
        `SELECT billing_state, plan, screening_status, screened_at, stripe_mailbox_item_id FROM tenant_profile WHERE id = ?`,
        tenantId,
      )
      .one(),
  );
}

function countCheckoutLedgerRows(tenantId: string): Promise<number> {
  return runInDurableObject(tenantStub(tenantId), async (_i, state) =>
    state.storage.sql
      .exec<{ n: number }>(
        `SELECT COUNT(*) as n FROM ledger_entries WHERE tenant_id = ? AND description LIKE '%checkout.session.completed%'`,
        tenantId,
      )
      .one().n,
  );
}

/** Arms a Stripe test key for one delivery, the way quantity-sync.test.ts does.
 *  Narrow on purpose: a set key also arms isRealSpendArmed. */
async function withStripeKey<T>(fn: () => Promise<T>): Promise<T> {
  const saved = env.STRIPE_SECRET_KEY;
  (env as { STRIPE_SECRET_KEY?: string }).STRIPE_SECRET_KEY = "sk_test_boundary_fixture";
  try {
    return await fn();
  } finally {
    (env as { STRIPE_SECRET_KEY?: string }).STRIPE_SECRET_KEY = saved;
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("finding 1 — tenant resolution must work on REAL invoice and dispute payloads", () => {
  it("a realistic invoice.payment_failed (metadata {}, tenant only under subscription_details) marks the tenant past_due", async () => {
    const { tenantId } = await mintTenant("Realistic Invoice Co", "managed");
    await seedBenignSdnList();
    await postWebhook(checkoutSessionCompleted({ tenantId, created: T0 }));

    const res = await postWebhook<WebhookResponse>(
      invoicePaymentFailed({ tenantId, customerId: stripeCustomerIdFor(tenantId), created: T0 + 60 }),
    );

    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(true);
    expect((await readProfile(tenantId)).billing_state).toBe("past_due");
  });

  it("an invoice carrying NO metadata anywhere resolves through the customer index recorded at checkout", async () => {
    const { tenantId } = await mintTenant("Customer Index Co", "managed");
    await seedBenignSdnList();
    // The checkout is where we first learn `customer` AND the tenant together.
    await postWebhook(checkoutSessionCompleted({ tenantId, created: T0 }));

    // A real invoice whose subscription carried no metadata: the ONLY route back
    // to the tenant is `data.object.customer`.
    const res = await postWebhook<WebhookResponse>(
      invoicePaymentFailed({ tenantId: null, customerId: stripeCustomerIdFor(tenantId), created: T0 + 60 }),
    );

    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(true);
    expect((await readProfile(tenantId)).billing_state).toBe("past_due");
  });

  it("a realistic charge.dispute.created (no metadata, no customer field) freezes the tenant via its charge", async () => {
    const { tenantId } = await mintTenant("Realistic Dispute Co", "managed");
    await seedBenignSdnList();
    await postWebhook(checkoutSessionCompleted({ tenantId, created: T0 }));

    const res = await postDisputeWebhook<WebhookResponse>(
      disputeCreated({ chargeId: "ch_test_boundary_disputed", created: T0 + 120 }),
      tenantId,
    );

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ applied: true, frozen: true });
    expect((await readProfile(tenantId)).billing_state).toBe("disputed");
  });

  it("a dispute whose charge belongs to no tenant we know is accepted, not retried into oblivion", async () => {
    const res = await postDisputeWebhook<WebhookResponse>(
      disputeCreated({ chargeId: "ch_test_orphan" }),
      "ten_never_existed",
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ received: true, applied: false });
  });
});

describe("finding 2 — a Stripe hiccup mid-checkout must not permanently lose the compliance gate or the quantity capture", () => {
  it("a crash on the subscription round trip leaves screening DONE, and the retry completes the capture exactly once", async () => {
    const { tenantId } = await mintTenant("Crash Checkout Co", "managed");
    await seedBenignSdnList();
    const event = checkoutSessionCompleted({ tenantId, created: T0, subscriptionId: "sub_crash_1" });

    // Delivery #1: Stripe 500s on GET /v1/subscriptions/{id} — the exact hiccup
    // the audit forced with a bogus key.
    const first = await withStripeKey(async () => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response("stripe is having a moment", { status: 503 })));
      return postWebhook<WebhookResponse>(event);
    });
    expect(first.status).toBe(500);

    // The compliance gate ran BEFORE the vendor round trip, so the crash cannot
    // have skipped it (this is the fail-OPEN the audit found: screening_status
    // stayed at its 'clear' DEFAULT with screened_at NULL, leaving the crashed
    // tenant MORE activated than a clean one).
    const afterCrash = await readProfile(tenantId);
    expect(afterCrash.screened_at).not.toBeNull();
    expect(afterCrash.stripe_mailbox_item_id).toBeNull();

    // Delivery #2 is Stripe's retry of the SAME event id. It is still a
    // duplicate, but it must FINISH the half-applied event rather than no-op.
    const second = await withStripeKey(async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: unknown) => {
          if (String(url).includes("/subscriptions/")) {
            return new Response(
              JSON.stringify({
                items: {
                  data: [
                    { id: "si_platform_1", quantity: 1, price: { id: "price_p", lookup_key: "coldrig_platform_monthly_v1" } },
                    { id: "si_mailbox_1", quantity: 5, price: { id: "price_m", lookup_key: "coldrig_mailbox_monthly_v1" } },
                  ],
                },
              }),
              { status: 200 },
            );
          }
          return new Response("{}", { status: 200 });
        }),
      );
      return postWebhook<WebhookResponse>(event);
    });
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ duplicate: true, completed: true });

    const afterRetry = await readProfile(tenantId);
    expect(afterRetry.stripe_mailbox_item_id).toBe("si_mailbox_1");
    // The completion re-run must not double-write the checkout ledger entry.
    expect(await countCheckoutLedgerRows(tenantId)).toBe(1);
  });

  it("does NOT finish a half-applied checkout that a newer event has since superseded", async () => {
    // The F2 fix must not reopen F3 one door down: completing crashed work is
    // only correct while that work is still the newest thing that happened.
    const { tenantId } = await mintTenant("Superseded Crash Co", "managed");
    await seedBenignSdnList();
    const event = checkoutSessionCompleted({ tenantId, created: T0, subscriptionId: "sub_superseded" });

    const first = await withStripeKey(async () => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 503 })));
      return postWebhook<WebhookResponse>(event);
    });
    expect(first.status).toBe(500);
    expect((await readProfile(tenantId)).billing_state).toBe("active");

    // The customer cancels before Stripe's retry lands.
    await postWebhook(subscriptionUpdated({ tenantId, status: "canceled", created: T0 + 100 }));
    expect((await readProfile(tenantId)).billing_state).toBe("canceled");

    // The retry must not resurrect them by "finishing" the crashed checkout.
    const retry = await postWebhook<WebhookResponse>(event);
    expect(retry.body).toMatchObject({ applied: false, duplicate: true, stale: true });
    expect((await readProfile(tenantId)).billing_state).toBe("canceled");
  });

  it("two CONCURRENT deliveries of one checkout still apply exactly once (held attack)", async () => {
    const { tenantId } = await mintTenant("Concurrent Delivery Co", "managed");
    await seedBenignSdnList();
    const event = checkoutSessionCompleted({ tenantId, created: T0 });

    const [a, b] = await Promise.all([postWebhook<WebhookResponse>(event), postWebhook<WebhookResponse>(event)]);
    const applied = [a, b].filter((r) => r.body.applied);
    const duplicates = [a, b].filter((r) => r.body.duplicate);
    expect(applied).toHaveLength(1);
    expect(duplicates).toHaveLength(1);
    expect(await countCheckoutLedgerRows(tenantId)).toBe(1);
    expect((await readProfile(tenantId)).billing_state).toBe("active");
  });

  it("an ordinary duplicate (nothing in flight) stays a pure no-op", async () => {
    const { tenantId } = await mintTenant("Plain Duplicate Co", "managed");
    await seedBenignSdnList();
    const event = checkoutSessionCompleted({ tenantId, created: T0 });

    const first = await postWebhook<WebhookResponse>(event);
    expect(first.body).toMatchObject({ applied: true, duplicate: false });

    const second = await postWebhook<WebhookResponse>(event);
    expect(second.body).toMatchObject({ applied: false, duplicate: true });
    expect(second.body.completed).toBeUndefined();
    expect(await countCheckoutLedgerRows(tenantId)).toBe(1);
  });
});

describe("finding 3 — a stale redelivered payment failure must not de-activate a recovered payer", () => {
  it("refuses an invoice.payment_failed older than the recovery that superseded it", async () => {
    const { tenantId } = await mintTenant("Recovered Payer Co", "managed");
    await seedBenignSdnList();
    await postWebhook(checkoutSessionCompleted({ tenantId, created: T0 }));

    // The card fails...
    await postWebhook(invoicePaymentFailed({ tenantId, customerId: stripeCustomerIdFor(tenantId), created: T0 + 100 }));
    expect((await readProfile(tenantId)).billing_state).toBe("past_due");

    // ...the customer fixes it and the subscription recovers.
    await postWebhook(subscriptionUpdated({ tenantId, status: "active", created: T0 + 200 }));
    expect((await readProfile(tenantId)).billing_state).toBe("active");

    // Stripe finally lands the failure it had been retrying since before the
    // recovery (a fresh event id: the original delivery never got as far as the
    // dedup claim, which is exactly what a 500 or an unresolved tenant produced).
    const stale = await postWebhook<WebhookResponse>(
      invoicePaymentFailed({ tenantId, customerId: stripeCustomerIdFor(tenantId), created: T0 + 100 }),
    );
    expect(stale.status).toBe(200);
    expect(stale.body).toMatchObject({ applied: false, stale: true });

    // Still active: no adapter swap, and nothing for the dunning sweep to
    // legitimately suspend on.
    expect((await readProfile(tenantId)).billing_state).toBe("active");
  });

  it("still applies a genuinely NEW payment failure that happened after the recovery", async () => {
    const { tenantId } = await mintTenant("New Failure Co", "managed");
    await seedBenignSdnList();
    await postWebhook(checkoutSessionCompleted({ tenantId, created: T0 }));
    await postWebhook(invoicePaymentFailed({ tenantId, customerId: stripeCustomerIdFor(tenantId), created: T0 + 100 }));
    await postWebhook(subscriptionUpdated({ tenantId, status: "active", created: T0 + 200 }));
    expect((await readProfile(tenantId)).billing_state).toBe("active");

    const fresh = await postWebhook<WebhookResponse>(
      invoicePaymentFailed({ tenantId, customerId: stripeCustomerIdFor(tenantId), created: T0 + 300 }),
    );
    expect(fresh.body.applied).toBe(true);
    expect((await readProfile(tenantId)).billing_state).toBe("past_due");
  });

  it("applies two events that share a `created` second (one-second granularity must not drop real transitions)", async () => {
    const { tenantId } = await mintTenant("Same Second Co", "managed");
    await seedBenignSdnList();
    await postWebhook(checkoutSessionCompleted({ tenantId, created: T0 }));

    const failed = await postWebhook<WebhookResponse>(
      invoicePaymentFailed({ tenantId, customerId: stripeCustomerIdFor(tenantId), created: T0 + 100 }),
    );
    expect(failed.body.applied).toBe(true);
    const recovered = await postWebhook<WebhookResponse>(subscriptionUpdated({ tenantId, status: "active", created: T0 + 100 }));
    expect(recovered.body.applied).toBe(true);
    expect((await readProfile(tenantId)).billing_state).toBe("active");
  });
});

// wave2-integration-gate-2026-08-06.md BLOCKING 2. The F3 watermark was ONE
// global row across all six subscribed event types, but those types are
// independent Stripe state machines on independent objects — a Dispute, a
// Subscription and an Invoice have no causal ordering with each other. Once any
// event at time T applied, EVERY event emitted before T was refused forever, in
// every lane: the D5 chargeback freeze silently never fired, and a paid checkout
// could be dropped with `screened_at` NULL, reopening the exact compliance
// fail-open finding 2 closed. A REGRESSION vs pre-watermark behavior.
describe("finding 3 rescoped — ordering must protect a lane, never silence another one", () => {
  it("freezes on a dispute emitted BEFORE a routine subscription event that was applied first", async () => {
    const { tenantId } = await mintTenant("Late Dispute Co", "managed");
    await seedBenignSdnList();
    await postWebhook(checkoutSessionCompleted({ tenantId, created: T0 }));

    // A routine renewal — the platform generates these on its own schedule.
    const renewal = await postWebhook<WebhookResponse>(subscriptionUpdated({ tenantId, status: "active", created: T0 + 300 }));
    expect(renewal.body.applied).toBe(true);

    // A REAL cardholder chargeback, emitted earlier, delivered late. The
    // subscription's status says nothing about whether a charge was disputed,
    // so it cannot supersede this.
    const dispute = await postDisputeWebhook<WebhookResponse>(
      disputeCreated({ chargeId: "ch_test_late_dispute", created: T0 + 120 }),
      tenantId,
    );
    expect(dispute.body).toMatchObject({ applied: true, frozen: true });
    expect((await readProfile(tenantId)).billing_state).toBe("disputed");
  });

  it("applies a checkout emitted BEFORE a later subscription event, screening intact", async () => {
    const { tenantId } = await mintTenant("Late Checkout Co", "managed");
    await seedBenignSdnList();

    // The subscription event lands first (Stripe gives no cross-object ordering).
    await postWebhook(subscriptionUpdated({ tenantId, status: "active", created: T0 + 300 }));

    // The checkout that PAID for it arrives after, emitted earlier. It writes the
    // same billing_state the renewal already established, so there is nothing to
    // regress — and its other effects (the OFAC gate, the ledger credit, the
    // subscription-item capture) exist nowhere else.
    const checkout = await postWebhook<WebhookResponse>(checkoutSessionCompleted({ tenantId, created: T0 }));
    expect(checkout.body.applied).toBe(true);

    const profile = await readProfile(tenantId);
    expect(profile.screened_at).not.toBeNull();
    expect(profile.billing_state).toBe("active");
  });

  it("still refuses a stale dispute.closed(won) that would lift a NEWER freeze", async () => {
    const { tenantId } = await mintTenant("Stale Won Co", "managed");
    await seedBenignSdnList();
    await postWebhook(checkoutSessionCompleted({ tenantId, created: T0 }));

    await postDisputeWebhook(disputeCreated({ chargeId: "ch_stale_won", disputeId: "dp_new", created: T0 + 300 }), tenantId);
    expect((await readProfile(tenantId)).billing_state).toBe("disputed");

    // An earlier-emitted resolution of an OLDER dispute must not unfreeze the
    // tenant the newer one just froze — ordering WITHIN the dispute lane holds.
    const staleWon = await postDisputeWebhook<WebhookResponse>(
      disputeClosed({ chargeId: "ch_stale_won", disputeId: "dp_old", status: "won", created: T0 + 100 }),
      tenantId,
    );
    expect(staleWon.body).toMatchObject({ applied: false, stale: true });
    expect((await readProfile(tenantId)).billing_state).toBe("disputed");
  });
});

// wave2-integration-gate-2026-08-06.md N-1 + N-2 — the two residuals the
// per-lane rescoping above left behind. Both are the SAME shape as everything
// before them: a guard keyed more broadly than the state it protects.
describe("N-1 — one dispute's lifecycle must not silence a DIFFERENT chargeback", () => {
  it("freezes on a second, distinct dispute whose event predates the first dispute's win", async () => {
    const { tenantId } = await mintTenant("Two Disputes Co", "managed");
    await seedBenignSdnList();
    await postWebhook(checkoutSessionCompleted({ tenantId, created: T0 }));

    // Dispute A opens, then the tenant WINS it — which puts the dispute lane's
    // mark at A's resolution and the tenant back to 'active'.
    await postDisputeWebhook(disputeCreated({ chargeId: "ch_a", disputeId: "dp_a", created: T0 + 200 }), tenantId);
    expect((await readProfile(tenantId)).billing_state).toBe("disputed");
    await postDisputeWebhook(disputeClosed({ chargeId: "ch_a", disputeId: "dp_a", status: "won", created: T0 + 800 }), tenantId);
    expect((await readProfile(tenantId)).billing_state).toBe("active");

    // Dispute B is a REAL second chargeback on a DIFFERENT charge, emitted
    // between A's open and A's win and delivered late. Nothing about A's
    // outcome says anything about B, so B must still freeze.
    const b = await postDisputeWebhook<WebhookResponse>(
      disputeCreated({ chargeId: "ch_b", disputeId: "dp_b", created: T0 + 400 }),
      tenantId,
    );
    expect(b.body).toMatchObject({ applied: true, frozen: true });
    expect((await readProfile(tenantId)).billing_state).toBe("disputed");
  });
});

describe("N-2 — an event REFUSED as stale must not count as a dunning strike", () => {
  it("a recovered payer is not suspended on their first genuine failure after three refused stale ones", async () => {
    const { tenantId } = await mintTenant("Refused Strikes Co", "managed");
    await seedBenignSdnList();
    await postWebhook(checkoutSessionCompleted({ tenantId, created: T0 }));

    // A real failure, then a real recovery — which closes the dunning cycle.
    await postWebhook(invoicePaymentFailed({ tenantId, customerId: stripeCustomerIdFor(tenantId), created: T0 + 100 }));
    await postWebhook(subscriptionUpdated({ tenantId, status: "active", created: T0 + 200 }));
    expect((await readProfile(tenantId)).billing_state).toBe("active");

    // Stripe lands three DISTINCT failures it had been retrying from before the
    // recovery. Each is correctly refused and changes no state...
    for (let i = 0; i < 3; i++) {
      const stale = await postWebhook<WebhookResponse>(
        invoicePaymentFailed({ tenantId, customerId: stripeCustomerIdFor(tenantId), created: T0 + 100 }),
      );
      expect(stale.body).toMatchObject({ applied: false, stale: true });
    }
    expect((await readProfile(tenantId)).billing_state).toBe("active");

    // ...so a genuinely NEW failure is strike ONE of a new cycle, not strike
    // four. The claim row exists for all four (dedup must stay claim-first);
    // only the APPLIED one is a strike.
    const fresh = await postWebhook<WebhookResponse>(
      invoicePaymentFailed({ tenantId, customerId: stripeCustomerIdFor(tenantId), created: T0 + 300 }),
    );
    expect(fresh.body.applied).toBe(true);

    const summary = await tenantStub(tenantId).opsSummary(Date.now());
    expect(summary.billingState).toBe("past_due");
    expect(summary.billingFailureCount).toBe(1);
  });

  // The COMPLETION-PASS half of the same rule. A handler that dies mid-effect
  // leaves its claim row (applied defaults to 1) plus an in-flight marker; if a
  // newer event supersedes it before Stripe redelivers, the completion pass
  // refuses to finish it — so that event never applied and must not be a strike
  // either. The crash itself is an infrastructure event and cannot be forced
  // in-process, so the half-applied state is written DIRECTLY here; what is
  // under test is the refusal path's semantics, not the crash.
  it("a REFUSED completion pass does not count the half-applied event as a strike", async () => {
    const { tenantId } = await mintTenant("Half Applied Strike Co", "managed");
    await seedBenignSdnList();
    await postWebhook(checkoutSessionCompleted({ tenantId, created: T0 }));

    // The exact durable residue of an attempt that claimed the event and then
    // died before its effects landed.
    const halfApplied = invoicePaymentFailed({
      tenantId,
      customerId: stripeCustomerIdFor(tenantId),
      created: T0 + 100,
    });
    await runInDurableObject(tenantStub(tenantId), async (_i, state) => {
      state.storage.sql.exec(
        `INSERT INTO webhook_events (event_id, type, ts) VALUES (?, 'invoice.payment_failed', ?)`,
        halfApplied.id,
        Date.now(),
      );
      state.storage.sql.exec(
        `INSERT INTO webhook_event_inflight (event_id, started_at) VALUES (?, ?)`,
        halfApplied.id,
        Date.now(),
      );
    });

    // A newer event supersedes it. `subscription.deleted` on purpose: it moves
    // the billing lane's mark and conflicts with 'past_due' WITHOUT recording a
    // dunning-cycle basis, which a recovery would — a moved basis would hide
    // the strike for the wrong reason and make this test vacuous.
    await postWebhook(subscriptionDeleted({ tenantId, created: T0 + 200 }));
    expect((await readProfile(tenantId)).billing_state).toBe("canceled");

    const redelivery = await postWebhook<WebhookResponse>(halfApplied);
    expect(redelivery.body).toMatchObject({ applied: false, duplicate: true, stale: true });

    const row = await runInDurableObject(tenantStub(tenantId), async (_i, state) =>
      state.storage.sql
        .exec<{ applied: number }>(`SELECT applied FROM webhook_events WHERE event_id = ?`, halfApplied.id)
        .one(),
    );
    // The claim row SURVIVES (it is the replay guard) but reads not-applied.
    expect(row.applied).toBe(0);
    expect((await tenantStub(tenantId).opsSummary(Date.now())).billingFailureCount).toBe(0);
  });

  // The gate's N-3 standing hazard: `CREATE TABLE IF NOT EXISTS` never alters
  // an existing table, so a new column is unreachable on every DO that already
  // exists unless the constructor back-fills it. Every test DO is created fresh
  // from the current schema, which is exactly why that class is invisible here
  // — so this test manufactures the pre-column shape and reconstructs for real.
  it("back-fills `applied` on a DO that predates the column, without reclassifying its history", async () => {
    const { tenantId } = await mintTenant("Pre-Column DO Co", "managed");
    await seedBenignSdnList();
    await postWebhook(checkoutSessionCompleted({ tenantId, created: T0 }));
    await postWebhook(invoicePaymentFailed({ tenantId, customerId: stripeCustomerIdFor(tenantId), created: T0 + 100 }));

    // Rewind this DO to the table it had before this change shipped, rows and
    // all. (Rebuilt rather than `ALTER TABLE ... DROP COLUMN`: SQLite rewrites
    // the stored CREATE TABLE text on a drop and chokes on the comments in it.)
    await runInDurableObject(tenantStub(tenantId), async (_i, state) => {
      const sql = state.storage.sql;
      const rows = sql
        .exec<{ event_id: string; type: string; ts: number }>(`SELECT event_id, type, ts FROM webhook_events`)
        .toArray();
      sql.exec(`DROP TABLE webhook_events`);
      sql.exec(`CREATE TABLE webhook_events (event_id TEXT PRIMARY KEY, type TEXT NOT NULL, ts INTEGER NOT NULL)`);
      for (const row of rows) {
        sql.exec(`INSERT INTO webhook_events (event_id, type, ts) VALUES (?, ?, ?)`, row.event_id, row.type, row.ts);
      }
    });
    const dropped = await runInDurableObject(tenantStub(tenantId), async (_i, state) =>
      state.storage.sql.exec<{ name: string }>(`PRAGMA table_info(webhook_events)`).toArray(),
    );
    expect(dropped.some((c) => c.name === "applied")).toBe(false);

    await evictDurableObject(tenantStub(tenantId));
    // Any RPC re-instantiates the DO, running the real constructor.
    const summary = await tenantStub(tenantId).opsSummary(Date.now());

    // The column is back AND the pre-existing failure still counts: DEFAULT 1
    // means "an event already recorded was applied", so no tenant's dunning
    // cycle silently resets at deploy.
    expect(summary.billingFailureCount).toBe(1);
    const columns = await runInDurableObject(tenantStub(tenantId), async (_i, state) =>
      state.storage.sql.exec<{ name: string }>(`PRAGMA table_info(webhook_events)`).toArray(),
    );
    expect(columns.some((c) => c.name === "applied")).toBe(true);
  });
});

describe("finding 4 — the Stripe-Signature timestamp must be inside a tolerance window", () => {
  it("rejects a signature timestamped 2 hours ago", async () => {
    const { tenantId } = await mintTenant("Stale Sig Co", "demo");
    const event = checkoutSessionCompleted({ tenantId });
    const body = JSON.stringify(event);
    const ts = Math.floor(Date.now() / 1000) - 2 * 60 * 60;
    const res = await postSigned(event, `t=${ts},v1=${await signWith(body, ts)}`);
    expect(res.status).toBe(400);
    expect((await readProfile(tenantId)).plan).toBe("demo");
  });

  it("rejects a signature timestamped far in the future", async () => {
    const { tenantId } = await mintTenant("Future Sig Co", "demo");
    const event = checkoutSessionCompleted({ tenantId });
    const body = JSON.stringify(event);
    const ts = Math.floor(Date.now() / 1000) + 10 * 365 * 24 * 60 * 60;
    const res = await postSigned(event, `t=${ts},v1=${await signWith(body, ts)}`);
    expect(res.status).toBe(400);
  });

  it("rejects a non-numeric timestamp", async () => {
    const { tenantId } = await mintTenant("NaN Sig Co", "demo");
    const event = checkoutSessionCompleted({ tenantId });
    const body = JSON.stringify(event);
    const res = await postSigned(event, `t=not-a-number,v1=${await signWith(body, "not-a-number")}`);
    expect(res.status).toBe(400);
  });

  it("accepts a signature inside the window (control)", async () => {
    const { tenantId } = await mintTenant("Fresh Sig Co", "demo");
    await seedBenignSdnList();
    const event = checkoutSessionCompleted({ tenantId });
    const body = JSON.stringify(event);
    const ts = Math.floor(Date.now() / 1000) - 60;
    const res = await postSigned<WebhookResponse>(event, `t=${ts},v1=${await signWith(body, ts)}`);
    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(true);
  });
});

describe("finding 5 — every v1 signature in the header is checked, not just the last", () => {
  it("accepts when the VALID signature is first and a foreign one follows (secret rotation)", async () => {
    const { tenantId } = await mintTenant("Rotation Co", "demo");
    await seedBenignSdnList();
    const event = checkoutSessionCompleted({ tenantId });
    const body = JSON.stringify(event);
    const ts = Math.floor(Date.now() / 1000);
    const valid = await signWith(body, ts);
    const foreign = await signWith(body, ts, "whsec_some_other_secret");

    const res = await postSigned<WebhookResponse>(event, `t=${ts},v1=${valid},v1=${foreign}`);
    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(true);
  });

  it("accepts when the valid signature is last (the ordering that already worked)", async () => {
    const { tenantId } = await mintTenant("Rotation Two Co", "demo");
    await seedBenignSdnList();
    const event = checkoutSessionCompleted({ tenantId });
    const body = JSON.stringify(event);
    const ts = Math.floor(Date.now() / 1000);
    const valid = await signWith(body, ts);
    const foreign = await signWith(body, ts, "whsec_some_other_secret");

    const res = await postSigned<WebhookResponse>(event, `t=${ts},v1=${foreign},v1=${valid}`);
    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(true);
  });

  it("still rejects when NO v1 in the header verifies", async () => {
    const { tenantId } = await mintTenant("Rotation Three Co", "demo");
    const event = checkoutSessionCompleted({ tenantId });
    const body = JSON.stringify(event);
    const ts = Math.floor(Date.now() / 1000);
    const foreignA = await signWith(body, ts, "whsec_wrong_a");
    const foreignB = await signWith(body, ts, "whsec_wrong_b");

    const res = await postSigned(event, `t=${ts},v1=${foreignA},v1=${foreignB}`);
    expect(res.status).toBe(400);
    expect((await readProfile(tenantId)).plan).toBe("demo");
  });
});

describe("finding 8 — a signed event naming a tenant we do not have must not 500 for three days", () => {
  it("returns 200 applied:false instead of a 500 that counts toward endpoint auto-disable", async () => {
    const res = await postWebhook<WebhookResponse>(checkoutSessionCompleted({ tenantId: "ten_does_not_exist_at_all" }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ received: true, applied: false });
  });
});
