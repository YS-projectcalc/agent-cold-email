#!/usr/bin/env bash
# Submit every sitemap URL to IndexNow (propagates to Bing/Yandex/Naver/Seznam/Yep).
# PRECONDITION: run only AFTER a site deploy — the key file must be live at
#   https://$HOST/$KEY.txt or engines reject the submission when they crawl it.
# No account/auth involved; see docs/research/traffic-channels-selfserve-2026-07-13.md #1.
#
# Usage: ./submit.sh [host]   (default: agent-cold-email.pages.dev; pass the
#        custom domain after activation's find-replace swaps the placeholder)
set -euo pipefail
cd "$(dirname "$0")/../.."

HOST="${1:-agent-cold-email.pages.dev}"
KEY="a23dd986c5474f292aeddebefead63ee"

if ! curl -sf "https://${HOST}/${KEY}.txt" | grep -q "^${KEY}$"; then
  echo "ABORT: key file not live at https://${HOST}/${KEY}.txt — deploy the site first." >&2
  exit 1
fi

URLS=$(grep -o '<loc>[^<]*</loc>' site/sitemap.xml \
  | sed -e 's|<loc>||' -e 's|</loc>||' -e "s|https://[^/]*|https://${HOST}|" \
  | sed -e 's|^|"|' -e 's|$|",|' | tr -d '\n' | sed 's|,$||')

RESPONSE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "https://api.indexnow.org/IndexNow" \
  -H "Content-Type: application/json; charset=utf-8" \
  -d "{\"host\":\"${HOST}\",\"key\":\"${KEY}\",\"keyLocation\":\"https://${HOST}/${KEY}.txt\",\"urlList\":[${URLS}]}")

echo "IndexNow response: HTTP ${RESPONSE} (200/202 = accepted)"
[ "$RESPONSE" = "200" ] || [ "$RESPONSE" = "202" ]
