#!/usr/bin/env bash
# Droplet-side SDN relay push. Cloudflare Workers cannot reach Treasury's
# sanctionslistservice.ofac.treas.gov host directly — its TLS front-end 525s
# every Worker-origin fetch (proven live 2026-07-23/24 by two persistent cron
# alerts, both the legacy www.treasury.gov and direct URLs; curl from a
# Mac/droplet gets the file fine). This droplet already does IMAP for the
# exact same "Workers can't reach this host" reason (ACTIVATION.md's
# go-engine host) — this script is the same pattern applied to the SDN list:
# curl the real feed here, relay the raw CSV to the Worker's
# POST /admin/sdn/ingest, authenticated by SDN_INGEST_TOKEN (a narrow,
# dedicated secret — never ADMIN_TOKEN; this droplet must never hold
# cross-tenant admin power).
#
# Installed on the droplet at arming (see ACTIVATION.md) and run via cron:
#   17 6 * * *  /root/push-sdn.sh >> /var/log/sdn-relay.log 2>&1
#
# On ANY failure this exits non-zero and prints ONE line to stderr — that is
# the full extent of this script's own alerting. Cron mail is NOT configured
# on this droplet, so a failure here is otherwise silent unless someone reads
# cron output. That is deliberately acceptable: the Worker's OWN daily
# refresh attempt (maybeRefreshSdnList, apps/platform/src/ofac/sdn-refresh.ts)
# independently keeps retrying every ~5 minutes and ALREADY alerts
# OPS_ALERT_EMAIL on failure — so a skipped relay push just means that
# existing alert keeps firing until the next successful push (either this
# script's, or, if Treasury ever unblocks Cloudflare egress, the Worker's own
# direct fetch self-healing). No redundant alerting is needed here.
set -euo pipefail

ENV_FILE="/root/sdn-relay.env"
SDN_URL="https://sanctionslistservice.ofac.treas.gov/api/publicationpreview/exports/sdn.csv"

if [ ! -f "$ENV_FILE" ]; then
  echo "push-sdn.sh: FAILED — $ENV_FILE not found (expected SDN_INGEST_TOKEN + INGEST_URL)" >&2
  exit 1
fi
# shellcheck disable=SC1090
source "$ENV_FILE"

if [ -z "${SDN_INGEST_TOKEN:-}" ]; then
  echo "push-sdn.sh: FAILED — SDN_INGEST_TOKEN not set in $ENV_FILE" >&2
  exit 1
fi
if [ -z "${INGEST_URL:-}" ]; then
  echo "push-sdn.sh: FAILED — INGEST_URL not set in $ENV_FILE (e.g. https://<worker-host>/admin/sdn/ingest)" >&2
  exit 1
fi

# Token-hygiene warning (adversary runbook note, docs/adversarial/
# sdn-relay-review-2026-07-24.md) — non-fatal: flags loose permissions on the
# env file holding the secret without blocking the push over it.
ENV_PERMS=$(stat -c '%a' "$ENV_FILE" 2>/dev/null || stat -f '%Lp' "$ENV_FILE" 2>/dev/null || echo "?")
if [ "$ENV_PERMS" != "600" ]; then
  echo "push-sdn.sh: WARNING — $ENV_FILE permissions are $ENV_PERMS, expected 600 (run: chmod 600 $ENV_FILE)" >&2
fi

TMPFILE=$(mktemp)
# The curl CONFIG file (not -H on argv) is how the bearer token stays out of
# `ps` output while curl runs — a `-H "Authorization: Bearer $TOKEN"` on the
# command line is visible to any other process on the box for the duration of
# the call (adversary runbook note). The config file is created 600 and
# removed in the SAME trap as the fetched CSV tempfile.
CURL_CFG=$(mktemp)
chmod 600 "$CURL_CFG"
trap 'rm -f "$TMPFILE" "$CURL_CFG"' EXIT
{
  echo "header = \"Content-Type: text/csv\""
  echo "header = \"Authorization: Bearer $SDN_INGEST_TOKEN\""
} > "$CURL_CFG"

# -L is load-bearing: Treasury answers HEAD directly but 302-redirects GETs
# (proven live 2026-07-24: HEAD→200 with Content-Disposition, GET→302 size:0).
if ! curl -sfL --max-redirs 5 -m 120 -o "$TMPFILE" "$SDN_URL"; then
  echo "push-sdn.sh: FAILED — curl fetch of $SDN_URL did not return 200" >&2
  exit 1
fi

if [ ! -s "$TMPFILE" ]; then
  echo "push-sdn.sh: FAILED — fetched SDN.CSV is empty" >&2
  exit 1
fi

RESPONSE=$(curl -s -o /dev/null -w '%{http_code}' -m 60 -X POST "$INGEST_URL" \
  -K "$CURL_CFG" \
  --data-binary "@$TMPFILE")

if [ "$RESPONSE" != "200" ]; then
  echo "push-sdn.sh: FAILED — ingest POST returned HTTP $RESPONSE (not 200)" >&2
  exit 1
fi

echo "push-sdn.sh: OK — relayed $(wc -l < "$TMPFILE") lines, ingest returned 200"
