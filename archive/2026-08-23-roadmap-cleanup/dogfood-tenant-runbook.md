# Coldrig dogfood tenant #1 (EpiphanyMade) — RUNBOOK

**Prepared 2026-08-23 · READ-ONLY investigation · `/Users/yaakovscher/dev/coldstart`**
Grounded at HEAD `d2e7755`; sibling agents advanced the tree to `1f61739` during this pass. Every `file:line` below was **re-verified against `1f61739`** after the move — all held.
Nothing in this file has been executed. No tenant was created, no money moved, no repo file changed.

Evidence convention: **OBSERVED** = read off a live wire or file this pass, command quoted. **CODE** = read in the repo, `file:line`. **INFERRED** = arithmetic/reasoning, flagged as such. **UNVERIFIED** = could not be checked read-only.

---

## 0. Three premise corrections before anything else

The brief carries three assumptions that the code and the live wire contradict. They change the plan, so they lead.

1. **There is no Porkbun adapter in the live path. Porkbun was dropped.**
   `ACTIVATION.md:31` — *"Porkbun DROPPED (no purchase API). Real `DomainPort` adapter is coded against Porkbun … needs a rewrite against Cloudflare Registrar, unactivated until then."*
   The file at `apps/platform/src/vendors/real/domain-port.ts` is now `RegistrarUnarmedDomainPort` — a fail-loud stub that throws on every method (`domain-port.ts:46-60`). The **only** working registrar is **InboxKit-as-registrar** (`apps/platform/src/vendors/real/inboxkit-domain-port.ts`), reached only when BOTH `REGISTRAR_PROVIDER=inboxkit` (env) AND the tenant's persisted `registerDomains` opt-in are true (`apps/platform/src/vendors/registrar-arming.ts:6-21`).

2. **`npx agent-cold-email setup` cannot buy a domain.** The CLI's setup command builds its body from six flags and never sends `registerDomains` or `registrant` (`packages/cli/src/commands/infra.ts:8-19`, `runSetup`). Omitting `registerDomains` blocks any new purchase and returns `400 registrar_optin_missing` (`AGENTS.md`, `setup_infrastructure` row; `packages/shared/src/intents.ts:78`). **The real setup call must go over HTTP or MCP, not the CLI.** The CLI is usable for `signup`, `status`, `campaign launch --file`, `inbox`, `metrics`, `pause`, `account` — and for nothing on the provisioning path.

3. **The blocking step is not domains, mailboxes or warmup. It is the per-mailbox Gmail OAuth grant, and it has never completed in production.**
   ```
   $ curl -H "Authorization: Bearer $TOK" https://api.coldrig.dev/admin/ops/digest
   HTTP 200 in 31.0s
   … "pendingCredentialPushes":4 …
   "4 mailbox(es) still awaiting an engine credential push — they cannot send or poll until an OAuth grant is minted for them (manual-grant step)"
   ```
   All four are Mordy's; there are no others on the platform. Programmatic minting is **dead by vendor policy** — `ROADMAP.md:52`, InboxKit support verbatim 2026-08-10: *"we don't support using the generated refresh tokens for programmatic sending through the Gmail API."* The live path is `ManualOAuthMinter`, which reads a per-address grant from the `GMAIL_OAUTH_GRANTS` Worker secret and throws permanently for any address absent from it (`apps/platform/src/vendors/real/oauth-mint.ts:48-59`). `ROADMAP.md:52` prices this at **~10 min founder-hands per mailbox**.

   Consequence: **a dogfood campaign's first real send would be the first time this platform has ever pushed a credential and sent through the real path.** That is the dogfood's actual value and its actual risk, and it is not a step that can be run unattended.

---

## 1. Does an EpiphanyMade / founder tenant already exist?

**No.** Not a paid one, not an activated one, not one under any founder address.

### Read paths available (and the one that does not exist)
There is **no admin tenant-list endpoint**. The registered admin routes are, in full:
`POST /admin/tenants/:id/messages`, `GET /admin/tenants/:id/messages` (`routes/admin-messages.ts:18,47`), `GET /admin/tenants/:id/provisioning-state` (`routes/admin-provisioning-state.ts:23`), `GET /admin/screening/reviews`, `POST /admin/tenants/:id/screening` (`routes/admin-screening.ts:29,37`), `POST /admin/support/triage`, `GET /admin/support/digest` (`routes/admin-support.ts:17,69`), `POST /admin/sdn/ingest` (`routes/admin-sdn-ingest.ts:35`), `POST /admin/ops/dunning-sweep`, `GET /admin/ops/digest`, `GET /admin/ops/checks`, `GET /admin/ops/waitlist`, `POST /admin/tenants/:id/terminate` (`routes/admin-ops.ts:43,49,127,161,173`).
`/admin/db` and `/admin/tenant-slice` named in the brief are **module names**, not routes (`apps/platform/src/admin/db.ts`, `apps/platform/src/admin/tenant-slice.ts`). The digest is aggregate-only — it exposes counts, never a per-tenant contact email (`apps/platform/src/admin/ops-sweep.ts:551-613`).

So Q1 was answered two ways: the aggregate over the wire, and a read-only D1 SELECT.

### Aggregate (live)
```
$ TOK=$(security find-generic-password -s admin-token -a coldrig -w)
$ curl -H "Authorization: Bearer $TOK" https://api.coldrig.dev/admin/ops/digest
HTTP 200 in 31.0s
{"windowHours":24,"tenants":{"total":64,"scanned":64,
  "activeByPlan":{"demo":55,"launch":5,"growth":2,"managed":1,"scale":1}},
 "complete":true,"mrrCents":3960,"totalUsageCents":3624,"provisioningFailureCount":0,
 "deliverability":{"pausedMailboxesTotal":2,"burningDomainsTotal":0,"actionsInWindow":0},
 "pendingCredentialPushes":4,"support":{"open":0,"escalated":8,"closed":0,"total":8},
 "pastDueCount":0,"lifecycle":{"canceled":1,"terminated":0,"disputed":1,
 "annualDomainLiabilityCents":2216,"unbucketed":0},"waitlist":{"count":3},"errors":0}
```
`managed` is the single current paid plan (`apps/platform/src/engine/billing.ts:69` — `const MANAGED_PLAN: TenantPlan = "managed"`). **`managed: 1`** and **`mrrCents: 3960` = $39.60** are both exactly Mordy. `launch`/`growth`/`scale` are retired plan names on old internal test tenants.

### Per-tenant (read-only D1 SELECT, `rows_written: 0`)
```
$ npx wrangler d1 execute coldstart-platform-db --remote --json \
    --command "SELECT COUNT(*) AS total,
      SUM(CASE WHEN lower(contact_email)='yaakovscher@gmail.com' THEN 1 ELSE 0 END) AS exact_founder,
      SUM(CASE WHEN lower(contact_email) LIKE '%@epiphanymade.com' THEN 1 ELSE 0 END) AS epiphany_domain,
      SUM(CASE WHEN status!='active' THEN 1 ELSE 0 END) AS not_active FROM tenants_index"
[{'total': 64, 'exact_founder': 0, 'epiphany_domain': 1, 'not_active': 0}]
```
The seven rows matching any founder pattern:

| created | plan | status | contact_email | brand |
|---|---|---|---|---|
| 2026-07-24 | demo | active | yaakovscher+billingverify3@gmail.com | Coldrig Billing Verify3 (internal) |
| 2026-07-24 | demo | active | yaakovscher+billingverify2@gmail.com | Coldrig Billing Verify2 (internal) |
| 2026-07-24 | demo | active | yaakovscher+billingverify20260724@gmail.com | Coldrig Billing Verify (internal) |
| 2026-07-23 | demo | active | yaakovscher+pricev-scale@gmail.com | Coldrig Price Verify scale (internal) |
| 2026-07-23 | demo | active | yaakovscher+pricev-growth@gmail.com | Coldrig Price Verify growth (internal) |
| 2026-07-23 | demo | active | yaakovscher+flipverify20260723@gmail.com | Coldrig Flip Verify (internal) |
| 2026-07-15 | demo | active | jacob@epiphanymade.com | coldrig-smithery-scan |

**Verdict: zero tenants at `yaakovscher@gmail.com`. Exactly one `@epiphanymade.com` tenant — `ten_308b1b65…`, brand `coldrig-smithery-scan`, a sandbox tenant minted for the Smithery directory security scan on 2026-07-15 (`ROADMAP.md:161`, item (h): "scan tenant ten_308b1b65 sandbox").** All seven are `demo` plan = structurally sandboxed, no real vendor adapter reachable (`AGENTS.md`, Auth model). Nothing to reuse — tenant #1 is a genuine new build.

Caveat worth carrying: `tenants_index.plan` is **never updated after signup** (`ROADMAP.md:220` ⚠️; there is no UPDATE of that column anywhere — `apps/platform/src/db.ts:24` inserts it, `db.ts:209` only ever writes `status`). Mordy's row also still reads `demo`. Plan truth lives in the DO / Stripe, which is what the digest reads.

Also relevant to any later reporting: `ROADMAP.md:76` — 62 of 63 (now 63 of 64) `tenants_index` rows are internal test/QA tenants. A dogfood tenant would be the **second** real one.

---

## 2. The exact sequence to create tenant #1 through the real product path

### Step 1 — `signup` (free, no card, seconds)
```
npx agent-cold-email signup --brand "EpiphanyMade" --email "yaakovscher@gmail.com"
```
Asks for nothing interactively; both values come from flags or positionals (`packages/cli/src/commands/signup.ts:6-13`). POSTs `{brand, contactEmail}` to `/signup`, prints `Tenant created: ten_…` and `Token (store this securely — shown once): …` (`signup.ts:17-24`).

Server side (`apps/platform/src/routes/signup.ts`): rate-limited per-IP 5/min, 50/day (lines 19-20); **always mints `plan: "demo"`** (line 51); no CAPTCHA, no screening at this step. Response `201 {tenantId, token}`.

⚠️ Store the token immediately — it is shown once and is the only credential for the tenant.

**Brand choice matters downstream.** `brand` and `primaryDomain` must be consistent — `engine/brand-guard.ts` hard-rejects a well-known-brand denylist and requires the asserted brand to correspond to the primary domain (`brand-guard.ts:27-46` for the denylist; neither "coldrig" nor "epiphanymade" is on it). The brand also feeds the lookalike generator, i.e. it picks the domain you will buy (Step 3).

### Step 2 — activation via `POST /checkout` ⚠️ REAL MONEY, LIVE STRIPE
There is **no CLI command for checkout** (`packages/cli/src/index.ts:20-35` — the nine subcommands do not include it). HTTP or MCP only.

```
POST https://api.coldrig.dev/checkout
Authorization: Bearer <tenant token>
{"mailboxes": 5, "interval": "month"}
```
`mailboxes` is `int min 5 max 60`; `interval` defaults to `"month"` (`packages/shared/src/intents.ts:238-241`). Returns `201 {mode, url, sessionId}` — a hosted Stripe Checkout URL.

**Stripe is on LIVE keys in production.** `MEMORY.md:23` (2026-07-23): *"LIVE Stripe key flip executed and verified two ways: Stripe API read-back showed `livemode:true` on the created checkout session."* Confirmed again this pass — the live account holds a live subscription:
```
$ SK=$(security find-generic-password -s stripe-live-secret-key -a coldrig -w)
$ curl -G https://api.stripe.com/v1/subscriptions -d limit=10 -d status=all -H "Authorization: Bearer $SK"
sub_1TyESeRKYEFKoA9wy4x95zyH | active | items [('coldrig_platform_monthly_v1', 1), ('coldrig_mailbox_monthly_v1', 5)]
```

**Is a card required?** The session is created with `payment_method_collection: "if_required"` and `allow_promotion_codes: "true"` (`apps/platform/src/billing/stripe-client.ts:104-105`). The docstring states it exactly (`stripe-client.ts:81-84`): *"`payment_method_collection: "if_required"` still collects a card whenever the discounted invoice is > $0 … only a 100%-off ($0) checkout completes without one."* Proven historically in test mode — `ROADMAP.md:114`: 100%-off promo → *"$0.00 / 100% off" shown, NO card requested*.

**Does a 100%-off coupon exist in LIVE mode? No.** Read-only listing this pass:
```
$ curl -G https://api.stripe.com/v1/coupons -d limit=50 -H "Authorization: Bearer $SK" -H "Stripe-Version: 2024-06-20"
livemode: True | count 1
nxzMBfAw | name=Mordy pilot (cost-pric | pct=60.0 | duration=forever | valid=True | redeemed=1

$ curl -G https://api.stripe.com/v1/promotion_codes -d limit=50 -H "Authorization: Bearer $SK" …
count 1
code=MORDYPILOT | coupon=nxzMBfAw pct=60.0 dur=forever | active=False | max_red=1 used=1 | livemode=True
```
The live account holds **one coupon (60% off) and one promotion code, `MORDYPILOT`, which is `active=False` and exhausted (`max_redemptions:1`, `times_redeemed:1`)**. There is no usable code of any percentage in live mode today.

So the checkout page today reads **$99.00/mo and demands a card.**

Three ways out, in order of preference:

- **(A) Mint a live 100%-off coupon + promotion code — recommended.** Founder action in the Stripe dashboard (or an authorized API write). Constraints are mandatory, not stylistic (`stripe-client.ts:74-80`): **`duration: "forever"`** (or a `repeating` duration covering the whole term) and `max_redemptions: 1`. A duration-limited coupon expiring later leaves a renewal invoice charging a subscription **whose card was never collected**, which lands the tenant in `past_due` → dunning-suspend. Gotcha carried from the last mint (`ROADMAP.md:114`, item (c)): `POST /v1/promotion_codes` rejects the `coupon` param on the account's default API version — **pin `Stripe-Version: 2024-06-20`** or use the dashboard.
- **(B) Reuse the 60% coupon** → $39.60/mo, **card required** (discounted invoice > $0), and the founder pays himself $39.60/mo minus Stripe fees. Worse than (A) on every axis.
- **(C) Pay the real $99/mo.** Only if the founder wants a clean, uncomped revenue-path exercise.

**There is no admin or manual activation bypass.** `billing_state = 'active'` has exactly two writers: `completeCheckoutSimulated` (`engine/billing.ts:258`) and the Stripe `checkout.session.completed` webhook (`engine/billing.ts:656`). The simulated route is hard-404'd whenever real spend is armed (`routes/checkout.ts:73-75`, `isRealSpendArmed`), and spend **is** armed (§3 below). Activation must go through live Stripe.

**OFAC screening fires here.** `screenTenant(ctx, {trigger:"checkout"})` runs on the checkout lane (`engine/billing.ts:282, 714`). It is real, not stubbed — the live SDN table holds **19,249 rows** (`SELECT COUNT(*) n FROM sdn_entries` → `[{'n': 19249}]`). It screens brand, the contact-email **domain**, and the Stripe billing name (`ofac/screening.ts:100-108`). "EpiphanyMade"/"gmail.com" will not match; the residual risk is the **fail-closed** branch — if no SDN list is loaded at screening time the verdict is `review`, which blocks activation exactly like a real hit (`ofac/screening.ts:112-127`). Clearing that is an admin write: `POST /admin/tenants/:id/screening {"decision":"clear"}` (`routes/admin-screening.ts:37`).

### Step 3 — `setup_infrastructure` (HTTP/MCP only) ⚠️ REAL VENDOR SPEND
```
POST https://api.coldrig.dev/setup-infrastructure
Authorization: Bearer <tenant token>
Idempotency-Key: <stable key, reuse verbatim on every retry>
{
  "brand": "EpiphanyMade",
  "primaryDomain": "epiphanymade.com",
  "domains": 1,
  "inboxesEach": 2,
  "persona": "Jacob",
  "physicalAddress": "209 Crest Hill Road, Toms River, NJ 08755, US",
  "senderIdentity": "Jacob, EpiphanyMade",
  "registerDomains": true,
  "registrant": {
    "firstName": "...", "lastName": "...", "email": "...", "phone": "...",
    "addressLine1": "209 Crest Hill Road", "city": "Toms River",
    "state": "NJ", "country": "US", "postalCode": "08755",
    "organization": "EpiphanyMade"
  }
}
```
Schema: `packages/shared/src/intents.ts:39-135`. Field notes that bite:
- `senderIdentity` is a **plain string**, not an object (`intents.ts:47`; `AGENTS.md`).
- `inboxesEach` (uniform) **or** `distribution` (per-ordinal array, one entry per domain) — one is required (`intents.ts:120-127`). `distribution: [3,2]` is how you express 5 mailboxes over 2 domains without overshooting to 6.
- `registerDomains` is **optional with no default, deliberately three-valued**: `true` opts in, `false` opts out, **absent leaves prior consent untouched** (`intents.ts:60-79`). Omitting it on a later call does not wipe consent — that was fixed after incident 2026-08-05.
- `registrant` is optional even with `registerDomains:true` (it is re-derived from `tenant_profile.registrant_json`), but on the FIRST call there is nothing on file, so it must be supplied or the call fails at the buy site after one wasted vendor read (`intents.ts:81-99`).
- `quoteOnly: true` returns the proposed mailbox count and projected monthly price **without provisioning** (`intents.ts:52-56`). **Run this first.**
- `domains` covers ordinals `0..domains-1`; a repeat call at the same `domains` provisions nothing new. Keep `persona` **unchanged** across retries — addresses are deterministic from it.
- `physicalAddress` and `senderIdentity` are appended to every outbound message as the CAN-SPAM footer alongside the one-click unsubscribe link (`engine/tick.ts:97-111`).

**What actually happens, and what it costs.** Domain purchase goes through `RealInboxKitDomainPort`:
- Candidate names are generated deterministically: `["go","the","my","get","try"]` + the slug of `primaryDomain`'s root + **`.com` only** (`inboxkit-domain-port.ts:108-124`). For `primaryDomain: epiphanymade.com` → `goepiphanymade.com`, `theepiphanymade.com`, `myepiphanymade.com`, `getepiphanymade.com`, `tryepiphanymade.com`. Past five, it spills to `epiphanymade1.com`, `epiphanymade2.com` (`:122-125`). **You do not get to choose the name** — you choose `brand` + `primaryDomain` and the generator picks. Availability is probed one real network call per candidate (`:139-155`).
- The buy is `POST /domains/register` with `use_wallet_balance: true` and the registrant block, `registration_years: 1` (`inboxkit-domain-port.ts:225-245`).
- **Cost, OBSERVED on the live wire this pass:** `.com` = **$12.50/yr**.
  ```
  $ IK=$(security find-generic-password -s inboxkit-api-key -a coldrig -w)
  $ curl -X POST -H "Authorization: Bearer $IK" -H "X-Workspace-Id: c5188ced-…" \
      -H "Content-Type: application/json" -d '{"page":1}' https://api.inboxkit.com/v1/api/domains/list
  goauthorpitchdesk.com  | price 12.5 | active | 2 mailboxes | purchased | 2026-08-04
  theauthorpitchdesk.com | price 12.5 | active | 2 mailboxes | purchased | 2026-08-12
  dmhadvisor.com         | price 0    | scheduled_for_deletion | 0 | connected
  ```
- ⚠️ **If the wallet cannot cover it, the vendor returns a Stripe checkout URL instead of debiting** — the adapter throws `operatorActionable` because the pipeline has no interactive-checkout step (`inboxkit-domain-port.ts:250-264`). This is the exact 2026-08-18 incident class.

Mailbox provisioning: `POST /mailboxes/buy` with `use_wallet_balance: true`, `platform: "GOOGLE"` (`vendors/real/mailbox-port.ts:59-79`). The buy is **async** — the vendor answers `status: "scheduled"` and the mailbox does not exist yet; the engine polls `provisioningState` until `active` (`mailbox-port.ts:81-123`). Addresses are `{personaSlug}{domainOrdinal+1}{mailboxIndex+1}@{domain}` (`engine/mailbox-provisioning.ts:111-116`) — e.g. `jacob11@goepiphanymade.com`, `jacob12@goepiphanymade.com`. Recommended density is 3 mailboxes/domain (`packages/shared/src/pricing.ts:26`).

Warmup enrolls automatically once the mailbox is `active`: `POST /warmup/add` with `activate_immediately: true` (`mailbox-port.ts:165-172`). **Cost OBSERVED: $3/mo per mailbox**, and the vendor's own pool config is `starting_volume 10 → +1/day → target 25`:
```
$ curl -X POST … -d '{"page":1}' https://api.inboxkit.com/v1/api/warmup/list
mordytee22@goauthorpitchdesk.com | $3/mo | active | started 2026-08-18T21:13:49Z
  warmup config: {'starting_volume': 10, 'daily_increase': 1, 'target_volume': 25, …}
  … (4 subscriptions, all $3/mo, all Mordy's)
```
Note the vendor's pool warmup is **feed-invisible** — nothing in `infrastructure_status` surfaces it (`AGENTS.md`, warmup quartet).

Response shape: `202` with a `provisioning` field naming the state when work is still owed, `200` when it finished inside the call. Poll `GET /infrastructure-status` or re-call the same endpoint to progress it (`AGENTS.md`). **Repeating a call never buys twice**, whatever you do with the idempotency key.

**Observed latencies (live data, this pass):**
| leg | observed | source |
|---|---|---|
| domain buy → vendor registration | ~25 s | platform `purchasedAt` 1786563007341 = 19:30:07Z vs vendor `registration_date` 19:30:32Z |
| domain → mail DNS ready | bounded at **6 h**, then the platform gives up honestly | `engine/domain-dns.ts:115` `DNS_PENDING_MAX_MS = 6*60*60*1000` |
| mailbox buy → warmup enrolled | **~1 h 19 m – 2 h 04 m** typical (one ~22 h outlier) | mailbox `createdAt` vs warmup `started_at`, 4 samples |

### Alternative Step 3 — BYO domain (`configure_byo_domain`)
Avoids the $12.50 but adds gates. `action: "register"` needs `{domain, domainRelationship}` where relationship ∈ `fresh_standalone | subdomain_of_primary | is_primary` (`intents.ts:317-322`). Registration runs a pre-flight DNS scan, an abuse/homoglyph gate, and a reputation ladder (`engine/byo-intake.ts:123-165`). Status walks `pending_kyc | pending_consent | pending_dns → active` (or `rejected`/`abandoned`). `is_primary` **requires** an explicit `acknowledge_consent` call before it can proceed. Then `request_managed_mailboxes {id, count}` provisions platform mailboxes onto it.
Two warnings from `AGENTS.md`: **a burned BYO domain hard-pauses and is never auto-replaced** (unlike a purchased lookalike), and **there is no published price for BYO-connected mailboxes — do not quote one**. Also: `pending_kyc` has **no admin clearance route in this build** — the row sits until a human clears it, and no such human path exists (`byo-intake.ts:156-161`). Using `epiphanymade.com` itself as `is_primary` would delegate mail DNS on the live brand domain; do not.

### Step 4 — the Gmail OAuth grant ⚠️ THE ACTUAL BLOCKER
Per mailbox, manual, founder-hands, ~10 min each (`ROADMAP.md:52`). The refresh token goes into the `GMAIL_OAUTH_GRANTS` Worker secret; `ManualOAuthMinter` throws non-retryably for any address not present (`oauth-mint.ts:52-58`). The push is recorded before it runs and retried by the reconcile sweep on failure, and never throws into the provisioning saga (`engine/mailbox-credential-push.ts:11-27`). The consent screen is **in Production**, so refresh tokens do **not** expire weekly — the old "Testing status" note is a corrected ledger error (`ROADMAP.md:127`).

Until this lands for a given mailbox, that mailbox cannot send or poll. Today: 4 of 4 pending, platform-wide.

### Step 5 — `campaign launch --file`
```
npx agent-cold-email campaign launch --file campaign.json
```
The CLI reads the file and POSTs it verbatim to `/campaigns` (`packages/cli/src/commands/campaign.ts:16-22`). Body = `LaunchCampaignInput` (`packages/shared/src/intents.ts:157-181`):
```json
{
  "name": "string (1-200)",
  "offer": "string (1-2000)",
  "leads": [{"email": "valid@email", "firstName": "string (1-200)", "company": "string (default \"\")"}],
  "sequence": [{"step": 1, "subject": "string (1-300)", "body": "string (1-20000)", "delayDays": 0}],
  "timezone": "UTC",
  "sendWindow": {"startHour": 9, "endHour": 17},
  "stopOnReply": true
}
```
Bounds: `leads` 1–5000, `sequence` 1–10 steps, `delayDays` 0–60. `sendWindow` hours are **integers 0–23**, never `"09:00"` strings (`intents.ts:176`; `AGENTS.md`). `timezone` defaults `"UTC"`, `stopOnReply` defaults `true`.

**Personalization is exactly two tokens: `{{firstName}}` and `{{company}}`.** Rendered per-recipient at send time against the lead row (`engine/tick.ts:369-370`). There is no custom-field mechanism and no per-recipient body override — the body lives on the *step*, not the lead.

Reply/suppression/compliance behaviour:
- Every send appends `senderIdentity` + `physicalAddress` + a signed one-click unsubscribe URL, plus a `List-Unsubscribe` header (`engine/tick.ts:88-111, 428`).
- Suppression is re-checked **at send time**, tenant-wide, across every campaign — a suppression created after launch is honoured (`engine/tick.ts:243-247, 322-324`).
- Lead status, campaign status and the send window are all re-checked per due row (`engine/campaigns.ts:63-71`).
- Replies land in the unified `GET /inbox`; `stopOnReply: true` halts that lead's remaining steps.
- A launch byte-identical to one made in the **last 60 seconds** is refused `409 duplicate_campaign` (`engine/campaigns.ts:85-110`).
- `launch_campaign` does **not** require mailboxes to exist — sends are scheduled with `mailbox_id NULL` and a mailbox is picked at send time (`engine/campaigns.ts:155-160`, `engine/tick.ts:343-344`). A campaign can be launched early; it simply will not send.

---

## 3. Timeline and cost

### Arming state (all verified live this pass)
```
$ curl https://api.coldrig.dev/status                    → {"status":"ok","sweepAgeSeconds":203}
$ curl -H "Authorization: Bearer $TOK" .../admin/ops/checks?unhealthy=1
  expected: [do_storage, failure_signals, cron_legs, sweep_coverage, sweep_signals,
             alert_delivery, engine, vendor_wallet, warmup_duplicates]   missing: []
  unhealthyCount: 2  (sweep_coverage — capacity, "NOTHING IS FAILING";
                      customer_progress_agent:ten_91aab24a… — Mordy's agent idle 39h)
```
`engine` and `vendor_wallet` both appear in `expected` with `missing: []`, which means `ENGINE_BASE_URL` and the InboxKit credentials are both bound — the checks are env-conditional and a skip-dark check would show up in `missing`. Real spend **is** armed (`engine/billing.ts:66-76`, `isRealSpendArmed`). The two unhealthy rows are the known standing baseline (`HANDOFF.md:14`), not a blocker.

### Time from signup to first real send
| phase | elapsed | gating |
|---|---|---|
| signup | seconds | none |
| checkout | ~5 min | ⚠️ founder browser + card-or-coupon decision |
| OFAC screen | inline at checkout | auto-clears; fail-closed needs an admin write |
| domain buy → registered | ~30 s | wallet must cover it |
| mail DNS ready | minutes–6 h | vendor automation; 6 h is the give-up bound |
| mailbox buy → active → warmup | ~1.5–2 h per batch | vendor async |
| **Gmail OAuth grant + credential push** | **~10 min founder-hands per mailbox, never yet done in prod** | ⚠️ **hard blocker, not automatable** |
| first send | day 1 of ramp | **5/day/mailbox** (`engine/warmup.ts:22`) |

**Infrastructure: same day, roughly 3–8 hours, mostly unattended. First real send: gated entirely on the OAuth grant, which needs the founder at a keyboard and has zero production track record.**

Ramp, per mailbox (`apps/platform/src/engine/warmup.ts:21-27`): days 1–7 = **5/day**, 8–14 = 15/day, 15–21 = 25/day, 22–28 = 35/day, 29+ = 40/day. `sendReady` flips only at day 29 and is a fully-ramped flag, **not** a send gate (`AGENTS.md`; `admin/support-kb.ts:57`). With 2 mailboxes that is **10 sends/day on day 1** — against a target list whose email-able size is 3–4 (§4). Capacity is not the constraint here; nothing about this campaign needs the ramp.

### Money

**Tenant-facing (Stripe, LIVE):**
| scenario | monthly | card required? |
|---|---|---|
| new 100%-off `forever` coupon (recommended) | **$0.00** | **no** |
| reuse the 60% coupon | $39.60 | ⚠️ **yes** |
| no coupon | ⚠️ **$99.00** | ⚠️ **yes** |
List price is $49 platform + $10/mailbox × min 5 (`billing/stripe-client.ts:19-24` — `unitAmount` 4900 + 1000; `packages/shared/src/pricing.ts:18-20`). Note the floor: **you are billed for 5 mailboxes even if you provision 2** (`engine/billing.ts:88-96`, `checkoutMailboxQuantity` = `max(5, provisioned)`).

**Vendor COGS (InboxKit wallet — our money, invisible to the tenant bill).** Live wallet, read this pass:
```
$ curl -H "Authorization: Bearer $IK" -H "X-Workspace-Id: c5188ced-…" \
     https://api.inboxkit.com/v1/api/billing/wallet
{"error":false,"message":"Wallet Details","total_credits":91,"credits_used":51,
 "credits_remaining":40,"auto_topup_enabled":true,"auto_topup_mode":"threshold",
 "auto_topup_trigger_drops_below":10,"auto_topup_add_credits":25}
```
| item | unit | basis |
|---|---|---|
| `.com` domain | **12.5** / yr | OBSERVED (`price: 12.5` on both live domains) |
| warmup subscription | **3** / mo / mailbox | OBSERVED (`price_per_month: 3`, ×4 live) |
| Google mailbox | **~3.5** / mo | **INFERRED**: 51 used − 25 (2 domains) − 12 (4 warmups) = 14 ÷ 4 mailboxes. Consistent with `DEFAULT_COST_MAILBOX_CENTS = 690` = "slot amortized ($39/10) + $3/mo warmup" (`engine/spend-ceiling.ts:78`). Not directly readable. |
| credit ↔ dollar mapping | **UNVERIFIED** | no wired endpoint states it; treat 1 credit ≈ $1 |

Projected wallet draw for a **2-mailbox / 1-domain** dogfood: `12.5 + 2×3.5 + 2×3 = 25.5` first month, **~13/mo recurring**. Against 40 remaining, that fits — but only just.
For the **5-mailbox / 2-domain** shape the checkout floor implies: `25 + 5×3.5 + 5×3 = 57.5` first month — **exceeds the 40 available.**

⚠️ **`auto_topup_enabled: true`.** When the wallet drops below **10** credits, InboxKit automatically buys **25** more and charges the card on file **with no approval prompt**. This fires whether or not anyone is watching. Standing draw is already ~26/mo for Mordy alone (4 mailboxes × 3.5 + 4 × 3); at 40 remaining the wallet reaches the floor within roughly a month **even with no dogfood at all**. A dogfood accelerates that. The founder should know the topups are automatic and recurring.

### ⚠️ Every step that spends money
| step | amount | whose money |
|---|---|---|
| `POST /checkout` completion | **$99/mo** (or $39.60 with the 60% coupon; $0 only with a new 100% coupon) | founder's card → founder's Stripe, minus fees |
| `setup_infrastructure` domain buy | **12.5 credits/yr each** | InboxKit wallet |
| `setup_infrastructure` mailbox buy | **~3.5 credits/mo each** (inferred) | InboxKit wallet |
| warmup enrollment | **3 credits/mo each** | InboxKit wallet |
| InboxKit auto-topup | **+25 credits, automatic, unprompted** | founder's card at InboxKit |
| Stripe renewal with a duration-limited coupon | full price on a **card that was never collected** → `past_due` → dunning-suspend | founder |

---

## 4. Risks specific to dogfooding

**a) The target list is barely an email campaign.** Mechanically counted from the ranked table (`docs/research/backlink-outreach-targets-2026-08-17.md:144-158`), **4 of 14** rows carry a literal email address — and all four are generic inboxes:

| # | target | route | email-able |
|---|---|---|---|
| 1 | Fastio | `help@fast.io` | ✅ generic |
| 2 | Crustdata | `info@crustdata.com` | ✅ generic |
| 3 | Salestools Club | submit form | ❌ |
| 4 | Noded | `hello@getnoded.ai` | ✅ generic |
| 5 | ColdIQ | LinkedIn / X / booking link | ❌ DM |
| 6 | Directory for AI | Submit Tool form | ❌ |
| 7 | mcpservers.org | form | ❌ |
| 8 | MCP.Directory | form | ❌ |
| 9 | best-of-mcp-servers | GitHub PR (**already filed, #366**) | ❌ |
| 10 | Oryndex | submit form | ❌ |
| 11 | mcp-server-directory.com | form | ❌ |
| 12 | Trumpet | `support@sendtrumpet.com` | ✅ generic |
| 13 | Catchr | contact page | ❌ |
| 14 | O-mega | **HOLD** — category mismatch | ❌ |

The doc's own sequencing is narrower still (`:520`): *"Send only three personalized editorial emails in the first wave: Fastio, Crustdata, and Noded."* **So the realistic campaign is 3 recipients, 4 at the outside.** Ten of fourteen need a browser (forms, DMs, a PR) — work the platform structurally cannot do.

**b) The platform's personalization cannot express what the playbook requires.** The playbook mandates per-target specificity — *"One observation that proves the page was read … Delete any sentence that would work unchanged for every target"* (`:451-460`). Coldrig offers `{{firstName}}` and `{{company}}` and nothing else (`engine/tick.ts:369-370`). To send three genuinely personalized emails you launch **three campaigns of one lead each**, which is the platform used as a very expensive `sendmail`. That is a legitimate dogfood — it exercises signup → checkout → provisioning → warmup → send → inbox → suppression end to end — but it will not exercise sequencing, per-recipient rendering, or the ramp.

**c) Brand-new domain + machine-shaped address into an editor's inbox.** The generated sender is `jacob11@goepiphanymade.com` (`mailbox-provisioning.ts:116`) on a domain registered that morning with zero sending history. The recipients are editors and directory curators who will read headers. The playbook's own pre-send gate warns that a contradictory first impression poisons future pitches (`:60`). A `go`-prefixed lookalike of a brand the recipient has never heard of, from a first-day domain, is a materially worse first touch than the founder's real mailbox — **and the dogfood premise does not require otherwise**: the prior design record already anticipated signing as *"the Coldrig agent, on behalf of EpiphanyMade"* with disclosure-forward copy (`docs/research/reviewsites-dogfood-2026-07-21.md:96`). Disclosure converts the weird sender from a liability into the point of the email. Without it, this is just a cold email from a stranger on a new domain.

**d) Primary vs secondary domain.** Do not put `epiphanymade.com` or `coldrig.dev` in the sending path. Use a purchased lookalike (which is what `setup_infrastructure` does anyway). Naming is not free-choice — it is `["go","the","my","get","try"] + slug + ".com"`, `.com` only, per `SPEC.md §12`'s no-renewal-cliff default (`inboxkit-domain-port.ts:108-125`). **Recommended: `primaryDomain: "epiphanymade.com"` → first available of `goepiphanymade.com` / `theepiphanymade.com` / `getepiphanymade.com`.** I did **not** run an availability check: `GET /domains/available` is a read, but probing candidates against the live vendor is a step that belongs inside the real setup call, and skipping it here costs nothing. Prefer `epiphanymade` over `coldrig` as the slug for one more reason: `ACTIVATION.md:15` holds public "Coldrig" display-brand rollout until attorney trademark clearance.

**e) The prior design record says dogfood should not race the pilot.** `docs/research/reviewsites-dogfood-2026-07-21.md:116` — dogfood should start *"after Mordy's pilot has completed at least one real, unremarkable send cycle (proof the arming holds under real conditions)."* **Mordy has not sent anything** — all 4 of his mailboxes are still `pendingCredentialPushes`, and his agent has been idle 39 h. That precondition is unmet today. It is a judgment call the founder owns, not a hard gate, and there is a real counter-argument: the founder's own account is exactly the right place to discover the credential-push bugs before a paying customer does. **Recommendation: dogfood the OAuth-grant → first-send path deliberately, on the founder's own tenant, as the primary objective — and treat the 3 editorial emails as the payload, not the point.**

**f) Platform guardrails that could block or slow it.**
| guardrail | effect | source |
|---|---|---|
| brand ↔ primaryDomain consistency + brand denylist | 400 at setup if inconsistent | `engine/brand-guard.ts:27-46` |
| OFAC screen at checkout | `review` blocks activation; fail-closed if no list loaded | `engine/billing.ts:282`, `ofac/screening.ts:112-127` |
| `registrar_optin_missing` | 400 until `registerDomains:true` — self-correcting, never an escalation | `AGENTS.md`, `intents.ts:60-79` |
| incomplete registrant | 400 naming the missing fields, **before any purchase** | `intents.ts:88-96` |
| wallet insufficient | vendor returns a checkout URL; adapter throws `operatorActionable` | `inboxkit-domain-port.ts:250-264` |
| DNS not ready | up to 6 h, then an honest give-up | `engine/domain-dns.ts:115` |
| ramp cap | 5/day/mailbox for the first week | `engine/warmup.ts:22` |
| suppression | re-checked at send time, tenant-wide, no un-suppress tool | `engine/tick.ts:322-324`; `AGENTS.md` |
| duplicate-campaign guard | 409 on a byte-identical relaunch within 60 s | `engine/campaigns.ts:85-110` |
| lifecycle freeze | suspended/disputed/canceled cannot launch | `engine/campaigns.ts:81` |
| unsubscribe key unavailable | **all sending pauses** for the tenant | `engine/tick.ts:283-290` |

**g) Reputational floor.** From the prior design record (`reviewsites-dogfood-2026-07-21.md:130`): *"Zero spam complaints / zero deliverability degradation on the sending domain — a hard floor … a bad outcome here damages the domain for the platform's real business."* With 3 recipients, a single complaint is a 33% complaint rate on that domain. The deliverability control loop auto-pauses on complaint rate, and a burned domain gets auto-retired and replaced — spending another 12.5 credits.

---

## 5. STOP list — do not run without the founder present

1. ⚠️ **Completing the Stripe checkout.** Live keys, real card. Founder's browser, founder's card. No exception.
2. ⚠️ **Creating or modifying any live Stripe coupon or promotion code.** A write to the live billing account. If a 100%-off code is minted it **must** be `duration: "forever"` and `max_redemptions: 1` (`stripe-client.ts:74-80`) — a duration-limited one silently sets up a future `past_due` on a card that was never collected.
3. ⚠️ **Any single action above $30, and any cumulative vendor draw above ~$30 in one session.** The 5-mailbox shape draws ~57.5 credits, above the 40 available, and would trigger auto-topup. Hold at 1 domain + 2 mailboxes (~25.5) unless the founder raises the ceiling.
4. ⚠️ **Anything that could top up the InboxKit wallet.** Auto-topup is already armed at `<10 → +25`. Do not manually top up, and flag to the founder that the automatic ones will keep firing on Mordy's recurring draw alone.
5. ⚠️ **Every irreversible action on Mordy's tenant `ten_91aab24a-43a8-45c1-bf43-af88ef633221`.** Specifically: `POST /remove-mailboxes` (release cannot be undone), `POST /admin/tenants/:id/terminate`, `suppress_lead` (no un-suppress tool exists), and **anything touching `PROVISIONING_RECONCILE_ENABLED`** — its arm-gate has four open blockers and R6 re-buys deliberately-removed mailboxes as a real purchase (`HANDOFF.md:72`). Mordy's `domainIntents[].inboxesEach` must stay `null`; verified still `null` this pass.
6. ⚠️ **The Gmail OAuth consent clicks.** Founder identity required; cannot be synthesized. ~10 min per mailbox.
7. ⚠️ **Sending any of the 3–4 editorial emails.** The playbook's standing rule (`backlink-outreach-targets-2026-08-17.md:5`): *"every email, DM, form submission, comment, issue, or PR is an external action and requires the founder's approval for that specific send. One send, one approval."* Launching the campaign in Coldrig **is** the send.
8. ⚠️ **Clearing a screening hold** (`POST /admin/tenants/:id/screening {"decision":"clear"}`) — an admin override of a sanctions gate. Founder call, even on our own tenant.
9. Do **not** re-file `mcp.so`, PulseMCP, `punkpeye/awesome-mcp-servers` #10106, or `best-of-mcp-servers` #366 — all already open or done (`backlink-outreach-targets-2026-08-17.md:499-505`).

---

## Recommended shape, in one paragraph

Mint a live 100%-off `forever` coupon (founder, Stripe dashboard, ~2 min) so activation costs $0 and needs no card. `signup --brand "EpiphanyMade" --email yaakovscher@gmail.com`. `POST /checkout {"mailboxes":5}`, redeem the code, complete at $0.00. `POST /setup-infrastructure` with `quoteOnly:true` first, then for real with `domains:1, inboxesEach:2, registerDomains:true` and a full registrant — ~25.5 credits of the 40 available, buying `goepiphanymade.com` + two mailboxes. Wait ~2 h for `active` + warmup. Then the real work: mint two Gmail OAuth grants by hand, push them, and watch the first credential-push-to-send path this platform has ever exercised. Finally launch **three one-lead campaigns** — Fastio, Crustdata, Noded — with disclosure-forward copy, each founder-approved individually. The other eleven targets are forms, DMs and a PR; they are browser work, not campaign work, and no amount of cold-email infrastructure will change that.
