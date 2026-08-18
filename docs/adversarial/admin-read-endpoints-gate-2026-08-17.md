# Adversarial gate — admin read endpoints (2026-08-17)

**Branch** `feat/admin-messages-read-2026-08-17` **HEAD** `ca0a7b08c36709e2029a70a570d62e7380454b85`
**Merge-base** `1e4c9732` · **Reviewed diff** `git diff 1e4c973..ca0a7b0`
**Executed in** a throwaway clone at
`/private/tmp/claude-503/-Users-yaakovscher/3c640ead-e624-4b14-ae4d-7c6a7ed77c00/scratchpad/msgread-gate-clone`
(live worktree: read-only git only).

**VERDICT: SHIP-WITH-NOTES** — 0 blocking, 3 non-blocking.

## Grounding

Live `main` moved twice during the review (`9d3ec7e9` → `3597b861`); both moves are
docs/ledger only (`HANDOFF.md`, `ROADMAP.md`, six `docs/adversarial/class-sweep-*`
files). A real `git merge origin/main` into `ca0a7b0` was run in the clone against
both revisions: clean, and `git diff ca0a7b0..<merged> -- apps/ packages/` is EMPTY,
so the branch standing alone on current main is code-identical to what was tested.
`packages/shared` tree hash is identical on branch and main (`04df811a`), so the
symlinked `node_modules` introduced no grounding error.

## Battery (in the clone, at `ca0a7b0`)

| Gate | Result |
|---|---|
| `vitest run` (apps/platform) | **177 files / 1704 tests / 0 failed**, 510s, exit 0 |
| `npm run typecheck` (all 5 workspaces) | clean |
| `npm run build` (`wrangler deploy --dry-run`) | clean; **no new bindings** |

The 1704 count matches the claim exactly. The battery ran before any probe file
was added, so the number is uncontaminated.

## Findings

### F1 · NON-BLOCKING · `provisioning-state` applies no LIMIT to any of its three queries, unlike its own messages twin

`apps/platform/src/engine/provisioning-state.ts:75-131` — all three SELECTs
(`domains`, `domain_intents`, `request_idempotency`) are unbounded. The sibling
built in the same wave, `listMessagesForOperator`
(`apps/platform/src/engine/tenant-messages.ts:361-378`), clamps to 200 and reports
`total` so truncation is visible. The asymmetry is the finding.

Row growth is tenant-controlled and cheap. `POST /setup-infrastructure`
(`apps/platform/src/routes/infrastructure.ts:13`) takes an arbitrary caller-supplied
`Idempotency-Key` header; it is not rate-limited (only signup/login use
`SIGNUP_LIMITER`); a retry that acquires nothing still succeeds
(`apps/platform/src/engine/provisioning.ts:412-413`, "a retry — which acquires
nothing — passes them all"); and `{quoteOnly: true}` returns 200 having provisioned
nothing while still being wrapped by `withRequestIdempotency`
(`apps/platform/src/tenant-do.ts:726-728`). Each distinct key writes one `done` row
that survives the 30-day TTL, and eviction is write-time and `status='done'`-only,
so orphaned `pending` rows are never evicted at all
(`apps/platform/src/engine/idempotency.ts:108-111`).

**Verification:** seeded a tenant and drove the live endpoint. 2,000 rows → 200 with
2,000 rows / 149,000 bytes. 50,000 rows → 200 with **13,830,000 bytes**. 5,000
`domain_intents` rows → 200 with 5,000 rows.

**Why not blocking:** the surface is admin-only and operator-invoked, so the blast
radius is the operator's own request plus transient occupancy of that one tenant's
DO — no customer-facing path, no data loss, no leak. Before this branch the operator
had zero visibility into these tables, so shipping is strictly better than not.
**Follow-up:** add a clamped `?limit=` + `total` per collection, mirroring the
messages twin. Note this endpoint is the *only* window into DO storage, so a
pathological tenant can degrade the diagnostic used to investigate it.

### F2 · NON-BLOCKING · `?limit=` with an empty value returns 1 row instead of the 50 default

`apps/platform/src/routes/admin-messages.ts:45-46` does
`rawLimit !== undefined ? Number(rawLimit) : undefined`. For `?limit=`, Hono returns
`""`, `Number("")` is `0`, and the clamp floors it at 1
(`apps/platform/src/engine/tenant-messages.ts:344-347`), so the operator gets exactly
one message. Realistic trigger: `curl ".../messages?limit=$LIMIT"` with `LIMIT`
unset, or a blank form field.

**Verification:** against a 205-message tenant, `?limit=` returned
`messages.length === 1` with `total === 205`. Every other shape is correct: absent→50,
`abc`→50, `1e999`→50, `0`→1, `-5`→1, `2.9`→2, `200`/`201`/`250`→200.

**Why not blocking:** `total` still reports 205, so the truncation is visible in the
same response. Suggested fix: treat an empty string as absent.

### F3 · NON-BLOCKING (latent) · `LIKE 'setup_infrastructure:%'` is a pattern, not a prefix

`apps/platform/src/engine/provisioning-state.ts:124` — `_` is a single-character
wildcard in SQL `LIKE`, so the filter also matches any key of the form
`setup?infrastructure:*`.

**Verification:** inserted `setupXinfrastructure:zzwildcardleakzz`; it appeared in the
response.

**Why not blocking:** no real key can trip it. The only writer of
`request_idempotency` is `withRequestIdempotency`
(`apps/platform/src/engine/idempotency.ts:102`), and all six call sites build the
prefix server-side: `setup_infrastructure:`, `launch_campaign:`, `remove_mailboxes:`,
`reply:<threadId>:`, `provision:<intentKey>`. None matches the pattern, and the
caller-supplied portion always lands after the colon. Direction of harm would be
over-inclusion of a key name, never `response_json`. Suggested hardening:
`WHERE substr(key, 1, 21) = 'setup_infrastructure:'` or `ESCAPE`.

## Attacks that failed

**A1 auth reality** — drove the composed worker entry (`SELF.fetch` → `src/index.ts`
default export), not the engine functions, against both new paths:

| Vector | Result |
|---|---|
| No `Authorization` header | 401 both |
| Wrong admin token | 401 both |
| Tenant's OWN bearer token | 401 both |
| A DIFFERENT tenant's bearer token | 401 both |
| `SDN_INGEST_TOKEN` (the one carve-out) | 401 both — carve-out is pinned to `POST /admin/sdn/ingest` |
| `HEAD` (Hono auto-derives it from GET) | 401 both |
| `//admin/…`, `/Admin/…`, `/admin%2Ftenants/…` | 404 (no route matched) |
| `/./admin/…`, `/admin/../admin/…`, trailing slash | 401 (middleware fired first — fail-closed) |
| **CONTROL: valid admin token** | **200 both** |

No variant returned 200 or the seeded sentinel body. The control arm proves the 401s
are real rejects and not a broken probe. `admin.use("/admin/*", requireAdminAuth)` is
registered at `src/index.ts:86` *before* the four route mounts, and Hono composes
every pattern-matching middleware regardless of which sub-app registered the handler.

**A2 tenant isolation and data exposure** — seeded two tenants; tenant B's read
returned neither A's message bodies, domain, intent key, nor idempotency key, while
A's own read contained all of them (control). Seeded a `setup_infrastructure:` row
whose `response_json` held nested sentinels and asserted over the full response text:
neither sentinel, nor `response_json`, nor `responseJson` appeared, while the row's
`key` did (control — a clean text is not merely an empty result). Isolation is
architectural: `ctx.sql` is DO-local `SqlStorage` and every stub is
`TENANT.idFromName(tenantId)`, one tenant per DO, so the unfiltered
`request_idempotency` query cannot see another tenant's rows. Confirmed the prefix
filter excludes `launch_campaign:`, `remove_mailboxes:`, `reply:`, and `provision:`
keys. Nothing rides along: every SELECT is an explicit column list, zero `SELECT *`.
`domains` carries `scan_json`, `abuse_gate_json`, `consent_json`, `is_primary`,
`dns_mode`, `byo_status`, `reputation_branch`, `breaker_tier` — none is selected.
Neither table holds credentials, billing tokens, or webhook secrets.

**A3 correctness** — 9 of 10 limit shapes correct (F2 is the tenth); `total` was 205
in all ten. `?unreadOnly=1` filters both list and total; `?unreadOnly=0` correctly
does not filter. Expired messages are included by design and `expiresAt` is surfaced
(`expiresAt: 1` for a long-expired row, `null` when unset); an expired-and-read row
is still returned and `unreadOnly` excludes it on `read_at` alone. `ordinal` is JSON
`null`, never `NaN` or garbage, for a `replace:`-prefixed key, for `#01`, `# 2`, `#`,
`#-1`, and for another tenant's prefix — and the replacement intent is still
surfaced, as its doc comment claims. NULL dns columns serialize as JSON `null` with
the keys present, not dropped.

**A4 no behavior change** — hammered both GETs repeatedly and diffed a full snapshot
of `domains`/`domain_intents`/`request_idempotency` counts plus the idempotency row's
`status` and `created_at`: byte-identical before and after. `read_at` stayed `null`
after six GETs, so the read never races `ackMessage`, which remains the only writer.
The POST twin, restructured from `new Hono().post(...)` into a `.post().get()` chain,
still 201s and writes, 404s an unknown tenant, 400s a bad kind, and 401s without
auth. No existing route pattern is shadowed; no migration, binding, env var, or flag
is involved, so deploy is code-only.

**A5 DO RPC surface** — no duplicate method names across the 66 methods on `TenantDO`,
and no collision with the `DurableObject` base. Both new methods are callable on a
real stub and return real values: `listMessagesForOperator({})` returned
`total: 1` with `actionHint` deep-equal to `{tool:"setup_infrastructure"}` (so the
`object | null` workaround did not collapse to `never` or strip the field), and
`getProvisioningStateForOperator()` returned the three-key shape. Typecheck across
all five workspaces is clean, which is the authoritative check for the
`Record<string, unknown>` never-collapse the builder documented at
`tenant-messages.ts:312-320`.

**A6 test honesty** — reverted the four modified source files to `1e4c973` and deleted
the two new ones, keeping the new tests, then re-ran both files: **7 failures in
`admin-messages.test.ts` and 2 in `admin-provisioning-state.test.ts`** — exactly the
RED runs claimed. The 17 new tests count is correct (11 + 6). Assertions are
behavioral, not existence checks: they compare bodies, ordering, `readAt`
transitions, and `total` arithmetic. One honest caveat: the six auth tests pass on
the reverted source too, since a missing route also 401s/404s — but each file also
contains a 200-with-admin-token round-trip, so the gate proof holds in aggregate,
and my own probes added an explicit control arm.

**Idempotency-row eviction as a diagnostic blind spot (refuted)** — I expected the
30-day TTL to have already evicted the rows for the stuck-tenant population the audit
cared about. It has not: `REQUEST_IDEMPOTENCY_TTL_MS` is 30 days
(`idempotency.ts:9`), eviction is write-time only, and `pending` rows are never
evicted. The window comfortably covers a days-stuck tenant.

**Fixture realism on the key prefix (refuted)** — the tests use a literal
`"setup_infrastructure:apd-setup-a-2mbx"`. Production builds
`` `setup_infrastructure:${idempotencyKey}` `` at `tenant-do.ts:728`. The fixture
matches the real producer.

**Design (lens 6)** — the endpoint does answer UNVERIFIABLE-1/2/3: `status` on a
`setup_infrastructure:` key distinguishes `done` (a retry replays with zero vendor
work) from `pending`, and ordinal plus dns fields answer 2 and 3.

## UNVERIFIABLE

1. **Production response-size ceiling for F1.** 13.8 MB round-trips through miniflare's
   DO RPC boundary; I cannot confirm Cloudflare's production limit or its failure mode
   at that size without deploying. Resolved by a post-deploy GET against a
   high-row-count tenant, or by adding the LIMIT and making the question moot.
2. **Live production behavior of both endpoints.** Not yet deployed, and the review was
   spend-safe/read-only. Resolved by a GET with the keychain admin token
   (`security find-generic-password -s admin-token -a coldrig -w`) against
   `https://api.coldrig.dev` after deploy.

## NEW (out of scope, no verdict weight)

- `connection_type` and `dns_mode` are omitted from the `domains` projection even though
  the stated purpose is "a domain's real DNS standing", and `connection_type` was the
  root cause of INCIDENT 2026-08-05 (`schema.ts:151-159`). Worth adding.
- `toTenantMessage` (`tenant-messages.ts:177`) calls `JSON.parse(row.action_hint)`
  unguarded; malformed stored JSON would 500. Pre-existing and shared with both agent
  surfaces, not introduced here.
- `created_at`/`purchased_at` are stamped on `ctx.clock`, which is VIRTUAL for demo/free
  tenants, so operator "how long has this been stuck" arithmetic against wall time is
  only meaningful for paid tenants. Pre-existing convention.
- Code comments on the branch cite
  `docs/adversarial/agent-channel-product-audit-2026-08-17.md`, which exists only on
  `main`. The reference resolves on merge; nothing to do.
