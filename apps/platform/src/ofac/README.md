# src/ofac

G1 — real OFAC/SDN sanctions screening, replacing `screeningStatusStub`
(`docs/research/ga-gates-design-2026-07-22.md` §G1). Two halves:

- **G1a — the list itself.** Fetches, parses, and stores the US Treasury OFAC
  SDN list. Free/no-provider (SDN.CSV public download).
- **G1b — screening at activation.** Screens a tenant's brand/contact-email
  domain/Stripe billing name against the active list at checkout and at
  `setup_infrastructure`'s brand rewrite, and persists the verdict on
  `tenant_profile`.

**Read the honesty statement before quoting this anywhere customer-facing:**
`docs/research/ofac-v1-honesty-statement-2026-07-23.md` — claim "SDN-screened",
never "OFAC compliant."

## Layout

- `csv.ts` — a minimal RFC-4180-ish quoted-CSV parser (no dependency; SDN.CSV's
  shape is small and fixed).
- `normalize.ts` — `normalizeName`/`tokenize`, shared by BOTH the list build
  and the matcher so both sides normalize identically.
- `sdn-parse.ts` — parses SDN.CSV text into entries. **Fail-loud** (F5
  convention): throws on any malformed row (wrong column count) or a
  zero-entry result — never silently degrades to an empty/partial list.
- `sdn-list.ts` — D1 storage. **Shadow-swap**: `swapInSdnList` builds a
  COMPLETE new list version's rows, then atomically flips
  `sdn_list_meta.active_version` — a corrupt/partial fetch never reaches the
  active pointer. `getActiveSdnEntries`/`getActiveSdnListVersion` are the
  matcher's read side.
- `sdn-refresh.ts` — `maybeRefreshSdnList`, called from `../scheduled.ts`'s
  existing 5-min ops-sweep cron (no second `[triggers]` entry). A once-daily
  guard (`sdn_list_meta.fetched_at`) makes every other tick a cheap no-op. On
  failure: alerts the founder, keeps the prior good list, and leaves the guard
  cursor unchanged so the NEXT sweep (~5 min) retries sooner than a full day.
  `fetchImpl` is injectable (default global `fetch`) — tests NEVER make a real
  network call to treasury.gov.
- `match.ts` — the pure matcher (`matchAgainstSdn`): EXACT normalized-name
  match (any token count) + conservative SUBSET-token match (every token of a
  2+-token SDN name present in the candidate) — deliberately narrow to hold
  down false positives. No edit-distance/phonetic fuzz in v1 (documented gap).
- `screening.ts` — `screenTenant` (the orchestrator: reads the active list,
  matches the tenant's known fields, writes `tenant_profile.screening_status`/
  `screening_list_version`/`screened_at`, and on a hit writes a
  `screening_reviews` D1 row + fires a founder-only ops alert) and
  `clearScreeningStatus` (the admin `clear` resolution's write path).
- `screening-alert.ts` — the founder ops alert on a hit. Mirrors
  `../engine/registrar-alert.ts`'s exact pattern: injectable mailer, never
  fails the screening write that triggered it, founder-only framing (never
  "sanctions match" on any customer-visible surface).

## Where this plugs into the rest of the platform

- `../engine/activation.ts`'s `readActivationState` reads
  `tenant_profile.screening_status` as a blocking conjunct of
  `isTenantActivated` — **no caller of that function changed**; G1 only
  replaced what the stub returned.
- `../engine/billing.ts`'s `completeSimulatedCheckout` and
  `applyStripeWebhookEvent`'s `checkout.session.completed` case both call
  `screenTenant` at the activation transition.
- `../engine/provisioning.ts`'s `runSetupInfrastructure` re-screens on the
  brand rewrite there (NB-1 disposition — the operative sending brand is
  finalized at that point, not at checkout).
- `../routes/admin-screening.ts` is the admin resolution surface
  (`GET /admin/screening/reviews`, `POST /admin/tenants/:id/screening`).
- `../tenant-do.ts`'s `grandfatherActiveScreening` (constructor-time,
  self-applying like `ensureColumnMigrations`) stamps any tenant that is
  ALREADY `billing_state='active'` at the moment this code first deploys
  `'clear'` with a `'grandfathered-2026-07-23'` sentinel version — turning
  screening on can never strand the live pilot.

## How to run

Part of `apps/platform`; exercised by `test/ofac-*.test.ts`,
`test/admin-screening.test.ts`, and `test/screening-grandfather.test.ts`.
