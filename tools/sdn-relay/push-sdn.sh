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

TMPFILE=$(mktemp)
trap 'rm -f "$TMPFILE"' EXIT

if ! curl -sf -m 120 -o "$TMPFILE" "$SDN_URL"; then
  echo "push-sdn.sh: FAILED — curl fetch of $SDN_URL did not return 200" >&2
  exit 1
fi

if [ ! -s "$TMPFILE" ]; then
  echo "push-sdn.sh: FAILED — fetched SDN.CSV is empty" >&2
  exit 1
fi

RESPONSE=$(curl -s -o /dev/null -w '%{http_code}' -m 60 -X POST "$INGEST_URL" \
  -H "Content-Type: text/csv" \
  -H "Authorization: Bearer $SDN_INGEST_TOKEN" \
  --data-binary "@$TMPFILE")

if [ "$RESPONSE" != "200" ]; then
  echo "push-sdn.sh: FAILED — ingest POST returned HTTP $RESPONSE (not 200)" >&2
  exit 1
fi

echo "push-sdn.sh: OK — relayed $(wc -l < "$TMPFILE") lines, ingest returned 200"
