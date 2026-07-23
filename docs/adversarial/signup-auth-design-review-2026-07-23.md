# Adversarial design review — human-signup + magic-link + one-funnel

- **Design under review:** `docs/research/human-signup-magic-link-design-2026-07-22.md`
- **Repo snapshot:** `git rev-parse HEAD` = `62e3fc6fd7232b2ea203efbe7b6ad692639640b5` (main; design committed at this SHA)
- **Reviewer:** adversary (fresh context), read-only git, no deploys, no secrets
- **Scope:** attack the DESIGN before build. Verdict gates the build lane.

## VERDICT: SHIP-AFTER-FIXES (1 BLOCKING)

The design is well-grounded — I re-derived its claims about the existing session
mint (`dashboard-session.ts:27-45`), the cookie/CSRF posture (`require-auth.ts`,
`csrf-guard.ts`), the unauthenticated mount block (`index.ts:41-56`), the atomic
rate limiter (`rate-limiter-do.ts`), the SPA base/routing (`vite.config.ts` base
`/app/` + `main.tsx` `basename="/app"`), and the token-in-URL precedent
(`checkout.ts:43-46`) — and every one holds. The single-use atomic-UPDATE
pattern, prefetch-safe GET-never-consumes split, and enumeration response-shape
identity are all sound. The one thing the brief specifically told me not to take
on faith — the OPS_EMAIL channel's customer-facing suitability — is the one thing
the design did NOT actually verify, and it erred on a live fact (DMARC policy).
That is the blocking item. Everything else is non-blocking refinement.

---

## Findings

### 1 · BLOCKING · OPS_EMAIL customer-facing suitability is asserted-verified but not established; the design missed the LIVE `p=reject` DMARC policy and recommends an unproven from-address whose failure mode under `p=reject` is silent-total

**Lens:** 4 (arm-time plumbing) + 2 (would it actually run) + the brief's explicit "check it actually did, don't take its word."

**What the design claims (§1.7):**
- "DKIM/SPF alignment for `@coldrig.dev` mail is in place… It is **live**: … end-to-end-verified 2026-07-20."
- Recommends sending auth mail from **`login@coldrig.dev`** (a different local-part than the code-pinned `ops@coldrig.dev`, `ops-mailer.ts:19`), asserting "only a different `from` in the send call."
- On DMARC: "confirm a DMARC record exists for `coldrig.dev`… **verify at build, add `p=none`→`quarantine` if absent**."

**Ground truth (`ACTIVATION.md:82`, the cited Gate-4 record):**
- DMARC is **not absent** — it is live and **`v=DMARC1; p=reject;`** (the strictest policy). The design's "add `p=none` if absent" remedy is premised on a false state; a builder who followed it literally would be reasoning about the wrong policy, and under `p=reject` there is no soft-fail: a message that fails DKIM/SPF alignment is **rejected outright** by Gmail/Outlook, not spam-foldered.
- The "end-to-end-verified 2026-07-20" evidence the design leans on verified the **inbound** `support@` → Worker → forward-to-founder path (Email Routing `message.forward`; tickets `sup_d5cc06ca…`, `sup_aa357563…`) and that the `*/5` cron *fired* (`wrangler tail`). It did **not** verify a successful **outbound `send_email` (`OPS_EMAIL.send`) delivery to any external customer inbox**. The outbound binding's only ever-proven consumer is founder alerts to the founder's own Gmail (a known-contact inbox), which the record doesn't even confirm landed. Cold outbound to arbitrary customer inboxes — the actual magic-link use case — is unproven in the cited evidence.

**Failure scenario:** Build proceeds "as designed," sending magic links from `login@coldrig.dev`. If Cloudflare's `send_email` binding does not DKIM-sign that local-part with `d=coldrig.dev` (unverified — the only sender the domain-onboarding has exercised is `ops@coldrig.dev`), then under the live `p=reject` policy every DMARC-honoring provider **hard-rejects** the message. The design's own dark-safe degrade (§1.7) returns the identical generic `200` to the requester on send failure, so the user sees "we've sent a sign-in link," no link ever arrives, and there is **no user-visible bounce**. The founder-ordered "way back in" is 100% dead-on-arrival for Gmail/Outlook users, silently. This is exactly the class the brief flagged ("don't take its word") — the design took a verification's word for a case it doesn't cover.

**Verification method:** Read `ACTIVATION.md:82` (DMARC `p=reject`; the two e2e tests are inbound-forward, not outbound-send). Read `wrangler.toml:41-52` + `real-ops-mailer.ts:18-31` (from-address pinned to `ops@coldrig.dev`; unrestricted binding). Read design §1.7 and cross-checked its DMARC and "live/verified" claims against those records. Confirmed the from-address is a code constant (`OPS_FROM_EMAIL`), so "just change the `from`" also silently changes the DKIM-alignment surface no one has tested.

**Cheap remedy (either closes it):** (a) Send auth mail from the already-proven `ops@coldrig.dev` identity — zero new deliverability risk, and the reputation-hygiene argument for a separate `login@` sender is soft; **or** (b) keep `login@coldrig.dev` but make an empirical `OPS_EMAIL.send()` → arbitrary-external-inbox delivery-and-alignment test (from that exact from-address, asserting DKIM `d=coldrig.dev` aligns) a **hard build gate before arming**. Either way, correct §1.7 to state the DMARC policy is **live `p=reject`** (not "verify if absent"), because that raises a from-address misconfig from soft-degrade to hard-fail.

---

### 2 · NON-BLOCKING · Enumeration timing side-channel is left open (only response-shape + rate-limit asymmetry are closed)

**Lens:** email-enumeration (timing). §1.3 step 6 asserts "no timing/branch/status difference between exists and not-exists," but the design specifies no mechanism to equalize timing. The exists-branch does INSERT + an **awaited** `OPS_EMAIL.send()` (`real-ops-mailer.ts:21-29` is `await binding.send(...)`, a network round trip); the not-exists branch does nothing. A naive builder awaiting the send before the `200` leaks a ~50-300 ms delta that distinguishes real from unknown emails.

**Why NON-BLOCKING (self-refuted down):** the design's own per-email cap (§1.6, ~10/day) throttles an attacker to ~10 timing samples per target per day — far too few to separate a ~100 ms signal from internet jitter for a single address, and enumeration must test many capped addresses. The dominant shape/status oracle IS closed. Residual is real but heavily blunted by the specified rate limits.

**Remedy (belt-and-suspenders, put it in the design so the builder doesn't await):** send via `ctx.waitUntil(...)` so both branches return in ~equal time; optionally do a constant-shape no-op on the not-exists branch.

**Verification:** traced §1.3/§1.7 against `real-ops-mailer.ts` (awaited send) and `rate-limiter-do.ts` (per-key cap semantics).

---

### 3 · NON-BLOCKING · Login-CSRF on `POST /login/consume` is dismissed, not analyzed

**Lens:** CSRF on the redemption endpoint. §1.4 says the consume route "is unauthenticated… so the CSRF guard does not apply" and stops there. That's true of the *guard* (`csrf-guard.ts:27` only fires for `authVia==='cookie'`, and consume isn't behind `requireAuth`), but it means login-CSRF is **unmitigated**: `parseJsonBody`→`c.req.json()` (`validate.ts`) parses the body regardless of Content-Type, so a cross-site `text/plain` simple POST (no CORS preflight) carrying an attacker's own valid unconsumed token forces the victim's browser to consume it → the victim silently receives the **attacker's** dashboard-session cookie and lands in the attacker's tenant. On a cold-email platform a victim who doesn't notice the brand swap could connect a real mailbox / paste real leads into the attacker's account.

**Why NON-BLOCKING:** this exactly mirrors the already-shipped, already-accepted exposure on `POST /dashboard/session` (paste-a-token login has the identical property); magic-link broadens the trigger (email-initiated) but adds no *new* class. It is not session fixation in the dangerous direction — the session id is minted server-side and httpOnly, so the attacker never learns the victim's id.

**Remedy (optional hardening):** bind consume to same-origin via a signed state nonce round-tripped through the SPA, or require the `X-Coldstart-Client` header on consume (forces a preflight the API won't approve cross-site). Worth a sentence in the design even if deferred.

**Verification:** read `csrf-guard.ts`, `index.ts:41-56` (unauthenticated mount), `validate.ts` (`c.req.json()` ignores Content-Type → simple-request CSRF is reachable).

---

### 4 · NON-BLOCKING · Email case-normalization gap is a silent login-failure vector (design flagged it as "small" — it's bigger than that)

**Lens:** fixture realism / correctness. §1.3 step 3 notes store-time email is unnormalized (`signup.ts:53` persists `contactEmail` verbatim) and defers case-folding to "a small correctness detail." If the lookup is case-sensitive, a user who signed up as `John@x.com` and requests a link for `john@x.com` gets **zero tenants → the identical "no account" 200 → no link** — the way-back-in silently fails for that user with no signal. Not small: it's the same silent-total failure mode as finding 1, for a different reason. **Remedy:** normalize-on-write (lowercase at signup) or a case-insensitive/functional index; pick one in the design, don't leave it to the builder. Note the design's proposed `idx_tenants_contact_email` is a plain index — a `LOWER()` comparison would not use it, so decide index shape and query together.

---

## Attacks that FAILED (design held)

- **Single-use replay / concurrent-redemption race** → held. The atomic `UPDATE … WHERE token_hash=? AND consumed_at IS NULL` + `changes()===1` (§1.2) serializes under D1's single-writer model; two concurrent consumes → exactly one wins. Multi-tenant path consumes only on the final pick, preserving exactly-once. (Minor: adding `AND expires_at > ?` to the UPDATE would belt-and-suspender the expiry TOCTOU, but the read-side expiry check already suffices since expiry is monotonic.)
- **Session fixation (dangerous direction)** → held. Mint is server-side fresh (`generateDashboardSessionId`), stored only as `SHA-256(pepper:id)`, cookie is httpOnly/Secure/SameSite=Strict; attacker cannot pre-plant or learn a victim's session id.
- **Prefetch burns the link (Outlook SafeLinks/Gmail scanners)** → held. `/app/*` is asset-served with SPA fallback (`wrangler.toml:63-67`), a GET renders the page and never consumes; only the JS `fetch` POST consumes, which scanners don't execute (§1.4). Confirmed the routing: `basename="/app"` → `/app/login?token=` resolves to a `login` route (increment B adds it).
- **Response-shape / status enumeration oracle** → held. Identical `200 {ok:true}` for exists/not-exists, rate-limit BEFORE lookup, no courtesy mail on unknown (§1.3). (Timing residual is finding 2.)
- **New session system / CSRF-posture divergence** → held. Design terminates in the EXACT existing mint via a `mintDashboardSession()` extraction reused by both routes; cookie/CSRF/`authVia` semantics are preserved because the same helper runs (§1.1). Verified against `dashboard-session.ts` + `require-auth.ts` + `csrf-guard.ts`.
- **Suspended/terminated tenant reactivates via magic link** → held. Lookup filters `status='active'` (§1.3), matching `resolveTenantFromToken`'s `status!=='active'→account_suspended` gate (`require-auth.ts:65-67`).
- **Rollout collision (I3+I4 / brand-sweep)** → held; design handled this lens well. Verified `isRealSpendArmed(env) = STRIPE_SECRET_KEY || (ENGINE_BASE_URL && ENGINE_AUTH_SECRET)` (`engine/billing.ts:37-39`) — TURNSTILE_SECRET is correctly NOT a vendor-spend field, so the §4 R3-1 caution (keep that assertion scoped to vendor fields) is well-founded. A/B reuse only pre-existing bindings (OPS_EMAIL, SIGNUP_LIMITER, TOKEN_HASH_PEPPER, PUBLIC_BASE_URL — all confirmed declared in `env.ts`/`wrangler.toml`); only C touches `env.ts`, correctly sequenced after I3+I4. D correctly serialized after brand-sweep.

## UNVERIFIABLE (need a live environment / owner action)

- **Whether Cloudflare's `send_email` binding DKIM-signs `login@coldrig.dev` with `d=coldrig.dev` (alignment under `p=reject`).** Resolvable only by an actual outbound `OPS_EMAIL.send()` from that from-address to an external inbox + reading the received `Authentication-Results`. This is the empirical gate finding 1 asks for; I cannot send mail (no deploy/secrets).
- **Actual cold-inbox placement (spam vs inbox) for `coldrig.dev` auth mail with no established sending reputation.** Even with alignment passing, first-send-from-a-new-domain placement is an empirical, provider-dependent question. Monitor at arm-time; not design-blocking, but the founder should know a magic link that inboxes-in-spam is still a failed way-back-in.

## NEW (out-of-scope observations, no verdict weight)

- **Citation drift in the design (non-substantive):** it cites the mailer as `real-ops-mailer.ts:1-12` / `ops-mailer.ts:23`, but those files live at `apps/platform/src/ops-mail/` and `OPS_FROM_EMAIL` is at `ops-mailer.ts:19`. Substance is accurate; paths/lines are slightly off. Worth fixing so post-build cite-resolution doesn't dead-end.
- **Per-email cap as a targeted-lockout knob:** ~10/day per email (§1.6) means an attacker can exhaust a victim's daily magic-link allowance (availability nuisance). Acceptable — token paste still works and legit users rarely exceed 10 requests/day — but note it when tuning the cap.
- **Stale "17 tools" onboarding strings** (`SetupPage.tsx`, now 24 per prior tool-count sweep) — design already flags this for the brand-sweep lane; recording so ownership doesn't fall between lanes.

---

## Build review — 2026-07-23

- **Branch:** `worktree-signup-auth-20260723`, HEAD `b543814` (5 commits `0478d21`→`b543814` on `main@116a058`).
- **Worktree:** `/Users/yaakovscher/dev/coldstart/.claude/worktrees/signup-auth-20260723` (shared live tree, read-only git).
- **Reviewer:** adversary (same fresh context that reviewed the design). Re-derived every claim; ran the battery.

### VERDICT: SHIP

Safe to build/merge as built. All eight attack priorities held, all three round-1 obligations (NB2/NB3/NB4) are honored in code (not just claimed), the committed SPA bundle is byte-identical to a fresh rebuild, and the full battery is green. My round-1 BLOCKING (email-channel suitability) is adequately addressed for a merge: the code is honest and dark-safe, ships NO public magic-link advertising, and the only unresolved piece — empirical outbound deliverability of `login@coldrig.dev` under the live `p=reject` policy — is correctly deferred to the named post-deploy `§1.7b` gate the main loop owns. **One operational condition carries forward** (below); it is not a code defect and does not block the merge.

### Round-1 obligations — verified honored (not just claimed)

- **NB2 (timing / waitUntil):** `login.ts:89` fires the send via `c.executionCtx.waitUntil(...).catch(log)`; never inline-awaited. RED-proven by `login.test.ts:291-318` (patches `RealOpsMailer.prototype.send` to 3000 ms, asserts response `< 1000 ms`). Note the test correctly targets `RealOpsMailer` — the class actually exercised, because `env.OPS_EMAIL` is truthy under miniflare (see priority 6).
- **NB3 (login-CSRF on consume):** `login.ts:109-111` requires `X-Coldstart-Client: dashboard` explicitly (the global `csrfGuard` never runs on an unauthenticated route). RED-proven by `login.test.ts:178-189` (no header → 403, token stays unconsumed; the SPA's `apiRequest` attaches the header on non-GET so the real flow works). Closes the cross-site simple-POST login-CSRF I raised.
- **NB4 (email normalization):** `db.ts:22` lowercases `contact_email` on write; `login.ts:55` lowercases the lookup; migration `0009` backfills existing rows (`UPDATE ... SET contact_email = LOWER(...)`) **before** creating the plain index, so index and data agree. RED-proven by `login.test.ts:96-101` (a `MIXED.CASE` login finds a lowercase-stored tenant).

### Attack priorities — all held

1. **Auth core.** Atomic single-use is `UPDATE login_links SET consumed_at=? WHERE token_hash=? AND consumed_at IS NULL` + `changes()===1` (`db.ts:157-162`); RED-proven by the concurrent test `Promise.all([consume,consume]) → [200,401]`, exactly one session (`login.test.ts:136-146`). Token = `generateDashboardSessionId()` (256-bit hex) hashed via `hashApiToken(id, TOKEN_HASH_PEPPER)` — no new secret. `mintDashboardSession` (`dashboard-session.ts:25-45`) is a byte-equivalent pure extraction of the pre-refactor inline body — diffed field-by-field: same id-gen, same hash, same insert shape, same cookie flags (`httpOnly/Secure/SameSite=Strict/path:"/"/maxAge`), same `{tenantId}` return. Consume calls the identical mint. Session fixation impossible (fresh server-side id, httpOnly, attacker never learns it).
2. **Enumeration.** Identical `200 {ok,message}` for exists vs never-registered (`login.test.ts:59-68`); suspended tenant gets the same 200 and NO `login_links` row (`login.test.ts:79-86`, `status='active'` filter); Turnstile is gated AFTER rate limits but BEFORE the tenant lookup (`login.ts:70-71`), so a Turnstile-fail 400 is independent of email existence (`login.test.ts:276-288`, no row created); timing closed via waitUntil. Residual: the exists-branch does one synchronous `insertLoginLink` the missing-branch skips — a sub-millisecond-to-low-ms delta, throttled to 10/day/email, far below internet jitter; not a practical oracle (consistent with the r1 non-blocking stance).
3. **Picker.** The consume list is looked up by `link.contact_email` (server-side, bound to the token), never a client-supplied email — so a token cannot enumerate another email's tenants. `tenantId ∈ email's own tenants` is enforced (`login.ts:135-136`, `tenants.find(...)` → 403, no consume); RED-proven by `login.test.ts:208-221` (foreign tenantId → 403, token survives) and the replay-of-confirmed-pick → 401 (`login.test.ts:233-234`).
4. **Mailer seam.** `sender?: "ops"|"auth"` is a closed enum applied by a ternary in both `RealOpsMailer` and `SandboxOpsMailer` — never a caller-arbitrary From, so no header-injection surface; the recipient `to` is validated by `z.string().email()` (`packages/shared/src/auth.ts:11`). `sender` omitted ⇒ `ops@coldrig.dev`, so every existing caller is unchanged; `ops-mailer.test.ts` is unmodified and green.
5. **Committed SPA bundle.** Rebuilt the dashboard to a scratch outDir (non-mutating) — the four changed chunks (`LoginVerifyPage`, `RecoveryPage`, `SignupPage`, `SetupPage`) and `index-*.js` are **byte-identical** to the committed `apps/platform/public/app/assets/*` (same content-hash filenames AND same bytes). No stale-chunk. No secret baked in — the only home-ish string is the public `agent-cold-email-api.yaakovscher.workers.dev` API origin.
6. **OPS_EMAIL truthy under miniflare.** Confirmed PRE-EXISTING, not a regression: the `[[send_email]] OPS_EMAIL` binding was already in `wrangler.toml` at the base commit `116a058`, and `vitest.config.ts` loads `wrangler.toml`. Every email-content-asserting sweep/dunning/watchtower test injects its own `new SandboxOpsMailer()` (watchtower/admin-dunning/deliverability/registrar tests all do), so none silently rode `RealOpsMailer`. The build's new tests handle it correctly (patch `RealOpsMailer.prototype`). Only artifact: the stale doc comment (below, NEW).
7. **Copy honesty.** NO magic-link / "sign-in link" / "email me a link" advertising anywhere in `site/`; NO `/login` or `/recover` entry in `sitemap.xml`; "Free sign up" applied across `index/connect/signup`; every stale "17 tools" flipped to "24" (incl. `SetupPage.tsx`). 24 is TRUE — `mcp.test.ts:88` asserts `tools/list` `toHaveLength(24)` and `server-card.json` lists exactly 24.
8. **Battery (ran it).** Platform 676/676 (95 files, exit 0), dashboard 106/106, root typecheck clean across all 5 workspaces (dashboard/engine/platform/CLI/shared).

### Carried operational condition (NON-BLOCKING — main loop owns it, not the build)

- **`§1.7b` outbound-deliverability gate must pass before the recovery page is relied upon / before any arming.** The build chose `login@coldrig.dev` (a valid option from the r1 remedy menu) and defers the empirical "does `login@` DKIM-align and inbox under the live `p=reject` DMARC" test to a post-deploy main-loop step. The code is dark-safe (waitUntil + catch + generic 200 ⇒ no leak, no spend, no oracle if the send hard-bounces), and no public surface advertises magic-link. The ONE residual: the functional `RecoveryPage` at `/app/recover` (linked from `TokenGate`) IS live at deploy time and tells a user "a sign-in link is on its way" — so if `§1.7b` FAILS (login@ hard-rejected under p=reject) and isn't run promptly, the page becomes a silent non-delivering dead-end that overstates success. This is no worse than the pre-existing dead-end it replaced and carries zero security/spend harm, but the main loop should run `§1.7b` before relying on the recovery page, and fall back to the proven `ops@coldrig.dev` sender if `login@` fails alignment. I cannot close this myself (no live send / no secrets) — it remains the UNVERIFIABLE item from round 1.

### NEW (out-of-scope, no verdict weight)

- **Stale doc comment:** `apps/platform/src/ops-mail/ops-mailer.ts:74-77` still says "In tests/dev the binding is never bound, so this returns a SandboxOpsMailer automatically" — now inaccurate, since `env.OPS_EMAIL` IS a truthy miniflare-simulated binding under test (the build's `login.test.ts:295-300` documents the real behavior). Pre-existing; worth a one-line correction so the next reader isn't misled.
