# tools/indexnow

Post-deploy IndexNow submitter: pings `api.indexnow.org` with every `site/sitemap.xml` URL so Bing/Yandex/Naver/Seznam/Yep (and the agent search backends Bing feeds, e.g. Copilot) re-crawl immediately. Zero-account protocol — ownership is proven by the key file `site/a23dd986c5474f292aeddebefead63ee.txt` served from the live site root.

**Run:** `./submit.sh` after every site deploy (or `./submit.sh <custom-domain>` once the placeholder domain is swapped at activation). Aborts if the key file isn't live yet. Re-running is idempotent — engines treat it as a refresh hint.

Depends on: `site/sitemap.xml` (URL source), the key file in `site/`. Provenance: `docs/research/traffic-channels-selfserve-2026-07-13.md` channel #1 (verified no-auth flow).
