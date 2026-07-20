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

export const IK_MAILBOX_HEALTH_SUCCESS = {
  success: true,
  data: {
    health_status: "healthy",
    bounce_rate: 1.8,
    reply_rate: 22.3,
    sent_7d: 85,
    received_7d: 62,
    last_event_at: "2026-01-15T14:30:00.000Z",
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

/** Gateway/auth-layer error envelope — verified live 2026-07-20 (401/404, no `error` field). */
export const IK_GATEWAY_ERROR_401 = { code: 401, message: "jwt malformed" };
export const IK_GATEWAY_ERROR_404 = { code: 404, message: "Not found" };

/** App-level business error envelope — from docs.inboxkit.com's response examples. */
export const IK_APP_ERROR_UNAUTHORIZED = { error: true, message: "Unauthorized" };
