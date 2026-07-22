# Self-serve activation — design & gap inventory (2026-07-21)

Design lane for the founder ORDER (`ROADMAP.md:18`): *"why not just set it up so he can do it himself like any customer we want to"* + *"I'd rather do billing and give him a code"* (`ROADMAP.md:19`). Target end-state: a new customer signs up self-serve, pays via Stripe Checkout (a 100%-off promotion code works for the pilot), brings a bare domain, mailboxes provision via InboxKit, and REAL sending starts — **zero operator involvement per customer**. One-time infra arming (Cloudflare Tunnel, secrets, Stripe KYC) is acceptable founder-hands; per-customer manual steps are not.

**Scope (this design):** make the **managed shape** fully self-serve — bare domain → InboxKit provisions mailboxes → real send/poll. Mordy's actual domain `authorpitchdesk.com` is now confirmed **bare** (zero DNS records, `ROADMAP.md:24`), so he IS the managed shape, not the §20.6 BYO-mailbox/OAuth-connect shape. §20.6 "Connect Google/Microsoft" is a named follow-on increment, out of this critical path.

Ground: live worktree, all cites verified against source this session.

---

## 1. VERIFIED GAP INVENTORY

Legend: **[code]** = build work · **[founder-infra]** = one-time owner-hands arming (acceptable) · **[per-cust→auto]** = a step done manually per customer today that MUST become automatic.

### A. Activation gate — the manual allowlist is the concierge step

| # | Gap | Evidence | Class |
|---|-----|----------|-------|
| A1 | Real sending is gated on `realAdaptersActivated` (hard-`false`, no code can set it true) AND membership in the manual `ENGINE_TENANTS` comma-separated tenant-ID allowlist. The allowlist IS the per-customer concierge step — an operator hand-edits a wrangler secret and restarts DOs to onboard each tenant. | `factory.ts:112-116` (gate logic), `factory.ts:113` (`isEngineAllowlisted`), `tenant-do.ts:287` (literal `false` passed), `tenant-do.ts:293` (`this.env.ENGINE_TENANTS`), `env.ts:40-49` | **[per-cust→auto]** |
| A2 | Nothing derives activation from **product state** (paid + billing-active). The factory keys only on `plan==='demo'/'free'` + the two flags above; a paid, billing-active tenant that is NOT on the allowlist still gets a sandbox email port by construction. | `factory.ts:112-116`; freeze predicate exists but isn't consulted by the factory: `billing-state.ts:31-33` | **[code]** |
| A3 | Adapter bundle is **cached for the DO's lifetime** (`this.adapters ??= …`). After checkout, `this.plan` is refreshed in memory but the cached bundle is NOT rebuilt — a tenant that pays mid-DO-life keeps its sandbox adapters until the DO evicts/restarts. Any product-driven activation must invalidate this cache on the billing-state transition. | `tenant-do.ts:287` (`??=`), `tenant-do.ts:514-515` (`this.plan` updated on upgrade, no adapter rebuild), `tenant-do.ts:521` | **[code]** |
| A4 | Even the current allowlist has known revocation lag: adapters cached per-DO, so removing a tenant needs a DO restart to take effect (carried in `ACTIVATION.md` Gate 2, residual 3). Same root cause as A3. | `ACTIVATION.md:26` (Gate-2 residual 3) | **[code]** |

### B. Mailbox-credential plumbing — the engine can't learn a new mailbox at runtime

| # | Gap | Evidence | Class |
|---|-----|----------|-------|
| B1 | The engine loads **all** mailbox credentials **once at boot** from `/root/mailboxes.json` (or `MAILBOX_CREDENTIALS` inline) into an in-memory map. There is no runtime path to add a mailbox — you edit the file and restart the daemon. This is the core per-customer manual step for the managed shape. | `engine/config.ts:121-142` (`readCredentials`), `engine/config.ts:149-166` (`loadConfig`), `engine/index.ts:36-45` (boot wiring), `ACTIVATION.md:38-47` (the `/root/mailboxes.json` runbook) | **[per-cust→auto]** |
| B2 | `EmailEngine.resolve(email)` reads only the boot-time map; an unknown mailbox is a permanent `UnknownMailboxError`. No dynamic store, no fetch-on-miss. | `engine/engine.ts:207-211` | **[code]** |
| B3 | The engine's entire HTTP surface is `GET /health`, `POST /v1/send`, `POST /v1/poll`. There is **no credential-registration endpoint**. | `engine/router.ts:33-53` | **[code]** |
| B4 | `RealMailboxPort.provision()` returns only `{email, provider, provisionedAt}` — it never fetches the mailbox's SMTP/IMAP/OAuth credentials (InboxKit exposes `GET /mailboxes/:id/credentials`, `ACTIVATION.md:14`), and `provisionMailboxesForDomain` has no step that hands credentials to the engine. So even after a successful provision, the engine cannot send from the new box. | `mailbox-port.ts:47-71` (provision, no cred fetch), `provisioning.ts:36-101` (no cred-push step), `vendor-ports.ts:45-68` (`MailboxPort`/`ProvisionedMailbox` carry no creds) | **[code]** |
| B5 | InboxKit provisions **real Google Workspace** boxes; DO blocks SMTP submission (465/587), so the managed send path must be **gmail_api over 443** — i.e. the credential is an **OAuth refresh token**, not an SMTP password. A programmatic per-mailbox refresh-token mint exists only as an unverified candidate (`POST /mailboxes/client-id-request/initiate`); the proven fallback is a manual mint. Without the programmatic path, every managed Google mailbox needs a founder-hands token — a per-customer manual step. | `ROADMAP.md:28` (client-id-request candidate + manual-mint fallback), `ROADMAP.md:53` (SMTP-egress block), `config.ts:30-41` (`gmail_api` transport shape) | **[per-cust→auto]** (long pole) |
| B6 | IMAP reply-polling is port 993; the DO SMTP block is documented for 465/587 only, but 993-from-droplet has never been exercised (Gate-1 smoke is still open). Verify at arming. | `ROADMAP.md:53`, `ACTIVATION.md:13` (Gate-1 still open) | **[founder-infra]** (verify) |

### C. InboxKit adapters — the five REQUIRED-BEFORE-ARMING gates (dark today)

The adapters are committed but dark: sole call site passes `false` and no call site supplies `inboxKitConfig` (`factory.ts:102`, `tenant-do.ts:287`; verified in the frozen adversary record `docs/adversarial/inboxkit-adapters-2026-07-20.md`). The five gates (also `ROADMAP.md:28`):

| Gate | Gap | Evidence | Class |
|---|-----|----------|-------|
| (a) | Domain port is welded to the **same** `inboxKitConfig` credential as the mailbox port — arming the mailbox silently co-arms InboxKit as registrar, contradicting `ACTIVATION.md:9` (mailbox-scoped ruling) vs `ACTIVATION.md:25` (still names Namecheap/Porkbun). Needs a **separate explicit domain-port arming flag** + founder reconciliation of the two ACTIVATION lines. | `factory.ts:142`, `inboxkit-domain-port.ts:33-46` (OPEN QUESTION doc) | **[code]** + **[founder decision]** |
| (b) | `resolveMailboxUid` trusts `mailboxes[0]` from a keyword search with **no exact-email assert** before the destructive `/mailboxes/cancel`. | `mailbox-port.ts:123-132` (resolve), `mailbox-port.ts:111-120` (cancel) | **[code]** |
| (c) | `provision()` has **no vendor idempotency key** (double-charge retry window) + a fragile `/already exists/i` substring match; below the repo's own `withRequestIdempotency` standard. | `mailbox-port.ts:23-33` (KNOWN GAP doc), `mailbox-port.ts:47-70` | **[code]** |
| (d) | Vendor `reputationScore`/`placementRate` are fabricated approximations (health endpoint doesn't expose them) yet reach the customer-facing `infrastructure` tool + dashboard as if real. Decisions already use local signals only — this is a **display-honesty** fix. | `mailbox-port.ts:85-95` (derivations), `provisioning.ts:239-256` (surfaced to display) | **[code]** |
| (e) | `/mailboxes/list` keyword exact-vs-fuzzy semantics is UNVERIFIABLE without a live POST — resolve with a throwaway mailbox at arming (gates (b)). | `docs/adversarial/inboxkit-adapters-2026-07-20.md:12,20` | **[founder-infra]** (arming-time verify) |

### D. Billing / checkout — promo code + live keys

| # | Gap | Evidence | Class |
|---|-----|----------|-------|
| D1 | The real Stripe Checkout session does **not** set `allow_promotion_codes`, so Mordy's 100%-off code cannot be entered. It's also subscription-mode with default payment-method collection, so a 100%-off code would still prompt for a card unless `payment_method_collection:"if_required"` is set. | `stripe-client.ts:50-63` (no promo/collection params) | **[code]** |
| D2 | Live Stripe keys unset → checkout runs the **simulated** path (no card, no codes, upgrades on a self-hit landing URL). Fine for test mode, but the BILLING-FIRST pilot (`ROADMAP.md:19`) requires live keys so real payment gates activation. | `billing.ts:24-38` (branches on `STRIPE_SECRET_KEY`), `billing.ts:78-119` (simulated complete), `env.ts:20-21` | **[founder-infra]** (Stripe KYC, `ACTIVATION.md:21`) |
| D3 | Checkout plan is the legacy `launch/growth/scale` enum; `launch` = flat $99 (5 mbx). The metered `$49 + $10/mbx` curve (SPEC §18) powers quote surfaces only, not checkout. Pilot uses `launch` + promo; the quantity migration is a later build (matches `ROADMAP.md:19`). | `intents.ts:64-66` (`CheckoutInput` enum), `pricing.ts:19-23` (`PLAN_QUOTAS`), `pricing.ts:26-52` (curve, quote-only) | **[code]** (later) |

### E. Screening / abuse — D4 OFAC is claimed-built but is not

| # | Gap | Evidence | Class |
|---|-----|----------|-------|
| E1 | `ACTIVATION.md:93` says the OFAC "screening hook is built; wire the data source" — but there is **no** OFAC/sanctions/denied-party screening code anywhere in `apps/platform/src`. `ROADMAP.md:68` correctly lists D4 OFAC screen as still-to-build. The only screening that exists is the brand-denylist + homoglyph BYO-abuse gate (routes to KYC, not sanctions), which runs at BYO intake, not at signup/activation. For self-serve real sending this is a genuine open gap. | grep: zero OFAC/sanction/watchlist hits in `apps/platform/src`; `byo-abuse-gate.ts:1-60` (brand/homoglyph only), `ROADMAP.md:68`, `ACTIVATION.md:93` | **[code]** |
| E2 | Signup captures `contactEmail` with no verification; it's rate-limited but not confirmed-ownership. Minor abuse surface for self-serve real sending (below OFAC in priority). | `signup.ts:38-59` | **[code]** (optional) |

### F. One-time founder infra (acceptable — NOT per-customer)

These are the arming steps the founder does ONCE. Listed so the build doesn't accidentally try to automate them.

- **Cloudflare Tunnel + `ENGINE_BASE_URL` (https) + `ENGINE_AUTH_SECRET`** on the droplet + Worker. Engine host is provisioned but unarmed (no tunnel, no Worker secrets). `ACTIVATION.md:26-69`, `ROADMAP.md:75`. The client rejects a plain `http://` URL as permanent, so the tunnel is mandatory (`ACTIVATION.md:56`).
- **InboxKit workspace config** (`apiKey` + `workspaceId`) injected to the Worker — session-local key must be re-pasted (`ROADMAP.md:23`, `inboxkit-client.ts:17-24`).
- **Stripe live KYC** + `STRIPE_WEBHOOK_SECRET` (`ACTIVATION.md:21,23`).
- **Registrant-of-record identity** for InboxKit domain registration — a real legal fact, deliberately never defaulted (`inboxkit-domain-port.ts:5-24`). Only needed if we register lookalikes for the tenant; Mordy rides his own bare domain, so this can wait.
- **Watchtower** (ops-alert + external prober) must be armed BEFORE real sending — the prerequisite ordering in `ACTIVATION.md:20`. Alert channel done; external prober still open (`ACTIVATION.md:89`).

---

## 2. PROPOSED DESIGN

### 2.1 Product-driven activation (replaces the manual allowlist)

Split the current two-flag gate into a clean **global-armed** check and a **per-tenant product** check, and delete `ENGINE_TENANTS`.

**Global "infra armed" gate (one-time founder, replaces `realAdaptersActivated`):** the platform can do real work when the infra is wired — derived, not a magic boolean:
- Engine wired: `ENGINE_BASE_URL` && `ENGINE_AUTH_SECRET` present (already computed, `tenant-do.ts:301-306`).
- Mailbox vendor wired: `inboxKitConfig` present (from new `INBOXKIT_API_KEY`/`INBOXKIT_WORKSPACE_ID` env).
- Domain registrar wired: a **separate** explicit flag (gate (a)) — absent for Mordy (he brings his own domain).

**Per-tenant product gate (automatic, replaces `ENGINE_TENANTS.has(tenantId)`):** a pure function of persisted state the customer's own payment drives —
```
activated(tenant) =
     plan is a paid tier (isPaidPlanTier)
  && billing_state === 'active'
  && NOT isLifecycleFrozen(status, billing_state)   // billing-state.ts:31-33
  && screening_status === 'clear'                    // §2.7
```
No operator ever touches an allowlist: paying flips `billing_state` to `active` (`billing.ts:98-99` / `196-205`), which flips activation on. Stopping payment (dunning → suspend, or dispute) trips `isLifecycleFrozen`, which flips activation off AND already halts every spend path (`billing-state.ts:25-33`). The existing freeze/abuse machine becomes the deactivation mechanism for free.

This narrows exactly as the allowlist did (a frozen/unpaid tenant can never reach a real port) with no new widening surface — the decision reads only server-authoritative columns, never client input.

### 2.2 Adapter-cache invalidation (fixes A3/A4)

Because activation is now a function of mutable billing state, the DO can no longer cache one bundle for its lifetime. Two options:
- **(Recommended) Don't cache the real/sandbox *decision*; cache the ports.** Keep the sandbox `EmailPort` instance cached (its in-memory queues must persist — `tenant-do.ts:280-283`), but re-evaluate `activated(tenant)` on each `buildAdapters()` and swap between the (stateless HTTP) `RealEmailPort` and the cached sandbox port accordingly. The real ports are stateless, so re-evaluation is cheap and correct.
- Simpler alternative: rebuild `this.adapters` on the billing-state write path (checkout complete, webhook apply, dunning suspend, dispute) — an explicit `invalidateAdapters()`. More surgical but must be called from every state-transition site (easy to miss one → the exact class the freeze-predicate centralization was created to avoid, `billing-state.ts:5-10`). Prefer re-evaluation.

### 2.3 Per-tenant mailbox-credential store + engine fetch path

**Recommendation: PUSH-to-droplet.** The Worker orchestrates provisioning and pushes the resulting credentials to the engine over the existing authed boundary; the engine persists them and resolves from a boot-map ∪ dynamic-store union.

Flow (managed shape):
1. `provisionMailboxesForDomain` calls `mailbox.provision()` (InboxKit buy) as today (`provisioning.ts:46`).
2. **New step:** fetch the mailbox's live send/receive credentials. For InboxKit-Google that is the gmail_api OAuth refresh token via the client-id-request flow (B5); for the IMAP leg, InboxKit's `GET /mailboxes/:id/credentials`. This runs **on the Worker**, which already holds `inboxKitConfig` — the InboxKit API key never leaves the control plane.
3. **New step:** push `{email → MailboxCredentials}` to a new authed engine endpoint `POST /v1/mailboxes` (bearer `ENGINE_AUTH_SECRET`, same trust boundary as `/v1/send`). The engine validates against `mailboxCredentialsSchema` (`config.ts:70-104`) and upserts into a durable store.
4. Engine `resolve()` reads boot-map ∪ dynamic-store. Teardown/release deletes the entry (mirror on `mailbox.release`, `provisioning`/`lifecycle`).

**Engine-side build:** extend `EngineStore` (already atomic JSON-file with a serialized write chain, `store.ts:40-124`) with a `mailboxes` credential map + `upsertMailbox`/`removeMailbox`/`getMailbox`; `EmailEngine.resolve` consults it (`engine.ts:207-211`); add the route (`router.ts`). Credentials at rest on the droplet disk — identical posture to today's `/root/mailboxes.json`.

**Worker-side build:** a new port method to carry credentials to the engine. Cleanest seam: add `getCredentials(email)` to `MailboxPort` (InboxKit `GET /mailboxes/:id/credentials` + the OAuth mint) and a `registerMailbox(email, creds)` on the engine client (`RealEmailPort`/`real/email-port.ts`), called from `provisionMailboxesForDomain`. `ProvisionedMailbox` (`vendor-ports.ts:45-48`) stays credential-free; credentials flow through the dedicated method so the port contract stays clean.

**Security rationale (why push, not pull):**
- **Blast-radius containment.** OAuth refresh tokens + IMAP passwords are the highest-value secrets in the system. Push keeps them concentrated on the **firewall-locked droplet behind the CF Tunnel** — exactly where they already live (`/root/mailboxes.json`). Pull would force the internet-facing Worker/DO to **persist plaintext refresh tokens** in the control plane and **serve them on an inbound endpoint** — one SSRF/auth bug on the public MCP/API surface then leaks every tenant's live sending credentials. The Worker already reaches the internet on the MCP/API; the droplet does not.
- **Trust direction preserved.** The Worker→engine direction is already authenticated (`ENGINE_AUTH_SECRET`, `router.ts:40,47`). Push adds one more authed write on that existing boundary. Pull would invert it — a new privileged engine→Worker inbound path on the public Worker that returns plaintext creds is a high-value target requiring its own mutual-auth story.
- **Vendor-key locality.** Push lets the InboxKit API key live only on the Worker (control plane). Pull-from-InboxKit-directly would spread the key to the droplet.

Trade-off accepted: the engine gains durable secret state (must survive restart) and a delete path for teardown. Both are small, and the alternative is strictly worse on secret exposure.

### 2.4 InboxKit arming gates as concrete build items

- **(a)** Add an explicit `INBOXKIT_DOMAIN_REGISTRAR` arming flag distinct from the mailbox `inboxKitConfig`; only wire `RealInboxKitDomainPort` when it's set (`factory.ts:142`). Fix the contradicting comment/README. Founder must reconcile `ACTIVATION.md:9` vs `:25`. **For Mordy this is inert** (he brings his own domain — no registration), so (a) is NOT on his critical path.
- **(b)** Assert `username@domain_name === requested email` before `/mailboxes/cancel` in `resolveMailboxUid` (`mailbox-port.ts:123-132`). Add a test that fails on the old code.
- **(c)** Persist a local provision record keyed on the deterministic `(domain, localPart)` idempotency key and check it before the InboxKit buy; replace the `/already exists/i` substring match with the vendor's structured error where possible (`mailbox-port.ts:47-70`). Bring to `withRequestIdempotency` standard.
- **(d)** Display-honesty: either fetch real placement via InboxKit's separate inbox-placement product, or label `reputationScore`/`placementRate` as derived/approximate at the display boundary (`provisioning.ts:239-256`) rather than presenting them as measured.
- **(e)** Arming-time: verify `/mailboxes/list` keyword semantics with a throwaway mailbox (validates (b)'s assertion is sufficient).

### 2.5 Checkout promotion codes

In `createStripeCheckoutSession` (`stripe-client.ts:50-63`):
- `body.set("allow_promotion_codes", "true")` — enables the code entry box.
- `body.set("payment_method_collection", "if_required")` — so a 100%-off code that zeroes the invoice completes with **no card**. Requires the founder's coupon to be duration-forever (or repeating covering the pilot term) so no future charge is implied. A 100%-off-once coupon would still collect a card for the renewal.
- Founder mints the coupon + a promotion code in Stripe (one-time, per `ROADMAP.md:19`).

The simulated path (`billing.ts:78-119`) needs no promo work — the pilot uses live keys, so simulated checkout is out of the pilot flow.

### 2.6 Deliverability guardrails that MUST stay automatic (already built — do not bypass)

Activation only decides real-vs-sandbox **ports**; every guardrail below runs per-tick / per-DO regardless and is inherited for free. The design must not add any activation branch that skips them:
- **Warmup ramp** — `warmupDailyCap` 5→15→25→35→40 over 28 days (`warmup.ts:15-21`), stamped on every provisioned mailbox (`provisioning.ts:67`).
- **Daily caps** — `mailboxes.daily_cap`, effective cap = `MIN(warmup cap, cap_override)` so a throttle survives the per-tick recompute (`schema.ts:118,127-131`).
- **Burn hard-pause** — thresholds `burnComplaintRate 0.5%` / `burnBounceRate 15%` domain-wide, plus per-mailbox hard/warn/throttle tiers; `deliv_status='paused'` is excluded from send scheduling; domain burn → `REPLACE_DOMAIN` (`deliverability.ts:57-62,178-229`, `schema.ts:124-138`).
- **Lifecycle freeze kill-switch** — `isLifecycleFrozen` (suspended/disputed/canceling/canceled) halts all spend; consulted by the tick and the deliverability sweep (`billing-state.ts:25-33`). This is what auto-deactivates a self-serve tenant who stops paying.
- **Plan quota / provisioning cap** — `assertWithinProvisioningCap` bounds mailbox/domain count per plan (launch = 5 mbx / 2 domains, `pricing.ts:20`, `quota.ts`), the de-facto recurring-spend ceiling. Note: SPEC §18 also names an explicit "owner spend ceiling" as an activation prerequisite; no separate absolute-$ ceiling exists beyond the quota cap — flag for the founder (see Q2).

### 2.7 Where D4 OFAC screening slots in

OFAC screening is **unbuilt** (E1), so it is a real prerequisite, not a wiring step. Slot it as a gate inside `activated(tenant)` (§2.1): a tenant's `screening_status` must be `clear` before the product gate returns true. Screen once at the first activation transition (checkout-complete), not per-send, storing the verdict on `tenant_profile`. A `review`/`kyc_required` verdict holds the tenant on sandbox and queues human review — reusing the existing KYC-escalation shape from the BYO abuse gate (`byo-abuse-gate.ts:19-24`, SPEC §20.3's "independent gates"). The data source (paid list vs the free OFAC SDN file) is the one wire-up step (`ACTIVATION.md:93`) once the hook exists.

---

## 3. ORDERED BUILD INCREMENTS

Smallest shippable units. **The long pole is I3 (managed-mailbox credential path incl. the programmatic OAuth mint)** — it's the only item that is both on the critical path AND carries live-vendor unknowns.

| # | Increment | Size | Parallel? | Notes |
|---|-----------|------|-----------|-------|
| **I1** | **Product-driven activation gate** — replace `ENGINE_TENANTS`/`realAdaptersActivated` with `activated(tenant)` (§2.1) + adapter-cache re-evaluation (§2.2). Global-armed derived from env; delete allowlist. | **M** | — (foundational; others build on it) | Pure factory + DO-cache change; fully testable with sandbox adapters (RED-prove a paid+active tenant now gets the real email port, a frozen one doesn't). No live vendor. |
| **I2** | **Checkout promo codes** — `allow_promotion_codes` + `payment_method_collection:"if_required"` (§2.5). | **S** | ‖ with I1, I4, I5 | Test-mode Stripe verifies the session shape. Founder mints the coupon. |
| **I3** | **Managed-mailbox credential path** — engine `POST /v1/mailboxes` + durable cred store + resolve-union + delete (§2.3 engine side); Worker `getCredentials`/`registerMailbox` + provisioning push (§2.3 Worker side); **programmatic gmail_api OAuth mint** via InboxKit client-id-request, with manual-mint fallback (B5). | **L** | engine store ‖ Worker port; OAuth mint is the serial tail | **LONG POLE.** OAuth-fleet mint is unverified against InboxKit (`ROADMAP.md:28`) — verify empirically at first mailbox; manual-mint fallback keeps Mordy unblocked but is a per-customer step until the programmatic path is proven, so it doesn't fully satisfy "zero operator per customer" until then. |
| **I4** | **InboxKit arming gates (b)+(c)+(d)** — exact-email assert before cancel; local provision-idempotency record; display-honesty on fabricated health fields. | **M** | ‖ with I1/I2/I5 | Gate (a) domain-registrar flag is a **separate S item, deferrable** — inert for Mordy. Gate (e) is arming-time verification, not code. |
| **I5** | **D4 OFAC screening hook** — build the screening function + `screening_status` column + wire into `activated()` (§2.7). | **M** | ‖ with I1 (I1 references the column; land the column first or stub `clear`) | `ACTIVATION.md:93`'s "hook is built" is false — this is net-new. Data-source wire-up is the only founder-infra part. |
| **I6** | **Metered `$49+$10/mbx` checkout migration** (SPEC §18) — quantity-based line item + quote-before-provision. | **L** | after I2 | **Explicitly deferred** — pilot ships on flat `launch`/$99 + promo (`ROADMAP.md:19`). Not in the self-serve critical path. |

**Founder-infra arming (one-time, parallel to all builds):** Cloudflare Tunnel + Worker secrets (§1.F), Stripe live KYC, InboxKit key paste, watchtower external prober. These gate go-live, not the build.

**Critical path to Mordy self-serve real send:** I1 → I3 (with manual-mint fallback acceptable for the single pilot) + I2 + founder arming. I4/I5 are required for a *clean* self-serve GA but I5 (OFAC) can ship as `clear`-stub for the single trusted pilot if the founder accepts the risk for one known customer.

---

## 4. FOUNDER QUESTIONS

1. **Registrar reconciliation (gate (a)).** `ACTIVATION.md:9` ("go inboxkit") reads mailbox-scoped; `ACTIVATION.md:25` still names Namecheap/Porkbun as the registrar. For customers who need a *provisioned* domain (not Mordy — he brings his own), should InboxKit also be the registrar (one vendor, wallet-funded), or stay Porkbun? This only blocks the provisioned-domain path, not the pilot. Recommendation: InboxKit as registrar too (single vendor, already wired), behind its own arming flag.

2. **OFAC + owner-spend-ceiling for the pilot.** OFAC screening (E1) and an explicit owner spend-ceiling (SPEC §18) are both prerequisites the code doesn't yet satisfy. For the single trusted pilot (Mordy, comped), do you accept shipping with OFAC stubbed `clear` and the plan quota (5-mbx cap) as the de-facto spend ceiling, deferring the real OFAC hook + absolute-$ ceiling to before *public* self-serve GA? Recommendation: yes for the pilot, build both before opening signup to strangers.
