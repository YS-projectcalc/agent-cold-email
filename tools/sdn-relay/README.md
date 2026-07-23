# tools/sdn-relay

Droplet-side relay for the OFAC SDN (sanctions) list. Cloudflare Workers cannot
reach `sanctionslistservice.ofac.treas.gov` directly — Treasury's TLS
front-end 525s every Worker-origin fetch (proven live 2026-07-23/24 by two
persistent cron alerts, both the legacy `www.treasury.gov` redirect and the
direct URL; a plain `curl` from a Mac or droplet gets the file fine, so this
is a Cloudflare-egress-specific block, not a broken feed). The platform's
screening system correctly fail-closes to `'review'` when no list is loaded,
but that means every real checkout gets held for manual review until a list
successfully loads — this relay is what makes that not permanent.

The droplet that already runs the email engine (`apps/engine/` —
ACTIVATION.md's "go-engine host") already does IMAP for this exact same
"Workers can't reach this host" reason. `push-sdn.sh` applies the identical
pattern to the SDN list: curl the real feed from the droplet, then POST the
raw CSV to the Worker's `POST /admin/sdn/ingest`.

## What runs where

- **`push-sdn.sh`** — runs ON THE DROPLET (installed at arming, see
  `ACTIVATION.md`'s SDN relay section). Fetches the direct Treasury URL
  (`-m 120`, fails on a non-200 or empty response), then POSTs the raw CSV to
  the Worker's ingest endpoint with a bearer token read from a droplet-local
  env file (`/root/sdn-relay.env` — NOT this repo; CLAUDE.md rule g). Exits
  non-zero with a one-line stderr message on ANY failure.
- **`POST /admin/sdn/ingest`** (`apps/platform/src/routes/admin-sdn-ingest.ts`)
  — runs in the Worker. Authenticated by a NARROW, dedicated secret
  `SDN_INGEST_TOKEN` (never `ADMIN_TOKEN` — the droplet must never hold
  cross-tenant admin power; see `require-admin-auth.ts`'s carve-out). Feeds the
  SAME `parseSdnCsv` -> `swapInSdnList` path the direct Worker fetch uses
  (`apps/platform/src/ofac/sdn-refresh.ts`), plus an additional
  `MIN_SDN_ENTRIES` floor guard (`apps/platform/src/ofac/sdn-ingest.ts`) — a
  stolen `SDN_INGEST_TOKEN` can at most submit a full, real-looking SDN list;
  it cannot neuter screening by pushing a tiny "clean" one.
- The direct Worker fetch (`maybeRefreshSdnList`) stays the PRIMARY attempt on
  every 5-minute ops-sweep cron tick and self-heals automatically if Treasury
  ever unblocks Cloudflare egress. This relay is the arriving path, not a
  replacement.

## Run / test

`push-sdn.sh` has no unit tests of its own (it is a thin curl-and-relay
shell script — the logic worth testing, `ingestSdnCsv`/`parseSdnCsv`/
`swapInSdnList`, is covered by `apps/platform/test/ofac-sdn-ingest.test.ts` and
`apps/platform/test/admin-sdn-ingest-route.test.ts`, fixtures only, no live
fetch). To exercise it for real: install it on the droplet per
`ACTIVATION.md`, then run it manually once — a `push-sdn.sh: OK` line and a
`200` from `curl https://<worker-host>/status` (or checking
`sdn_list_meta.active_version` starts with `sdn-relay-`) confirms an
end-to-end round trip.

## Why a droplet-side failure doesn't page anyone directly

Cron mail is not configured on this droplet, so `push-sdn.sh` failing is
otherwise silent. This is a deliberate, not an oversight: the Worker's own
daily refresh attempt (`maybeRefreshSdnList`) independently retries every
~5 minutes and already emails `OPS_ALERT_EMAIL` on failure — so a skipped
relay push just means that existing alert keeps firing until the next
successful push. Adding a second alert channel here would be redundant, not
additional coverage.

## Depends on

- `apps/platform/src/routes/admin-sdn-ingest.ts`, `src/ofac/sdn-ingest.ts`,
  `src/ofac/sdn-list.ts`, `src/ofac/sdn-parse.ts` (the ingest endpoint + the
  shared parse/swap path).
- `apps/platform/src/require-admin-auth.ts` (the `SDN_INGEST_TOKEN` carve-out).
- A droplet already provisioned for the go-engine host (or an equivalent
  reachable-to-Treasury host) — see `ACTIVATION.md`.
