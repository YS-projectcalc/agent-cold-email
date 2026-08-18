/**
 * Sanitized InboxKit API fixtures for the real/ adapter contract tests
 * (test/real-mailbox-port.test.ts, test/real-inboxkit-domain-port.test.ts,
 * test/real-inboxkit-client.test.ts). Derived from real responses captured
 * live against `https://api.inboxkit.com/v1/api` and its published docs
 * (https://docs.inboxkit.com/) on 2026-07-20 — every workspace/account uid
 * and email address below is a SYNTHETIC placeholder, not the real captured
 * value (CLAUDE.md rule g: no real vendor identifiers in committed code).
 */

export const IK_WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
export const IK_API_KEY = "test-inboxkit-jwt";

export const IK_MAILBOX_BUY_SUCCESS = {
  error: false,
  message: "Mailbox scheduled to be assigned to domains successfully",
  mailboxes: [
    {
      uid: "mbx-11111111-2222-3333-4444-555555555555",
      domain_name: "example-lookalike.com",
      first_name: "John",
      last_name: "Doe",
      username: "john.doe",
      platform: "GOOGLE",
      status: "scheduled",
      renewal_date: null,
      renewal_cycle: "monthly",
      createdAt: "2026-01-15T10:30:00.000Z",
      updatedAt: "2026-01-15T10:30:00.000Z",
    },
  ],
};

export const IK_MAILBOX_ALREADY_EXISTS = {
  error: true,
  message: "Mailbox john.doe@example-lookalike.com already exists",
};

export const IK_MAILBOX_LIST_SUCCESS = {
  error: false,
  message: "Mailboxes retrieved successfully",
  mailboxes: [
    {
      uid: "mbx-11111111-2222-3333-4444-555555555555",
      domain_name: "example-lookalike.com",
      username: "john.doe",
      status: "active",
    },
  ],
  total: 1,
  pages: 1,
  current_page: 1,
  limit: 1,
};

export const IK_MAILBOX_LIST_EMPTY = {
  error: false,
  message: "Mailboxes retrieved successfully",
  mailboxes: [],
  total: 0,
  pages: 0,
  current_page: 0,
  limit: 0,
};

/**
 * GET /email-insights/mailbox/{uid}/health.
 *
 * capturedFrom: GET https://api.inboxkit.com/v1/api/email-insights/mailbox/{uid}/health
 * capturedAt:   2026-08-18 (live, read-only — docs/adversarial/class-sweep-vendor-truth-2026-08-18.md Part 3 #8)
 *
 * ⚠ THIS FIXTURE REPLACES AN INVENTED ONE. The previous version had
 * `health_status: "healthy"`, `bounce_rate: 1.8`, `reply_rate`, `sent_7d`,
 * `received_7d` — none of which this endpoint returns. It was written in the
 * same commit as the adapter that read those fields, so it restated the code's
 * premise rather than the vendor's behaviour, and the contract test built on it
 * was green while the live path produced `NaN`. A fixture is only worth
 * anything if it came from the vendor; hence the provenance header, which every
 * new fixture in this file gets.
 *
 * ⚠ `data.status` is ACTIVITY, not lifecycle: it reads "inactive" for a mailbox
 * whose `/mailboxes/list` status is "active" and whose 7d/30d volumes are zero.
 * Never feed it to classifyVendorLifecycle.
 */
export const IK_MAILBOX_HEALTH_SUCCESS = {
  success: true,
  data: {
    status: "inactive",
    bounce_rate_30d: 1.8,
    total_7d: 0,
    total_30d: 0,
    last_event_at: "0001-01-01T00:00:00Z",
  },
};

/**
 * The same endpoint for a mailbox the vendor reports NOTHING about — the
 * normal shape for a brand-new mailbox, and the one that used to produce
 * `NaN` bounce rates and a fabricated reputation score of 50.
 *
 * capturedFrom: same endpoint as above; `data` present, metric fields absent.
 * capturedAt:   2026-08-18 (derived from the same live capture: the fields this
 *               adapter reads are optional on the wire, never guaranteed).
 */
export const IK_MAILBOX_HEALTH_NO_METRICS = {
  success: true,
  data: {
    status: "inactive",
    total_7d: 0,
    total_30d: 0,
    last_event_at: "0001-01-01T00:00:00Z",
  },
};

export const IK_WARMUP_ADD_SUCCESS = {
  error: false,
  message: "Created 1 warmup subscription(s)",
  subscriptions: [
    {
      uid: "warm-a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      status: "active",
      mailbox_email: "john.doe@example-lookalike.com",
      price_per_month: 3,
      started_at: null,
      next_billing_date: "2026-02-15T10:30:00.000Z",
      createdAt: "2026-01-15T10:30:00.000Z",
    },
  ],
  errors: [],
  skipped: 0,
};

// POST /warmup/cancel — the mailbox's uid comes back under results.success.
// Shape captured from docs.inboxkit.com/cancel-warmup-for-mailboxes-28170231e0.
export const IK_WARMUP_CANCEL_SUCCESS = {
  error: false,
  message: "Processed 1 mailbox(es): 1 cancelled, 0 failed",
  results: {
    success: [
      {
        mailbox_uid: "mbx-11111111-2222-3333-4444-555555555555",
        subscription_uid: "warm-a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        action: "cancelled",
      },
    ],
  },
};

/** A cancel that reports NOTHING cancelled — ambiguous between "it failed" and
 * "there was nothing left to cancel" (adversary N-d). Only /warmup/list resolves it. */
export const IK_WARMUP_CANCEL_NONE = {
  error: false,
  message: "Processed 1 mailbox(es): 0 cancelled, 1 failed",
  results: { success: [] },
};

// POST /warmup/list — contract captured from
// docs.inboxkit.com/list-warmup-subscriptions-28170226e0 (2026-08-02).
export const IK_WARMUP_LIST_ACTIVE = {
  error: false,
  message: "Warmup subscriptions retrieved successfully",
  subscriptions: [
    {
      uid: "warm-a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      status: "active",
      mailbox_email: "john.doe@example-lookalike.com",
      price_per_month: 3,
      started_at: "2026-01-15T10:30:00.000Z",
      next_billing_date: "2026-02-15T10:30:00.000Z",
      mailbox: {
        uid: "mbx-11111111-2222-3333-4444-555555555555",
        username: "john.doe",
        domain_name: "example-lookalike.com",
        platform: "GOOGLE",
        status: "active",
      },
      createdAt: "2026-01-15T10:30:00.000Z",
    },
  ],
  total: 1,
  pages: 1,
  current_page: 1,
  limit: 100,
};

/** No ACTIVE subscription for our mailbox — the already-cancelled proof. */
export const IK_WARMUP_LIST_EMPTY = {
  error: false,
  message: "Warmup subscriptions retrieved successfully",
  subscriptions: [],
  total: 0,
  pages: 0,
  current_page: 1,
  limit: 100,
};

export const IK_MAILBOX_CANCEL_SUCCESS = {
  error: false,
  message: "Mailbox scheduled for cancellation",
};

export const IK_DOMAIN_AVAILABLE = {
  error: false,
  message: "Domain is available for registration",
  banned: false,
  available: true,
  registration_price: 12.5,
  renewal_price: 12.5,
};

export const IK_DOMAIN_NOT_AVAILABLE = {
  error: false,
  message: "Domain is not available for registration",
  banned: false,
  available: false,
  registration_price: 12.5,
  renewal_price: 12.5,
};

export const IK_DOMAIN_REGISTER_WALLET_SUCCESS = {
  error: false,
  message: "Domains registration initiated successfully",
  domains_count: 1,
  total_cost: 12.5,
  payment_type: "wallet",
  contact_details: {
    first_name: "Jane",
    last_name: "Registrant",
    email: "registrant@example.test",
  },
  domain_uids: ["dom-11111111-2222-3333-4444-555555555555"],
};

export const IK_DOMAIN_REGISTER_STRIPE_SESSION = {
  error: false,
  message: "Payment session created successfully",
  url: "https://checkout.stripe.com/pay/cs_test_sanitized",
  session_id: "cs_test_sanitized",
  domains_count: 1,
  total_cost: 12.5,
  domain_uids: ["dom-11111111-2222-3333-4444-555555555555"],
};

export const IK_NAMESERVERS_RESULT = {
  error: false,
  message: "Nameservers created successfully",
  result: [
    {
      domain: "example-lookalike.com",
      nameservers: ["ns1.cloudflare.com", "ns2.cloudflare.com"],
      uid: "dom-11111111-2222-3333-4444-555555555555",
    },
  ],
};

export const IK_PROPAGATION_CONFIRMED = {
  error: false,
  message: "Nameservers propagation checked successfully",
  result: [
    {
      _id: "000000000000000000000001",
      uid: "dom-11111111-2222-3333-4444-555555555555",
      name: "example-lookalike.com",
      status: "active",
      createdAt: "2026-01-15T08:40:07.003Z",
      updatedAt: "2026-01-16T13:52:38.064Z",
      propagated: true,
    },
  ],
};

export const IK_PROPAGATION_PENDING = {
  error: false,
  message: "Nameservers propagation checked successfully",
  result: [
    {
      _id: "000000000000000000000002",
      uid: "dom-11111111-2222-3333-4444-555555555555",
      name: "example-lookalike.com",
      status: "expired_propagation",
      createdAt: "2026-01-15T08:40:07.003Z",
      updatedAt: "2026-01-16T13:52:38.064Z",
      propagated: false,
    },
  ],
};

/**
 * POST /domains/list for a domain InboxKit ITSELF registered, whose registrar-
 * side nameserver change has not propagated yet — the shape polled LIVE on
 * 2026-08-05 from the workspace holding the stranded incident domain, field for
 * field (only the uid is synthetic). This is the state three customer retries
 * kept hitting, and the one no fixture in the suite could express before: the
 * old adopt fixtures modelled a domain as `{name, status, assigned_mailboxes}`
 * with no connection type and no DNS state at all, so "purchased, not yet
 * propagated" — the actual production state — was unrepresentable.
 */
export const IK_DOMAINS_LIST_PURCHASED_PENDING = {
  error: false,
  message: "Domains retrieved successfully",
  domains: [
    {
      uid: "dom-22222222-3333-4444-5555-666666666666",
      name: "goauthorpitchdesk.com",
      price: 12.5,
      assigned_mailboxes: 0,
      status: "active",
      connection_type: "purchased",
      dns_propagation_status: "pending",
      nameserver_match_status: "pending",
      last_nameserver_check: null,
      actual_nameservers: [],
      nameservers: ["alexandra.ns.cloudflare.com", "phil.ns.cloudflare.com"],
    },
  ],
  total: 1,
  pages: 1,
};

/** The same purchased domain once the registrar change has actually propagated:
 * the assigned nameservers appear in `actual_nameservers` AND both of the
 * vendor's verdicts read finished. `actual_nameservers` is NOT a route to ready
 * on its own — that short-circuit was the 2026-08-06 false-ready bug and is
 * deleted (inboxkit-domain-port.ts's `polledDomainIsReady`). */
export const IK_DOMAINS_LIST_PURCHASED_PROPAGATED = {
  ...IK_DOMAINS_LIST_PURCHASED_PENDING,
  domains: [
    {
      ...IK_DOMAINS_LIST_PURCHASED_PENDING.domains[0],
      dns_propagation_status: "completed",
      nameserver_match_status: "matched",
      last_nameserver_check: "2026-08-05T12:00:00.000Z",
      actual_nameservers: ["alexandra.ns.cloudflare.com", "phil.ns.cloudflare.com"],
    },
  ],
};

/**
 * THE INTERMEDIATE STATE — the registrar's nameserver delegation has landed, but
 * the vendor has NOT finished setting up the domain's mail DNS.
 *
 * This shape did not exist in the fixtures, and its absence hid a false-ready
 * bug (combined-diff gate 2026-08-06, finding #1): the only "propagated" fixture
 * flipped `actual_nameservers`, `nameserver_match_status` and
 * `dns_propagation_status` SIMULTANEOUSLY, so a readiness rule that consulted
 * the nameservers and ignored the propagation verdict was indistinguishable from
 * one that required both. A domain in this state must read NOT ready: mail sent
 * from it would not deliver, and a mailbox bought on it bills monthly.
 *
 * Causally this is the EXPECTED window, not a corner case — mail DNS cannot
 * propagate until the delegation lands, so every purchased domain passes through
 * it on the way to ready.
 */
export const IK_DOMAINS_LIST_PURCHASED_NS_MATCHED_DNS_PENDING = {
  ...IK_DOMAINS_LIST_PURCHASED_PENDING,
  domains: [
    {
      ...IK_DOMAINS_LIST_PURCHASED_PENDING.domains[0],
      // Delegation confirmed, by BOTH the raw field and the vendor's verdict…
      nameserver_match_status: "matched",
      last_nameserver_check: "2026-08-05T12:00:00.000Z",
      actual_nameservers: ["alexandra.ns.cloudflare.com", "phil.ns.cloudflare.com"],
      // …but the mail DNS itself is still being set up.
      dns_propagation_status: "pending",
    },
  ],
};

/** A domain CONNECTED to the workspace (registered elsewhere) — the other half
 * of the discriminator, and the only shape the nameserver handshake applies to. */
export const IK_DOMAINS_LIST_CONNECTED = {
  error: false,
  message: "Domains retrieved successfully",
  domains: [
    {
      uid: "dom-77777777-8888-9999-aaaa-bbbbbbbbbbbb",
      name: "connected-elsewhere.com",
      assigned_mailboxes: 0,
      status: "active",
      connection_type: "connected",
      dns_propagation_status: "pending",
      nameserver_match_status: "pending",
      actual_nameservers: [],
      nameservers: ["alexandra.ns.cloudflare.com", "phil.ns.cloudflare.com"],
    },
  ],
  total: 1,
  pages: 1,
};

export const IK_DOMAIN_REMOVE_SUCCESS = {
  error: false,
  message: "Domains scheduled for deletion",
  result: {
    updated: [],
    deleted: [
      { name: "example-lookalike.com", uid: "dom-11111111-2222-3333-4444-555555555555", previous_status: "active", new_status: "deleted" },
    ],
  },
};

/**
 * show-mailbox-credentials — WHAT THE ENDPOINT ACTUALLY ANSWERS.
 *
 * capturedFrom: GET https://api.inboxkit.com/v1/api/mailboxes/{uid}/credentials
 * capturedAt:   2026-08-18 (live, read-only)
 *
 * The route does not exist; the gateway 404s it. The fixture that stood here
 * was an invented SUCCESS payload for it — a documented-shape guess whose
 * contract test proved only that our mapper can read our own invention. It is
 * deleted rather than corrected: there is nothing to correct it to until the
 * endpoint is real. The adapter's mapping stays UNVERIFIED and untested by
 * design, and this 404 is graded operator-actionable (ours to fix), never
 * "check your inputs".
 */
export const IK_MAILBOX_CREDENTIALS_NOT_FOUND = { code: 404, message: "Not found" };

/** InboxKit programmatic OAuth consent response (I3c). ⚠️ UNVERIFIED SHAPE — documented guess. */
export const IK_CONSENT_SUCCESS = {
  error: false,
  message: "Consent granted",
  refresh_token: "1//refresh-token-from-consent",
  client_secret: "google-oauth-client-secret",
};

/** Gateway/auth-layer error envelope — verified live 2026-07-20 (401/404, no `error` field). */
export const IK_GATEWAY_ERROR_401 = { code: 401, message: "jwt malformed" };
export const IK_GATEWAY_ERROR_404 = { code: 404, message: "Not found" };

/** App-level business error envelope — from docs.inboxkit.com's response examples. */
export const IK_APP_ERROR_UNAUTHORIZED = { error: true, message: "Unauthorized" };
