// Tier-2 Stripe TEST-MODE gate (quantity-billing-design-2026-07-23.md §10).
// Verifies the money behaviors a self-authored sandbox CANNOT prove, against
// REAL Stripe test mode (sk_test_ — never a live charge). Runs as a standalone
// script (NOT vitest). The request shapes mirror apps/platform/src/billing/
// stripe-client.ts (two-item durable-Price checkout, ensureStripePrices'
// lookup_key resolve-or-create with duplicate re-fetch, setSubscriptionItemQuantity
// absolute set-to-N). Creates uniquely-named test objects per run and cleans
// them all up. NEVER prints the secret key.
//
// Scenarios (design §10):
//   (a) coupon %-off rides a FUTURE quantity bump's proration line
//   (b) an increase prorates (positive proration line on the upcoming invoice)
//   (c) a decrease does NOT credit (proration_behavior 'none' -> no negative line)
//   (d) two concurrent ensureStripePrices converge on ONE Price per lookup_key
//   (e) a 60%-off checkout still collects a card (invoice > $0) + first invoice succeeds

const KEY = process.env.STRIPE_SECRET_KEY;
if (!KEY) {
  console.error("FATAL: STRIPE_SECRET_KEY not set (run.sh reads it from the main worktree .dev.vars)");
  process.exit(2);
}
if (!KEY.startsWith("sk_test_")) {
  console.error("FATAL: STRIPE_SECRET_KEY is NOT a test-mode key (sk_test_) — refusing to run against a live account");
  process.exit(2);
}

const BASE = "https://api.stripe.com/v1";
const API_VERSION = "2024-06-20";
const RUN = `gate${Date.now()}`;

// Flatten nested objects/arrays into Stripe's bracketed form-encoding.
function encode(params, prefix, out) {
  out = out || new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (item !== null && typeof item === "object") encode(item, `${key}[${i}]`, out);
        else out.append(`${key}[${i}]`, String(item));
      });
    } else if (typeof v === "object") {
      encode(v, key, out);
    } else {
      out.append(key, String(v));
    }
  }
  return out;
}

async function stripe(method, path, params, idemKey) {
  const headers = {
    Authorization: `Bearer ${KEY}`,
    "Content-Type": "application/x-www-form-urlencoded",
    "Stripe-Version": API_VERSION,
  };
  if (idemKey) headers["Idempotency-Key"] = idemKey;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: params ? encode(params).toString() : undefined,
  });
  const json = await res.json();
  if (!res.ok) {
    const err = new Error(`${method} ${path} -> ${res.status}: ${JSON.stringify(json.error || json)}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

const cleanup = [];
const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? `: ${detail}` : ""}`);
}

async function ensurePriceRaceSafe(lookupKey, unitAmount, productName) {
  // Mirrors stripe-client.ts ensureStripePrices' per-key path: GET by lookup_key,
  // else find-or-create Product + create Price; on a duplicate-lookup_key create
  // error, re-fetch by lookup_key (N3 convergence).
  const found = await stripe("GET", `/prices?lookup_keys[]=${encodeURIComponent(lookupKey)}&active=true&limit=1`);
  const existing = (found.data || []).find((p) => p.lookup_key === lookupKey);
  if (existing) return existing.id;
  const product = await stripe("POST", "/products", { name: productName, metadata: { coldrig_gate: RUN } });
  cleanup.push(() => stripe("POST", `/products/${product.id}`, { active: false }));
  try {
    const price = await stripe("POST", "/prices", {
      currency: "usd",
      unit_amount: unitAmount,
      recurring: { interval: "month" },
      product: product.id,
      lookup_key: lookupKey,
    });
    cleanup.push(() => stripe("POST", `/prices/${price.id}`, { active: false }));
    return price.id;
  } catch (err) {
    if (/lookup_key/i.test(JSON.stringify(err.body || err.message))) {
      const refetch = await stripe("GET", `/prices?lookup_keys[]=${encodeURIComponent(lookupKey)}&active=true&limit=1`);
      const winner = (refetch.data || []).find((p) => p.lookup_key === lookupKey);
      if (winner) return winner.id;
    }
    throw err;
  }
}

function mailboxItem(sub, mailboxPriceId) {
  return sub.items.data.find((i) => i.price.id === mailboxPriceId);
}

function dumpLines(label, upcoming) {
  if (!process.env.GATE_DEBUG) return;
  console.log(`  [debug ${label}] subtotal=${upcoming.subtotal} total=${upcoming.total} discount=${JSON.stringify(upcoming.total_discount_amounts)}`);
  for (const l of upcoming.lines?.data || []) {
    console.log(`    line amount=${l.amount} proration=${l.proration} desc="${l.description}" disc=${JSON.stringify(l.discount_amounts)}`);
  }
}

async function main() {
  // --- Shared setup ---
  const product = await stripe("POST", "/products", { name: `Coldrig Gate ${RUN}`, metadata: { coldrig_gate: RUN } });
  cleanup.push(() => stripe("POST", `/products/${product.id}`, { active: false }));
  const platformPrice = await stripe("POST", "/prices", {
    currency: "usd",
    unit_amount: 4900,
    recurring: { interval: "month" },
    product: product.id,
  });
  cleanup.push(() => stripe("POST", `/prices/${platformPrice.id}`, { active: false }));
  const mailboxPrice = await stripe("POST", "/prices", {
    currency: "usd",
    unit_amount: 1000,
    recurring: { interval: "month" },
    product: product.id,
  });
  cleanup.push(() => stripe("POST", `/prices/${mailboxPrice.id}`, { active: false }));

  const coupon = await stripe("POST", "/coupons", { percent_off: 60, duration: "forever", name: `Gate 60 ${RUN}` });
  cleanup.push(() => stripe("DELETE", `/coupons/${coupon.id}`));

  // A test customer WITH a chargeable card on file (tok_visa always succeeds).
  const customer = await stripe("POST", "/customers", { name: `Gate ${RUN}`, source: "tok_visa" });
  cleanup.push(() => stripe("DELETE", `/customers/${customer.id}`));

  // Subscription on the per-mailbox curve: platform qty 1 + mailbox qty 5, 60% off.
  // Charges the first invoice immediately against the card on file.
  const sub = await stripe("POST", "/subscriptions", {
    customer: customer.id,
    items: [
      { price: platformPrice.id, quantity: 1 },
      { price: mailboxPrice.id, quantity: 5 },
    ],
    coupon: coupon.id,
    expand: ["latest_invoice"],
  });

  // --- Scenario (e): 60%-off still collects a card + first invoice succeeds ---
  try {
    const inv = sub.latest_invoice;
    const grossFirst = 4900 + 5 * 1000; // 9900
    const expected = Math.round(grossFirst * 0.4); // 60% off -> 3960
    const ok = inv && inv.status === "paid" && inv.amount_paid === expected && inv.amount_paid > 0;
    record(
      "(e) 60%-off checkout collects a card (>$0) + first invoice paid",
      ok,
      `invoice.status=${inv?.status} amount_paid=${inv?.amount_paid} (expected ${expected}, 60% off ${grossFirst})`,
    );
  } catch (err) {
    record("(e) 60%-off checkout collects a card (>$0) + first invoice paid", false, String(err));
  }

  const mbxItem = mailboxItem(sub, mailboxPrice.id);

  // --- Scenarios (a)+(b): increase prorates + coupon rides the proration ---
  try {
    await stripe(
      "POST",
      `/subscription_items/${mbxItem.id}`,
      { quantity: 8, proration_behavior: "create_prorations" },
      `gate-inc-${RUN}`,
    );
    const upcoming = await stripe("GET", `/invoices/upcoming?subscription=${sub.id}`);
    dumpLines("a+b", upcoming);
    const prorationLines = (upcoming.lines?.data || []).filter((l) => l.proration);
    const positiveProration = prorationLines.filter((l) => l.amount > 0);
    // (b) a positive prorated charge exists for the 3 added mailboxes.
    const bOk = positiveProration.length > 0;
    record(
      "(b) an increase prorates (positive proration line on the upcoming invoice)",
      bOk,
      `positive proration lines=${positiveProration.length} amounts=${positiveProration.map((l) => l.amount).join(",")}`,
    );
    // (a) the 60% coupon rides the FUTURE quantity-bump charges. Stripe applies
    // the discount two ways: the bumped-quantity RECURRING line carries an
    // explicit 60% invoice discount (discount_amounts), and the PRORATION line
    // is discounted at the unit level (Stripe bakes it into the amount and
    // renders "(with 60.0% off)" in the description). Assert both — proof the
    // coupon rides new charges, not just the first invoice.
    const bumpedRecurring = (upcoming.lines?.data || []).find(
      (l) => !l.proration && l.description?.includes("$10.00"),
    );
    const recurringDiscount = (bumpedRecurring?.discount_amounts || []).reduce((s, d) => s + d.amount, 0);
    const recurringOk = bumpedRecurring && recurringDiscount === Math.round(bumpedRecurring.amount * 0.6);
    const prorationRidesCoupon = positiveProration.some((l) => /%\s*off/i.test(l.description || ""));
    const aOk = recurringOk && prorationRidesCoupon;
    record(
      "(a) coupon %-off rides the future quantity-bump charges (recurring + proration)",
      aOk,
      `bumped mailbox recurring amount=${bumpedRecurring?.amount} discount=${recurringDiscount} (want 60%); proration line discounted=${prorationRidesCoupon}`,
    );
  } catch (err) {
    record("(b) an increase prorates (positive proration line on the upcoming invoice)", false, String(err));
    record("(a) coupon %-off rides the future quantity-bump charges (recurring + proration)", false, String(err));
  }

  // --- Scenario (c): decrease does NOT credit ---
  // On a FRESH subscription (no prior increase proration to confuse the check):
  // decrease the quantity with proration_behavior 'none' and assert it creates
  // ZERO proration lines at all — no mid-cycle credit (founder ruling 2).
  try {
    const sub2 = await stripe("POST", "/subscriptions", {
      customer: customer.id,
      items: [
        { price: platformPrice.id, quantity: 1 },
        { price: mailboxPrice.id, quantity: 8 },
      ],
      coupon: coupon.id,
    });
    const mbx2 = mailboxItem(sub2, mailboxPrice.id);
    await stripe(
      "POST",
      `/subscription_items/${mbx2.id}`,
      { quantity: 5, proration_behavior: "none" },
      `gate-dec-${RUN}`,
    );
    const upcoming = await stripe("GET", `/invoices/upcoming?subscription=${sub2.id}`);
    dumpLines("c", upcoming);
    // proration_behavior 'none' must create NO proration line — neither a credit
    // nor a charge. The upcoming invoice is just the next period at the new qty.
    const prorationLines = (upcoming.lines?.data || []).filter((l) => l.proration);
    const cOk = prorationLines.length === 0;
    record(
      "(c) a decrease does NOT credit (proration_behavior 'none' -> zero proration lines)",
      cOk,
      `proration lines created by the decrease=${prorationLines.length}`,
    );
    try {
      await stripe("DELETE", `/subscriptions/${sub2.id}`);
    } catch {
      /* customer delete cascades */
    }
  } catch (err) {
    record("(c) a decrease does NOT credit (proration_behavior 'none' -> zero proration lines)", false, String(err));
  }

  // --- Scenario (d): two concurrent ensureStripePrices converge on one Price ---
  try {
    const lk = `coldrig_gate_race_${RUN}`;
    const [id1, id2] = await Promise.all([
      ensurePriceRaceSafe(lk, 1000, `Coldrig Gate Race ${RUN}`),
      ensurePriceRaceSafe(lk, 1000, `Coldrig Gate Race ${RUN}`),
    ]);
    const after = await stripe("GET", `/prices?lookup_keys[]=${encodeURIComponent(lk)}&active=true&limit=10`);
    const activeForKey = (after.data || []).filter((p) => p.lookup_key === lk);
    const dOk = id1 === id2 && activeForKey.length === 1;
    record(
      "(d) two concurrent ensureStripePrices converge on ONE Price per lookup_key",
      dOk,
      `id1===id2=${id1 === id2} active prices for key=${activeForKey.length}`,
    );
  } catch (err) {
    record("(d) two concurrent ensureStripePrices converge on ONE Price per lookup_key", false, String(err));
  }

  // Cancel the subscription before customer delete (best-effort; customer delete also cascades).
  try {
    await stripe("DELETE", `/subscriptions/${sub.id}`);
  } catch {
    /* customer delete below cascades */
  }
}

async function runCleanup() {
  for (const fn of cleanup.reverse()) {
    try {
      await fn();
    } catch (err) {
      console.log(`  cleanup warning: ${String(err).slice(0, 160)}`);
    }
  }
}

main()
  .catch((err) => {
    console.error(`FATAL during gate run: ${err}`);
    results.push({ name: "gate execution", ok: false, detail: String(err) });
  })
  .finally(async () => {
    console.log("--- cleaning up test objects ---");
    await runCleanup();
    const passed = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\nSUMMARY: ${passed} passed, ${failed} failed (5 scenarios: a,b,c,d,e)`);
    process.exit(failed === 0 && passed >= 5 ? 0 : 1);
  });
