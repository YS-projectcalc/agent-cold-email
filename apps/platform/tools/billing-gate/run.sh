#!/usr/bin/env bash
# Tier-2 Stripe TEST-MODE gate runner (quantity-billing-design §10). Reads the
# TEST-mode STRIPE_SECRET_KEY from the MAIN checkout's .dev.vars (wired 2026-07-22,
# a test-mode key that cannot charge real money), verifies it is sk_test_, and
# runs gate.mjs. NEVER prints, commits, or touches the live Keychain. The gate
# creates uniquely-named Stripe test objects and cleans them up.
set -euo pipefail

DEV_VARS="/Users/yaakovscher/dev/coldstart/apps/platform/.dev.vars"

if [[ ! -f "$DEV_VARS" ]]; then
  echo "FATAL: $DEV_VARS not found — cannot read the test-mode key. STOP." >&2
  exit 2
fi

KEY="$(grep -E '^STRIPE_SECRET_KEY=' "$DEV_VARS" | head -1 | cut -d= -f2- | tr -d '"'"'"'[:space:]')"

if [[ -z "$KEY" ]]; then
  echo "FATAL: STRIPE_SECRET_KEY missing/empty in $DEV_VARS. STOP." >&2
  exit 2
fi
if [[ "$KEY" != sk_test_* ]]; then
  echo "FATAL: STRIPE_SECRET_KEY is not a test-mode key (sk_test_). REFUSING to run against a live account." >&2
  exit 2
fi

echo "Running Tier-2 Stripe test-mode gate against a sk_test_ key (value never printed)..."
STRIPE_SECRET_KEY="$KEY" node "$(dirname "$0")/gate.mjs"
