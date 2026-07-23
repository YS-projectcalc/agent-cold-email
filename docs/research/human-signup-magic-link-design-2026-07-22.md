# Human signup + magic-link login — design (2026-07-22)

Design lane for the founder ORDER (`ROADMAP.md:19`, verbatim): *"do magic link with email"*, *"why not allow human signup also"*, *"even for an agent, flow can be just 'free sign up' and standard is sandbox till upgraded"*. This is item (3) of the autonomous go-live program (`ROADMAP.md:18`). **Design only — no source edits. All cites verified against source this session (live shared worktree).**

---

## 0. TL;DR — most of this is already built; the real work is magic-link login

Two facts reframe the whole task:

1. **The unified "free sign up" funnel and the human web form already exist and already land a sandbox tenant.** `POST /signup` mints a `demo`-plan tenant + bearer token (`apps/platform/src/routes/signup.ts:24-55`); the human web form (`apps/dashboard/src/auth/SignupPage.tsx`) already collects brand+email, calls that same path, shows the token once, then **auto-mints a dashboard session** via `login(token)` and routes to the onboarding checklist. The "connect your agent" onboarding panel with copy-paste per-client MCP snippets already exists (`apps/dashboard/src/pages/SetupPage.tsx:8-33`, Codex/Claude Code/Cursor/Cline). So deliverable (2) is ~80% shipped — it needs a copy/claim reframe and a magic-link recovery entry, **not** a rebuild.

2. **The one genuinely-missing capability is a persistent way back in.** Today, a human who loses their token hits a dead end: `apps/dashboard/src/auth/RecoveryPage.tsx` literally says *"Tokens cannot be emailed back"* and offers only "make a new sandbox" or "email support." Magic-link login is exactly the fix the founder ordered. This is the bulk of the build.

The activation gate is untouched by all of this: every signup — human or agent — lands a `demo`/sandbox tenant (`signup.ts:44-52`), and sandbox→paid activation is product-driven and already live in prod (`ROADMAP.md:30`, deployed `8a30ec0`). Magic-link login mints the **same** dashboard session a pasted token mints; it grants no new capability, it only restores access. Sandbox signups incur zero spend, so the GA gates (OFAC, spend ceiling) are unaffected.

---

## 1. Magic-link authentication design

### 1.1 Where it plugs into the existing session system (do not invent a second one)

The dashboard session mechanism to terminate in (SPEC §19.1):

- `POST /dashboard/session` is **unauthenticated**; it takes a pasted bearer token in the JSON body, resolves it via the normal hash resolver `resolveTenantFromToken` (`apps/platform/src/routes/dashboard-session.ts:23-24` → `require-auth.ts:63-73`), then mints a server-side session: random 256-bit opaque id (`auth.ts:63-66` `generateDashboardSessionId`), stores only `SHA-256(pepper:id)` in D1 `dashboard_sessions` (`db.ts:58`, migration `0006_dashboard_sessions.sql`), and sets a `HttpOnly; Secure; SameSite=Strict; Path=/` cookie carrying the opaque id (`dashboard-session.ts:37-43`). TTL 30d (`dashboard-session.ts:14`).
- The cookie is never the credential; the raw id lives only in the cookie, its hash only in D1 (mirrors how the bearer token is never stored plaintext).
- `requireAuth` reads the cookie as a fallback only when no `Authorization`/`X-API-Key` header is present (`require-auth.ts:110-125`), and stamps `authVia: 'cookie'`.
- The **global CSRF guard** (`csrf-guard.ts:24-29`) requires header `X-Coldstart-Client: dashboard` on any cookie-authed non-GET mutation; bearer callers are exempt (`csrf-guard.ts` docstring). The SPA attaches this header on every mutation (`apps/dashboard/src/api/client.ts` `MUTATING_HEADER`, `credentials: "include"`).

**Design rule:** magic-link verification MUST end in this exact mint. Extract the mint body of `dashboard-session.ts:27-43` into a shared helper `mintDashboardSession(c, env, tenantId)` and call it from **both** `POST /dashboard/session` (after bearer resolution) and the new `POST /login/consume` (after magic-link resolution). One session table, one cookie, one CSRF posture — no second session system. This is a pure refactor of existing code; the cookie/CSRF/`authVia` semantics are preserved because the *same* helper runs.

### 1.2 Token design (mirror the existing hashing pattern)

New table (migration `0009_login_links.sql`), modeled exactly on `0006_dashboard_sessions.sql`:

```sql
CREATE TABLE IF NOT EXISTS login_links (
  token_hash    TEXT PRIMARY KEY,   -- SHA-256(pepper:id); raw id only ever lives in the emailed URL
  contact_email TEXT NOT NULL,      -- the verified email this link proves control of (NOT a single tenant)
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,   -- created_at + 15min
  consumed_at   INTEGER             -- NULL until single-use consumption; set atomically on mint
);
CREATE INDEX IF NOT EXISTS idx_login_links_expires ON login_links(expires_at);  -- cheap sweep of expired rows
-- Also needed (magic-link lookup is by email, which today has no index):
CREATE INDEX IF NOT EXISTS idx_tenants_contact_email ON tenants_index(contact_email);
```

- **Id generation:** reuse the `generateDashboardSessionId()` shape (256-bit, hex, deliberately NOT `cs_test_`/`cs_live_`-prefixed so it's never mistaken for a bearer token if it leaks into a log — `auth.ts:59-66`). Hash at rest with `hashApiToken(id, env.TOKEN_HASH_PEPPER)` (`auth.ts:19-22`) — the identical pepper+SHA-256 path the bearer token and session id already use. **No new secret/env binding needed.**
- **Single-use:** consumption is an atomic conditional update — `UPDATE login_links SET consumed_at=? WHERE token_hash=? AND consumed_at IS NULL` and check `changes()===1`. This closes the double-submit / replay window at the DB layer, not in app logic.
- **Short expiry:** 15 min, wall-clock (`expires_at`), re-checked on consume exactly as sessions re-check their TTL (`require-auth.ts:96-98`).
- **Bound to email, not tenant** — see multi-tenant handling (§1.5).

### 1.3 Request flow — `POST /login` (enumeration-safe)

Unauthenticated public route (mounted alongside `POST /dashboard/session` in the unauthenticated block, `index.ts:41-52`). Body: `{ email, turnstileToken? }` (new `LoginRequestInput` zod schema in `packages/shared`, validated at the boundary per CLAUDE.md rule h).

1. Rate-limit BEFORE any lookup (§1.6).
2. Verify Turnstile if enabled (§2.3) — human-only endpoint, safe to gate.
3. `lookupActiveTenantsByContactEmail(env, email)` — new `db.ts` fn: `SELECT id, brand FROM tenants_index WHERE contact_email = ? AND status = 'active'` (uses the new index). Case-fold the email for the lookup (store-time email is unnormalized; compare `LOWER()` both sides or normalize on write — flag as a small correctness detail for the builder).
4. **If ≥1 tenant:** insert one `login_links` row bound to the email, build the URL `${PUBLIC_BASE_URL}/app/login?token=<id>` (`PUBLIC_BASE_URL` already exists, `env.ts:76` — the Worker's own public origin, so the link is correct regardless of whether `/app` is served from `workers.dev` today or `coldrig.dev` post-activation), and send the email (§1.7).
5. **If 0 tenants:** do nothing (no email — see abuse §1.8). No courtesy "you don't have an account" mail (that's a bomb amplifier).
6. **Always** return the identical `200 { ok: true }` with copy *"If an account exists for that email, we've sent a sign-in link."* — no timing/branch/status difference between exists and not-exists. This is the enumeration guarantee the founder's ruling implies ("magic link with email" must not become an account-oracle).

### 1.4 Verification flow — `GET /app/login?token=` → `POST /login/consume` → session

The emailed link points at the SPA (`/app/*` is served by Cloudflare's asset layer with SPA fallback, `wrangler.toml:63-67`), so **no new Worker HTML route is needed** for the landing:

1. Email client GET-loads `/app/login?token=<id>` → SPA renders a new `LoginVerifyPage`. **A GET never consumes the token** (critical: Outlook SafeLinks / Gmail / corporate scanners prefetch links with a GET and would otherwise burn a single-use link before the human clicks). Consumption happens only via a JS `fetch` POST, which link-prefetchers do not execute.
2. `LoginVerifyPage` POSTs `{ token }` to `POST /login/consume` (unauthenticated, in the same block as `/dashboard/session`).
3. `/login/consume` validates the token (hash lookup, not expired, not consumed), resolves the email's active tenants:
   - **Exactly one tenant:** atomically consume, then `mintDashboardSession(c, env, tenantId)` (§1.1) → `Set-Cookie` → return `{ tenantId }`. SPA redirects to `/app/dashboard`.
   - **Multiple tenants (§1.5):** return `{ tenants: [{tenantId, brand}] }` **without consuming**; SPA shows a picker; the pick re-POSTs `{ token, tenantId }`, which asserts `tenantId ∈ email's active tenants`, then consumes + mints.
4. SPA strips `?token` from the URL (`history.replaceState`) immediately on load so it never lands in browser history / back-button re-navigation.

This reuses the exact cookie mint; the consume route is unauthenticated (no cookie yet), so the CSRF guard does not apply to it — same reasoning `POST /dashboard/session` is already CSRF-exempt (`index.ts:41-52`). The token in the URL *is* the credential for this single step, exactly the pattern `GET /checkout/simulate` already uses (`checkout.ts:37-46`, "the session id is itself the unguessable single-use credential").

### 1.5 Multi-tenant-per-email — picker, not most-recent

One email can own several tenants (nothing enforces one-tenant-per-email at signup — `signup.ts` never checks the address). **Recommendation: email-bound token + picker** (designed into §1.4 above). Rationale: "most-recent only" silently hides a customer's other tenants — a confident-wrong UX where a human who wants their older rig simply can't reach it via the link. The picker is a few extra lines (the token is already email-bound; the second POST just carries `tenantId`) and it's honest. Consumption still happens exactly once (on the final pick), preserving single-use. Most humans own exactly one tenant, so the picker is invisible for the common case (single-tenant auto-submits step 2).

### 1.6 Rate limits — reuse the existing atomic limiter, no new binding

Reuse the `SIGNUP_LIMITER` `RateLimiterDO` (`rate-limiter-do.ts`, `.hit(perMinute, perDay)` → `{allowed}`) with distinct key namespaces so limits don't cross-contaminate signup:

- **Per-email:** DO name `login:email:<sha256(email)>` (hash the email so PII never lands in a DO id). Suggest 3/15-min-equivalent + 10/day. (The limiter is minute+day; treat "3/min" as the burst cap.) This is *the* primary email-bomb defense.
- **Per-IP:** DO name `login:ip:<ip>` (`CF-Connecting-IP`, as `signup.ts:25`). Suggest 5/min + 30/day.
- **Global ceiling:** DO name `login:__global__`, mirroring `signup.ts:34-38` — caps total blast radius of a distributed bomb.

Reusing `SIGNUP_LIMITER` avoids a new `wrangler.toml`/`env.ts` binding (which matters for collision avoidance — §4).

### 1.7 The email channel — reuse the `OPS_EMAIL` binding; it is suitable for customer-facing auth mail

Verified answer to the brief's question: **yes, the same binding can send the magic-link mail.**

- `OPS_EMAIL` is a Cloudflare Email Sending `send_email` binding — the binding *is* the credential, no API key (`env.ts:52-60`, `real-ops-mailer.ts:1-12`). It is declared **unrestricted** on purpose (no `destination_address` in `wrangler.toml:48-52`): the comment states this is precisely so the dunning path can email *arbitrary tenant contact addresses*. So it is already sanctioned to send to arbitrary customer inboxes — a magic link to a customer's own contact email is squarely within that.
- ~~It is **live** … end-to-end-verified 2026-07-20~~ **CORRECTED (adversary r1 B1, 2026-07-23): the channel is ARMED but outbound delivery is UNPROVEN.** The 07-20 Gate-4 verification proved the INBOUND path (support@ → Worker → forward) and that the cron fires — it never proved a successful outbound `send_email` delivery to any external inbox, from ANY from-address. DKIM signing config is Cloudflare-managed for the domain, but whether CF actually signs a given from-address with `d=coldrig.dev` alignment is empirically unverified (and load-bearing — see the DMARC bullet).
- **From-address:** the real mailer currently pins `from: ops@coldrig.dev` (`ops-mailer.ts:23` `OPS_FROM_EMAIL`, applied in `real-ops-mailer.ts:29-35`). Because CF Email Sending is **domain**-onboarded (not address-onboarded), `login@coldrig.dev` sends fine with no new binding — only a different `from` in the send call. **Recommendation:** send auth mail from `login@coldrig.dev` (a stable, recognizable transactional sender, separable from ops alerts for deliverability reputation), via a small generalization: either parameterize the fixed-from in the mailer or add a thin `AuthMailer` that shares the same `OPS_EMAIL` binding. Both html+text bodies are mandatory (`ops-mailer.ts:26-30`) — supply both.
- **Dark-safe degrade:** if the binding were ever unbound, `RealOpsMailer.send` throws `OpsMailNotConfiguredError` (`ops-mailer.ts`, `real-ops-mailer.ts:26`). Watchtower catches-and-logs (`watchtower.ts:248-258`). For magic-link the flow must **fail closed without leaking**: return the same generic `200` copy to the requester (never reveal the send failed for a real vs unknown email), and log/alert the misconfig. In practice the channel is live, so this is a defense-in-depth path, not the happy path.
- **DMARC / Reply-To considerations:** (a) ~~confirm a DMARC record exists … add `p=none` if absent~~ **CORRECTED (adversary r1 B1): DMARC is LIVE and `p=reject`** — the strictest policy, dig-verified 2026-07-20 (`ACTIVATION.md` Gate 4: `_dmarc` TXT `v=DMARC1; p=reject;`). Under `p=reject` a from-address that fails DKIM alignment is HARD-REJECTED by Gmail/Outlook — combined with the identical-200 enumeration posture and the dark-safe degrade, a misaligned sender means **silent-total failure**: no link arrives, no bounce the user sees, no signal to us. This is why the empirical gate below is a BLOCKING build gate. (b) `login@coldrig.dev` should not imply a monitored mailbox — either omit `Reply-To`, or set `Reply-To: support@coldrig.dev` **only once** support inbound is armed (`ACTIVATION.md` Gate 4; support routing is currently disarmed, `ROADMAP.md:99c`). (c) include the requesting IP/UA and a "if this wasn't you, ignore this" line in the body (forwarded-link hygiene, §1.8).

### 1.7b EMPIRICAL OUTBOUND GATE — BLOCKING build gate (adversary r1 B1, 2026-07-23)

No magic-link announcement ships until a real outbound send is **proven delivered and aligned**, fully autonomously:

1. Deploy increment A with the send path live (endpoint may go live dark — the identical-200 posture means an unannounced endpoint harms no one) from the preferred sender `login@coldrig.dev`.
2. Trigger a real magic-link request for a tenant whose contact email is `yaakovscher@gmail.com` (founder-owned test tenant).
3. Verify receipt WITHOUT founder hands via the engine droplet's IMAP access to that inbox (`/root/mailboxes.json` app password; same gm-raw IMAP technique as the 07-19 engine smoke): the mail must be PRESENT (not spam-folder), and its `Authentication-Results` header must show `dkim=pass` with `d=coldrig.dev`, `dmarc=pass`.
4. On failure: flip the sender to `ops@coldrig.dev` (config const, no code change) and re-run the gate. If both fail, the channel itself is misconfigured — STOP the lane, fix CF Email Sending, re-gate.
5. Only after PASS may increment D flip the site funnel/CTA to advertise login.

### 1.8 Abuse surface

- **Email bombing** (attacker POSTs a victim's email repeatedly): defended by per-email rate limit (§1.6, the key control) + global ceiling + Turnstile on the request form (§2.3). Only *real* customers can be mailed at all, and only up to the per-email cap.
- **Link forwarding / interception:** short expiry (15 min) + single-use bound the damage; accept the residual (do NOT bind to IP/device — that breaks the read-on-phone-click-on-desktop path). Include requesting IP/UA in the email so the owner notices an unexpected link. This is the industry-standard magic-link posture.
- **Token-in-URL leakage via Referer:** the `/app/login` landing must load no third-party assets and send `Referrer-Policy: no-referrer`; strip `?token` from the URL on load (§1.4).
- **Unknown emails:** silent no-op + identical response (§1.3). No enumeration oracle, no amplifier email.
- **Prefetch consumption:** solved structurally — GET never consumes; only the JS POST does (§1.4).

---

## 2. Human web signup

### 2.1 What already exists (do not rebuild)

- Form: `SignupPage.tsx` — brand + work email, posts to `useSignup()` → `POST /signup` (`queries.ts:43-52`), same path agents use. Sandbox-only warning banner already present.
- Token-shown-once: full token displayed with a copy button + a "I saved it" checkbox gating the next step (SignupPage, post-success branch). This is the correct once-only pattern (the token is never recoverable — `auth.ts` stores only the hash).
- Auto session mint: on "Open setup checklist," it calls `login(token)` (→ `POST /dashboard/session`, `AuthProvider.tsx` → `queries.ts:32-42`) and routes to `/setup`.
- Onboarding "connect your agent" panel: `SetupPage.tsx:8-33` — per-client copy-paste MCP config for Codex, Claude Code, Cursor, Cline, plus the safety-boundary checklist. (Note: those snippets say "17 tools"/"all 17 tools" — **stale, now 24**; that's a claim-surface fix owned by the brand-sweep lane, flagged here so it isn't missed.)
- Marketing entry: `site/signup.html` CTA already points at `/app/signup`.

### 2.2 What this order adds to signup

1. **Magic-link recovery entry** (the substantive change): rewrite `RecoveryPage.tsx` from the "tokens cannot be emailed back" dead-end into the magic-link request form ("Enter your email — we'll send a sign-in link"). Keep the honest note that the *token itself* is never emailed (only a session link).
2. **A login on-ramp for humans without their token:** add "Email me a sign-in link instead" on `TokenGate.tsx` (currently paste-token-only, with a "Lost your token?" link to `/app/recover`).
3. **Copy reframe** so the human path reads as a first-class "Free sign up," not an agent afterthought (§3).

### 2.3 Bot protection — Turnstile on `/login` only, never on `/signup`

Hard constraint: `POST /signup` is **deliberately un-CAPTCHA'd** — *"No Turnstile/CAPTCHA on purpose: this signup must stay agent-drivable"* (`signup.ts:15-16`). The founder's one-funnel ruling keeps `/signup` shared by humans and agents, so we cannot gate it with an interactive challenge without breaking the agent path.

**Recommendation:** rely on the existing signup rate limits (per-IP 5/min + global ceiling, `signup.ts:18-38`) as the bot defense for `/signup`; add **Turnstile to the `/login` request form only** (`POST /login`) — that endpoint is human-only (agents authenticate with bearer tokens and never request magic links), so a challenge there breaks nothing and directly blunts email-bombing. Cloudflare Turnstile is the native fit (all-Cloudflare stack); the `turnstile-spin` skill provisions the widget via the CF API + a siteverify check. This is the only place a new secret/env binding is required (§4 flags the collision).

---

## 3. One-funnel site IA

Current IA (verified): nav CTA "Create sandbox → `/signup`" (`index.html:77`); hero CTAs "Connect your agent → `/connect`" + "Try the safe sandbox → `/signup`" (`index.html:87-89`); nav "Sign in → /app" (the token-gate). The agent funnel is the guides + `for-agents.html`; the human funnel is `signup.html` → `/app/signup`.

**The shift is additive, not a retraction** — agent-first positioning stays; a human on-ramp is raised to equal prominence:

- **"Free sign up" CTA** becomes the single primary conversion action, replacing "Create sandbox"/"Create free sandbox"/"Try the safe sandbox" wording, pointing at the same `/signup` → `/app/signup` form. One funnel, two front doors: a human clicks "Free sign up" and gets the web form; an agent reads the guide and hits `POST /signup` directly — **identical sandbox-tenant outcome**.
- **"Connect your agent"** stays as the agent-first secondary path (guides), so the agent narrative is preserved.
- **`/login`** — a real sign-in destination. Point nav "Sign in" at the magic-link/token screen (`/app/login` or a thin `site/login.html` that links into it). Add `/login` to `sitemap.xml`.
- **Honest copy:** *"Free sign up — every account starts as a sandbox; upgrade to go live."* This matches the founder's exact framing ("standard is sandbox till upgraded") and the live product truth (`signup.html` already says "no hidden free-trial clock," "sandbox is an evaluation environment"). No claim that humans can send real mail today — the concierge/arming caveat stays until arming completes (`ROADMAP.md:18` honest boundary).

**Claim-surface files touched:** `site/index.html` (nav CTA + hero + final-CTA + honesty note), `site/signup.html`, `site/connect.html`, `site/faq.html`, `site/sitemap.xml`, and the SPA `RecoveryPage.tsx`/`TokenGate.tsx` copy. **Every one of these is in the brand-sweep lane's blast radius — see §4.**

---

## 4. Build increments (sizes, parallelism, collisions)

| # | Increment | Size | Parallel? | Key files |
|---|-----------|------|-----------|-----------|
| **A** | **Magic-link backend.** Migration `0009_login_links.sql` (table + `idx_tenants_contact_email`); `db.ts` `insertLoginLink`/`lookupLoginLinkByHash`/`consumeLoginLink` (atomic single-use)/`lookupActiveTenantsByContactEmail`; `auth.ts` login-id gen (reuse session-id shape); shared `LoginRequestInput`/`LoginConsumeInput`; `routes/login.ts` (`POST /login` + `POST /login/consume`); **refactor** `dashboard-session.ts` mint into shared `mintDashboardSession()` reused by both routes; auth-mail send via `OPS_EMAIL` (from `login@coldrig.dev`, dark-safe degrade); rate limits reuse `SIGNUP_LIMITER`; mount in `index.ts`. Tests: enumeration-identical response, single-use replay fails, expiry, prefetch-safe GET, rate-limit trip, multi-tenant picker, mint reuses cookie+CSRF path. | **M** | Backbone; B builds against its contract | `apps/platform/src/{routes/login.ts,routes/dashboard-session.ts,db.ts,auth.ts,index.ts}`, `apps/platform/migrations/0009_*`, `packages/shared/src/*` |
| **B** | **Magic-link SPA + verify.** `RecoveryPage.tsx` → email-link request form; `TokenGate.tsx` "email me a link"; new `auth/LoginVerifyPage.tsx` (reads `?token`, strips it, POSTs consume, single-auto/multi-picker, redirect); `App.tsx` route `/login`; `queries.ts` `useRequestLoginLink`/`useConsumeLoginLink`. | **S–M** | ‖ with A once the request/consume contract is fixed | `apps/dashboard/src/auth/*`, `apps/dashboard/src/App.tsx`, `apps/dashboard/src/api/queries.ts` |
| **C** | **Turnstile on `/login`.** `turnstile-spin` skill: widget via CF API; `TURNSTILE_SECRET` wrangler secret + `env.ts` field; siteverify in `POST /login`; client widget on the request form. | **S** | ‖ but **env.ts-gated** (see collisions) | `apps/platform/src/{env.ts,routes/login.ts}`, `apps/platform/wrangler.toml`, request-form component |
| **D** | **One-funnel site IA + copy.** "Free sign up" CTA across `site/*.html`; `/login` entry + `sitemap.xml`; additive humans+agents / "sandbox till upgrade" copy; fix the stale "17 tools" onboarding strings. | **M** | **Serialized after brand-sweep** (see collisions) | `site/index.html`, `site/signup.html`, `site/connect.html`, `site/faq.html`, `site/sitemap.xml`, `apps/dashboard/src/auth/{RecoveryPage,TokenGate}.tsx` |

Auth-mail from-identity + DMARC/Reply-To verification (§1.7) folds into **A** (it's a few lines in the mailer + one DNS check), not a separate increment.

### Parallelization & long pole

- **A ∥ B** once the API contract is frozen (freeze it first — the two shapes in §1.3/§1.4). A is the **technical long pole**: the correctness-critical, adversary-gated piece (enumeration-safety, atomic single-use, prefetch-safety, rate limits, session-mint reuse).
- **D is the calendar long pole**: it cannot start until brand-sweep merges, then needs a re-pass over whatever brand-sweep changed. It gates the coordinated deploy, not the code.
- **C** is small and independent but touches `env.ts`/`wrangler.toml` — sequence its env change after the I3+I4 lane's env change (below).

### Collision flags (against the two in-flight lanes)

**vs. I3+I4 lane** (`ROADMAP.md:24` — isolated worktree: `apps/engine/*`, `apps/platform/src/vendors/*`, `engine/billing.ts`, and `env.ts`/`wrangler.toml` for `INBOXKIT_API_KEY`/`INBOXKIT_WORKSPACE_ID` bindings + the R3-1 failing-by-construction test):

- **`env.ts` + `wrangler.toml` — the one real collision.** This design **deliberately adds nothing to `env.ts`** for increments A/B: it reuses `OPS_EMAIL`, `SIGNUP_LIMITER`, `TOKEN_HASH_PEPPER`, and `PUBLIC_BASE_URL` (all already declared). **Only increment C (Turnstile) touches `env.ts`/`wrangler.toml`** (`TURNSTILE_SECRET`). Sequence C's env change **after** I3+I4 merges to avoid a three-way env.ts conflict.
- **R3-1 test caution.** I3+I4 must add a test asserting *every vendor-arming env field is referenced by `isRealSpendArmed`* (`ROADMAP.md:24,30`). `TURNSTILE_SECRET` is **auth infrastructure, not vendor spend** — it must NOT be added to `isRealSpendArmed`. If that R3-1 test is written to assert "every env field" rather than "every *vendor-arming* field," `TURNSTILE_SECRET` would trip it. **Coordinate: keep the R3-1 assertion scoped to vendor-spend fields.** (Magic-link adds no spend surface at all.)
- `db.ts`, `index.ts`, `routes/*`, `apps/dashboard/*` — mine; I3+I4 is engine/vendors/tenant-do. No overlap.
- `packages/shared` — I3+I4 and the warm-lead lane both touch `schema.ts` (additive-merge hazard already flagged, `ROADMAP.md:30`). My new input schemas are additive in `intents.ts`/`dashboard.ts` (or a new `auth.ts` shared module). Low risk; coordinate the additive merge at integration.

**vs. brand-sweep lane** (`ROADMAP.md:18` item 1 — customer-visible copy strings incl. `site/`):

- **Increment D collides directly and entirely** with brand-sweep on `site/*.html`. Per `ROADMAP.md:19` the build is already sequenced "QUEUED BEHIND … brand-sweep (site/ + copy collision avoidance)." **D must land after brand-sweep merges**, then re-pass. The specific overlapping files: `site/index.html`, `site/signup.html`, `site/connect.html`, `site/faq.html`, `site/sitemap.xml`. The stale "17 tools" strings in `SetupPage.tsx` are a brand-sweep-class fix — decide which lane owns it, don't fix it twice.

Increments **A, B, C carry no `site/` copy** and so do not collide with brand-sweep. A and B (the actual magic-link engine) can proceed immediately in the queued build; only D waits on brand-sweep.

---

## 5. Founder questions (2)

1. **Magic-link = email-possession as an account-access factor for ALL tenants, including paid/activated ones?** Whoever controls a tenant's contact-email inbox can mint a dashboard session for it. For sandbox tenants this is harmless (no spend). For a paid/activated tenant, email takeover = access to a live-sending, billed account. Recommendation: **allow it for all tenants** — email-based recovery is the industry-standard login/recovery factor, and it *is* the "way back in" the founder asked for; the bearer token stays the machine credential, magic-link is the human recovery path. Flagging only because it defines the de-facto account-recovery security posture. (If "no," we'd gate paid tenants to token-only + support-verified recovery — more friction, contradicts the one-funnel intent.)
2. **Multi-tenant-per-email: picker (recommended) confirmed?** One email can own several tenants. I've designed a picker (honest — never hides a customer's other rigs) over "most-recent-only" (simpler but silently drops tenants). It's a small delta. Confirming this is the intended behavior, not a "most-recent, ship it" call.

Neither blocks the build: proceeding on the recommended answers (yes / picker) is safe and reversible.

---

## 6. Adversary round 1 — 2026-07-23 (verdict: SHIP-AFTER-FIXES, applied same day)

Frozen verdict: `docs/adversarial/signup-auth-design-review-2026-07-23.md` (reviewed at 62e3fc6). BLOCKING B1 fixed in place: §1.7 claims corrected (channel armed but outbound UNPROVEN; DMARC live `p=reject`, not absent) + new **§1.7b empirical outbound gate** (BLOCKING build gate, droplet-IMAP DKIM/DMARC verification, autonomous). The adversary's UNVERIFIABLE items (does CF DKIM-sign `login@` with `d=coldrig.dev`; cold-inbox placement) are exactly what §1.7b resolves empirically.

Non-blocking dispositions (build lane MUST carry):
1. **Timing channel on `POST /login` (NB2):** the exists-branch awaits the send → measurably slower. Fire the send via `ctx.waitUntil()` so both branches return on the same path. (Already blunted by the 10/day per-email cap; close it anyway.)
2. **Login-CSRF on `/login/consume` (NB3):** `c.req.json()` ignores Content-Type, so a cross-site simple POST could log a victim into the attacker's tenant. Require the existing same-origin header (`X-Coldstart-Client`) on `/login/consume` exactly as the global cookie-mutation guard does — do not dismiss by analogy to `/dashboard/session`.
3. **Email case-normalization (NB4):** mixed-case contact emails silently never match → silent login failure. Normalize-on-write (lowercase) at BOTH the signup write and the login lookup + one-time backfill migration for existing `tenants.contact_email` rows + index on the normalized column (a plain index does not serve `LOWER()` queries — normalize the data, not the query).

Design attacks that HELD (re-derived against source by the adversary): atomic single-use consume (`changes()===1`), reuse of the exact existing `mintDashboardSession` (cookie/CSRF/authVia preserved), GET-never-consumes prefetch safety, enumeration response-shape/status/rate-limit symmetry, suspended-tenant exclusion, TURNSTILE_SECRET kept out of `isRealSpendArmed`.
